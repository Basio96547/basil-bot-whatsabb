import { config } from './config.ts';
import { startWhatsApp } from './whatsapp/client.ts';
import { startWorker } from './queue/worker.ts';
import { scheduleDailyRetention } from './cleanup/retention.ts';
import { createServer } from './http/server.ts';

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
  app.listen(config.port, () => {
    console.log(`[boot] الخدمة تستمع على المنفذ ${config.port}`);
  });

  startWorker();
  scheduleDailyRetention();

  startWhatsApp();
}

main().catch((err) => {
  console.error('[boot] فشل تشغيل الخدمة', err);
  process.exit(1);
});
