#!/data/data/com.termux/files/usr/bin/sh
# تدوير سجلات pm2 بالحجم. يشغّله scripts/maintenance.sh كل ساعة.
#
# بلا تدوير كانت السجلات تكبر إلى أن يمتلئ قرص الجوال، وعلى قرص ممتلئ ترفض
# قاعدة البيانات الكتابة فتفشل كل طلبات الكود في كل المواقع. التنظيف الوحيد
# كان `pm2 flush` اليدوي في phone-cooldown.sh.
#
# copytruncate لا نقل: pm2 يفتح السجلات بوضع الإلحاق (O_APPEND)، فتفريغ الملف
# في مكانه آمن والكتابة التالية تبدأ من أوله — بلا إعادة تشغيل أي عملية، ولكل
# إعادة تشغيل هنا ثمنها (إعادة ربط واتساب). يُحفظ جيل سابق واحد مضغوطاً.

LOG_HOME="${PM2_HOME:-$HOME/.pm2}"
MAX_BYTES="${LOG_MAX_BYTES:-5242880}" # ٥ ميغا لكل ملف

for f in "$LOG_HOME"/pm2.log "$LOG_HOME"/logs/*.log; do
  [ -f "$f" ] || continue
  size=$(wc -c < "$f")
  [ "$size" -gt "$MAX_BYTES" ] || continue
  if command -v gzip >/dev/null 2>&1; then
    gzip -c "$f" > "$f.1.gz.tmp" && mv -f "$f.1.gz.tmp" "$f.1.gz"
  else
    cp -f "$f" "$f.1"
  fi
  : > "$f"
  echo "[rotate-logs] $(basename "$f"): $size بايت ← 0"
done
