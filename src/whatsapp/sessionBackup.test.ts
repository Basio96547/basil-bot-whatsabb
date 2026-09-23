// The local backup layer is what makes session recovery work without any
// credentials at all, so its two dangerous edges get tested directly: it must
// not restore from an unreadable backup, and a re-snapshot must not leave
// deleted keys behind to be restored later as stale signal state.
//
// DATA_DIR is redirected to a throwaway folder BEFORE config.ts is imported —
// these functions resolve their paths once at module load, and the real
// data/auth-session holds a live WhatsApp login that must never be touched by
// a test run.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sms-api-backup-'));

process.env.SESSION_BACKUP_ENCRYPTION_KEY ??= 'test-passphrase-for-backup-roundtrip';
// Fake but well-formed — makes config.sessionBackup.enabled true so
// quarantineDeadSession's R2 branch is exercised below, using injected
// stand-ins rather than a real S3Client, which none of these tests have.
process.env.R2_ACCOUNT_ID ??= 'test-account';
process.env.R2_ACCESS_KEY_ID ??= 'test-access-key';
process.env.R2_SECRET_ACCESS_KEY ??= 'test-secret';
// config.ts requires one of these per project in config/projects.json at
// import time, unrelated to anything this file actually tests — on a fresh
// checkout with no .env yet, this file failed before a single test ran.
process.env.PROJECT_API_KEY_STORE ??= 'test-store-key';
process.env.PROJECT_API_KEY_QAREEB ??= 'test-qareeb-key';
process.env.PROJECT_API_KEY_FIREWORKS ??= 'test-fireworks-key';
process.env.OTP_HASH_SECRET ??= 'test-otp-hash-secret';

const {
  snapshotLocal,
  restoreFromLocal,
  encryptBundle,
  decryptBundle,
  encryptFragments,
  quarantineLocal,
  quarantineDeadSession,
  clearStaleAuthFiles,
} = await import('./sessionBackup.ts');
const crypto = await import('node:crypto');
const zlib = await import('node:zlib');

const AUTH_DIR = path.join(process.env.DATA_DIR, 'auth-session');
const BUNDLE = `${AUTH_DIR}-backup.enc`;
// The pre-bundle local format — a directory holding a plain copy of every file.
const LEGACY_DIR = `${AUTH_DIR}-backup`;

function reset(): void {
  rmSync(AUTH_DIR, { recursive: true, force: true });
  rmSync(BUNDLE, { force: true });
  rmSync(LEGACY_DIR, { recursive: true, force: true });
  mkdirSync(AUTH_DIR, { recursive: true });
}

/** The file names inside the local backup, read the way a restore reads it. */
function backupFiles(): string[] {
  return Object.keys(JSON.parse(decryptBundle(readFileSync(BUNDLE)))).sort();
}

function writeSession(creds: object, extra: Record<string, object> = {}): void {
  writeFileSync(path.join(AUTH_DIR, 'creds.json'), JSON.stringify(creds), 'utf-8');
  for (const [name, value] of Object.entries(extra)) {
    writeFileSync(path.join(AUTH_DIR, `${name}.json`), JSON.stringify(value), 'utf-8');
  }
}

test('an encrypted bundle round-trips', () => {
  const payload = JSON.stringify({ 'creds.json': '{"registered":true}', 'session-a.json': '{"k":1}' });
  assert.equal(decryptBundle(encryptBundle(payload)), payload);
});

test('the streaming encoder produces something the same decoder reads back', async () => {
  // The R2 path no longer builds the ~45MB bundle as one string: it feeds
  // fragments through gzip into the cipher. The two encoders must stay
  // interchangeable, or a backup written by one cannot be restored by the other.
  const parts = ['{', '"creds.json":"{\\"registered\\":true}"', ',"session-a.json":"{}"', '}'];
  const blob = await encryptFragments(parts);
  assert.equal(decryptBundle(blob), parts.join(''));
});

test('a bundle written BEFORE compression was added still restores', async () => {
  // There is a live uncompressed bundle in R2 right now. Losing the ability to
  // read it would mean the backup exists but cannot be used — the worst
  // possible outcome for this feature.
  const payload = JSON.stringify({ 'creds.json': '{"registered":true}' });
  const key = crypto.createHash('sha256')
    .update(process.env.SESSION_BACKUP_ENCRYPTION_KEY!)
    .digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  // The OLD format: raw utf-8 plaintext, no gzip layer.
  const encrypted = Buffer.concat([cipher.update(payload, 'utf-8'), cipher.final()]);
  const legacyBlob = Buffer.concat([iv, cipher.getAuthTag(), encrypted]);

  assert.equal(decryptBundle(legacyBlob), payload);
});

test('compression actually shrinks a realistic session by a large factor', async () => {
  // The whole point of the change: ~7500 near-identical key files are highly
  // repetitive, so the retained ciphertext is a fraction of the plaintext.
  const fragments: string[] = ['{'];
  for (let i = 0; i < 400; i++) {
    fragments.push(`${i ? ',' : ''}"session-${i}.json":${JSON.stringify(JSON.stringify({ k: i, pad: 'x'.repeat(200) }))}`);
  }
  fragments.push('}');
  const plainSize = fragments.join('').length;

  const blob = await encryptFragments(fragments);
  assert.ok(blob.length * 4 < plainSize, `expected strong compression, got ${blob.length} from ${plainSize}`);
  // And it still decodes to exactly the input.
  assert.equal(decryptBundle(blob), fragments.join(''));
});

test('a snapshot that cannot produce creds.json leaves the previous backup intact', async () => {
  // A backup that cannot complete must leave the good one untouched — it is
  // the only recovery path, and it is needed exactly when things went wrong.
  reset();
  writeSession({ registrationId: 1 }, { 'session-a': { k: 1 } });
  assert.equal(await snapshotLocal(), 2);
  const good = readFileSync(BUNDLE);

  // Live session loses creds.json (the state a wipe or a torn write leaves).
  rmSync(path.join(AUTH_DIR, 'creds.json'), { force: true });
  await assert.rejects(() => snapshotLocal(), /creds\.json/);

  assert.ok(readFileSync(BUNDLE).equals(good), 'النسخة القديمة يجب أن تبقى كما هي بلا تعديل');
  assert.ok(!existsSync(`${BUNDLE}.tmp`), 'لا يُترك ملف مؤقت خلفه');
});

test('a snapshot whose creds.json does not parse also leaves the previous backup intact', async () => {
  reset();
  writeSession({ registrationId: 1 });
  await snapshotLocal();
  const good = readFileSync(BUNDLE);

  writeFileSync(path.join(AUTH_DIR, 'creds.json'), '{"torn', 'utf-8');
  await assert.rejects(() => snapshotLocal(), /creds\.json/);
  assert.ok(readFileSync(BUNDLE).equals(good));
});

test('restore removes live keys the backup does not contain, instead of merging', async () => {
  // Copying the backup *over* the live folder kept every key the backup didn't
  // have, producing a hybrid identity that no snapshot ever produced: it can
  // authenticate and then fail to decrypt.
  reset();
  writeSession({ registrationId: 7 }, { 'session-old': { k: 1 } });
  assert.equal(await snapshotLocal(), 2);

  // A key appears in the live session AFTER the snapshot, then creds are lost.
  writeFileSync(path.join(AUTH_DIR, 'session-new.json'), JSON.stringify({ k: 2 }), 'utf-8');
  writeFileSync(path.join(AUTH_DIR, 'creds.json'), '{"trunc', 'utf-8');

  const result = await restoreFromLocal();
  assert.equal(result.ok, true);

  const live = readdirSync(AUTH_DIR).filter((n) => n.endsWith('.json')).sort();
  assert.deepEqual(live, ['creds.json', 'session-old.json'], 'المفتاح الأحدث من النسخة يجب أن يُزال');
});

test('a corrupt session is recovered from the local snapshot', async () => {
  reset();
  writeSession({ registrationId: 4242 }, { 'session-device-1': { k: 1 } });
  assert.equal(await snapshotLocal(), 2);

  // Exactly the failure this exists for: a truncated creds.json, which Baileys
  // would otherwise silently replace with a brand-new identity.
  writeFileSync(path.join(AUTH_DIR, 'creds.json'), '{"registrationId":4', 'utf-8');

  assert.deepEqual(await restoreFromLocal(), { ok: true, files: 2 });
  assert.equal(JSON.parse(readFileSync(path.join(AUTH_DIR, 'creds.json'), 'utf-8')).registrationId, 4242);
  assert.equal(JSON.parse(readFileSync(path.join(AUTH_DIR, 'session-device-1.json'), 'utf-8')).k, 1);
});

test('restore refuses an unreadable snapshot rather than replacing a damaged session with a broken one', async () => {
  reset();
  writeSession({ registrationId: 7 });
  await snapshotLocal();
  writeFileSync(BUNDLE, 'not a bundle');

  const live = readFileSync(path.join(AUTH_DIR, 'creds.json'), 'utf-8');
  assert.deepEqual(await restoreFromLocal(), { ok: false, reason: 'no_backup' });
  assert.equal(readFileSync(path.join(AUTH_DIR, 'creds.json'), 'utf-8'), live, 'live session must be untouched');
});

test('restore reports no_backup when none was ever taken', async () => {
  reset();
  writeSession({ registrationId: 1 });
  assert.deepEqual(await restoreFromLocal(), { ok: false, reason: 'no_backup' });
});

test('a new snapshot drops keys that were deleted from the live session', async () => {
  reset();
  writeSession({ registrationId: 1 }, { 'session-gone-later': { k: 1 } });
  await snapshotLocal();
  assert.ok(backupFiles().includes('session-gone-later.json'));

  rmSync(path.join(AUTH_DIR, 'session-gone-later.json'));
  await snapshotLocal();
  assert.ok(!backupFiles().includes('session-gone-later.json'));
});

test('snapshotting leaves no temp file for a later restore to trip over', async () => {
  reset();
  writeSession({ registrationId: 1 }, { 'session-a': { k: 1 } });
  await snapshotLocal();
  assert.deepEqual(
    readdirSync(process.env.DATA_DIR!).filter((f) => f.endsWith('.tmp')),
    [],
  );
});

// The upgrade path: the copy already sitting on the phone is in the old
// per-file directory format. It must still restore until the first new
// snapshot replaces it — and must then be removed, or a later failed bundle
// read would fall back to it.
test('a backup in the old per-file directory format still restores, and the next snapshot retires it', async () => {
  reset();
  mkdirSync(LEGACY_DIR, { recursive: true });
  writeFileSync(path.join(LEGACY_DIR, 'creds.json'), JSON.stringify({ registrationId: 99 }), 'utf-8');
  writeFileSync(path.join(LEGACY_DIR, 'session-x.json'), JSON.stringify({ k: 3 }), 'utf-8');
  writeFileSync(path.join(AUTH_DIR, 'creds.json'), '{"torn', 'utf-8');

  assert.deepEqual(await restoreFromLocal(), { ok: true, files: 2 });
  assert.equal(JSON.parse(readFileSync(path.join(AUTH_DIR, 'creds.json'), 'utf-8')).registrationId, 99);

  await snapshotLocal();
  assert.ok(!existsSync(LEGACY_DIR), 'the old-format copy is retired once a bundle exists');
  assert.ok(existsSync(BUNDLE));
});

// The defect this rewrite exists for: the old snapshot copied every session
// file with synchronous open/write/fsync/rename calls — 21.7 s of the event
// loop frozen for a 7500-file session, measured. Nothing else in the process
// (HTTP, the WhatsApp keep-alive) could run in that time. 3000 files would
// have frozen it for ~8 s; a responsive snapshot never lets a 100 ms tick wait
// more than a fraction of a second.
test('a snapshot of a large session never freezes the event loop', async () => {
  reset();
  writeSession({ registrationId: 1 });
  const body = JSON.stringify({ k: 'x'.repeat(6000) });
  for (let i = 0; i < 3000; i++) writeFileSync(path.join(AUTH_DIR, `pre-key-${i}.json`), body, 'utf-8');

  let last = Date.now();
  let worstGapMs = 0;
  const heartbeat = setInterval(() => {
    const now = Date.now();
    worstGapMs = Math.max(worstGapMs, now - last);
    last = now;
  }, 100);
  try {
    assert.equal(await snapshotLocal(), 3001);
  } finally {
    clearInterval(heartbeat);
  }
  assert.ok(worstGapMs < 1000, `event loop blocked for ${worstGapMs} ms`);
});

// A real logout revokes the identity on WhatsApp's own servers, so the local
// backup is just as dead as the live session — restoring it must stop being
// possible, or prepareSession() would quietly bring the revoked session back.
test('quarantining a session moves both the live folder and its backup aside, not deleted', async () => {
  reset();
  writeSession({ registrationId: 1 }, { 'session-a': { k: 1 } });
  await snapshotLocal();
  assert.ok(existsSync(AUTH_DIR));
  assert.ok(existsSync(BUNDLE));

  quarantineLocal('test-suffix');

  assert.ok(!existsSync(AUTH_DIR), 'live folder must no longer be at its expected path');
  assert.ok(!existsSync(BUNDLE), 'backup must no longer be at its expected path');
  assert.ok(existsSync(`${AUTH_DIR}.test-suffix`), 'live folder must survive, renamed aside');
  assert.ok(existsSync(`${BUNDLE}.test-suffix`), 'backup must survive, renamed aside');
  assert.equal(
    JSON.parse(readFileSync(path.join(`${AUTH_DIR}.test-suffix`, 'creds.json'), 'utf-8')).registrationId,
    1,
    'the quarantined copy must be the real content, not an empty folder',
  );
});

test('after quarantining, a restore correctly reports no_backup instead of reviving the dead identity', async () => {
  reset();
  writeSession({ registrationId: 1 }, { 'session-a': { k: 1 } });
  await snapshotLocal();

  quarantineLocal('test-suffix-2');

  assert.deepEqual(await restoreFromLocal(), { ok: false, reason: 'no_backup' });
});

test('quarantining when there is nothing to quarantine yet does not throw', () => {
  reset();
  assert.doesNotThrow(() => quarantineLocal('test-suffix-3'));
});

// clearStaleAuthFiles is the guard restoreFromLocal AND restoreSessionFromR2
// both now share — restoreSessionFromR2 needs real R2 to exercise end to end,
// but the guard itself is a pure filesystem operation and is tested directly.
test('clearStaleAuthFiles removes any live key not in the given set, leaving the rest untouched', () => {
  reset();
  writeSession({ registrationId: 1 }, { 'session-old': { k: 1 }, 'session-keep': { k: 2 } });

  clearStaleAuthFiles(new Set(['creds.json', 'session-keep.json']));

  const live = readdirSync(AUTH_DIR).filter((n) => n.endsWith('.json')).sort();
  assert.deepEqual(live, ['creds.json', 'session-keep.json']);
});

test('clearStaleAuthFiles does nothing, and does not throw, when the live folder does not exist yet', () => {
  rmSync(AUTH_DIR, { recursive: true, force: true });
  assert.doesNotThrow(() => clearStaleAuthFiles(new Set(['creds.json'])));
});

// The restart race this pins: quarantineDeadSession used to rename the local
// session aside FIRST (fast, near-instant) and only then quarantine R2
// (slow, network round-trips) — so a process restart in between left R2's
// well-known key still live while the local copy was already gone, and
// restoreSessionFromR2 would resurrect the very identity WhatsApp just
// revoked. R2 must now be quarantined first.
test('quarantineDeadSession quarantines R2 BEFORE the local rename', async () => {
  const calls: string[] = [];
  await quarantineDeadSession(
    { info: () => {}, error: () => {} },
    {
      quarantineR2: async () => {
        calls.push('r2');
      },
      quarantineLocal: () => {
        calls.push('local');
      },
    },
  );
  assert.deepEqual(calls, ['r2', 'local'], 'R2 must finish before the fast local rename removes the last local trace');
});

test('a failing R2 quarantine does not stop the local quarantine from still happening', async () => {
  const calls: string[] = [];
  await quarantineDeadSession(
    { info: () => {}, error: () => {} },
    {
      quarantineR2: async () => {
        throw new Error('network down');
      },
      quarantineLocal: () => {
        calls.push('local');
      },
    },
  );
  assert.deepEqual(calls, ['local'], 'a dead identity must still be quarantined locally even if R2 could not be reached');
});
