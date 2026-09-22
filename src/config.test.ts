// Every project listed in config/projects.json loads eagerly at import time
// (see loadProjects()), and one missing its PROJECT_API_KEY_<ID> env var
// throws and takes the WHOLE service down with it — not just that project.
// This pins that every currently-registered project actually loads.
//
// SEND_MAX_PER_HOUR is set to an explicit empty string BEFORE config.ts is
// imported: `Number(process.env.X ?? fallback)` only falls back when X is
// UNSET, and an empty string left in .env (`X=`) is not undefined — it used
// to silently zero the ceiling instead of using its documented default.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SEND_MAX_PER_HOUR = '';
// Fallbacks (not overriding a real .env) so this runs on a fresh checkout
// with no .env yet too — config.ts requires all of these at import time.
process.env.PROJECT_API_KEY_STORE ??= 'test-store-key';
process.env.PROJECT_API_KEY_QAREEB ??= 'test-qareeb-key';
process.env.PROJECT_API_KEY_FIREWORKS ??= 'test-fireworks-key';
process.env.OTP_HASH_SECRET ??= 'test-otp-hash-secret';
process.env.SESSION_BACKUP_ENCRYPTION_KEY ??= 'test-passphrase-for-backup-roundtrip';

const { getProjectById, config } = await import('./config.ts');

test('a blank (empty-string) numeric env var falls back to its documented default, not 0', () => {
  assert.equal(config.sendRate.maxPerHour, 120, 'an empty SEND_MAX_PER_HOUR must not silently zero the send-rate ceiling');
});

test('every project registered in config/projects.json loads with a real API key', () => {
  for (const id of ['store', 'qareeb', 'fireworks']) {
    const project = getProjectById(id);
    assert.ok(project, `project "${id}" did not load`);
    assert.ok(project!.apiKey.length > 0, `project "${id}" has no API key`);
  }
});

test('the fireworks-store project is reachable by id and carries its own brand name', () => {
  const project = getProjectById('fireworks');
  assert.ok(project);
  assert.equal(project!.brandName, 'متجر الألعاب النارية');
});

test('an unregistered project id is not silently found', () => {
  assert.equal(getProjectById('not-a-real-project'), undefined);
});
