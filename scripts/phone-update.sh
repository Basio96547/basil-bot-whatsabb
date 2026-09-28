#!/data/data/com.termux/files/usr/bin/sh
# تحديث الخدمة على الجوال بعد وصول كود جديد. آمن للتكرار — تشغيله مرتين لا يضر.
#
# الاستعمال داخل Termux (بعد `git pull` إن كان المجلد مستودع git، أو بعد نسخ
# الملفات يدوياً — ~/sms-api الحالي نُقل بـ adb push، وطريقه المعتاد هو
# scripts/push-to-phone.ps1 من الكمبيوتر):
#   sh ~/sms-api/scripts/phone-update.sh
#
# وُجد لأن التحديث اليدوي يحتاج عدة أوامر متتابعة، ولصقها سطراً سطراً في
# Termux أفسدها أكثر من مرة (أسطر تندمج، مسافات تُضاف). أمر واحد قصير أأمن.

set -e
cd "$(dirname "$0")/.."

echo "=== 0) الحزم ==="
# كود جديد قد يعتمد على حزمة جديدة؛ بدونها تُقلع الخدمة في حلقة انهيار
# (ERR_MODULE_NOT_FOUND). الفحص المسبق أدناه يكشف ذلك، لكن التثبيت هنا يجعله
# لا يحدث أصلاً.
npm install --omit=dev --no-audit --no-fund

echo "=== 1) مفاتيح المشاريع ==="
# لا يُكتب أي مفتاح داخل هذا الملف — المستودع على GitHub. المفقود يُولَّد هنا
# لكل مشروع في config/projects.json (كانت قائمة يدوية نسيت fireworks).
sh scripts/ensure-project-keys.sh

echo "=== 2) هل يُقلع الإعداد الجديد؟ ==="
sh scripts/preflight.sh

echo "=== 3) إعادة التشغيل ==="
# delete ثم start، لا restart: تغيّر خيارات ecosystem.config.cjs (مثل
# max_memory_restart) لا يلتقطه pm2 restart — يبقى على القيم المحفوظة وقت
# أول تشغيل، وهو ما جعل حدّ الذاكرة القديم يبدو "غير قابل للتعديل".
#
# `delete ecosystem.config.cjs` لا `delete all`: على هذا الجوال تطبيق ثالث
# (wa-bot-fireworks) ليس في هذا الملف. `delete all` كان يحذفه، ثم `pm2 save`
# يحفظ القائمة بدونه — فيبقى البوت ميتاً حتى يلتقطه الـwatchdog، ولا يعود
# بعد إعادة إقلاع الجوال.
pm2 delete ecosystem.config.cjs 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save

echo "=== 4) انتظار الإقلاع ==="
sleep 15
pm2 status

echo "=== 5) الفحص المحلي ==="
key=$(grep '^PROJECT_API_KEY_STORE=' .env | tail -1 | cut -d= -f2- | tr -d '\r"')
# `|| echo` لأن `set -e` أعلاه كان سيوقف السكربت قبل طباعة النتيجة لو ردّ
# curl بخطأ — وهي بالضبط الحالة التي نحتاج أن نراها فيها.
curl -s -m 10 -H "Authorization: Bearer $key" http://127.0.0.1:3000/health || echo "(الخدمة لم تردّ بعد)"
echo ""
echo "=== تم ==="
echo "تحقّق من الخارج أيضاً: https://sms-api.talisham.com/health"
