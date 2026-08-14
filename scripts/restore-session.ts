// Runbook (plan 8, layer 6): يشتغل لو انفقدت/اتلفت جلسة واتساب المحلية.
// تشغيل: npx tsx scripts/restore-session.ts
// يحمّل آخر نسخة من R2، يفك تشفيرها، يعيد كتابة ملفات الجلسة، وبعدها شغّل
// الخدمة عادي (npm start) بدون مسح QR من جديد.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from '../src/config.ts';
import { decryptBundle, BACKUP_KEY } from '../src/whatsapp/sessionBackup.ts';

async function main() {
  if (!config.sessionBackup.enabled) {
    console.error('R2 غير مُعَدّ بـ .env — لا يوجد نسخة احتياطية لاستعادتها.');
    process.exit(1);
  }

  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${config.sessionBackup.r2AccountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.sessionBackup.r2AccessKeyId,
      secretAccessKey: config.sessionBackup.r2SecretAccessKey,
    },
  });

  const response = await s3.send(new GetObjectCommand({ Bucket: config.sessionBackup.r2Bucket, Key: BACKUP_KEY }));
  const chunks: Buffer[] = [];
  for await (const chunk of response.Body as AsyncIterable<Buffer>) chunks.push(chunk);
  const encrypted = Buffer.concat(chunks);

  const bundle = JSON.parse(decryptBundle(encrypted)) as Record<string, string>;
  const authDir = path.join(config.dataDir, 'auth-session');
  mkdirSync(authDir, { recursive: true });
  for (const [filename, content] of Object.entries(bundle)) {
    writeFileSync(path.join(authDir, filename), content, 'utf-8');
  }

  console.log(`تمت استعادة ${Object.keys(bundle).length} ملف جلسة إلى ${authDir}. شغّل الخدمة الآن.`);
}

main().catch((err) => {
  console.error('فشلت الاستعادة:', err);
  process.exit(1);
});
