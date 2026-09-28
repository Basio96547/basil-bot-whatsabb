import { config } from './config.ts';
import { startWhatsApp } from './whatsapp/client.ts';
import { startWorker, stopWorker } from './queue/worker.ts';
import { scheduleDailyRetention } from './cleanup/retention.ts';
import { createServer } from './http/server.ts';

// How long a stop waits for the message being sent right now. pm2's
// kill_timeout (ecosystem.config.cjs) must stay above this, or pm2 kills the
// process before it has finished waiting.
const SHUTDOWN_GRACE_MS = 15_000;

async function main() {
  console.log(`[boot] ${config.projects.length} مشروع مُعرَّف: ${config.projects.map((p) => p.id).join(', ')}`);
  if (!config.sms.enabled) console.log('[boot] لا يوجد مزوّد SMS بعد — الإرسال عبر واتساب فقط حالياً (بند 6)');
  if (!config.sessionBackup.enabled) console.log('[boot] نسخ R2 الاحتياطي غير مُفعَّل — أضف بيانات R2 بـ .env لتشغيله (بند 8)');

  // The HTTP server comes up first, before anything that touches the network.
  // connectWhatsApp() fetches the current protocol version over the internet
  // with no timeout of its own, so awaiting it here meant that on a
  // half-connected network (booting before the router is back, a VPN still
  // dialing) the API answered "connection refused" for minutes instead of a
  // clean 503 from /health — which is precisely when a monitor needs to reach
  // it. The queue worker tolerates a socket that isn't up yet.
  const app = createServer();
  const server = app.listen(config.port, config.host, () => {
    console.log(`[boot] الخدمة تستمع على ${config.host}:${config.port}`);
  });

  startWorker();
  scheduleDailyRetention();

  startWhatsApp();

  // pm2 stops a process with SIGINT (a deploy, max_memory_restart, `pm2
  // restart`) and it used to die mid-send: a message WhatsApp had already
  // delivered stayed 'pending' with no attempt recorded, and went out a
  // second time after the restart. Now the send in progress is allowed to
  // finish (or time out) first. The WhatsApp socket is deliberately NOT
  // logged out — only a human unlinks this device.
  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`[shutdown] ${signal} — إنهاء الرسالة الجارية ثم الإيقاف`);
    server.close();
    const grace = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS).unref());
    void Promise.race([stopWorker(), grace]).finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[boot] فشل تشغيل الخدمة', err);
  process.exit(1);
});
