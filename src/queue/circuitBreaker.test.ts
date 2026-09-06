// Plan 9 point 6. Pure in-memory state — no db, no network, nothing to
// redirect — so unlike every neighbouring module this one had no test file at
// all until now, despite gating whether the worker attempts a send at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import { isPaused, pausedChannels, recordSuccess, recordFailure } from './circuitBreaker.ts';

const FAILURE_THRESHOLD = 5; // must match circuitBreaker.ts

test('a channel with no recorded failures is not paused', () => {
  const channel = `chan-fresh-${Date.now()}`;
  assert.equal(isPaused(channel), false);
  assert.deepEqual(
    pausedChannels().find((p) => p.channel === channel),
    undefined,
  );
});

test('fewer than the threshold of consecutive failures does not pause the channel', () => {
  const channel = `chan-few-${Date.now()}`;
  for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) recordFailure(channel);
  assert.equal(isPaused(channel), false);
});

test('hitting the failure threshold pauses the channel, and it shows up on pausedChannels()', () => {
  const channel = `chan-trip-${Date.now()}`;
  for (let i = 0; i < FAILURE_THRESHOLD; i++) recordFailure(channel);
  assert.equal(isPaused(channel), true);

  const entry = pausedChannels().find((p) => p.channel === channel);
  assert.ok(entry, 'a paused channel must be surfaced for /health, or an operator has no way to see it');
  assert.ok(new Date(entry!.until).getTime() > Date.now(), '"until" must be in the future');
});

test('a success resets the streak — the channel is not one failure away from pausing again', () => {
  const channel = `chan-reset-${Date.now()}`;
  for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) recordFailure(channel);
  recordSuccess(channel);
  recordFailure(channel); // if the streak had survived, this alone would trip the pause
  assert.equal(isPaused(channel), false);
});

test('a success clears an existing pause immediately, not just future failures', () => {
  const channel = `chan-clear-${Date.now()}`;
  for (let i = 0; i < FAILURE_THRESHOLD; i++) recordFailure(channel);
  assert.equal(isPaused(channel), true);

  recordSuccess(channel);
  assert.equal(isPaused(channel), false);
  assert.deepEqual(
    pausedChannels().find((p) => p.channel === channel),
    undefined,
  );
});

test('repeated trips back off: the second pause window is longer than the first', () => {
  const channel = `chan-backoff-${Date.now()}`;

  for (let i = 0; i < FAILURE_THRESHOLD; i++) recordFailure(channel);
  const firstUntil = pausedChannels().find((p) => p.channel === channel)!.until;

  // Simulate the pause having elapsed and the channel failing again: recordFailure
  // itself doesn't check pausedUntil (the worker's isPaused gate does that), so
  // driving it straight to a second trip is enough to observe the backoff.
  for (let i = 0; i < FAILURE_THRESHOLD; i++) recordFailure(channel);
  const secondUntil = pausedChannels().find((p) => p.channel === channel)!.until;

  assert.ok(
    new Date(secondUntil).getTime() > new Date(firstUntil).getTime(),
    'the second pause must extend further than the first — otherwise a channel that keeps failing never backs off',
  );
});

test('channels are tracked independently — one paused channel does not pause another', () => {
  const busy = `chan-busy-${Date.now()}`;
  const quiet = `chan-quiet-${Date.now()}`;
  for (let i = 0; i < FAILURE_THRESHOLD; i++) recordFailure(busy);
  assert.equal(isPaused(busy), true);
  assert.equal(isPaused(quiet), false);
});
