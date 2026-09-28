#!/data/data/com.termux/files/usr/bin/sh
# يتأكد أن الإعداد والكود الجديدين يُقلعان قبل أن نمسّ الخدمة الحيّة.
#
# config.ts يفشل عمداً عند الإقلاع على أي خلل (مفتاح مشروع ناقص أو مثالي،
# رقم غير صالح في projects.json أو .env، قالب مكسور، مفتاحا API متطابقان).
# هذا الفشل المبكر جيد في التطوير، لكنه على الجوال كان يعني: pm2 delete ثم
# start لنسخة لا تُقلع = حلقة انهيار كل ٣ ثوانٍ وتوقّف التحقق لكل المواقع —
# و`pm2 save` بعدها يحفظ تلك الحال عبر إعادة إقلاع الجوال.
#
# لذلك يُحمَّل هنا كل ما يحمّله src/index.ts (لا config.ts وحده): خطأ صياغة في
# أي ملف، أو استيراد لملف غير موجود، أو حزمة جديدة لم يُثبّتها npm install —
# كلها كانت تمرّ من فحص config.ts وحده. التحميل على قاعدة بيانات مؤقتة تُحذف
# بعده، بلا اتصال واتساب ولا خادم HTTP؛ إن فشل خرجنا والخدمة القديمة ما زالت
# تعمل من ذاكرتها.

cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if DATA_DIR="$tmp" node --import tsx --input-type=module -e "
  await import('./src/config.ts');
  await import('./src/http/server.ts');
  await import('./src/queue/worker.ts');
  await import('./src/cleanup/retention.ts');
  await import('./src/whatsapp/client.ts');
  process.exit(0);
"; then
  echo "  الإعداد والكود سليمان"
else
  echo ""
  echo "  !!! الإعداد أو الكود الجديد لا يُقلع — لم يُعَد تشغيل شيء، والخدمة الحالية ما زالت تعمل."
  echo "  !!! أصلح السبب أعلاه (غالباً مفتاح ناقص في .env، أو npm install لم يُشغَّل) ثم أعد التشغيل."
  exit 1
fi
