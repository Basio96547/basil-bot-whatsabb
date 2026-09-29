// addColumnIfMissing used to detect "already migrated" purely by catching and
// string-matching ALTER TABLE's error message — fragile against a future
// node:sqlite wording change, which would silently treat every genuine
// failure as "already migrated" too. PRAGMA table_info is now checked first
// and is what actually decides; these pin that it works, that it is
// idempotent, and that a real failure still throws instead of being
// swallowed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { useTestEnv } from './testEnv.ts';

useTestEnv('db');

const { columnExists, addColumnIfMissing, inTransaction, db } = await import('./db.ts');

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

// A connection still inside a transaction cannot BEGIN another one.
function assertNoOpenTransaction(): void {
  assert.doesNotThrow(() => {
    db.exec('BEGIN');
    db.exec('ROLLBACK');
  }, 'the shared connection was left inside a transaction');
}

test('a full disk inside a transaction surfaces as "database or disk is full", not as the rollback that follows it', () => {
  db.exec('CREATE TABLE IF NOT EXISTS test_filler (x BLOB)');
  const pages = (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
  db.exec(`PRAGMA max_page_count = ${pages + 2}`);
  try {
    assert.throws(
      () =>
        inTransaction(() => {
          for (let i = 0; i < 100; i++) db.prepare('INSERT INTO test_filler VALUES (randomblob(3000))').run();
          return 1;
        }),
      /database or disk is full/,
    );
  } finally {
    db.exec('PRAGMA max_page_count = 1073741823');
  }
  assertNoOpenTransaction();
});

test('a COMMIT that fails does not leave the connection stuck inside the transaction', () => {
  // A deferred foreign key is checked at COMMIT, and a COMMIT failing on it
  // keeps the transaction open — the same shape as a COMMIT on a full disk.
  db.exec(`CREATE TABLE IF NOT EXISTS test_parent (id INTEGER PRIMARY KEY);
           CREATE TABLE IF NOT EXISTS test_child (parent INTEGER REFERENCES test_parent(id) DEFERRABLE INITIALLY DEFERRED)`);
  assert.throws(
    () =>
      inTransaction(() => {
        db.prepare('INSERT INTO test_child VALUES (424242)').run();
        return 1;
      }),
    /FOREIGN KEY/,
  );
  assertNoOpenTransaction();
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM test_child').get() as { n: number }).n, 0);
});
