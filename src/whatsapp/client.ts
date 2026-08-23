import path from 'node:path';
import makeWASocket, {
  fetchLatestBaileysVersion,
  DisconnectReason,
  type WASocket,
} from '@whiskeysockets/baileys';
import qrcodeTerminal from 'qrcode-terminal';
import pino from 'pino';
import { config } from '../config.ts';
import { scheduleSessionBackup, restoreSessionFromR2, restoreFromLocal } from './sessionBackup.ts';
import { probeCreds, useAtomicMultiFileAuthState } from './authState.ts';
import { notifyWork } from '../queue/wakeup.ts';

const logger = pino({ level: 'silent' }); // Baileys' own internal logger — noisy at 'info', we log our own lines below
const app = { info: (m: string) => console.log(m), error: (m: string, e?: unknown) => console.error(m, e ?? '') };

// Plan 8, layer 1: reconnect on any drop except an actual logout, with
// increasing backoff so a long outage doesn't hammer the network.
const RECONNECT_DELAYS_MS = [5_000, 15_000, 60_000];
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

// Bumped for every socket we create. A socket that has been replaced can still
// emit events (including its own 'close' when we end it), and acting on those
// would start a second reconnect chain racing the first — each cycle doubling
// the number of live sockets. Handlers compare against this and bail if stale.
let generation = 0;

// What the identity on disk looked like at the last connect attempt. 'fresh'
// and 'restored' both mean the previous session did NOT survive intact, which
// a monitor needs to see as its own signal — 'fresh' in particular means a QR
// scan is pending and no amount of retrying will fix it.
export type SessionOrigin = 'existing' | 'restored' | 'fresh';

export interface ConnectionState {
  connected: boolean;
  needsReauth: boolean;
  lastConnectedAt: string | null;
  lastDisconnectReason: string | null;
  sessionOrigin: SessionOrigin;
  sessionNote: string | null;
}

const state: ConnectionState = {
  connected: false,
  needsReauth: false,
  lastConnectedAt: null,
  lastDisconnectReason: null,
  sessionOrigin: 'existing',
  sessionNote: null,
};

export function getConnectionState(): ConnectionState {
  return { ...state };
}

let socket: WASocket | null = null;

// نداء شبكة خارجي عند كل محاولة اتصال. في يوم عادي هو نداء واحد، أما في
// نوبة انقطاع فهو نداء كل ٦٠ ثانية إلى الأبد — إيقاظ للراديو ومعالجة بلا
// طائل. مهلة ٦ ساعات تكفي لتفادي ذلك دون تجميد الإصدار: بروتوكول واتساب
// يتغيّر بمقياس أسابيع، وتخزينه للأبد كان سيحوّل خدمة تعمل منذ شهر إلى خدمة
// تُرفض بإصدار قديم دون سبب ظاهر.
const VERSION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
let cachedVersion: Awaited<ReturnType<typeof fetchLatestBaileysVersion>>['version'] | null = null;
let cachedVersionAt = 0;

async function getProtocolVersion(): Promise<NonNullable<typeof cachedVersion>> {
  if (cachedVersion && Date.now() - cachedVersionAt < VERSION_CACHE_TTL_MS) return cachedVersion;
  try {
    const { version } = await fetchLatestBaileysVersion();
    cachedVersion = version;
    cachedVersionAt = Date.now();
    return version;
  } catch (err) {
    // نسخة قديمة أفضل من لا اتصال: الشبكة تسقط على هذا الجوال بانتظام، وبلا
    // هذا الرجوع كان فشل هذا النداء وحده يُسقط محاولة الاتصال كلها.
    if (cachedVersion) {
      app.error('[whatsapp] تعذّر تحديث إصدار البروتوكول — استُعملت النسخة المحفوظة', err);
      return cachedVersion;
    }
    throw err;
  }
}

export function getSocket(): WASocket {
  if (!socket) throw new Error('WhatsApp socket not initialized yet');
  return socket;
}

const authDir = path.join(config.dataDir, 'auth-session');

function scheduleReconnect(): void {
  if (reconnectTimer) return; // one chain at a time, however many close events arrive

  const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
  reconnectAttempt += 1;
  app.info(`[whatsapp] إعادة محاولة خلال ${delay / 1000}ث`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWhatsApp().catch((err) => {
      // The retry chain used to end right here: connectWhatsApp() throwing
      // (a corrupt auth file, an R2 client blowing up) left the process alive
      // but permanently disconnected, and pm2 — seeing a healthy process —
      // would never restart it. Re-arming keeps the backoff going instead.
      app.error('[whatsapp] فشلت إعادة الاتصال', err);
      scheduleReconnect();
    });
  }, delay);
}

// Runs before any identity is generated. A missing or corrupt creds.json used
// to be indistinguishable from a first run — Baileys would quietly mint a new
// identity, the old WhatsApp link would be dead, and nothing anywhere would
// say so. Now the backup is tried first, and whatever happened is recorded on
// `state` so /health (and the monitor polling it) can report it.
async function prepareSession(): Promise<void> {
  const probe = await probeCreds(authDir);
  // Nothing to repair — leave whatever the last connect concluded in place;
  // only a successful 'open' below clears a previous warning.
  if (probe === 'ok') return;

  const problem = probe === 'corrupt' ? 'ملف الجلسة تالف' : 'لا توجد جلسة محلية';
  app.info(`[whatsapp] ${problem} — محاولة الاستعادة`);

  // Local copy first: it needs no credentials, is never staler than the R2
  // one, and can't fail on a dead tunnel.
  const local = restoreFromLocal();
  if (local.ok) {
    state.sessionOrigin = 'restored';
    state.sessionNote = `${problem} — استُعيدت ${local.files} ملف من النسخة المحلية`;
    app.info(`[whatsapp] ${state.sessionNote}`);
    return;
  }

  const restore = await restoreSessionFromR2();
  if (restore.ok) {
    state.sessionOrigin = 'restored';
    state.sessionNote = `${problem} — استُعيدت ${restore.files} ملف من نسخة R2`;
    app.info(`[whatsapp] ${state.sessionNote}`);
    return;
  }

  state.sessionNote =
    restore.reason === 'not_configured'
      ? `${problem}، ولا نسخة محلية، ونسخ R2 غير مُفعَّل`
      : `${problem}، ولا نسخة محلية، وتعذّرت الاستعادة من R2 (${restore.reason})`;
  app.error(`[whatsapp] ${state.sessionNote}`, restore.error);
}

// Boot entry point. Deliberately not awaited by the caller (see index.ts) and
// deliberately not allowed to fail silently: a first-connect failure re-arms
// the same backoff the reconnect path uses.
export function startWhatsApp(): void {
  connectWhatsApp().catch((err) => {
    app.error('[whatsapp] فشل أول اتصال', err);
    scheduleReconnect();
  });
}

export async function connectWhatsApp(): Promise<void> {
  await prepareSession();
  const { state: authState, saveCreds } = await useAtomicMultiFileAuthState(authDir);

  // The authoritative check, and the reason prepareSession doesn't have to be
  // exactly right: an unregistered identity is one no QR has been scanned for,
  // whether that's a genuine first run or a session that just died. Retrying
  // the connection can never fix it, so it's surfaced as needsReauth (503 on
  // /health) immediately instead of after a first failed connect.
  if (!authState.creds.registered) {
    state.sessionOrigin = 'fresh';
    state.needsReauth = true;
    state.sessionNote = `${state.sessionNote ?? 'الجلسة غير مرتبطة'} — يحتاج مسح QR جديد`;
    app.error(`[whatsapp] ${state.sessionNote}`);
  }

  const version = await getProtocolVersion();

  const previousSocket = socket;
  const myGeneration = ++generation;
  socket = makeWASocket({ version, auth: authState, logger });

  // Reconnecting used to leave the old socket open with its keep-alive timers
  // still running — one leaked socket per drop, on a phone, forever.
  if (previousSocket) {
    try {
      previousSocket.end(undefined);
    } catch {
      /* already dead — that's the normal case here */
    }
  }

  // Only a live, paired session is worth copying over the backup — see
  // scheduleSessionBackup's own comment for what this guard prevents.
  const backupEligible = () => state.connected && !state.needsReauth;

  socket.ev.on('creds.update', () => {
    void saveCreds();
    scheduleSessionBackup(app, backupEligible);
  });

  socket.ev.on('connection.update', (update) => {
    if (myGeneration !== generation) return; // superseded socket — ignore
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('امسح كود QR هذا من واتساب (الأجهزة المرتبطة → ربط جهاز):');
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === 'open') {
      state.connected = true;
      state.needsReauth = false;
      state.lastConnectedAt = new Date().toISOString();
      state.lastDisconnectReason = null;
      // A live connection is the only thing that actually clears a session
      // warning — a restored or freshly-scanned identity has now proven it
      // works, so the alert shouldn't keep firing.
      state.sessionOrigin = 'existing';
      state.sessionNote = null;
      reconnectAttempt = 0;
      app.info('[whatsapp] متصل');
      // العامل يتراجع إلى نبضة الدقيقة أثناء الانقطاع (راجع queue/wakeup.ts)
      // — بلا هذه الإشارة سيظل الطابور المتراكم واقفاً بعد عودة الاتصال حتى
      // تنتهي دورة الخمول الطويلة.
      notifyWork();
      // First snapshot of a newly-paired or newly-restored session. Without
      // this, a session paired and then lost before any creds.update would
      // have no backup at all.
      scheduleSessionBackup(app, backupEligible);
    }

    if (connection === 'close') {
      state.connected = false;
      const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
        ?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      state.lastDisconnectReason = loggedOut ? 'logged_out' : `code_${statusCode ?? 'unknown'}`;

      if (loggedOut) {
        // Plan 8, layer 1: the one case that needs a human — new QR required.
        state.needsReauth = true;
        app.error('[whatsapp] تسجيل خروج فعلي — يحتاج مسح QR جديد. راقب /health.');
        return;
      }

      app.info(`[whatsapp] انقطع الاتصال (${state.lastDisconnectReason})`);
      scheduleReconnect();
    }
  });
}

export function toJid(digitsOnlyPhone: string): string {
  return `${digitsOnlyPhone}@s.whatsapp.net`;
}

export async function sendWhatsAppText(digitsOnlyPhone: string, text: string): Promise<void> {
  await getSocket().sendMessage(toJid(digitsOnlyPhone), { text });
}
