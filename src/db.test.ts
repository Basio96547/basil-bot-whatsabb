// addColumnIfMissing used to detect "already migrated" purely by catching and
// string-matching ALTER TABLE's error message — fragile against a future
// node:sqlite wording change, which would silently treat every genuine
// failure as "already migrated" too. PRAGMA table_info is now checked first
// and is what actually decides; these pin that it works, that it is
// idempotent, and that a real failure still throws instead of being
// swallowed.
//
// DATA_DIR is redirected before db.ts is imported so this runs against a
// throwaway SQLite file, never the live queue.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sms-api-db-'));

const { columnExists, addColumnIfMissing } = await import('./db.ts');

test('columnExists reports true for a column db.ts already migrated in, false for one that was never added', () => {
  assert.equal(columnExists('otp_codes', 'purpose'), true);
  assert.equal(columnExists('messages', 'expires_at'), true);
  assert.equal(columnExists('otp_codes', 'this_column_was_never_added'), false);
});

test('addColumnIfMissing is a genuine no-op the second time, decided by schema introspection rather than by triggering (and string-matching) a duplicate-column error', () => {
  assert.doesNotThrow(() => addColumnIfMissing('otp_codes', 'purpose', `TEXT NOT NULL DEFAULT 'login'`));
  assert.equal(columnExists('otp_codes', 'purpose'), true, 'still there, unharmed by the repeat call');
});

test('a brand-new column is still added for real', () => {
  const name = 'test_migration_marker';
  assert.equal(columnExists('otp_codes', name), false);
  addColumnIfMissing('otp_codes', name, 'TEXT');
  assert.equal(columnExists('otp_codes', name), true);
});

test('a genuine ALTER TABLE failure still throws instead of being silently swallowed as "already migrated"', () => {
  // Not a "duplicate column name" error — the table itself does not exist —
  // so this must propagate, exactly like before this change.
  assert.throws(() => addColumnIfMissing('no_such_table_at_all', 'col', 'TEXT'));
});
