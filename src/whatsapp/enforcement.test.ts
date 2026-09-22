// The payload in "the real notice" below is the exact one WhatsApp sent on
// 2026-09-03 at 02:52, moments before revoking the sibling bot's linked
// device. It was worked out by hand from a log line hours after the fact; the
// point of these tests is that it never has to be again.
//
// DATA_DIR is redirected before db.ts is imported so this runs against a
// throwaway SQLite file, never the live queue.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sms-api-enf-'));

const { parseEnforcement, recordEnforcement, activeEnforcement } = await import('./enforcement.ts');
const { db } = await import('../db.ts');

function clear(): void {
  db.exec('DELETE FROM account_enforcement');
}

/** The notice exactly as it arrived: JSON in a Buffer, nested in a node. */
function realNotice(endsAtSeconds: number): unknown {
  const payload = JSON.stringify({
    data: {
      xwa2_notify_account_reachout_timelock: {
        enforcement_type: 'RESTRICT_ALL_COMPANIONS',
        is_active: true,
        time_enforcement_ends: String(endsAtSeconds),
      },
    },
  });
  return {
    tag: 'notification',
    attrs: { from: '@s.whatsapp.net', type: 'mex', id: '1303728784' },
    content: [
      {
        tag: 'update',
        attrs: { op_name: 'NotificationUserReachoutTimelockUpdate' },
        content: Buffer.from(payload, 'utf-8'),
      },
    ],
  };
}

test('the real notice is recognised, with its type and end time', () => {
  const endsAt = 1788414761;
  const found = parseEnforcement(realNotice(endsAt));
  assert.ok(found, 'يجب أن يُتعرَّف على الإشعار الحقيقي');
  assert.equal(found.type, 'RESTRICT_ALL_COMPANIONS');
  assert.equal(found.endsAtMs, endsAt * 1000);
});

test('a Buffer that survived a JSON round-trip is still recognised', () => {
  // Baileys hands some payloads through as {type:'Buffer',data:[…]}.
  const node = JSON.parse(JSON.stringify(realNotice(1788414761)));
  const found = parseEnforcement(node);
  assert.ok(found);
  assert.equal(found.type, 'RESTRICT_ALL_COMPANIONS');
});

test('an inactive timelock is not treated as a restriction', () => {
  const node = {
    content: Buffer.from(
      JSON.stringify({
        data: {
          xwa2_notify_account_reachout_timelock: {
            enforcement_type: 'RESTRICT_ALL_COMPANIONS',
            is_active: false,
            time_enforcement_ends: '1788414761',
          },
        },
      }),
      'utf-8',
    ),
  };
  assert.equal(parseEnforcement(node), null);
});

test('ordinary traffic parses to null and never throws', () => {
  for (const node of [
    null,
    undefined,
    'hello',
    42,
    {},
    [],
    { tag: 'message', content: Buffer.from('not json at all') },
    { tag: 'notification', attrs: { type: 'encrypt' }, content: [{ tag: 'count' }] },
    { deeply: { nested: [{ irrelevant: true }] } },
  ]) {
    assert.equal(parseEnforcement(node), null, `unexpected match for ${JSON.stringify(node)}`);
  }
});

test('an active restriction is reported until its window passes', () => {
  clear();
  const endsAtMs = Date.now() + 60_000;
  recordEnforcement({ type: 'RESTRICT_ALL_COMPANIONS', endsAtMs });

  const active = activeEnforcement();
  assert.ok(active, 'يجب أن يُبلَّغ عن القيد ما دام سارياً');
  assert.equal(active.type, 'RESTRICT_ALL_COMPANIONS');
});

test('an expired restriction stops being reported, and clears itself', () => {
  clear();
  recordEnforcement({ type: 'RESTRICT_ALL_COMPANIONS', endsAtMs: Date.now() - 60_000 });

  assert.equal(activeEnforcement(), null, 'القيد المنتهي لا يُبلَّغ عنه');
  const left = (db.prepare('SELECT COUNT(*) AS n FROM account_enforcement').get() as { n: number }).n;
  assert.equal(left, 0, 'ويُحذف من القاعدة');
});

test('a newer notice replaces the earlier one instead of stacking', () => {
  clear();
  const first = Date.now() + 60_000;
  const second = Date.now() + 6 * 60 * 60_000;
  recordEnforcement({ type: 'RESTRICT_ALL_COMPANIONS', endsAtMs: first });
  recordEnforcement({ type: 'RESTRICT_ALL_COMPANIONS', endsAtMs: second });

  const rows = (db.prepare('SELECT COUNT(*) AS n FROM account_enforcement').get() as { n: number }).n;
  assert.equal(rows, 1);
  const active = activeEnforcement();
  assert.ok(active);
  // Stored at second precision, so compare on that.
  assert.equal(Math.floor(active.endsAtMs / 1000), Math.floor(second / 1000));
});
