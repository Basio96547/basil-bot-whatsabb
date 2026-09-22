// Plan 9, point 6: after repeated consecutive failures on a channel, stop
// hammering it and pause for a bit instead — protects battery/CPU on a phone
// host and avoids a hung provider looking like a fast retry loop.

const FAILURE_THRESHOLD = 5;
const BASE_PAUSE_MS = 60_000;
const MAX_PAUSE_MS = 10 * 60_000;

interface ChannelState {
  consecutiveFailures: number;
  pausedUntil: number; // epoch ms, 0 = not paused
  currentPauseMs: number;
}

const channels = new Map<string, ChannelState>();

function getState(channel: string): ChannelState {
  let s = channels.get(channel);
  if (!s) {
    s = { consecutiveFailures: 0, pausedUntil: 0, currentPauseMs: BASE_PAUSE_MS };
    channels.set(channel, s);
  }
  return s;
}

export function isPaused(channel: string): boolean {
  return getState(channel).pausedUntil > Date.now();
}

/**
 * Channels currently in a circuit-breaker pause, with when each frees up.
 *
 * Surfaced on /health rather than left as dead API: a channel sitting in a
 * 10-minute pause is a real reason nothing is being delivered, and it used to
 * be invisible to the monitor — /health reported queue depth and WhatsApp
 * state and never mentioned it.
 */
export function pausedChannels(): Array<{ channel: string; until: string }> {
  const now = Date.now();
  return [...channels.entries()]
    .filter(([, s]) => s.pausedUntil > now)
    .map(([channel, s]) => ({ channel, until: new Date(s.pausedUntil).toISOString() }));
}

export function recordSuccess(channel: string): void {
  const s = getState(channel);
  s.consecutiveFailures = 0;
  s.pausedUntil = 0;
  s.currentPauseMs = BASE_PAUSE_MS;
}

export function recordFailure(channel: string): void {
  const s = getState(channel);
  s.consecutiveFailures += 1;
  if (s.consecutiveFailures >= FAILURE_THRESHOLD) {
    s.pausedUntil = Date.now() + s.currentPauseMs;
    s.currentPauseMs = Math.min(s.currentPauseMs * 2, MAX_PAUSE_MS);
    s.consecutiveFailures = 0;
  }
}
