#!/data/data/com.termux/files/usr/bin/sh
# يضمن أن في .env مفتاح PROJECT_API_KEY_<ID> لكل مشروع في config/projects.json.
#
# الخدمة لا تُقلع أصلاً إن نقص مفتاح مشروع واحد (config.ts يرمي عند الإقلاع)،
# فمشروع يُضاف إلى projects.json بلا مفتاحه في .env الجوال = sms-api في حلقة
# انهيار، ومعه رموز التحقق لكل المواقع. القائمة هنا تُقرأ من projects.json
# نفسه لا من قائمة مكتوبة يدوياً — القائمة اليدوية هي ما نسي fireworks.
#
# المفتاح المولَّد يُطبع فقط حين تكون المخرجات طرفية حقيقية: push-to-phone.ps1
# يحوّل كل شيء إلى سجل على /sdcard يقرؤه أي تطبيق يملك صلاحية التخزين.

set -e
cd "$(dirname "$0")/.."
touch .env

ids=$(node -e 'for (const p of require("./config/projects.json")) console.log(p.id.toUpperCase())')
for id in $ids; do
  name="PROJECT_API_KEY_${id}"
  if grep -q "^${name}=." .env; then
    echo "  $name موجود — تُرك كما هو"
    continue
  fi
  # سطر فارغ `NAME=` يُحذف أولاً — وإلا بقي سطران للاسم نفسه.
  sed -i "/^${name}=\$/d" .env
  value=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
  printf '%s=%s\n' "$name" "$value" >> .env
  if [ -t 1 ]; then
    echo "  أُنشئ $name — انسخ القيمة التالية إلى secret الووركر المقابل (SMS_API_KEY):"
    echo ""
    echo "      $value"
    echo ""
  else
    echo "  أُنشئ $name — القيمة محفوظة في .env ولم تُطبع (المخرجات تُكتب في سجل)."
    echo "  اقرأها لاحقاً: adb shell \"run-as com.termux grep ${name} files/home/sms-api/.env\""
  fi
done
