import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { readdirSync, readFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import { readdir, readFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { S3Client, PutObjectCommand, GetObjectCommand, CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { config } from '../config.ts';
import { writeAtomic, syncDirectory } from './authState.ts';

// Plan 8, layer 6: backup of the Baileys auth-state folder, taken on
// creds.update (not a fixed schedule) so a lost or corrupted session never
// means re-scanning QR from zero. Debounced — creds.update fires often during
// normal operation and re-copying on every single one is pointless.
//
// TWO layers, because they fail for different reasons:
//
//   1. A local copy at `<dataDir>/auth-session-backup.enc`. Needs no
//      credentials at all, so it is always on. Covers the realistic failures:
//      a torn creds.json, an accidental delete, a bad overwrite.
//   2. The same bundle on R2, when R2 is configured. This is the one that
//      survives losing the phone itself — the local copy obviously cannot.
//
// Both are ONE file: the encrypted, gzipped bundle below. The local layer used
// to be a plain copy of the ~7500 session files, written one by one with a
// synchronous open/write/fsync/rename each — measured at 21.7 s of the event
// loop frozen solid per snapshot, run 30 s after every WhatsApp reconnect. For
// all of that time no HTTP request was answered (the sites give up after 8 s)
// and Baileys' keep-alive could not see its own pongs, so it declared the
// connection lost (408) — which reconnects, which schedules another snapshot.
// Now the files are read asynchronously, compressed off the main thread, and
// written as a single file with a single fsync; the R2 upload reuses the very
// same bytes instead of reading the session a second time.
//
// Restore prefers the local copy: it is newer by definition (written on the
// same event, without a network round-trip) and cannot fail on a dead tunnel.

const AUTH_DIR = path.join(config.dataDir, 'auth-session');
const LOCAL_BUNDLE = `${AUTH_DIR}-backup.enc`;
// The previous local format (a directory holding a plain copy of every file).
// Still restorable, so an upgrade does not strand the copy already on disk;
// removed by the first snapshot in the new format.
const LEGACY_BACKUP_DIR = `${AUTH_DIR}-backup`;
const BACKUP_KEY = 'whatsapp-session.enc';
const DEBOUNCE_MS = 30_000;
// Writes during a restore run a few at a time: one by one, 7500 fsyncs took
// tens of seconds on flash storage; all at once would exhaust file handles.
const RESTORE_WRITE_CONCURRENCY = 8;

function deriveKey(): Buffer {
  // Lets the operator set any passphrase in .env rather than a raw 32-byte
  // hex string — SHA-256 always yields the 32 bytes AES-256-GCM needs.
  return crypto.createHash('sha256').update(config.sessionBackup.encryptionKey).digest();
}

interface BundleStats {
  files: number;
  hasCreds: boolean;
}

// Emits the bundle as a stream of JSON fragments instead of building it whole,
// holding one session file at a time — the whole thing is ~45 MB against a
// 256 MB heap. Reads are asynchronous so the event loop keeps serving between
// files.
async function* bundleFragments(stats: BundleStats): AsyncGenerator<string> {
  const names = (await readdir(AUTH_DIR)).filter((name) => name.endsWith('.json'));
  yield '{';
  let first = true;
  for (const name of names) {
    let contents: string;
    try {
      contents = await readFile(path.join(AUTH_DIR, name), 'utf-8');
    } catch {
      continue; // Baileys deletes keys while we work — skip, don't abort
    }
    if (name === 'creds.json') {
      // A snapshot is only as good as its creds.json — one that does not
      // parse must not replace a backup that does.
      try {
        JSON.parse(contents);
        stats.hasCreds = true;
      } catch {
        continue;
      }
    }
    yield `${first ? '' : ','}${JSON.stringify(name)}:${JSON.stringify(contents)}`;
    first = false;
    stats.files += 1;
  }
  yield '}';
}

// Layout: [12-byte IV][16-byte auth tag][ciphertext] — unchanged, so a bundle
// written by the previous version still decrypts. The PLAINTEXT is gzipped
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
export async function encryptFragments(fragments: Iterable<string> | AsyncIterable<string>): Promise<Buffer> {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(), iv);
  const gzip = zlib.createGzip();

  const out: Buffer[] = [];
  const done = new Promise<void>((resolve, reject) => {
    gzip.on('data', (chunk: Buffer) => out.push(cipher.update(chunk)));
    gzip.on('end', resolve);
    gzip.on('error', reject);
  });

  for await (const fragment of fragments) {
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

/**
 * Reads the live session into one encrypted bundle. Throws — writing nothing —
 * when the live session has no readable creds.json: without it the copy is
 * worthless and must not replace a good backup.
 */
export async function buildSessionBundle(): Promise<{ bundle: Buffer; files: number }> {
  const stats: BundleStats = { files: 0, hasCreds: false };
  const bundle = await encryptFragments(bundleFragments(stats));
  if (!stats.hasCreds) throw new Error('snapshot aborted: creds.json missing from the live session');
  return { bundle, files: stats.files };
}

/** The file list inside a decrypted bundle, or null if it holds no usable creds.json. */
function parseBundle(plaintext: string): Array<[string, string]> | null {
  const bundle = JSON.parse(plaintext) as Record<string, unknown>;
  const creds = bundle['creds.json'];
  if (typeof creds !== 'string') return null;
  // Verified before anything is overwritten — restoring an unreadable backup
  // over a merely-damaged session turns a recoverable state into a broken one.
  JSON.parse(creds);
  return Object.entries(bundle).filter(
    (entry): entry is [string, string] => entry[0].endsWith('.json') && typeof entry[1] === 'string',
  );
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

async function uploadBundle(bundle: Buffer): Promise<void> {
  await getS3().send(new PutObjectCommand({ Bucket: config.sessionBackup.r2Bucket, Key: BACKUP_KEY, Body: bundle }));
}

// Removes any live .json file NOT in `keep` — shared by both restore paths so
// neither can leave a hybrid of an older identity's leftover keys mixed with
// a newly-restored one. Copying a backup/bundle *over* the live folder without
// this kept every key the source didn't contain, producing a session that
// authenticates and then fails to decrypt. Exported for testing.
export function clearStaleAuthFiles(keep: Set<string>): void {
  if (!existsSync(AUTH_DIR)) return;
  for (const name of readdirSync(AUTH_DIR)) {
    if (name.endsWith('.json') && !keep.has(name)) {
      rmSync(path.join(AUTH_DIR, name), { force: true });
    }
  }
}

/**
 * Replaces the live session with `files`. creds.json is written LAST: a crash
 * part-way leaves the old (damaged — that is why we are restoring) creds.json
 * in place, so the next boot sees it and restores again, instead of a good
 * creds.json sitting on top of half a key set.
 */
async function writeSessionFiles(files: Array<[string, string]>): Promise<void> {
  await mkdir(AUTH_DIR, { recursive: true });
  clearStaleAuthFiles(new Set(files.map(([name]) => name)));

  const keys = files.filter(([name]) => name !== 'creds.json');
  let next = 0;
  const writer = async (): Promise<void> => {
    while (next < keys.length) {
      const [name, contents] = keys[next++];
      await writeAtomic(path.join(AUTH_DIR, name), contents, { syncDir: false });
    }
  };
  await Promise.all(Array.from({ length: Math.min(RESTORE_WRITE_CONCURRENCY, keys.length) }, writer));
  await syncDirectory(AUTH_DIR); // one flush for the whole batch, not one per file

  const creds = files.find(([name]) => name === 'creds.json');
  if (creds) await writeAtomic(path.join(AUTH_DIR, 'creds.json'), creds[1]);
}

// ---- layer 1: local copy (no credentials, always on) ----

/**
 * Writes the local backup. `prebuilt` lets the scheduled backup build the
 * bundle once and hand the same bytes to R2.
 *
 * One atomic file replace: a crash at any point leaves either the previous
 * backup or the new one, never a partial one — the property the old
 * staging-directory swap existed to provide, now without 7500 writes.
 */
export async function snapshotLocal(prebuilt?: { bundle: Buffer; files: number }): Promise<number> {
  const built = prebuilt ?? (await buildSessionBundle());
  await writeAtomic(LOCAL_BUNDLE, built.bundle);
  // The old per-file copy is now strictly older than this bundle. Left in
  // place it would be what a failed bundle read falls back to.
  for (const legacy of [LEGACY_BACKUP_DIR, `${LEGACY_BACKUP_DIR}.old`, `${LEGACY_BACKUP_DIR}.new`]) {
    await rm(legacy, { recursive: true, force: true });
  }
  return built.files;
}

async function readLocalBackup(): Promise<Array<[string, string]> | null> {
  try {
    const files = parseBundle(decryptBundle(await readFile(LOCAL_BUNDLE)));
    if (files) return files;
  } catch {
    /* missing, truncated, or a different key — try the older format */
  }
  try {
    JSON.parse(await readFile(path.join(LEGACY_BACKUP_DIR, 'creds.json'), 'utf-8'));
    const names = (await readdir(LEGACY_BACKUP_DIR)).filter((name) => name.endsWith('.json'));
    const files: Array<[string, string]> = [];
    for (const name of names) files.push([name, await readFile(path.join(LEGACY_BACKUP_DIR, name), 'utf-8')]);
    return files;
  } catch {
    return null;
  }
}

export async function restoreFromLocal(): Promise<
  { ok: true; files: number } | { ok: false; reason: 'no_backup' | 'error'; error?: unknown }
> {
  const files = await readLocalBackup();
  if (!files) return { ok: false, reason: 'no_backup' };
  try {
    await writeSessionFiles(files);
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
    const files = parseBundle(decryptBundle(Buffer.concat(chunks)));
    if (!files) return { ok: false, reason: 'no_backup' };

    await writeSessionFiles(files);
    return { ok: true, files: files.length };
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
  for (const target of [AUTH_DIR, LOCAL_BUNDLE, LEGACY_BACKUP_DIR, `${LEGACY_BACKUP_DIR}.old`]) {
    if (existsSync(target)) renameSync(target, `${target}.${suffix}`);
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
 * R2 is quarantined FIRST, deliberately, even though it is the slower half
 * (network round-trips) and the local rename is a single near-instant
 * syscall. restoreSessionFromR2() only ever runs once BOTH local checks
 * miss (see prepareSession() in client.ts) — so as long as the live local
 * folder is still in place, a process restart mid-R2-quarantine just means
 * this same handler fires again on the next reconnect attempt (the identity
 * is dead either way, so retrying is free) instead of leaving the R2 object
 * live under its well-known key while the local copy has ALREADY vanished,
 * which is exactly the window in which restoreSessionFromR2() would
 * resurrect the very session WhatsApp just revoked.
 *
 * `deps` is overridable only from tests — quarantineR2 needs real R2
 * credentials and network access that a unit test has neither of.
 *
 * Does not itself reconnect or delete anything irreversibly — see the header
 * comment above.
 */
export async function quarantineDeadSession(
  logger: { info: (msg: string) => void; error: (msg: string, err: unknown) => void },
  deps: { quarantineLocal?: (suffix: string) => void; quarantineR2?: (suffix: string) => Promise<void> } = {},
): Promise<void> {
  const doLocal = deps.quarantineLocal ?? quarantineLocal;
  const doR2 = deps.quarantineR2 ?? quarantineR2;
  const suffix = `loggedout-${timestampSuffix()}`;

  if (config.sessionBackup.enabled) {
    try {
      await doR2(suffix);
      logger.info('[session-backup] عُزلت نسخة R2');
    } catch (err) {
      // Best-effort: the local quarantine below still runs regardless, and a
      // permanently failed R2 quarantine (as opposed to a crash mid-attempt)
      // was already only ever best-effort — see the module header.
      logger.error(
        '[session-backup] تعذّر عزل نسخة R2 — ستبقى الجلسة الميتة قابلة للاستعادة منها لو فشلت الاستعادة المحلية لسبب آخر',
        err,
      );
    }
  }

  doLocal(suffix);
  logger.info('[session-backup] عُزلت الجلسة المحلية ونسختها الاحتياطية بعد تسجيل خروج فعلي — الاتصال التالي يبدأ بهوية فارغة');
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
// When the first postponed snapshot became due. The debounce restarted its
// timer on every creds.update with no ceiling, so a burst of updates arriving
// faster than every 30s postponed the snapshot for as long as the burst
// lasted — precisely when the session is changing fastest and a backup is most
// valuable. Past this cap the pending snapshot runs regardless of new events.
const MAX_DEBOUNCE_MS = 5 * 60_000;
let firstDeferredAt = 0;
// A backup now spans many awaits; a second one starting while the first is
// still reading would race it for the same temp file.
let backupInFlight = false;

type BackupLogger = { info: (msg: string) => void; error: (msg: string, err: unknown) => void };

async function runSessionBackup(logger: BackupLogger): Promise<void> {
  let built: { bundle: Buffer; files: number };
  try {
    built = await buildSessionBundle();
  } catch (err) {
    logger.error('[session-backup] تعذّر بناء النسخة الاحتياطية', err);
    return;
  }

  try {
    await snapshotLocal(built);
    logger.info(`[session-backup] نسخة محلية: ${built.files} ملف (${Math.ceil(built.bundle.length / 1024)} KB)`);
  } catch (err) {
    logger.error('[session-backup] فشلت النسخة المحلية', err);
  }

  if (!config.sessionBackup.enabled) return;
  try {
    await uploadBundle(built.bundle);
    logger.info('[session-backup] uploaded encrypted session to R2');
  } catch (err) {
    logger.error('[session-backup] upload failed, will retry on next change', err);
  }
}

/**
 * `isEligible` is the rule that makes this safe to run automatically: a
 * snapshot is only ever taken from a LINKED, currently-connected session.
 * Without it, the first QR-pending boot after a wipe would overwrite the good
 * backup with a blank identity — turning the safety net into the thing that
 * destroys the session.
 */
export function scheduleSessionBackup(logger: BackupLogger, isEligible: () => boolean): void {
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
    if (backupInFlight) {
      scheduleSessionBackup(logger, isEligible); // try again once this one is done
      return;
    }
    backupInFlight = true;
    void runSessionBackup(logger).finally(() => {
      backupInFlight = false;
    });
  }, DEBOUNCE_MS);
}
