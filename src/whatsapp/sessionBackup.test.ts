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

const { snapshotLocal, restoreFromLocal, encryptBundle, decryptBundle, encryptFragments } =
  await import('./sessionBackup.ts');
const crypto = await import('node:crypto');
const zlib = await import('node:zlib');

const AUTH_DIR = path.join(process.env.DATA_DIR, 'auth-session');
const BACKUP_DIR = `${AUTH_DIR}-backup`;

function reset(): void {
  rmSync(AUTH_DIR, { recursive: true, force: true });
  rmSync(BACKUP_DIR, { recursive: true, force: true });
  mkdirSync(AUTH_DIR, { recursive: true });
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

test('a snapshot that cannot produce creds.json leaves the previous backup intact', () => {
  // The old order deleted the backup first and copied afterwards, so anything
  // that interrupted the copy destroyed the only recovery path — at exactly
  // the moment it was needed. The backup is now built aside and swapped in, so
  // a snapshot that cannot complete must leave the good one untouched.
  reset();
  writeSession({ registrationId: 1 }, { 'session-a': { k: 1 } });
  assert.equal(snapshotLocal(), 2);
  const goodCreds = readFileSync(path.join(BACKUP_DIR, 'creds.json'), 'utf-8');

  // Live session loses creds.json (the state a wipe or a torn write leaves).
  rmSync(path.join(AUTH_DIR, 'creds.json'), { force: true });
  assert.throws(() => snapshotLocal(), /creds\.json/);

  assert.ok(existsSync(BACKUP_DIR), 'النسخة القديمة يجب أن تبقى');
  assert.equal(
    readFileSync(path.join(BACKUP_DIR, 'creds.json'), 'utf-8'),
    goodCreds,
    'النسخة القديمة يجب أن تبقى كما هي بلا تعديل',
  );
  assert.ok(!existsSync(`${BACKUP_DIR}.new`), 'لا يُترك مجلد مؤقت خلفه');
});

test('restore removes live keys the backup does not contain, instead of merging', () => {
  // Copying the backup *over* the live folder kept every key the backup didn't
  // have, producing a hybrid identity that no snapshot ever produced: it can
  // authenticate and then fail to decrypt.
  reset();
  writeSession({ registrationId: 7 }, { 'session-old': { k: 1 } });
  assert.equal(snapshotLocal(), 2);

  // A key appears in the live session AFTER the snapshot, then creds are lost.
  writeFileSync(path.join(AUTH_DIR, 'session-new.json'), JSON.stringify({ k: 2 }), 'utf-8');
  writeFileSync(path.join(AUTH_DIR, 'creds.json'), '{"trunc', 'utf-8');

  const result = restoreFromLocal();
  assert.equal(result.ok, true);

  const live = readdirSync(AUTH_DIR).filter((n) => n.endsWith('.json')).sort();
  assert.deepEqual(live, ['creds.json', 'session-old.json'], 'المفتاح الأحدث من النسخة يجب أن يُزال');
});

test('a corrupt session is recovered from the local snapshot', () => {
  reset();
  writeSession({ registrationId: 4242 }, { 'session-device-1': { k: 1 } });
  assert.equal(snapshotLocal(), 2);

  // Exactly the failure this exists for: a truncated creds.json, which Baileys
  // would otherwise silently replace with a brand-new identity.
  writeFileSync(path.join(AUTH_DIR, 'creds.json'), '{"registrationId":4', 'utf-8');

  assert.deepEqual(restoreFromLocal(), { ok: true, files: 2 });
  assert.equal(JSON.parse(readFileSync(path.join(AUTH_DIR, 'creds.json'), 'utf-8')).registrationId, 4242);
});

test('restore refuses an unreadable snapshot rather than replacing a damaged session with a broken one', () => {
  reset();
  writeSession({ registrationId: 7 });
  snapshotLocal();
  writeFileSync(path.join(BACKUP_DIR, 'creds.json'), 'not json', 'utf-8');

  const live = readFileSync(path.join(AUTH_DIR, 'creds.json'), 'utf-8');
  assert.deepEqual(restoreFromLocal(), { ok: false, reason: 'no_backup' });
  assert.equal(readFileSync(path.join(AUTH_DIR, 'creds.json'), 'utf-8'), live, 'live session must be untouched');
});

test('restore reports no_backup when none was ever taken', () => {
  reset();
  writeSession({ registrationId: 1 });
  assert.deepEqual(restoreFromLocal(), { ok: false, reason: 'no_backup' });
});

test('a new snapshot drops keys that were deleted from the live session', () => {
  reset();
  writeSession({ registrationId: 1 }, { 'session-gone-later': { k: 1 } });
  snapshotLocal();
  assert.ok(existsSync(path.join(BACKUP_DIR, 'session-gone-later.json')));

  rmSync(path.join(AUTH_DIR, 'session-gone-later.json'));
  snapshotLocal();
  assert.ok(!existsSync(path.join(BACKUP_DIR, 'session-gone-later.json')));
});

test('snapshotting leaves no temp file for a later restore to trip over', () => {
  reset();
  writeSession({ registrationId: 1 }, { 'session-a': { k: 1 } });
  snapshotLocal();
  assert.deepEqual(
    readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.tmp')),
    [],
  );
});
