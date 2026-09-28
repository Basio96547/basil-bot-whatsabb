import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sms-api-storage-'));
process.env.DISK_LOW_BYTES = '1000';
process.env.PROJECT_API_KEY_STORE ??= 'test-store-key';
process.env.PROJECT_API_KEY_QAREEB ??= 'test-qareeb-key';
process.env.PROJECT_API_KEY_FIREWORKS ??= 'test-fireworks-key';
process.env.OTP_HASH_SECRET ??= 'test-otp-hash-secret';
process.env.SESSION_BACKUP_ENCRYPTION_KEY ??= 'test-passphrase-for-backup-roundtrip';

const { noteStorageFailure, noteStorageSuccess, storageStatus, freeDiskBytes } = await import('./storageHealth.ts');

const PLENTY = 10_000;

test('an unrelated error is not a storage failure', () => {
  noteStorageFailure(new Error('invalid_json_body'));
  noteStorageFailure(new Error('database is locked'));
  assert.equal(storageStatus(Date.now(), PLENTY).failing, false);
});

test('"database or disk is full" marks storage failing, and it lapses after 15 minutes without another', () => {
  noteStorageFailure(new Error('database or disk is full'));
  const now = Date.now();
  assert.equal(storageStatus(now, PLENTY).failing, true);
  assert.equal(storageStatus(now + 14 * 60_000, PLENTY).failing, true);
  assert.equal(storageStatus(now + 16 * 60_000, PLENTY).failing, false);
});

test('a successful write clears it at once', () => {
  noteStorageFailure(new Error('disk I/O error'));
  assert.equal(storageStatus(Date.now(), PLENTY).failing, true);
  noteStorageSuccess();
  assert.equal(storageStatus(Date.now(), PLENTY).failing, false);
});

test('disk_low trips under the threshold and does not flap back until well above it', () => {
  assert.equal(storageStatus(Date.now(), 999).low, true);
  assert.equal(storageStatus(Date.now(), 1100).low, true, 'just over the threshold is not enough to clear it');
  assert.equal(storageStatus(Date.now(), 1300).low, false);
  assert.equal(storageStatus(Date.now(), 1100).low, false, 'nor to set it again from the other side');
});

test('free space is read from the real filesystem', () => {
  const free = freeDiskBytes();
  assert.equal(typeof free, 'number');
  assert.ok(free! > 0);
});
