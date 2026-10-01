// What db.ts does to an existing database when the service boots: the file a
// phone running an older version leaves behind, opened by this one.
//
// - Verification codes that older versions left in finished messages are
//   removed (plan 4.3: a copy of this file must not hand out codes; plan 10:
//   no code is kept once used or expired). Pending messages keep theirs — the
//   worker still has to render them. A payload that is not JSON does not stop
//   the boot. Only verification messages are touched.
// - The trigger that forgets a code when its message finishes is replaced,
//   not kept: CREATE TRIGGER IF NOT EXISTS never updated a definition that an
//   earlier version had already created.
//
// The old database is written with node:sqlite directly, before db.ts is
// imported: db.ts does all of this at import time, once per process.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sms-api-db-boot-'));
process.env.PROJECT_API_KEY_STORE ??= 'test-store-key';
process.env.PROJECT_API_KEY_QAREEB ??= 'test-qareeb-key';
process.env.PROJECT_API_KEY_FIREWORKS ??= 'test-fireworks-key';
process.env.OTP_HASH_SECRET ??= 'test-otp-hash-secret';
process.env.SESSION_BACKUP_ENCRYPTION_KEY ??= 'test-passphrase-for-backup-roundtrip';

const DB_FILE = path.join(process.env.DATA_DIR, 'sms-api.db');
const TRIGGER = 'messages_forget_code_when_done';

// ---- the database as an older version left it ------------------------------

const ids: Record<string, number> = {};
{
  const old = new DatabaseSync(DB_FILE);
  old.exec('PRAGMA journal_mode = WAL');
  old.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL,
      channel TEXT CHECK (channel IN ('whatsapp', 'sms')), channel_forced INTEGER NOT NULL DEFAULT 0,
      event TEXT NOT NULL, recipient TEXT NOT NULL, payload TEXT NOT NULL, template_variant INTEGER,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- An earlier definition under the same name: it does nothing at all.
    CREATE TRIGGER ${TRIGGER} AFTER UPDATE OF status ON messages WHEN 0 BEGIN SELECT 1; END;
  `);
  const insert = old.prepare(`INSERT INTO messages (project, event, recipient, payload, status) VALUES ('store', ?, '963900000700', ?, ?)`);
  const add = (name: string, event: string, payload: string, status: string) => {
    ids[name] = Number(insert.run(event, payload, status).lastInsertRowid);
  };
  add('sentLogin', 'otp', '{"code":"731904"}', 'sent');
  add('failedReset', 'password_reset', '{"code":"582046"}', 'failed');
  add('waiting', 'otp', '{"code":"649183"}', 'pending');
  add('notJson', 'otp', 'not json {"code":"915372"', 'failed');
  add('order', 'order_created', '{"order":"7","amount":"5","code":"DISCOUNT10"}', 'sent');
  old.close();
}

const { db } = await import('./db.ts');

const payloadOf = (id: number) => (db.prepare('SELECT payload FROM messages WHERE id = ?').get(id) as { payload: string }).payload;

test('the boot removes the codes finished verification messages still hold, and leaves everything else as it was', () => {
  assert.equal(payloadOf(ids.sentLogin), '{}');
  assert.equal(payloadOf(ids.failedReset), '{}');
  assert.equal(payloadOf(ids.waiting), '{"code":"649183"}', 'still to be sent — the worker renders it from here');
  assert.equal(payloadOf(ids.notJson), 'not json {"code":"915372"', 'not JSON: passed over, and the boot went on');
  assert.deepEqual(JSON.parse(payloadOf(ids.order)), { order: '7', amount: '5', code: 'DISCOUNT10' }, 'not a verification message');
});

test('an older definition of the trigger is replaced by the current one', () => {
  const { sql } = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`).get(TRIGGER) as { sql: string };
  assert.doesNotMatch(sql, /WHEN 0/, 'the old definition is still in place');

  db.prepare(`UPDATE messages SET status = 'sent' WHERE id = ?`).run(ids.waiting);
  assert.equal(payloadOf(ids.waiting), '{}', 'the trigger in place forgets a code once its message is done');
});

// /notify stores a site's payload as it came, and a "code" field there is the
// site's own data, not a verification code of this service: it is kept like
// the rest of the message log.
test('a finished message that is not a verification keeps its payload, a "code" field included', () => {
  const id = Number(
    db
      .prepare(`INSERT INTO messages (project, event, recipient, payload) VALUES ('store', 'delivered', '963900000701', '{"order":"8","code":"PICKUP-42"}')`)
      .run().lastInsertRowid,
  );
  db.prepare(`UPDATE messages SET status = 'sent' WHERE id = ?`).run(id);
  assert.deepEqual(JSON.parse(payloadOf(id)), { order: '8', code: 'PICKUP-42' });
});
