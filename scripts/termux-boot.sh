#!/data/data/com.termux/files/usr/bin/sh
# انسخ هذا الملف إلى ~/.termux/boot/termux-boot.sh (بند 7، نقطة 3 و8، طبقة 3)
# يحتاج تطبيق Termux:Boot مثبّتاً (من F-Droid، نفس مطوّري Termux) — بدونه
# أندرويد ما يشغّل أي سكربت تلقائياً بعد إعادة الإقلاع.

termux-wake-lock

cd ~/sms-api || exit 1
pm2 resurrect
