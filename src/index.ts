import { config } from './config.ts';
import { connectWhatsApp } from './whatsapp/client.ts';
import { startWorker } from './queue/worker.ts';
import { scheduleDailyRetention } from './cleanup/retention.ts';
import { createServer } from './http/server.ts';

async function main() {
  console.log(`[boot] ${config.projects.length} مشروع مُعرَّف: ${config.projects.map((p) => p.id).join(', ')}`);
  if (!config.sms.enabled) console.log('[boot] لا يوجد مزوّد SMS بعد — الإرسال عبر واتساب فقط حالياً (بند 6)');
  if (!config.sessionBackup.enabled) console.log('[boot] نسخ R2 الاحتياطي غير مُفعَّل — أضف بيانات R2 بـ .env لتشغيله (بند 8)');

  await connectWhatsApp();
  startWorker();
  scheduleDailyRetention();

  const app = createServer();
  app.listen(config.port, () => {
    console.log(`[boot] الخدمة تستمع على المنفذ ${config.port}`);
  });
}

main().catch((err) => {
  console.error('[boot] فشل تشغيل الخدمة', err);
  process.exit(1);
});
