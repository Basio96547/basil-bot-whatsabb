#!/data/data/com.termux/files/usr/bin/sh
# انسخ هذا الملف إلى ~/.termux/boot/termux-boot.sh (بند 7، نقطة 3 و8، طبقة 3)
# يحتاج تطبيق Termux:Boot مثبّتاً — من إصدارات Termux على GitHub نفسها التي
# جاء منها Termux (التطبيقان يتشاركان sharedUserId، فنسخة F-Droid ترفض
# التثبيت بجانب Termux من GitHub).
#
# لماذا لا نستدعي `pm2` مباشرة: $PREFIX/bin/pm2 سكربت يبدأ بـ
# `#!/usr/bin/env node`، و/usr/bin/env غير موجود على أندرويد. جلسة Termux
# التفاعلية تعمل فقط لأنها تحقن LD_PRELOAD=libtermux-exec الذي يعيد كتابة
# ذلك المسار — وTermux:Boot لا يحقنه. النتيجة (مُثبتة بتجربة إعادة إقلاع في
# 2026-09-03): "pm2: not found" ولا شيء يعود بعد إعادة الإقلاع. `command -v pm2`
# ينجح رغم ذلك (الملف موجود على PATH)، فلا تثق به لفحص هذا.
#
# والسجل هو بيت القصيد: فشل الإقلاع السابق لم يترك أي أثر، فلم يُشخَّص إلا
# بتجربة. ~/boot.log يُنسخ إلى /sdcard/sms-boot.log ليُقرأ عبر adb.

export PREFIX=/data/data/com.termux/files/usr
export HOME=/data/data/com.termux/files/home
export PATH="$PREFIX/bin:$PATH"
LOG="$HOME/boot.log"
PM2="$PREFIX/bin/node $PREFIX/lib/node_modules/pm2/bin/pm2"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }
mirror() { cp "$LOG" /sdcard/sms-boot.log 2>/dev/null || true; }

: > "$LOG"
log "boot script started"
termux-wake-lock

# الشبكة تتأخر بعد الإقلاع (وVPN بعدها) — pm2 resurrect قبلها يعني أن أول
# محاولة اتصال لكل خدمة تفشل وتدخل التباعد. حتى دقيقتين، ثم نكمل على أي حال.
tries=0
while [ "$tries" -lt 24 ] && ! ping -c 1 -W 2 1.1.1.1 >/dev/null 2>&1; do
  tries=$((tries + 1))
  sleep 5
done
log "network wait: $tries x 5s"

cd "$HOME/sms-api" || { log "~/sms-api missing"; mirror; exit 1; }
if $PM2 resurrect >> "$LOG" 2>&1; then
  log "pm2 resurrect ok"
else
  log "pm2 resurrect FAILED"
fi

# طبقة المراقبة (watchdog كل ١٥ دقيقة عبر termux-job-scheduler) تعيش على
# الجوال لا في هذا المستودع؛ تُعاد جدولتها إن وُجدت.
if [ -f "$HOME/.termux/watchdog-schedule.sh" ]; then
  sh "$HOME/.termux/watchdog-schedule.sh" >> "$LOG" 2>&1 && log "watchdog scheduled" || log "watchdog scheduling FAILED"
fi

$PM2 list >> "$LOG" 2>&1 || true
mirror
