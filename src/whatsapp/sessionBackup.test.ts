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

const { snapshotLocal, restoreFromLocal } = await import('./sessionBackup.ts');

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
