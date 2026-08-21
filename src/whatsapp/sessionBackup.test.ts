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
