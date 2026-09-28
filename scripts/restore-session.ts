// Runbook (plan 8, layer 6): يشتغل لو انفقدت/اتلفت جلسة واتساب المحلية.
//
//   npx tsx scripts/restore-session.ts                 فحص فقط: ينزّل النسخة من R2 ويفكّها ولا يلمس شيئاً
//   npx tsx scripts/restore-session.ts --apply         استعادة فعلية — والخدمة موقوفة (pm2 stop sms-api)
//   npx tsx scripts/restore-session.ts --apply --force استعادة فوق جلسة محلية سليمة (نادراً ما تريد هذا)
//
// ملاحظة: الخدمة صارت تعمل هذي الاستعادة تلقائياً عند الإقلاع لو لقت ملف
// الجلسة ناقصاً أو تالفاً (راجع prepareSession في src/whatsapp/client.ts)،
// فهذا السكربت للحالات اليدوية فقط — استعادة الجلسة على جهاز جديد قبل أول
// تشغيل، أو التأكد من أن النسخة الاحتياطية سليمة وتُفك بالمفتاح الحالي.
//
// الفحص هو الافتراضي لأن الاستعادة تمسح كل مفتاح حيّ ليس في النسخة وتكتب
// creds.json من R2 فوق المحلي — ونسخة R2 أقدم من المحلية بطبيعتها (وقد تكون
// أقدم بأيام إن كان الرفع يفشل). كان تشغيله «للتأكد فقط»، كما كانت
// التعليمات تقترح، يستبدل جلسة حيّة بأقدم منها؛ وإن كانت الخدمة تعمل فإنها
// تعيد كتابة بياناتها التي في الذاكرة فوق مفاتيح أقدم: خليط لا يفك الرسائل.

import path from 'node:path';
import { config } from '../src/config.ts';
import { probeCreds } from '../src/whatsapp/authState.ts';
import { fetchR2Backup, restoreSessionFromR2 } from '../src/whatsapp/sessionBackup.ts';

const MESSAGES: Record<string, string> = {
  not_configured: 'R2 غير مُعَدّ بـ .env — لا يوجد نسخة احتياطية لاستعادتها.',
  no_backup: 'لا توجد نسخة احتياطية في R2 بعد — يحتاج مسح QR من جديد.',
  error: 'فشل التنزيل أو فك التشفير (تحقق من SESSION_BACKUP_ENCRYPTION_KEY وبيانات R2).',
};

const apply = process.argv.includes('--apply');
const force = process.argv.includes('--force');

function fail(reason: string, error?: unknown): never {
  console.error(MESSAGES[reason] ?? reason);
  if (error) console.error(error);
  process.exit(1);
}

if (!apply) {
  const fetched = await fetchR2Backup();
  if (!fetched.ok) fail(fetched.reason, fetched.error);
  const creds = fetched.files.find(([name]) => name === 'creds.json');
  const me = creds ? (JSON.parse(creds[1]) as { me?: { id?: string } }).me?.id : undefined;
  console.log(`النسخة في R2 سليمة وتُفك بالمفتاح الحالي: ${fetched.files.length} ملف، الهوية ${me ?? '(غير مرتبطة)'}.`);
  console.log('لم يُغيَّر شيء. للاستعادة الفعلية: أوقف الخدمة ثم أعد التشغيل مع --apply');
  process.exit(0);
}

const live = await probeCreds(path.join(config.dataDir, 'auth-session'));
if (live === 'ok' && !force) {
  fail(
    'الجلسة المحلية سليمة — الاستعادة ستستبدلها بنسخة R2 الأقدم. إن كنت متأكداً (والخدمة موقوفة) أضف --force',
  );
}

const result = await restoreSessionFromR2();
if (!result.ok) fail(result.reason, result.error);
console.log(`تمت استعادة ${result.files} ملف جلسة. شغّل الخدمة الآن.`);
