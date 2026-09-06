import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { readdirSync, readFileSync, mkdirSync, writeFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { S3Client, PutObjectCommand, GetObjectCommand, CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { config } from '../config.ts';

// Plan 8, layer 6: backup of the Baileys auth-state folder, taken on
// creds.update (not a fixed schedule) so a lost or corrupted session never
// means re-scanning QR from zero. Debounced — creds.update fires often during
// normal operation and re-copying on every single one is pointless.
//
// TWO layers, because they fail for different reasons:
//
//   1. A plain local copy in `<dataDir>/auth-session-backup`. Needs no
//      credentials at all, so it is always on. Covers the realistic failures:
//      a torn creds.json, an accidental delete, a bad overwrite.
//   2. The encrypted copy on R2, when R2 is configured. This is the one that
//      survives losing the phone itself — the local copy obviously cannot.
//
// Restore prefers the local copy: it is newer by definition (written on the
// same event, without a network round-trip) and cannot fail on a dead tunnel.

const AUTH_DIR = path.join(config.dataDir, 'auth-session');
const LOCAL_BACKUP_DIR = `${AUTH_DIR}-backup`;
const BACKUP_KEY = 'whatsapp-session.enc';
const DEBOUNCE_MS = 30_000;

function deriveKey(): Buffer {
  // Lets the operator set any passphrase in .env rather than a raw 32-byte
  // hex string — SHA-256 always yields the 32 bytes AES-256-GCM needs.
  return crypto.createHash('sha256').update(config.sessionBackup.encryptionKey).digest();
}

// Emits the bundle as a stream of JSON fragments instead of building it whole.
//
// The old version read all ~7500 session files into one object and
// JSON.stringify'd it: a ~45 MB string, which the cipher then copied again,
// and Buffer.concat again — several hundred megabytes of transient allocation
// against `--max-old-space-size=256`, on a phone whose pm2 ceiling is 400 MB.
// Every one of those kills forces a full WhatsApp reconnect, which
// ecosystem.config.cjs calls the single biggest source of heat and the thing
// that most raises the ban risk on an unofficial client.
//
// Now only one file is held at a time; peak retained memory is the compressed
// ciphertext, which for this session is under a megabyte.
function* bundleFragments(): Generator<string> {
  const files = readdirSync(AUTH_DIR).filter((name) => name.endsWith('.json'));
  yield '{';
  let first = true;
  for (const name of files) {
    let contents: string;
    try {
      contents = readFileSync(path.join(AUTH_DIR, name), 'utf-8');
    } catch {
      continue; // Baileys deletes keys while we work — skip, don't abort
    }
    yield `${first ? '' : ','}${JSON.stringify(name)}:${JSON.stringify(contents)}`;
    first = false;
  }
  yield '}';
}

// Layout: [12-byte IV][16-byte auth tag][ciphertext] — unchanged, so a bundle
// written by the previous version still decrypts. The PLAINTEXT is now gzipped
// (the session is overwhelmingly repetitive JSON: ~45 MB becomes well under
// 1 MB), which is detected on the way back out rather than assumed — see
// decryptBundle.
export function encryptBundle(plaintext: string): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(), iv);
  const compressed = zlib.gzipSync(Buffer.from(plaintext, 'utf-8'));
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

/**
 * The streaming form: same output layout, without ever holding the whole
 * plaintext. ASYNC because Node's zlib streams do their work on the threadpool
 * — collecting their 'data' events synchronously would have produced an empty
 * backup, which is worse than the memory problem this replaces.
 */
export async function encryptFragments(fragments: Iterable<string>): Promise<Buffer> {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(), iv);
  const gzip = zlib.createGzip();

  const out: Buffer[] = [];
  const done = new Promise<void>((resolve, reject) => {
    gzip.on('data', (chunk: Buffer) => out.push(cipher.update(chunk)));
    gzip.on('end', resolve);
    gzip.on('error', reject);
  });

  for (const fragment of fragments) {
    // Respect backpressure: without this the whole bundle queues inside the
    // gzip stream's buffer and we are back to holding it all in memory.
    if (!gzip.write(fragment)) {
      await new Promise<void>((resolve) => gzip.once('drain', resolve));
    }
  }
  gzip.end();
  await done;

  if (out.length === 0) throw new Error('gzip produced no output — refusing to write an empty backup');

  out.push(cipher.final());
  return Buffer.concat([iv, cipher.getAuthTag(), ...out]);
}

// gzip's magic number. Bundles written before compression was added start with
// '{' instead, and must keep restoring — there is a live one in R2 right now.
const GZIP_MAGIC = [0x1f, 0x8b];

export function decryptBundle(blob: Buffer): string {
  const iv = blob.subarray(0, 12);
  const authTag = blob.subarray(12, 28);
  const ciphertext = blob.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(), iv);
  decipher.setAuthTag(authTag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  if (plain.length >= 2 && plain[0] === GZIP_MAGIC[0] && plain[1] === GZIP_MAGIC[1]) {
    return zlib.gunzipSync(plain).toString('utf-8');
  }
  return plain.toString('utf-8'); // pre-compression bundle
}

let s3Client: S3Client | null = null;
function getS3(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${config.sessionBackup.r2AccountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.sessionBackup.r2AccessKeyId,
        secretAccessKey: config.sessionBackup.r2SecretAccessKey,
      },
    });
  }
  return s3Client;
}

export { BACKUP_KEY };

async function runBackup(): Promise<void> {
  const encrypted = await encryptFragments(bundleFragments());
  await getS3().send(
    new PutObjectCommand({ Bucket: config.sessionBackup.r2Bucket, Key: BACKUP_KEY, Body: encrypted }),
  );
}

// ---- layer 1: local copy (no credentials, always on) ----

function writeFileAtomic(filePath: string, contents: string): void {
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, contents, 'utf-8');
  renameSync(tmpPath, filePath);
}

export function snapshotLocal(): number {
  // Built in a staging directory and swapped in by rename, NOT written over
  // the live backup.
  //
  // The old order deleted the backup first and then copied ~7500 files in one
  // by one, so anything that interrupted the copy — pm2's memory kill, the
  // low-memory killer, a power cut, or simply Baileys unlinking a signal key
  // mid-copy — left the backup missing or half-written. That is the exact
  // moment the backup exists for. Worse, restoreFromLocal only checks that
  // creds.json parses, so a partial snapshot passes validation and gets
  // restored as a session that authenticates but cannot decrypt.
  //
  // Every individual file write in this codebase is already atomic; the
  // directory replace was the one step that wasn't.
  const staging = `${LOCAL_BACKUP_DIR}.new`;
  const previous = `${LOCAL_BACKUP_DIR}.old`;

  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  const files = readdirSync(AUTH_DIR).filter((name) => name.endsWith('.json'));
  for (const name of files) {
    // A key deleted between readdir and readFile is skipped rather than
    // aborting the whole snapshot — it is gone from the live session anyway.
    let contents: string;
    try {
      contents = readFileSync(path.join(AUTH_DIR, name), 'utf-8');
    } catch {
      continue;
    }
    writeFileAtomic(path.join(staging, name), contents);
  }

  // creds.json is what makes a snapshot usable at all; without it the staging
  // copy is worthless and must not replace a good backup.
  if (!existsSync(path.join(staging, 'creds.json'))) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error('snapshot aborted: creds.json missing from the live session');
  }

  // Swap: move the current backup aside, promote staging, then drop the old
  // one. A crash between the renames leaves either the old or the new backup
  // in place — never a partial directory.
  rmSync(previous, { recursive: true, force: true });
  if (existsSync(LOCAL_BACKUP_DIR)) renameSync(LOCAL_BACKUP_DIR, previous);
  renameSync(staging, LOCAL_BACKUP_DIR);
  rmSync(previous, { recursive: true, force: true });

  return files.length;
}

export function restoreFromLocal(): { ok: true; files: number } | { ok: false; reason: 'no_backup' | 'error'; error?: unknown } {
  try {
    // Verified before anything is overwritten — restoring an unreadable backup
    // over a merely-damaged session turns a recoverable state into a broken one.
    JSON.parse(readFileSync(path.join(LOCAL_BACKUP_DIR, 'creds.json'), 'utf-8'));
  } catch {
    return { ok: false, reason: 'no_backup' };
  }

  try {
    mkdirSync(AUTH_DIR, { recursive: true });
    const files = readdirSync(LOCAL_BACKUP_DIR).filter((name) => name.endsWith('.json'));

    // Stale keys in the live folder are removed, not left in place. Copying the
    // backup *over* the live folder kept every key the backup didn't contain,
    // producing a hybrid of an older identity and newer session keys that no
    // snapshot ever produced — it can connect and then fail to decrypt.
    // snapshotLocal clears its own target for exactly this reason.
    const restored = new Set(files);
    for (const name of readdirSync(AUTH_DIR)) {
      if (name.endsWith('.json') && !restored.has(name)) {
        rmSync(path.join(AUTH_DIR, name), { force: true });
      }
    }

    for (const name of files) {
      writeFileAtomic(path.join(AUTH_DIR, name), readFileSync(path.join(LOCAL_BACKUP_DIR, name), 'utf-8'));
    }
    return { ok: true, files: files.length };
  } catch (error) {
    return { ok: false, reason: 'error', error };
  }
}

// ---- layer 2: encrypted copy on R2 (survives losing the phone) ----

export type RestoreResult =
  | { ok: true; files: number }
  | { ok: false; reason: 'not_configured' | 'no_backup' | 'error'; error?: unknown };

// Pulls the last encrypted bundle back down and rewrites the auth folder.
// Shared by the boot-time auto-restore in client.ts and the manual runbook
// script — a divergence between "what the runbook does" and "what the service
// does on its own" is exactly the kind of thing that bites during an outage.
export async function restoreSessionFromR2(): Promise<RestoreResult> {
  if (!config.sessionBackup.enabled) return { ok: false, reason: 'not_configured' };

  try {
    const response = await getS3().send(
      new GetObjectCommand({ Bucket: config.sessionBackup.r2Bucket, Key: BACKUP_KEY }),
    );
    if (!response.Body) return { ok: false, reason: 'no_backup' };

    const chunks: Buffer[] = [];
    for await (const chunk of response.Body as AsyncIterable<Buffer>) chunks.push(chunk);

    // Decrypting before touching the auth folder — a wrong
    // SESSION_BACKUP_ENCRYPTION_KEY or a truncated object must fail here,
    // with the existing (possibly still usable) files left untouched.
    const bundle = JSON.parse(decryptBundle(Buffer.concat(chunks))) as Record<string, string>;

    mkdirSync(AUTH_DIR, { recursive: true });
    for (const [filename, contents] of Object.entries(bundle)) {
      writeFileSync(path.join(AUTH_DIR, filename), contents, 'utf-8');
    }
    return { ok: true, files: Object.keys(bundle).length };
  } catch (error) {
    const code = (error as { name?: string })?.name;
    if (code === 'NoSuchKey' || code === 'NotFound') return { ok: false, reason: 'no_backup' };
    return { ok: false, reason: 'error', error };
  }
}

// ---- confirmed logout: stop both backup layers from resurrecting a dead identity ----
//
// A real WhatsApp logout (device unlinked, or a re-pair forced by an
// enforcement) revokes the identity on WhatsApp's OWN servers — not just the
// local file. So the local backup and the R2 backup are just as dead as the
// live session: nothing about either COPY changes when the original is
// revoked. Left in place, prepareSession() in client.ts would restore one of
// them the next time the process starts (a missing/corrupt creds.json is
// exactly what it treats as "restore me"), silently bringing the same revoked
// session back — a human "scanning a new QR" would just watch it fail the
// same way again, with no obvious reason why.
//
// Quarantined, not deleted: this runs off a single disconnect status code, and
// if that code is ever misreported, the operator can still recover the
// renamed/copied files by hand. Deleting outright would make that mistake
// unrecoverable.

function timestampSuffix(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// Exported for testing: the network-free half of quarantineDeadSession, and
// the half that alone already guarantees the next boot shows a fresh QR
// (restoreSessionFromR2 only ever runs after both local checks miss).
export function quarantineLocal(suffix: string): void {
  for (const dir of [AUTH_DIR, LOCAL_BACKUP_DIR, `${LOCAL_BACKUP_DIR}.old`]) {
    if (existsSync(dir)) renameSync(dir, `${dir}.${suffix}`);
  }
}

async function quarantineR2(suffix: string): Promise<void> {
  const bucket = config.sessionBackup.r2Bucket;
  await getS3().send(
    new CopyObjectCommand({ Bucket: bucket, CopySource: `/${bucket}/${BACKUP_KEY}`, Key: `whatsapp-session.loggedout-${suffix}.enc` }),
  );
  await getS3().send(new DeleteObjectCommand({ Bucket: bucket, Key: BACKUP_KEY }));
}

/**
 * Called once, from the `loggedOut` branch in client.ts. Renames the local
 * session and its local backup aside, and (best-effort) moves the R2 object
 * off its well-known key, so the NEXT connection attempt — whenever the
 * operator makes one — starts from a genuinely empty identity and shows a
 * fresh QR, instead of prepareSession() quietly restoring the one WhatsApp
 * just revoked.
 *
 * Does not itself reconnect or delete anything irreversibly — see the header
 * comment above.
 */
export async function quarantineDeadSession(logger: {
  info: (msg: string) => void;
  error: (msg: string, err: unknown) => void;
}): Promise<void> {
  const suffix = `loggedout-${timestampSuffix()}`;
  quarantineLocal(suffix);
  logger.info('[session-backup] عُزلت الجلسة المحلية ونسختها الاحتياطية بعد تسجيل خروج فعلي — الاتصال التالي يبدأ بهوية فارغة');

  if (!config.sessionBackup.enabled) return;
  try {
    await quarantineR2(suffix);
    logger.info('[session-backup] عُزلت نسخة R2 أيضاً');
  } catch (err) {
    // Best-effort: the local quarantine above is already enough for the next
    // boot to show a fresh QR, since restoreSessionFromR2 only runs when the
    // local checks (now both moved aside) find nothing.
    logger.error('[session-backup] تعذّر عزل نسخة R2 — ستبقى الجلسة الميتة قابلة للاستعادة منها لو فشلت الاستعادة المحلية لسبب آخر', err);
  }
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
// When the first postponed snapshot became due. The debounce restarted its
// timer on every creds.update with no ceiling, so a burst of updates arriving
// faster than every 30s postponed the snapshot for as long as the burst
// lasted — precisely when the session is changing fastest and a backup is most
// valuable. Past this cap the pending snapshot runs regardless of new events.
const MAX_DEBOUNCE_MS = 5 * 60_000;
let firstDeferredAt = 0;

/**
 * `isEligible` is the rule that makes this safe to run automatically: a
 * snapshot is only ever taken from a REGISTERED, currently-connected session.
 * Without it, the first QR-pending boot after a wipe would overwrite the good
 * backup with a blank identity — turning the safety net into the thing that
 * destroys the session.
 */
export function scheduleSessionBackup(
  logger: { info: (msg: string) => void; error: (msg: string, err: unknown) => void },
  isEligible: () => boolean,
): void {
  const now = Date.now();
  if (!debounceTimer) firstDeferredAt = now;

  // Already waited the cap: let the pending timer fire instead of pushing it
  // back again.
  if (debounceTimer && now - firstDeferredAt >= MAX_DEBOUNCE_MS) return;

  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    firstDeferredAt = 0;
    if (!isEligible()) return;

    try {
      const files = snapshotLocal();
      logger.info(`[session-backup] نسخة محلية: ${files} ملف`);
    } catch (err) {
      logger.error('[session-backup] فشلت النسخة المحلية', err);
    }

    if (!config.sessionBackup.enabled) return;
    runBackup().then(
      () => logger.info('[session-backup] uploaded encrypted session to R2'),
      (err) => logger.error('[session-backup] upload failed, will retry on next change', err),
    );
  }, DEBOUNCE_MS);
}
