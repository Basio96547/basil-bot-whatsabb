// The failure this pins: a creds.json that is merely UNREADABLE right now
// (EMFILE from the ~7500-file key folder, a permissions hiccup, the OS busy)
// is not the same as a missing session — prepareSession() already knew this
// and correctly skipped restoring a stale backup over it. But
// connectWhatsApp() used to load an auth state right afterward regardless,
// and useAtomicMultiFileAuthState's own creds read swallows every error
// (including this exact transient one) into a blank identity — which the
// very next creds.update then saves over the real session. connectWhatsApp
// must now abort the whole attempt instead, before ever touching Baileys.
//
// DATA_DIR is redirected before config.ts (and everything importing it) is
// loaded so this runs against a throwaway auth folder, never the real one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sms-api-client-'));

const { prepareSession, connectWhatsApp, getConnectionState } = await import('./client.ts');

const AUTH_DIR = path.join(process.env.DATA_DIR, 'auth-session');

test('prepareSession reports "missing" when there is no session and nothing to restore from', async () => {
  assert.equal(await prepareSession(), 'missing');
});

test('prepareSession reports "unreadable" for a creds.json that exists but cannot be read right now, and does not treat it as missing', async () => {
  // A directory in place of the file is a portable, deterministic way to hit
  // a read error that is NOT ENOENT (EISDIR here) — the same "exists but is
  // momentarily unreadable" shape as the real-world EMFILE this guards
  // against, without depending on a platform-specific permission trick.
  mkdirSync(path.join(AUTH_DIR, 'creds.json'), { recursive: true });

  const probe = await prepareSession();
  assert.equal(probe, 'unreadable');
  assert.ok(getConnectionState().sessionNote?.includes('تعذّر قراءة'), 'السبب يجب أن يُسجَّل بوضوح');
});

test('connectWhatsApp aborts BEFORE loading or generating an auth state when creds.json is merely unreadable', async () => {
  // Still the directory-in-place-of-a-file from the previous test. If this
  // guard were missing, connectWhatsApp would proceed to
  // useAtomicMultiFileAuthState, hit the same EISDIR independently, and fall
  // back to a blank identity instead of throwing here.
  await assert.rejects(() => connectWhatsApp(), /تعذّرت قراءته مؤقتاً/);
});
