import path from 'node:path';
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  type WASocket,
} from '@whiskeysockets/baileys';
import qrcodeTerminal from 'qrcode-terminal';
import pino from 'pino';
import { config } from '../config.ts';
import { scheduleSessionBackup } from './sessionBackup.ts';

const logger = pino({ level: 'silent' }); // Baileys' own internal logger — noisy at 'info', we log our own lines below
const app = { info: (m: string) => console.log(m), error: (m: string, e?: unknown) => console.error(m, e ?? '') };

// Plan 8, layer 1: reconnect on any drop except an actual logout, with
// increasing backoff so a long outage doesn't hammer the network.
const RECONNECT_DELAYS_MS = [5_000, 15_000, 60_000];
let reconnectAttempt = 0;

export interface ConnectionState {
  connected: boolean;
  needsReauth: boolean;
  lastConnectedAt: string | null;
  lastDisconnectReason: string | null;
}

const state: ConnectionState = {
  connected: false,
  needsReauth: false,
  lastConnectedAt: null,
  lastDisconnectReason: null,
};

export function getConnectionState(): ConnectionState {
  return { ...state };
}

let socket: WASocket | null = null;

export function getSocket(): WASocket {
  if (!socket) throw new Error('WhatsApp socket not initialized yet');
  return socket;
}

export async function connectWhatsApp(): Promise<void> {
  const authDir = path.join(config.dataDir, 'auth-session');
  const { state: authState, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  socket = makeWASocket({ version, auth: authState, logger });

  socket.ev.on('creds.update', () => {
    void saveCreds();
    scheduleSessionBackup(app);
  });

  socket.ev.on('connection.update', (update) => {
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
      reconnectAttempt = 0;
      app.info('[whatsapp] متصل');
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

      const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
      reconnectAttempt += 1;
      app.info(`[whatsapp] انقطع الاتصال (${state.lastDisconnectReason}) — إعادة محاولة خلال ${delay / 1000}ث`);
      setTimeout(() => {
        connectWhatsApp().catch((err) => app.error('[whatsapp] فشلت إعادة الاتصال', err));
      }, delay);
    }
  });
}

export function toJid(digitsOnlyPhone: string): string {
  return `${digitsOnlyPhone}@s.whatsapp.net`;
}

export async function sendWhatsAppText(digitsOnlyPhone: string, text: string): Promise<void> {
  await getSocket().sendMessage(toJid(digitsOnlyPhone), { text });
}
