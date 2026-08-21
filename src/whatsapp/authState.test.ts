// This module replaced Baileys' own auth-state storage, so it is the one place
// in this service where a bug quietly destroys the WhatsApp link instead of
// throwing: creds that don't round-trip mean a new identity and a dead session.
// These tests exercise the round-trip and the crash-safety properties directly.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initAuthCreds } from '@whiskeysockets/baileys';
import { probeCreds, useAtomicMultiFileAuthState } from './authState.ts';

function freshFolder(): string {
  return mkdtempSync(path.join(tmpdir(), 'sms-api-auth-'));
}

test('probeCreds distinguishes a missing session from a corrupt one', async () => {
  const folder = freshFolder();
  assert.equal(await probeCreds(folder), 'missing');

  writeFileSync(path.join(folder, 'creds.json'), '{"registrationId":1', 'utf-8'); // truncated, as a power cut would leave it
  assert.equal(await probeCreds(folder), 'corrupt');

  writeFileSync(path.join(folder, 'creds.json'), JSON.stringify(initAuthCreds()), 'utf-8');
  assert.equal(await probeCreds(folder), 'ok');
});

test('creds survive a save/reload cycle with their binary key material intact', async () => {
  const folder = freshFolder();
  const first = await useAtomicMultiFileAuthState(folder);
  await first.saveCreds();

  assert.equal(await probeCreds(folder), 'ok');

  const second = await useAtomicMultiFileAuthState(folder);
  assert.equal(second.state.creds.registrationId, first.state.creds.registrationId);
  assert.equal(second.state.creds.advSecretKey, first.state.creds.advSecretKey);
  // The bytes are what actually matter — a JSON round-trip that turned these
  // into {"type":"Buffer",...} objects would break signing, not parsing.
  assert.deepEqual(
    Buffer.from(second.state.creds.noiseKey.private),
    Buffer.from(first.state.creds.noiseKey.private),
  );
  assert.deepEqual(
    Buffer.from(second.state.creds.signedIdentityKey.public),
    Buffer.from(first.state.creds.signedIdentityKey.public),
  );
});

test('signal keys round-trip, and setting null deletes the key', async () => {
  const folder = freshFolder();
  const { state } = await useAtomicMultiFileAuthState(folder);

  const session = new Uint8Array([1, 2, 3, 250, 251]);
  await state.keys.set({ session: { 'device-1': session } });

  const read = await state.keys.get('session', ['device-1', 'never-stored']);
  assert.deepEqual(Buffer.from(read['device-1']), Buffer.from(session));
  // Baileys' own store returns null for a key it doesn't have and callers
  // rely on that, so the replacement has to behave identically.
  assert.equal(read['never-stored'], null);

  await state.keys.set({ session: { 'device-1': null } });
  assert.equal((await state.keys.get('session', ['device-1']))['device-1'], null);
});

test('a write leaves no temp file behind for a later read to trip over', async () => {
  const folder = freshFolder();
  const { state, saveCreds } = await useAtomicMultiFileAuthState(folder);
  await saveCreds();
  await state.keys.set({ session: { 'device-1': new Uint8Array([9]) } });

  assert.deepEqual(
    readdirSync(folder).filter((f) => f.endsWith('.tmp')),
    [],
  );
});

test('concurrent writes to the same file serialize instead of interleaving', async () => {
  const folder = freshFolder();
  const { state, saveCreds } = await useAtomicMultiFileAuthState(folder);

  // Ten overlapping writes to creds.json: with a torn or interleaved write the
  // file would end up unparseable, which is the exact failure this module
  // exists to prevent.
  await Promise.all(Array.from({ length: 10 }, () => saveCreds()));

  assert.equal(await probeCreds(folder), 'ok');
  JSON.parse(readFileSync(path.join(folder, 'creds.json'), 'utf-8')); // throws if torn
  assert.ok(state.creds.registrationId >= 0);
});
