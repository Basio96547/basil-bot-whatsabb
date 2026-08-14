import { db } from '../db.ts';
import { getSocket } from './client.ts';

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // plan 4.6: ~week per number

const selectCached = db.prepare(`SELECT has_whatsapp, checked_at FROM whatsapp_status_cache WHERE phone = ?`);
const upsertCache = db.prepare(`
  INSERT INTO whatsapp_status_cache (phone, has_whatsapp, checked_at) VALUES (?, ?, datetime('now'))
  ON CONFLICT(phone) DO UPDATE SET has_whatsapp = excluded.has_whatsapp, checked_at = excluded.checked_at
`);

export type ExistenceResult = 'yes' | 'no' | 'unknown';

export async function checkWhatsAppExists(digitsOnlyPhone: string): Promise<ExistenceResult> {
  const cached = selectCached.get(digitsOnlyPhone) as { has_whatsapp: number; checked_at: string } | undefined;
  if (cached) {
    const age = Date.now() - new Date(`${cached.checked_at}Z`).getTime();
    if (age < CACHE_TTL_MS) return cached.has_whatsapp ? 'yes' : 'no';
  }

  try {
    const results = await getSocket().onWhatsApp(digitsOnlyPhone);
    const exists = Boolean(results?.[0]?.exists);
    upsertCache.run(digitsOnlyPhone, exists ? 1 : 0);
    return exists ? 'yes' : 'no';
  } catch {
    // Plan 4.6: check itself failed (network hiccup) — caller falls back to
    // try-whatsapp-then-sms-on-failure instead of routing upfront.
    return 'unknown';
  }
}

export type Channel = 'whatsapp' | 'sms';

// Plan 4.1 + 4.6: caller-specified channel wins outright; otherwise route by
// existence check, and an inconclusive check defaults to trying WhatsApp
// first (the worker's own send-failure fallback covers the rest).
export async function resolveChannel(digitsOnlyPhone: string, override?: Channel): Promise<Channel> {
  if (override) return override;
  const existence = await checkWhatsAppExists(digitsOnlyPhone);
  if (existence === 'no') return 'sms';
  return 'whatsapp';
}
