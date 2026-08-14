import { config } from '../config.ts';

export interface SendResult {
  ok: boolean;
  error?: string;
}

const SEND_TIMEOUT_MS = 15_000; // plan 9: every external call gets a hard timeout

// Plan 6: SMS stays a pluggable stub until a real provider is chosen (Syria's
// sanctions make most global providers a dead end — see plan section 6). This
// generic JSON-over-HTTP shape is a placeholder: swap the body/headers below
// for whatever the real provider's API actually expects once picked.
export async function sendSms(phone: string, text: string): Promise<SendResult> {
  if (!config.sms.enabled) {
    return { ok: false, error: 'no_sms_provider_configured' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

  try {
    const response = await fetch(config.sms.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.sms.apiKey}`,
      },
      body: JSON.stringify({ to: phone, message: text }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return { ok: false, error: `sms_provider_http_${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    const reason = error instanceof Error && error.name === 'AbortError' ? 'sms_provider_timeout' : 'sms_provider_error';
    return { ok: false, error: reason };
  } finally {
    clearTimeout(timeout);
  }
}
