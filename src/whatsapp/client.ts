import path from 'node:path';
import makeWASocket, {
  fetchLatestBaileysVersion,
  generateMessageIDV2,
  DisconnectReason,
  DEFAULT_CONNECTION_CONFIG,
  type AuthenticationCreds,
  type BinaryNode,
  type ReachoutTimelockState,
  type WASocket,
} from '@whiskeysockets/baileys';
import qrcodeTerminal from 'qrcode-terminal';
import pino from 'pino';
import { config } from '../config.ts';
import { scheduleSessionBackup, restoreSessionFromR2, restoreFromLocal, quarantineDeadSession } from './sessionBackup.ts';
import { probeCreds, useAtomicMultiFileAuthState, type CredsProbe } from './authState.ts';
import { notifyWork } from '../queue/wakeup.ts';
import { rememberPairing, checkSendRate } from '../queue/sendRate.ts';
import { parseEnforcement, recordEnforcement, clearEnforcement, activeEnforcement, type Enforcement } from './enforcement.ts';

/** Records a restriction WhatsApp just announced, and says so loudly once. */
function noteEnforcement(found: Enforcement): void {
  const already = activeEnforcement();
  recordEnforcement(found);
  if (already && already.endsAtMs === found.endsAtMs) return; // same notice repeated
  app.error(
    `[whatsapp] واتساب قيّد الحساب (${found.type}) حتى ${new Date(found.endsAtMs).toISOString()} — الإرسال موقوف، ولا تمسح QR جديداً قبل انتهاء المدة`,
  );
}

/**
 * Baileys' own typed report of the account's restriction state (rc14+), sent
 * both when one starts and when it is LIFTED — the raw-notification parser
 * below only ever sees a start, so an early lift used to keep sending blocked
 * (and a new QR withheld) until the original end time.
 */
function applyReachoutTimelock(lock: ReachoutTimelockState): void {
  if (lock.isActive) {
    // WA Web itself assumes one minute when the server gives no end time.
    const endsAtMs = lock.timeEnforcementEnds?.getTime() ?? Date.now() + 60_000;
    noteEnforcement({ type: lock.enforcementType ?? 'UNKNOWN', endsAtMs });
    return;
  }
  if (activeEnforcement()) {
    clearEnforcement();
    app.info('[whatsapp] واتساب رفع القيد عن الحساب — الإرسال يُستأنف');
    notifyWork();
  }
}

const logger = pino({ level: 'silent' }); // Baileys' own internal logger — noisy at 'info', we log our own lines below
const app = { info: (m: string) => console.log(m), error: (m: string, e?: unknown) => console.error(m, e ?? '') };

// Plan 8, layer 1: reconnect on any drop except an actual logout, with
// increasing backoff so a long outage doesn't hammer the network.
//
// The old ceiling was 60s, i.e. up to 1440 connection attempts a day for as
// long as an outage lasted. Repeated reconnects on an unofficial client are
// themselves a ban signal — the very thing every other comment in this file
// works to avoid — and after the first minute nothing is gained by trying
// again sooner. The ramp now ends at 5 minutes; a recovered network still
// reconnects within that, and notifyWork()/a real send is never waiting on it.
const RECONNECT_DELAYS_MS = [5_000, 15_000, 60_000, 180_000, 300_000];
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

// After a QR scan WhatsApp closes the socket with 515 and expects the client
// to log straight back in with the new credentials. That close used to go
// through the ordinary backoff — and the QR screens that preceded it had
// already pushed the counter to its 5-minute ceiling, so a freshly scanned
// session sat unconnected for up to five minutes.
const RESTART_REQUIRED_DELAY_MS = 1_000;

// 440: another client took over this same session (the PC dev server holding
// a copy of data/auth-session did exactly this). 403: WhatsApp refuses the
// account. Reconnecting on the normal ramp just fights the other client — each
// connect kicks it, it kicks back — or knocks on a closed door every five
// minutes; either way, reconnect churn on an unofficial client is itself a
// ban signal. Retried rarely instead, so the service still comes back on its
// own once the other copy is gone.
const CONTESTED_RECONNECT_DELAY_MS = 30 * 60_000;

// setTimeout silently treats anything above ~24.8 days as 1 ms. A restriction
// that long (the enforcement gate below waits for its end) turned the
// reconnect timer into a tight loop — dozens of connect attempts a second,
// each with a log line and, with R2 on, a download. Waking every few hours
// instead costs nothing: the gate simply re-checks and waits again.
const MAX_RECONNECT_DELAY_MS = 6 * 60 * 60_000;

// The backoff ramp only resets once a connection has proven itself. Resetting
// on every 'open' meant a link that opens and drops straight away (a flaky
// network, a server that accepts and then kicks) retried every 5 s forever —
// the reconnect churn the ramp exists to prevent.
const STABLE_CONNECTION_MS = 2 * 60_000;
let openedAtMs = 0;

/**
 * A session that has completed pairing at least once — see connectWhatsApp.
 *
 * `me` alone is not proof: Baileys' requestPairingCode() writes creds.me the
 * moment a pairing CODE is asked for, before anyone enters it. `account` is
 * written only by configureSuccessfulPairing (validate-connection.js), on a
 * real pair-success, for both QR and code pairing. This service pairs by QR
 * only, but the stricter test costs nothing. (Found by the fireworks-bot
 * session reviewing the same fix, 2026-09-23.)
 */
export function isLinkedIdentity(creds: Pick<AuthenticationCreds, 'me' | 'account'>): boolean {
  return Boolean(creds.me?.id && creds.account);
}

const NEEDS_QR_SUFFIX = 'يحتاج مسح QR جديد';

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
  /** When the CURRENT identity was first seen connected — drives the send-rate warm-up. */
  pairedAtMs: number | null;
}

const state: ConnectionState = {
  connected: false,
  needsReauth: false,
  lastConnectedAt: null,
  lastDisconnectReason: null,
  sessionOrigin: 'existing',
  sessionNote: null,
  pairedAtMs: null,
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
// fetchLatestBaileysVersion() has no timeout of its own — Node's fetch waits
// up to 300 s for headers — and it reads raw.githubusercontent.com, the kind
// of GitHub CDN host this phone's network has been seen to stall on for
// minutes. That wait sat in front of every connect attempt, boot included.
const VERSION_FETCH_TIMEOUT_MS = 10_000;
// After a failed fetch, the fallback is reused for a while rather than paying
// the timeout again on every reconnect of an outage.
const VERSION_RETRY_AFTER_FAILURE_MS = 30 * 60_000;
type ProtocolVersion = typeof DEFAULT_CONNECTION_CONFIG.version;
let cachedVersion: ProtocolVersion | null = null;
let cachedVersionUntil = 0;

async function getProtocolVersion(): Promise<ProtocolVersion> {
  if (cachedVersion && Date.now() < cachedVersionUntil) return cachedVersion;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const fetched = await Promise.race([
    fetchLatestBaileysVersion().catch(() => null),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), VERSION_FETCH_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));

  // Baileys never throws here: on failure it resolves with its own bundled
  // version plus an `error` — so success has to be read from isLatest, not
  // from the absence of an exception (the old catch below was dead code, and
  // a failed fetch was cached as fresh for six hours).
  if (fetched?.isLatest) {
    cachedVersion = fetched.version;
    cachedVersionUntil = Date.now() + VERSION_CACHE_TTL_MS;
    return fetched.version;
  }

  // نسخة قديمة أفضل من لا اتصال: الشبكة تسقط على هذا الجوال بانتظام.
  const fallback = cachedVersion ?? fetched?.version ?? DEFAULT_CONNECTION_CONFIG.version;
  app.error('[whatsapp] تعذّر جلب إصدار البروتوكول الأحدث — استُعملت نسخة محفوظة/افتراضية');
  cachedVersion = fallback;
  cachedVersionUntil = Date.now() + VERSION_RETRY_AFTER_FAILURE_MS;
  return fallback;
}

export function getSocket(): WASocket {
  if (!socket) throw new Error('WhatsApp socket not initialized yet');
  return socket;
}

const authDir = path.join(config.dataDir, 'auth-session');

function scheduleReconnect(delayOverrideMs?: number): void {
  if (reconnectTimer) return; // one chain at a time, however many close events arrive

  const delay = Math.min(
    delayOverrideMs ?? RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)],
    MAX_RECONNECT_DELAY_MS,
  );
  if (delayOverrideMs === undefined) reconnectAttempt += 1;
  app.info(`[whatsapp] إعادة محاولة خلال ${Math.round(delay / 1000)}ث`);

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
  // The HTTP server is what keeps this process alive; a pending reconnect —
  // which can now be hours away, see the enforcement gate — must not be the
  // only thing holding it open.
  reconnectTimer.unref?.();
}

// Runs before any identity is generated. A missing or corrupt creds.json used
// to be indistinguishable from a first run — Baileys would quietly mint a new
// identity, the old WhatsApp link would be dead, and nothing anywhere would
// say so. Now the backup is tried first, and whatever happened is recorded on
// `state` so /health (and the monitor polling it) can report it.
// Returns the probe so the caller can decide whether it is even safe to load
// (or generate) an auth state afterward — see connectWhatsApp's use of it.
// How many connect attempts in a row may find the session gone and R2
// unreachable before a fresh identity (a QR) is accepted instead. Going
// straight to a fresh identity on the FIRST failed download — a boot before
// the network is fully back — was close to irreversible: Baileys saves the
// fresh creds.json before any QR is scanned (edge_routing), after which
// every probe reads 'ok' and the good R2 copy is never tried again. Waiting
// forever is no better when R2 is down for good, so after this many tries
// along the backoff ramp (about ten minutes) the QR is offered after all.
const MAX_R2_RESTORE_RETRIES = 5;
let r2RestoreFailures = 0;

export async function prepareSession(): Promise<CredsProbe | 'backup_unreachable'> {
  const probe = await probeCreds(authDir);
  // Nothing to repair — leave whatever the last connect concluded in place;
  // only a successful 'open' below clears a previous warning.
  if (probe === 'ok') return probe;

  // The file exists but could not be read right now (permissions, too many
  // open handles, the OS busy). Restoring here would overwrite a session that
  // is probably fine with an older snapshot — strictly worse than waiting for
  // the reconnect backoff to try again. The caller must also not proceed to
  // load an auth state on this same attempt: useAtomicMultiFileAuthState's own
  // creds read would hit this identical transient error and silently fall
  // back to a blank identity, which the next creds.update then saves over the
  // real session — the exact loss this probe exists to prevent, one function
  // away.
  if (probe === 'unreadable') {
    state.sessionNote = 'تعذّر قراءة ملف الجلسة مؤقتاً — لن تُستعاد نسخة فوق جلسة قد تكون سليمة';
    app.error(`[whatsapp] ${state.sessionNote}`);
    return probe;
  }

  const problem = probe === 'corrupt' ? 'ملف الجلسة تالف' : 'لا توجد جلسة محلية';
  app.info(`[whatsapp] ${problem} — محاولة الاستعادة`);

  // Local copy first: it needs no credentials, is never staler than the R2
  // one, and can't fail on a dead tunnel.
  const local = await restoreFromLocal();
  if (local.ok) {
    state.sessionOrigin = 'restored';
    state.sessionNote = `${problem} — استُعيدت ${local.files} ملف من النسخة المحلية`;
    app.info(`[whatsapp] ${state.sessionNote}`);
    return probe;
  }

  const restore = await restoreSessionFromR2();
  if (restore.ok) {
    r2RestoreFailures = 0;
    state.sessionOrigin = 'restored';
    state.sessionNote = `${problem} — استُعيدت ${restore.files} ملف من نسخة R2`;
    app.info(`[whatsapp] ${state.sessionNote}`);
    return probe;
  }

  if (restore.reason === 'error' && r2RestoreFailures < MAX_R2_RESTORE_RETRIES) {
    r2RestoreFailures += 1;
    state.sessionNote = `${problem}، ولا نسخة محلية، وتعذّر الوصول إلى R2 — إعادة المحاولة (${r2RestoreFailures}/${MAX_R2_RESTORE_RETRIES}) قبل قبول هوية جديدة`;
    app.error(`[whatsapp] ${state.sessionNote}`, restore.error);
    return 'backup_unreachable';
  }
  r2RestoreFailures = 0;

  state.sessionNote =
    restore.reason === 'not_configured'
      ? `${problem}، ولا نسخة محلية، ونسخ R2 غير مُفعَّل`
      : `${problem}، ولا نسخة محلية، وتعذّرت الاستعادة من R2 (${restore.reason})`;
  app.error(`[whatsapp] ${state.sessionNote}`, restore.error);
  return probe;
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
  const probe = await prepareSession();
  if (probe === 'backup_unreachable') {
    // Same retry-with-backoff as below, for the same reason: nothing may
    // mint an identity while the real one might still be one download away.
    throw new Error('الجلسة مفقودة ونسخة R2 لم تُحمَّل بعد — إعادة المحاولة بدل توليد هوية جديدة');
  }
  if (probe === 'unreadable') {
    // Do not let useAtomicMultiFileAuthState's own creds read hit this exact
    // transient error independently — see prepareSession's comment. Throwing
    // here routes through the same retry-with-backoff every other transient
    // connect failure already uses (see startWhatsApp / scheduleReconnect).
    throw new Error('creds.json تعذّرت قراءته مؤقتاً — إعادة المحاولة لاحقاً بدل بناء حالة مصادقة عليه الآن');
  }
  const { state: authState, saveCreds } = await useAtomicMultiFileAuthState(authDir);

  // The authoritative check, and the reason prepareSession doesn't have to be
  // exactly right: an identity that never completed pairing is one no QR has
  // been scanned for, whether that's a genuine first run or a session that
  // just died. Retrying the connection can never fix it, so it's surfaced as
  // needsReauth (503 on /health) immediately instead of after a first failed
  // connect.
  //
  // `creds.me`, NOT `creds.registered`: Baileys sets `registered` only in the
  // pairing-CODE flow (messages-recv.js), never for a QR pairing — this
  // session's creds.json has `registered: false` while perfectly healthy. The
  // old test therefore flagged "needs a QR scan" on EVERY connect and
  // reconnect, so /health reported whatsapp_needs_reauth for the whole of any
  // ordinary outage and the monitor told a human to re-pair a working
  // session. `me` is what Baileys itself uses to choose between logging in
  // and registering a new device (socket.js).
  const linked = isLinkedIdentity(authState.creds);
  if (!linked) {
    state.sessionOrigin = 'fresh';
    state.needsReauth = true;
    // Set, not appended: this runs on every reconnect of a QR-pending
    // session, and the note used to grow by one suffix per attempt.
    if (!state.sessionNote?.includes(NEEDS_QR_SUFFIX)) {
      state.sessionNote = `${state.sessionNote ?? 'الجلسة غير مرتبطة'} — ${NEEDS_QR_SUFFIX}`;
    }
    app.error(`[whatsapp] ${state.sessionNote}`);

    // enforcement.ts promises not to let the service be re-paired while
    // WhatsApp's own restriction is running — scanning a QR then is the one
    // action most likely to extend it — but nothing enforced that: a restart
    // during the window put a fresh QR in the log for anyone to scan. A new
    // pairing is now not even offered until the window ends. An identity that
    // is already linked is unaffected; it only logs back in.
    const enforcement = activeEnforcement();
    if (enforcement) {
      state.sessionNote = `قيد واتساب نشط (${enforcement.type}) حتى ${new Date(enforcement.endsAtMs).toISOString()} — لن يُعرض QR قبل انتهائه`;
      app.error(`[whatsapp] ${state.sessionNote}`);
      scheduleReconnect(Math.max(0, enforcement.endsAtMs - Date.now()) + 60_000);
      return;
    }
  }

  const version = await getProtocolVersion();

  const previousSocket = socket;
  const myGeneration = ++generation;
  socket = makeWASocket({
    version,
    auth: authState,
    logger,

    // ملاحظة: هذه الإعدادات كانت مطبَّقة في بوت الألعاب النارية وحده — وهو
    // يخدم متجراً واحداً — بينما هذه الخدمة تخدم متجرين حيّين على رقم شخصي
    // حقيقي، أي أنها الأهم وكانت الأقل تحصيناً. النقل مقصود ليتطابق السلوك.

    // markOnlineOnConnect: الافتراضي true يُعلن الحساب «متصل» فور الاتصال،
    // فيبدأ واتساب بتسليم الإشعارات لهذا العميل بدل جوال المالك. أثران:
    // إشعارات واتساب تتوقف على الجوال الأصلي (والرقم هنا رقم شخصي مستعمل)،
    // وحضور دائم «متصل» لحساب لا يقرأ ولا يكتب إلا رموز تحقق — وهو نمط
    // ظاهر لعميل غير رسمي. مرسِل بحت لا يحتاج الحضور أصلاً.
    markOnlineOnConnect: false,

    // مزامنة السجل: عند كل ربط جديد يدفع واتساب سجل المحادثات كاملاً —
    // عشرات الميغابايتات تُفك وتُعالج على جوال كومته محدودة بـ256 ميغا. ولا
    // نقرأ الرسائل الواردة إطلاقاً.
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,

    // أحداث رسائلنا نحن تعود إلينا افتراضياً فتُعالَج بلا مستمع لها.
    emitOwnEvents: false,

    // نبضة الإبقاء: كل نبضة توقظ راديو الجوال. الافتراضي ٣٠ ثانية معقول على
    // خادم؛ مضاعفته تنصّف الإيقاظات بلا أثر على التسليم.
    keepAliveIntervalMs: config.whatsapp.keepAliveIntervalMs,
  });

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
    // A bare `void saveCreds()` turned any write failure — a full disk,
    // storage permissions, the folder renamed aside by a logout quarantine —
    // into an unhandled rejection, which ends the process on Node >= 15; pm2
    // then restarts it and WhatsApp reconnects, and on a full disk that
    // repeats forever. A failed save is logged; the next update retries it.
    saveCreds().catch((err) => app.error('[whatsapp] تعذّر حفظ بيانات الجلسة — ستُعاد المحاولة مع التحديث التالي', err));
    scheduleSessionBackup(app, backupEligible);
  });

  // WhatsApp announces an account restriction before acting on it, as a raw
  // `notification` node of type "mex" — NOT a message, so messages.upsert
  // never sees it (Baileys itself only logs it as "Invalid mex newsletter
  // notification" and moves on). Catching it here is the difference between
  // knowing the window and reverse-engineering it from a log line hours
  // later — see enforcement.ts.
  //
  // `CB:<tag>` raw-node listeners are an internal Baileys surface that has
  // moved between versions, so this is attached defensively: losing the
  // listener must never stop the service from connecting.
  try {
    const raw = (socket as unknown as { ws?: { on?: (ev: string, cb: (node: unknown) => void) => void } }).ws;
    raw?.on?.('CB:notification', (node: unknown) => {
      try {
        const found = parseEnforcement(node);
        if (found) noteEnforcement(found);
      } catch (err) {
        app.error('[whatsapp] تعذّر تحليل إشعار من واتساب', err);
      }
    });
  } catch (err) {
    app.error('[whatsapp] تعذّر تركيب مستمع إشعارات الحساب — سيعمل بلا كشف تلقائي للقيود', err);
  }

  socket.ev.on('connection.update', (update) => {
    if (myGeneration !== generation) return; // superseded socket — ignore
    const { connection, lastDisconnect, qr } = update;

    if (update.reachoutTimeLock) {
      try {
        applyReachoutTimelock(update.reachoutTimeLock);
      } catch (err) {
        app.error('[whatsapp] تعذّر تسجيل حالة قيد الحساب', err);
      }
    }

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
      openedAtMs = Date.now();
      // Starts (or resumes) the warm-up clock for this identity. A different
      // JID here means a genuine re-pair, which begins a new ramp — exactly
      // the situation after an enforcement, when the number is most fragile.
      const meId = socket?.user?.id;
      if (meId) {
        state.pairedAtMs = rememberPairing(meId);
        const verdict = checkSendRate(state.pairedAtMs);
        if (verdict.warmingUp) {
          app.info(
            `[whatsapp] رقم حديث الربط — سقف الإرسال ${verdict.limit}/ساعة خلال أول ${config.sendRate.warmupHours} ساعة`,
          );
        }
      }
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
      if (openedAtMs && Date.now() - openedAtMs >= STABLE_CONNECTION_MS) reconnectAttempt = 0;
      openedAtMs = 0;
      const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
        ?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      state.lastDisconnectReason = loggedOut ? 'logged_out' : `code_${statusCode ?? 'unknown'}`;

      if (loggedOut) {
        // Plan 8, layer 1: the one case that needs a human — new QR required.
        state.needsReauth = true;
        app.error('[whatsapp] تسجيل خروج فعلي — يحتاج مسح QR جديد. راقب /health.');
        // The identity is revoked on WhatsApp's own servers, so the local and
        // R2 backups are just as dead as this session — left alone, either
        // one would be auto-restored on the next connect attempt and repeat
        // this exact failure with no visible reason why. No reconnect is
        // scheduled here: that stays a human decision, same as before.
        //
        // Only for an identity that WAS linked. Backups are only ever taken
        // from a linked, connected session, so while a QR is still pending
        // (a fresh identity — perhaps because a restore failed on a bad
        // network) the backups on disk and in R2 belong to a DIFFERENT
        // identity, quite possibly the good one; quarantining them over a
        // 401 on the QR screen would destroy the only way back to it.
        if (linked) {
          void quarantineDeadSession(app).catch((err) => app.error('[whatsapp] فشل عزل الجلسة الميتة', err));
        }
        return;
      }

      if (statusCode === DisconnectReason.restartRequired) {
        // Expected right after a QR scan — see RESTART_REQUIRED_DELAY_MS.
        reconnectAttempt = 0;
        app.info('[whatsapp] واتساب طلب إعادة الاتصال بعد الربط — فوراً');
        scheduleReconnect(RESTART_REQUIRED_DELAY_MS);
        return;
      }
      if (statusCode === DisconnectReason.connectionReplaced || statusCode === DisconnectReason.forbidden) {
        state.lastDisconnectReason = statusCode === DisconnectReason.connectionReplaced ? 'connection_replaced' : 'forbidden';
        app.error(
          statusCode === DisconnectReason.connectionReplaced
            ? '[whatsapp] جهاز آخر فتح نفس الجلسة (440) — أوقف النسخة الأخرى. لن نتصارع معها: المحاولة التالية بعد ٣٠ دقيقة'
            : '[whatsapp] واتساب يرفض هذا الحساب (403) — المحاولة التالية بعد ٣٠ دقيقة',
        );
        scheduleReconnect(CONTESTED_RECONNECT_DELAY_MS);
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

// 463 in a message ack: this account may not start a chat with this contact
// right now — the reach-out restriction, or a missing privacy token that
// comes with it. Baileys' own guidance: never retry, each retry is another
// "reach out" counted against the account.
const ACCOUNT_RESTRICTED_ACK = '463';

/** WhatsApp's server answered a send with an error instead of accepting it. */
export class WhatsAppRejectedError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`whatsapp_rejected_${code}`);
    this.name = 'WhatsAppRejectedError';
    this.code = code;
  }

  /** Retrying cannot help and would make the account's standing worse. */
  get permanent(): boolean {
    return this.code === ACCOUNT_RESTRICTED_ACK;
  }
}

// How long the ack is waited for before the message is given up as not
// received. It is NOT the send's timeout — the worker bounds that (15 s) and
// holds the row back while this call is still running, recording it as sent
// if the ack lands late. waitForMessage's clock starts at registration, i.e.
// BEFORE sendMessage's own device and pre-key lookups for a new contact, so a
// short budget here failed sends that had in fact gone out, and the retry
// delivered a duplicate. A half-open socket still ends this early: its
// 'close' rejects the wait.
const ACK_GIVE_UP_MS = 4 * 60_000;

type AckingSocket = Pick<WASocket, 'sendMessage' | 'waitForMessage'> & { user?: { id?: string } };

/**
 * Sends and waits for the server's acknowledgement of THIS message.
 *
 * sendMessage() resolves the moment the stanza is written to the socket — not
 * when WhatsApp accepts it. A refusal (463 during a restriction, which every
 * new-contact code hits) arrives afterwards as an error ack that nothing here
 * listened for, and a half-open socket (the drop goes unnoticed until the next
 * keep-alive, up to two minutes on this phone) swallows the stanza without an
 * ack at all. Both were recorded 'sent': the customer waited for a code that
 * never came, the circuit breaker counted a success, and no fallback ran.
 *
 * The id is chosen here so the wait is registered BEFORE the send — the ack
 * can arrive before sendMessage's own promise resolves.
 */
export async function sendTextAwaitingAck(
  sock: AckingSocket,
  jid: string,
  text: string,
  ackTimeoutMs = ACK_GIVE_UP_MS,
): Promise<void> {
  const messageId = generateMessageIDV2(sock.user?.id);
  const ack = sock.waitForMessage<BinaryNode>(messageId, ackTimeoutMs);
  ack.catch(() => {}); // settled below; this only stops an early rejection counting as unhandled
  await sock.sendMessage(jid, { text }, { messageId });
  const node = await ack;
  if (!node) throw new Error('no_server_ack');
  const error = node.attrs?.error;
  if (error) throw new WhatsAppRejectedError(String(error));
}

export async function sendWhatsAppText(digitsOnlyPhone: string, text: string): Promise<void> {
  const sock = getSocket();
  try {
    await sendTextAwaitingAck(sock, toJid(digitsOnlyPhone), text);
  } catch (err) {
    if (err instanceof WhatsAppRejectedError && err.permanent) {
      // Ask WhatsApp whether the whole account is restricted: the answer
      // comes back as connection.update → applyReachoutTimelock, which stops
      // every other queued message from knocking on the same closed door.
      sock.fetchAccountReachoutTimelock().catch((fetchErr) => app.error('[whatsapp] تعذّر الاستعلام عن قيد الحساب', fetchErr));
    }
    throw err;
  }
}
