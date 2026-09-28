// اختبار من الطرف إلى الطرف لنظام الإشعارات، لكل مشروع في config/projects.json.
//
// الاختبارات الأخرى تتوقف عند «دخلت الطابور» (server.test.ts) أو تحسم كل
// سيناريو قبل أن يصل الإرسال إلى المقبس (worker.test.ts). هذا الملف يمرّر
// الرسالة في المسار كله كما يحدث في الإنتاج: HTTP ← الطابور ← حلقة العامل
// الحقيقية (startWorker) ← القالب ← مقبس واتساب، ثم يأخذ الكود من نص الرسالة
// الواصلة فعلاً ويتحقق به. المزيَّف الوحيد هو وحدة whatsapp/client.ts (مقبس
// Baileys)، وكل ما سواها كود الإنتاج كما هو.
//
// خارج نمط src/**/*.test.ts عمداً: يحتاج --experimental-test-module-mocks
// لاستبدال المقبس، و--test-force-exit لأن حلقة العامل لا تنتهي. شغّله بـ
// `npm run test:e2e` (و`npm test` يشغّله بعد بقية الاختبارات).
//
// DATA_DIR يُحوَّل قبل استيراد db.ts، فلا يلمس الطابور الحيّ.

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'sms-api-e2e-'));
process.env.PROJECT_API_KEY_STORE = 'e2e-store-key';
process.env.PROJECT_API_KEY_QAREEB = 'e2e-qareeb-key';
process.env.PROJECT_API_KEY_FIREWORKS = 'e2e-fireworks-key';
process.env.OTP_HASH_SECRET = 'e2e-otp-hash-secret';
process.env.SESSION_BACKUP_ENCRYPTION_KEY = 'e2e-backup-passphrase';
// المباعدة البشرية بين الرسائل (٣–٩ ث) تُصفَّر هنا فقط لسرعة الاختبار.
process.env.SEND_MIN_DELAY_MS = '0';
process.env.SEND_MAX_DELAY_MS = '0';
delete process.env.SMS_PROVIDER; // واتساب فقط، كما هو في الإنتاج اليوم

// ───────────── مقبس واتساب مزيَّف ─────────────
interface Delivered { jid: string; text: string; at: number }
const delivered: Delivered[] = [];
const waState = {
  connected: true,
  needsReauth: false,
  lastConnectedAt: new Date().toISOString(),
  lastDisconnectReason: null as string | null,
  sessionOrigin: 'existing' as const,
  sessionNote: null as string | null,
  pairedAtMs: null as number | null,
};
const NO_WHATSAPP = new Set<string>();
const failTimes = new Map<string, number>(); // رقم ← كم مرة يفشل الإرسال إليه
const sendCalls = new Map<string, number>(); // رقم ← كم مرة خرج إليه إرسال فعلي
const fakeSocket = {
  async onWhatsApp(phone: string) {
    return [{ exists: !NO_WHATSAPP.has(phone), jid: `${phone}@s.whatsapp.net` }];
  },
  async sendMessage(jid: string, content: { text: string }) {
    const phone = jid.split('@')[0];
    sendCalls.set(phone, (sendCalls.get(phone) ?? 0) + 1);
    const left = failTimes.get(phone) ?? 0;
    if (left > 0) {
      failTimes.set(phone, left - 1);
      throw new Error('fake_send_failure');
    }
    delivered.push({ jid, text: content.text, at: Date.now() });
    return {};
  },
};
const toJid = (p: string) => `${p}@s.whatsapp.net`;
mock.module(new URL('../whatsapp/client.ts', import.meta.url).href, {
  namedExports: {
    getConnectionState: () => ({ ...waState }),
    getSocket: () => fakeSocket,
    toJid,
    // نفس سطر الإنتاج حرفياً (client.ts: sendWhatsAppText)
    sendWhatsAppText: async (phone: string, text: string) => {
      await fakeSocket.sendMessage(toJid(phone), { text });
    },
    startWhatsApp: () => {},
  },
});

const { createServer } = await import('../http/server.ts');
const { startWorker } = await import('../queue/worker.ts');
const { notifyWork } = await import('../queue/wakeup.ts');
const { renderTemplate } = await import('../templates/templates.ts');
const { config } = await import('../config.ts');
const { db } = await import('../db.ts');

const server = http.createServer(createServer());
await new Promise<void>((r) => server.listen(0, r));
const { port } = server.address() as AddressInfo;
startWorker();

const projectsFile = JSON.parse(readFileSync(new URL('../../config/projects.json', import.meta.url), 'utf-8')) as Array<{
  id: string; brandName: string; otpExpiryMinutes: number; resendCooldownMinutes: number; templates?: Record<string, string[]>;
}>;
const KEYS: Record<string, string> = {
  store: 'e2e-store-key',
  qareeb: 'e2e-qareeb-key',
  fireworks: 'e2e-fireworks-key',
};

// ───────────── أدوات مساعدة ─────────────
async function call(method: string, urlPath: string, key: string | null, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
}

async function waitStatus(id: number, key: string, want: 'sent' | 'failed', ms = 8000) {
  const end = Date.now() + ms;
  let last: Record<string, any> = {};
  while (Date.now() < end) {
    last = (await call('GET', `/status/${id}`, key)).json;
    if (last.status === want) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`message ${id} did not reach "${want}" within ${ms}ms — last: ${JSON.stringify(last)}`);
}

function lastTo(phone: string): Delivered {
  const m = [...delivered].reverse().find((d) => d.jid === `${phone}@s.whatsapp.net`);
  assert.ok(m, `no WhatsApp message delivered to ${phone}`);
  return m!;
}

function assertClean(text: string) {
  assert.doesNotMatch(text, /\{\w+\}/, `leftover placeholder in: ${text}`);
  assert.doesNotMatch(text, /undefined|null|NaN|\[object/, `bad value in: ${text}`);
}

function codeIn(text: string): string {
  const six = text.match(/(?<!\d)\d{6}(?!\d)/g) ?? [];
  assert.equal(six.length, 1, `expected exactly one 6-digit code in: ${text}`);
  return six[0];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function matchesAnyVariant(text: string, variants: string[], vars: Record<string, string | number>): boolean {
  return variants.some((v) => {
    let re = escapeRe(v);
    for (const [k, val] of Object.entries(vars)) re = re.split(escapeRe(`{${k}}`)).join(escapeRe(String(val)));
    re = re.split(escapeRe('{code}')).join('\\d{6}');
    return new RegExp(`^${re}$`).test(text);
  });
}

let phoneSeq = 0;
const phone = () => `9639000${String(++phoneSeq).padStart(5, '0')}`;

const ORDER = { order: 'A-1042', amount: '150,000 ل.س', name: 'سارة' };
const EVENTS = ['order_created', 'order_confirmed', 'out_for_delivery', 'delivered'] as const;

// ───────────── ١) كل مشروع: الرحلات الأربع كاملة ─────────────
for (const p of projectsFile) {
  const key = KEYS[p.id];
  assert.ok(key, `no test key mapped for project ${p.id} — add it to KEYS`);

  test(`[${p.id}] تسجيل: /otp/request ← يصل واتساب بالعلامة والكود ← /otp/verify بالكود الواصل`, async () => {
    const to = phone();
    const req = await call('POST', '/otp/request', key, { to });
    assert.equal(req.status, 202, JSON.stringify(req.json));
    const st = await waitStatus(req.json.id, key, 'sent');
    assert.equal(st.channel, 'whatsapp');
    assert.equal(st.event, 'otp');

    const msg = lastTo(to);
    assertClean(msg.text);
    assert.ok(msg.text.includes(p.brandName), `brand "${p.brandName}" missing: ${msg.text}`);
    assert.ok(msg.text.includes(String(p.otpExpiryMinutes)), `expiry missing: ${msg.text}`);
    if (p.templates?.otp) {
      assert.ok(
        matchesAnyVariant(msg.text, p.templates.otp, { brand: p.brandName, expiryMinutes: p.otpExpiryMinutes }),
        `${p.id} custom otp template not used: ${msg.text}`,
      );
    }

    const code = codeIn(msg.text);
    const wrong = code === '000000' ? '111111' : '000000';
    const bad = await call('POST', '/otp/verify', key, { to, code: wrong });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'invalid_code');

    // الزبون يلصق رسالة واتساب كاملة كما وصلته — README يَعِد بقبولها
    const ok = await call('POST', '/otp/verify', key, { to, code: msg.text });
    assert.equal(ok.status, 200, `pasted full message rejected: ${JSON.stringify(ok.json)} — text: ${msg.text}`);

    // الكود نفسه يبقى مقبولاً دقيقتين إن ضاع الرد الأول (d89b6b2)، لكن رمز آخر لا
    const again = await call('POST', '/otp/verify', key, { to, code: wrong });
    assert.equal(again.status, 400);
  });

  test(`[${p.id}] كود بأرقام عربية ← مقبول`, async () => {
    const to = phone();
    const req = await call('POST', '/otp/request', key, { to });
    assert.equal(req.status, 202);
    await waitStatus(req.json.id, key, 'sent');
    const code = codeIn(lastTo(to).text);
    const arabic = code.replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)]);
    const ok = await call('POST', '/otp/verify', key, { to, code: arabic });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
  });

  test(`[${p.id}] نسيت كلمة المرور: request ← يصل ← verify ← resetToken ← validate-token يستهلكه مرة واحدة`, async () => {
    const to = phone();
    const req = await call('POST', '/password-reset/request', key, { to });
    assert.equal(req.status, 202, JSON.stringify(req.json));
    const st = await waitStatus(req.json.id, key, 'sent');
    assert.equal(st.event, 'password_reset');

    const msg = lastTo(to);
    assertClean(msg.text);
    assert.ok(msg.text.includes(p.brandName), msg.text);
    if (p.templates?.password_reset) {
      assert.ok(
        matchesAnyVariant(msg.text, p.templates.password_reset, { brand: p.brandName, expiryMinutes: p.otpExpiryMinutes }),
        `${p.id} custom password_reset template not used: ${msg.text}`,
      );
    }

    // كود إعادة التعيين لا يصلح لتسجيل الدخول (سلّتان منفصلتان)
    const crossPurpose = await call('POST', '/otp/verify', key, { to, code: codeIn(msg.text) });
    assert.equal(crossPurpose.status, 400);

    const ver = await call('POST', '/password-reset/verify', key, { to, code: codeIn(msg.text) });
    assert.equal(ver.status, 200, JSON.stringify(ver.json));
    assert.equal(typeof ver.json.resetToken, 'string');

    const val = await call('POST', '/password-reset/validate-token', key, { token: ver.json.resetToken });
    assert.equal(val.status, 200);
    assert.equal(val.json.phone, to);

    const reuse = await call('POST', '/password-reset/validate-token', key, { token: ver.json.resetToken });
    assert.equal(reuse.status, 400, 'token must be single-use');
  });

  for (const event of EVENTS) {
    test(`[${p.id}] إشعار طلب: ${event} ← يصل بالرقم والمبلغ والاسم بلا متغيّرات متروكة`, async () => {
      const to = phone();
      const res = await call('POST', '/notify', key, { event, to, payload: ORDER });
      assert.equal(res.status, 202, JSON.stringify(res.json));
      await waitStatus(res.json.id, key, 'sent');
      const msg = lastTo(to);
      assertClean(msg.text);
      assert.ok(msg.text.includes(ORDER.order), `order number missing: ${msg.text}`);
      if (event === 'order_created' || event === 'out_for_delivery') {
        assert.ok(msg.text.includes(ORDER.amount), `amount missing: ${msg.text}`);
      }
    });
  }

  test(`[${p.id}] إشعار بحمولة ناقصة (بلا name) ← يُختار قالب لا يحتاجه، لا "{name}" عند الزبون`, async () => {
    const sent: string[] = [];
    for (let i = 0; i < 6; i++) {
      const to = phone();
      const res = await call('POST', '/notify', key, { event: 'delivered', to, payload: { order: 'B-7' } });
      assert.equal(res.status, 202);
      await waitStatus(res.json.id, key, 'sent');
      sent.push(lastTo(to).text);
    }
    for (const t of sent) assertClean(t);
  });
}

// ───────────── ٢) عزل المشاريع ─────────────
test('عزل: كود store لا يُتحقق منه بمفتاح qareeb، و/status لرسالة مشروع آخر 404', async () => {
  const to = phone();
  const req = await call('POST', '/otp/request', KEYS.store, { to });
  await waitStatus(req.json.id, KEYS.store, 'sent');
  const code = codeIn(lastTo(to).text);

  const cross = await call('POST', '/otp/verify', KEYS.qareeb, { to, code });
  assert.equal(cross.status, 400);
  assert.equal((await call('GET', `/status/${req.json.id}`, KEYS.qareeb)).status, 404);
  assert.equal((await call('GET', `/status/${req.json.id}`, KEYS.fireworks)).status, 404);

  const ok = await call('POST', '/otp/verify', KEYS.store, { to, code });
  assert.equal(ok.status, 200);
});

test('عزل: رسالة store لا تستعمل قوالب مخدم الخاصة، ورسالة مخدم لا تحمل اسم Talisham', async () => {
  const qareeb = projectsFile.find((p) => p.id === 'qareeb')!;
  const store = projectsFile.find((p) => p.id === 'store')!;
  for (let i = 0; i < 5; i++) {
    const a = phone();
    const r1 = await call('POST', '/otp/request', KEYS.store, { to: a });
    await waitStatus(r1.json.id, KEYS.store, 'sent');
    assert.ok(!matchesAnyVariant(lastTo(a).text, qareeb.templates!.otp, { brand: store.brandName, expiryMinutes: store.otpExpiryMinutes }));
    const b = phone();
    const r2 = await call('POST', '/otp/request', KEYS.qareeb, { to: b });
    await waitStatus(r2.json.id, KEYS.qareeb, 'sent');
    assert.ok(!lastTo(b).text.includes('Talisham'));
  }
});

test('مفتاح خاطئ أو غائب ← 401 قبل أي مسار', async () => {
  assert.equal((await call('POST', '/notify', null, {})).status, 401);
  assert.equal((await call('POST', '/notify', 'nope', {})).status, 401);
  assert.equal((await call('GET', '/health', 'nope')).status, 401);
});

// ───────────── ٣) التهدئة والحماية ─────────────
test('طلب كود ثانٍ والأول حيّ ← 202 alreadySent بلا رسالة ثانية؛ بعد التحقق ← 429 cooldown', async () => {
  const to = phone();
  const r1 = await call('POST', '/otp/request', KEYS.store, { to });
  await waitStatus(r1.json.id, KEYS.store, 'sent');
  const before = delivered.length;

  const r2 = await call('POST', '/otp/request', KEYS.store, { to });
  assert.equal(r2.status, 202);
  assert.equal(r2.json.alreadySent, true);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(delivered.length, before, 'a second WhatsApp message went out for an already_sent request');

  await call('POST', '/otp/verify', KEYS.store, { to, code: codeIn(lastTo(to).text) });
  const r3 = await call('POST', '/otp/request', KEYS.store, { to });
  assert.equal(r3.status, 429);
  assert.equal(r3.json.error, 'cooldown');
  assert.ok(r3.json.retryAfterSeconds > 0);
});

test('حمولة order_created بلا amount ← 400 missing_placeholders (لا تُرسل "{amount}" للزبون)', async () => {
  const res = await call('POST', '/notify', KEYS.store, { event: 'order_created', to: phone(), payload: { order: '1' } });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, 'missing_placeholders');
  assert.deepEqual(res.json.missing, ['amount']);
});

test('رقم محلي بصفر بادئ ← 400 قبل الطابور', async () => {
  const res = await call('POST', '/notify', KEYS.store, { event: 'delivered', to: '0958436703', payload: ORDER });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, 'invalid_recipient_format');
});

// ───────────── ٤) الصمود ─────────────
test('/health ← 200 ok والطابور فارغ وواتساب متصل', async () => {
  const h = await call('GET', '/health', KEYS.store);
  assert.equal(h.status, 200, JSON.stringify(h.json));
  assert.equal(h.json.status, 'ok');
  assert.equal(h.json.queue.pending, 0);
});

test('انقطاع واتساب: الإشعار يبقى pending بلا حرق محاولات، /health 503، ثم يصل فور العودة', async () => {
  waState.connected = false;
  const to = phone();
  const res = await call('POST', '/notify', KEYS.fireworks, { event: 'order_confirmed', to, payload: ORDER });
  assert.equal(res.status, 202);
  await new Promise((r) => setTimeout(r, 800));

  const st = (await call('GET', `/status/${res.json.id}`, KEYS.fireworks)).json;
  assert.equal(st.status, 'pending');
  assert.equal(st.attempts, 0, 'an outage burned a send attempt');
  const h = await call('GET', '/health', KEYS.fireworks);
  assert.equal(h.status, 503);
  assert.ok(h.json.reasons.includes('whatsapp_disconnected'), JSON.stringify(h.json.reasons));

  const t0 = Date.now();
  waState.connected = true;
  notifyWork(); // نفس ما يفعله client.ts عند connection === 'open'
  await waitStatus(res.json.id, KEYS.fireworks, 'sent', 3000);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0}ms to drain after reconnect`);
  assertClean(lastTo(to).text);
});

test('فشل إرسال عابر: تُحسب محاولة واحدة ثم تنجح إعادة المحاولة', async () => {
  const to = phone();
  failTimes.set(to, 1);
  const res = await call('POST', '/notify', KEYS.store, { event: 'delivered', to, payload: ORDER });
  const st = await waitStatus(res.json.id, KEYS.store, 'sent');
  assert.equal(st.attempts, 1);
  assertClean(lastTo(to).text);
});

test('واتساب يحتاج QR: /otp/request ← 503 delivery_unavailable بلا خصم من الحصة، و/health يسمّي السبب', async () => {
  waState.connected = false;
  waState.needsReauth = true;
  const to = phone();
  const r = await call('POST', '/otp/request', KEYS.qareeb, { to });
  assert.equal(r.status, 503);
  assert.equal(r.json.error, 'delivery_unavailable');
  const logged = db.prepare('SELECT COUNT(*) AS n FROM otp_send_log WHERE phone = ?').get(to) as { n: number };
  assert.equal(logged.n, 0, 'quota was charged for a code that was never issued');
  const h = await call('GET', '/health', KEYS.qareeb);
  assert.ok(h.json.reasons.includes('whatsapp_needs_reauth'));

  waState.needsReauth = false;
  waState.connected = true;
  notifyWork();
  const r2 = await call('POST', '/otp/request', KEYS.qareeb, { to });
  assert.equal(r2.status, 202);
  await waitStatus(r2.json.id, KEYS.qareeb, 'sent');
});

test('رقم بلا واتساب ولا مزوّد SMS ← failed no_channel_available، وطلب جديد يعطي كوداً جديداً لا "already_sent"', async () => {
  const to = phone();
  NO_WHATSAPP.add(to);
  const r1 = await call('POST', '/otp/request', KEYS.store, { to });
  assert.equal(r1.status, 202);
  const st = await waitStatus(r1.json.id, KEYS.store, 'failed');
  assert.equal(st.last_error, 'no_channel_available');

  // ما يزال بلا واتساب؛ الطلب التالي يجب ألا يَعِد بكود "في الطريق"
  const r2 = await call('POST', '/otp/request', KEYS.store, { to });
  assert.equal(r2.status, 202);
  assert.notEqual(r2.json.alreadySent, true, 'promised a code that can never arrive');
  NO_WHATSAPP.delete(to);
});

// ───────────── ٥) كل صيغ القوالب لكل مشروع ─────────────
test('كل صيغة من كل قالب في كل مشروع تُعرض نظيفة (٣٠٠ عرض لكل حدث)', () => {
  const allEvents = ['otp', 'password_reset', ...EVENTS];
  for (const proj of config.projects) {
    for (const event of allEvents) {
      const seen = new Set<number>();
      for (let i = 0; i < 300; i++) {
        const { text, variantIndex } = renderTemplate(
          event,
          { ...ORDER, code: '482913', brand: proj.brandName, expiryMinutes: proj.otpExpiryMinutes },
          proj.templates,
        );
        assertClean(text);
        assert.ok(text.includes(proj.brandName) || !['otp', 'password_reset'].includes(event), `${proj.id}/${event}: ${text}`);
        seen.add(variantIndex);
      }
      const expected = (proj.templates?.[event] ?? null)?.length;
      if (expected) assert.equal(seen.size, expected, `${proj.id}/${event}: only ${seen.size}/${expected} variants ever chosen`);
    }
  }
});

test('قرص ممتلئ لحظة تسجيل الإرسال: كل رسالة تصل مرة واحدة فقط، وتُسجَّل sent حين يتحرر', async () => {
  waState.connected = false;
  const phones = [phone(), phone(), phone()];
  const ids: number[] = [];
  for (const to of phones) {
    const r = await call('POST', '/notify', KEYS.store, { event: 'delivered', to, payload: ORDER });
    assert.equal(r.status, 202);
    ids.push(r.json.id);
  }
  // الرسالة تخرج، والسطر الذي يقول إنها خرجت لا يُكتب — كما على قرص ممتلئ
  db.exec(`CREATE TRIGGER e2e_disk_full BEFORE UPDATE OF status ON messages WHEN NEW.status = 'sent'
           BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`);
  try {
    waState.connected = true;
    notifyWork();
    await new Promise((r) => setTimeout(r, 300));
    for (let i = 0; i < 5; i++) {
      notifyWork(); // خمس نبضات إضافية والقرص ما زال ممتلئاً
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    db.exec('DROP TRIGGER e2e_disk_full');
  }
  notifyWork();
  for (const id of ids) await waitStatus(id, KEYS.store, 'sent');
  const counts = phones.map((to) => delivered.filter((d) => d.jid === toJid(to)).length);
  assert.deepEqual(counts, [1, 1, 1], `times each customer received the same message: ${counts}`);
});

// ───────────── ٦) الأخير: فشل دائم ← قاطع الدائرة ─────────────
test('فشل دائم: ٥ محاولات ← failed، والقناة تُوقف مؤقتاً ويظهر channel_paused في /health', async () => {
  const to = phone();
  failTimes.set(to, 99);
  const res = await call('POST', '/notify', KEYS.store, { event: 'delivered', to, payload: ORDER });
  const st = await waitStatus(res.json.id, KEYS.store, 'failed');
  assert.equal(sendCalls.get(to), 5, 'real network attempts');
  assert.equal(st.attempts, 5, `/status reports attempts=${st.attempts} after ${sendCalls.get(to)} real sends`);
  assert.equal(st.last_error, 'fake_send_failure');
  const h = await call('GET', '/health', KEYS.store);
  assert.equal(h.status, 503);
  assert.ok(h.json.reasons.includes('channel_paused'), JSON.stringify(h.json.reasons));
});

test.after(() => {
  server.close();
  console.log(`\n[e2e] رسائل واتساب سُلِّمت للمقبس المزيَّف: ${delivered.length}`);
  for (const d of delivered.slice(0, 3)) console.log(`[e2e] مثال → ${d.jid}: ${d.text.replace(/\n/g, ' ⏎ ')}`);
});
