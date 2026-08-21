// Runbook (plan 8, layer 6): يشتغل لو انفقدت/اتلفت جلسة واتساب المحلية.
// تشغيل: npx tsx scripts/restore-session.ts
//
// ملاحظة: الخدمة صارت تعمل هذي الاستعادة تلقائياً عند الإقلاع لو لقت ملف
// الجلسة ناقصاً أو تالفاً (راجع prepareSession في src/whatsapp/client.ts)،
// فهذا السكربت للحالات اليدوية فقط — مثلاً استعادة الجلسة على جهاز جديد قبل
// أول تشغيل، أو التأكد من أن النسخة الاحتياطية سليمة وتُفك بالمفتاح الحالي.

import { restoreSessionFromR2 } from '../src/whatsapp/sessionBackup.ts';

const MESSAGES: Record<string, string> = {
  not_configured: 'R2 غير مُعَدّ بـ .env — لا يوجد نسخة احتياطية لاستعادتها.',
  no_backup: 'لا توجد نسخة احتياطية في R2 بعد — يحتاج مسح QR من جديد.',
  error: 'فشلت الاستعادة (تحقق من SESSION_BACKUP_ENCRYPTION_KEY وبيانات R2).',
};

const result = await restoreSessionFromR2();

if (result.ok) {
  console.log(`تمت استعادة ${result.files} ملف جلسة. شغّل الخدمة الآن.`);
} else {
  console.error(MESSAGES[result.reason]);
  if (result.error) console.error(result.error);
  process.exit(1);
}
