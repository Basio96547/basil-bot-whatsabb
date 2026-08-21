#!/data/data/com.termux/files/usr/bin/sh
# تحديث الخدمة على الجوال بعد `git pull`. آمن للتكرار — تشغيله مرتين لا يضر.
#
# الاستعمال داخل Termux:
#   cd ~/sms-api && git pull
#   sh scripts/phone-update.sh
#
# وُجد لأن التحديث اليدوي يحتاج عدة أوامر متتابعة، ولصقها سطراً سطراً في
# Termux أفسدها أكثر من مرة (أسطر تندمج، مسافات تُضاف). أمر واحد قصير أأمن.

set -e
cd "$(dirname "$0")/.."

echo "=== 1) مفاتيح المشاريع ==="
# لا يُكتب أي مفتاح داخل هذا الملف — المستودع على GitHub. المفقود يُولَّد هنا
# ويُطبع مرة واحدة ليُنسخ إلى secret الووركر المقابل.
ensure_key() {
  key_name="$1"
  if grep -q "^${key_name}=" .env 2>/dev/null; then
    echo "  $key_name موجود — تُرك كما هو"
  else
    value=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
    printf '%s=%s\n' "$key_name" "$value" >> .env
    echo "  أُنشئ $key_name — انسخ القيمة التالية إلى secret الووركر:"
    echo ""
    echo "      $value"
    echo ""
  fi
}
ensure_key PROJECT_API_KEY_QAREEB

echo "=== 2) إعادة التشغيل ==="
# delete ثم start، لا restart: تغيّر خيارات ecosystem.config.cjs (مثل
# max_memory_restart) لا يلتقطه pm2 restart — يبقى على القيم المحفوظة وقت
# أول تشغيل، وهو ما جعل حدّ الذاكرة القديم يبدو "غير قابل للتعديل".
pm2 delete all 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save

echo "=== 3) انتظار الإقلاع ==="
sleep 15
pm2 status

echo "=== 4) الفحص المحلي ==="
key=$(grep '^PROJECT_API_KEY_STORE=' .env | cut -d= -f2-)
curl -s -m 10 -H "Authorization: Bearer $key" http://localhost:3000/health
echo ""
echo "=== تم ==="
echo "تحقّق من الخارج أيضاً: https://sms-api.talisham.com/health"
