#!/data/data/com.termux/files/usr/bin/sh
# يضمن أن في .env مفتاح PROJECT_API_KEY_<ID> لكل مشروع في config/projects.json.
#
# الخدمة لا تُقلع أصلاً إن نقص مفتاح مشروع واحد (config.ts يرمي عند الإقلاع)،
# فمشروع يُضاف إلى projects.json بلا مفتاحه في .env الجوال = sms-api في حلقة
# انهيار، ومعه رموز التحقق لكل المواقع. القائمة هنا تُقرأ من projects.json
# نفسه لا من قائمة مكتوبة يدوياً — القائمة اليدوية هي ما نسي fireworks.
#
# المنطق كله في ensure-project-keys.ts: قراءة .env بمحلّل dotenv نفسه، وإضافة
# لا تلتصق بسطر أخير بلا نهاية، وكتابة ذرّية. هذا الملف يبقى نقطة الدخول التي
# تستدعيها بقية السكربتات.

set -e
cd "$(dirname "$0")/.."
node --import tsx scripts/ensure-project-keys.ts
