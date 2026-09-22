// WhatsApp's own account-enforcement notice — parsed, remembered, and obeyed.
//
// On 2026-09-03 at 02:52 the sibling bot's number received this, moments
// before its linked device was revoked:
//
//   {"data":{"xwa2_notify_account_reachout_timelock":{
//      "enforcement_type":"RESTRICT_ALL_COMPANIONS",
//      "is_active":true,
//      "time_enforcement_ends":"1788414761"}}}
//
// WhatsApp said plainly what it was doing and for how long. Nothing in either
// codebase looked at it: the service saw only `device_removed`, reported
// "needs a QR scan", and would happily have let a human re-pair immediately —
// during an active restriction, which is the one action most likely to extend
// it. The window was worked out by hand, from a log line, hours later.
//
// This module closes that loop: recognise the notice, persist the window, and
// refuse to send or to treat the session as re-pairable until it has passed.

import { db } from '../db.ts';

/** What WhatsApp reported, in the shape the notification carries. */
export interface Enforcement {
  type: string;
  endsAtMs: number;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS account_enforcement (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    type       TEXT NOT NULL,
    ends_at    TEXT NOT NULL,
    noticed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const upsert = db.prepare(`
  INSERT INTO account_enforcement (id, type, ends_at, noticed_at)
  VALUES (1, ?, ?, datetime('now'))
  ON CONFLICT(id) DO UPDATE SET type = excluded.type, ends_at = excluded.ends_at, noticed_at = excluded.noticed_at
`);
const selectCurrent = db.prepare(`SELECT type, ends_at FROM account_enforcement WHERE id = 1`);
const clearRow = db.prepare(`DELETE FROM account_enforcement WHERE id = 1`);

/**
 * Pulls an enforcement out of a raw Baileys notification node, if it carries
 * one. Returns null for the overwhelming majority of nodes, which are ordinary
 * traffic.
 *
 * Deliberately tolerant about shape: this is an undocumented internal payload
 * that arrives as a Buffer of JSON nested in a protocol node, and a parser
 * that throws on an unfamiliar variant would be worse than one that shrugs.
 */
export function parseEnforcement(node: unknown): Enforcement | null {
  const json = findTimelockJson(node);
  if (!json) return null;

  const lock = json?.data?.xwa2_notify_account_reachout_timelock;
  if (!lock || lock.is_active !== true) return null;

  const endsSeconds = Number(lock.time_enforcement_ends);
  if (!Number.isFinite(endsSeconds) || endsSeconds <= 0) return null;

  return {
    type: typeof lock.enforcement_type === 'string' ? lock.enforcement_type : 'UNKNOWN',
    endsAtMs: endsSeconds * 1000,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Walks the node looking for the timelock payload, wherever it is nested. */
function findTimelockJson(node: unknown): any | null {
  if (node == null) return null;

  // The payload arrives as a Buffer (or a {type:'Buffer',data:[...]} shape once
  // it has been through JSON) holding the JSON document.
  const asText = bufferToText(node);
  if (asText && asText.includes('xwa2_notify_account_reachout_timelock')) {
    try {
      return JSON.parse(asText);
    } catch {
      return null;
    }
  }

  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findTimelockJson(child);
      if (found) return found;
    }
    return null;
  }

  if (typeof node === 'object') {
    for (const value of Object.values(node as Record<string, unknown>)) {
      const found = findTimelockJson(value);
      if (found) return found;
    }
  }
  return null;
}

function bufferToText(node: unknown): string | null {
  if (typeof node === 'string') return node;
  if (node instanceof Uint8Array) return Buffer.from(node).toString('utf-8');
  const maybe = node as { type?: string; data?: unknown };
  if (maybe?.type === 'Buffer' && Array.isArray(maybe.data)) {
    return Buffer.from(maybe.data as number[]).toString('utf-8');
  }
  return null;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function recordEnforcement(enforcement: Enforcement): void {
  upsert.run(enforcement.type, new Date(enforcement.endsAtMs).toISOString().slice(0, 19).replace('T', ' '));
}

/** The active enforcement, or null once its window has passed. */
export function activeEnforcement(): Enforcement | null {
  const row = selectCurrent.get() as { type: string; ends_at: string } | undefined;
  if (!row) return null;
  const endsAtMs = new Date(`${row.ends_at}Z`).getTime();
  if (endsAtMs <= Date.now()) {
    clearRow.run(); // expired — stop reporting it
    return null;
  }
  return { type: row.type, endsAtMs };
}
