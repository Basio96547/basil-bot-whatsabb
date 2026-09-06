// The aggregate ceiling. Per-number caps bound one recipient; nothing bounded
// what the sending account emits in total, and total volume is the dimension
// that gets a number restricted.
//
// DATA_DIR is redirected before db.ts is imported so this runs against a
// throwaway SQLite file, never the live queue.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sms-api-rate-'));
process.env.SEND_MAX_PER_HOUR = '10';
process.env.SEND_WARMUP_HOURS = '24';
process.env.SEND_WARMUP_MAX_PER_HOUR = '3';

const { checkSendRate, sentLastHour, rememberPairing } = await import('./sendRate.ts');
const { db } = await import('../db.ts');

function clear(): void {
  db.exec('DELETE FROM messages; DELETE FROM session_state;');
}

/** Records `n` messages as sent, `minutesAgo` in the past. */
function recordSent(n: number, minutesAgo = 0): void {
  const stmt = db.prepare(
    `INSERT INTO messages (project, event, recipient, payload, status, updated_at)
     VALUES ('store', 'otp', '963900000000', '{}', 'sent', datetime('now', ?))`,
  );
  for (let i = 0; i < n; i++) stmt.run(`-${minutesAgo} minutes`);
}

test('an empty queue is well under the ceiling', () => {
  clear();
  const verdict = checkSendRate(null);
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.used, 0);
  assert.equal(verdict.limit, 10);
});

test('the ceiling blocks once the hour is used up', () => {
  clear();
  recordSent(9);
  assert.equal(checkSendRate(null).allowed, true, 'تحت السقف');
  recordSent(1);
  assert.equal(checkSendRate(null).allowed, false, 'عند السقف يتوقف');
});

test('sends older than an hour no longer count', () => {
  clear();
  recordSent(20, 90); // 90 minutes ago
  assert.equal(sentLastHour(), 0);
  assert.equal(checkSendRate(null).allowed, true);
});

test('a freshly paired number runs at the warm-up ceiling', () => {
  clear();
  const pairedAtMs = Date.now() - 60_000; // paired a minute ago
  const verdict = checkSendRate(pairedAtMs);
  assert.equal(verdict.warmingUp, true);
  assert.equal(verdict.limit, 3, 'سقف التسخين أدنى من العادي');

  recordSent(3);
  assert.equal(checkSendRate(pairedAtMs).allowed, false, 'يتوقف عند سقف التسخين');
  // …while a long-established number would still be allowed at the same volume.
  assert.equal(checkSendRate(Date.now() - 48 * 60 * 60_000).allowed, true);
});

test('the warm-up expires once its window has passed', () => {
  clear();
  const verdict = checkSendRate(Date.now() - 48 * 60 * 60_000); // paired 2 days ago
  assert.equal(verdict.warmingUp, false);
  assert.equal(verdict.limit, 10);
});

test('the pairing clock survives a restart instead of restarting the warm-up', () => {
  clear();
  const first = rememberPairing('963958436703:3@s.whatsapp.net');
  // A reconnect, or a pm2 restart, calls this again for the same identity.
  const second = rememberPairing('963958436703:3@s.whatsapp.net');
  assert.equal(first, second, 'نفس الهوية تحافظ على وقت الربط الأصلي');
});

test('a different identity starts its own warm-up clock', () => {
  clear();
  rememberPairing('963958436703:3@s.whatsapp.net');
  const other = rememberPairing('966561325968:3@s.whatsapp.net');
  assert.ok(other > 0);
  const rows = (db.prepare('SELECT COUNT(*) AS n FROM session_state').get() as { n: number }).n;
  assert.equal(rows, 2, 'كل هوية سجلها الخاص');
});
