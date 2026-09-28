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
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

test('a numeric env var that parses but makes no sense is refused, not silently used', async () => {
  const { numberEnv } = await import('./config.ts');
  const set = (value: string) => {
    process.env.TEST_NUMBER_ENV = value;
  };
  try {
    set('0');
    assert.throws(() => numberEnv('TEST_NUMBER_ENV', 20, { min: 1, integer: true }), />= 1/);
    set('-1');
    assert.throws(() => numberEnv('TEST_NUMBER_ENV', 20, { min: 1, integer: true }), />= 1/);
    set('2.5');
    assert.throws(() => numberEnv('TEST_NUMBER_ENV', 20, { min: 1, integer: true }), /whole number/);
    set('70000');
    assert.throws(() => numberEnv('TEST_NUMBER_ENV', 3000, { min: 1, max: 65535 }), /<= 65535/);
    set('abc');
    assert.throws(() => numberEnv('TEST_NUMBER_ENV', 20), /must be a number/);
    set('25');
    assert.equal(numberEnv('TEST_NUMBER_ENV', 20, { min: 1, integer: true }), 25);
  } finally {
    delete process.env.TEST_NUMBER_ENV;
  }
});

test('the service listens on loopback unless HOST says otherwise', () => {
  assert.equal(config.host, process.env.HOST || '127.0.0.1');
});

// config.ts runs once per process, so a boot with a bad .env is checked the
// way scripts/preflight.sh checks it: in a child process of its own.
function bootConfig(env: Record<string, string>): { ok: boolean; stderr: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', "await import('./src/config.ts')"], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    env: {
      ...process.env,
      PROJECT_API_KEY_STORE: 'k-store-0123456789',
      PROJECT_API_KEY_QAREEB: 'k-qareeb-0123456789',
      PROJECT_API_KEY_FIREWORKS: 'k-fireworks-0123456789',
      OTP_HASH_SECRET: 'test-otp-hash-secret',
      SESSION_BACKUP_ENCRYPTION_KEY: 'test-passphrase',
      SEND_MAX_PER_HOUR: '',
      ...env,
    },
    encoding: 'utf-8',
  });
  return { ok: result.status === 0, stderr: result.stderr };
}

test('a project API key still set to the public .env.example placeholder stops the boot', () => {
  const boot = bootConfig({ PROJECT_API_KEY_FIREWORKS: 'change-me-fireworks-key' });
  assert.equal(boot.ok, false);
  assert.match(boot.stderr, /PROJECT_API_KEY_FIREWORKS is still the placeholder/);
});

test('a send delay range that is upside down stops the boot', () => {
  const boot = bootConfig({ SEND_MIN_DELAY_MS: '9000', SEND_MAX_DELAY_MS: '3000' });
  assert.equal(boot.ok, false);
  assert.match(boot.stderr, /SEND_MAX_DELAY_MS/);
});

test('the same environment with real values boots', () => {
  const boot = bootConfig({});
  assert.equal(boot.ok, true, boot.stderr);
});
