#!/data/data/com.termux/files/usr/bin/sh
# تحديث cloudflared بأمان. يشغّله scripts/maintenance.sh مرة في الشهر، ويصلح
# يدوياً أيضاً: sh scripts/update-cloudflared.sh
#
# لماذا: Cloudflare لا تدعم إلا نسخ cloudflared التي عمرها أقل من سنة من أحدث
# إصدار، والتونيل يعمل بـ --no-autoupdate (ecosystem.config.cjs) — فبلا هذا
# كان سيتعطل يوماً ما دون سابق إنذار. والتحديث الذاتي المدمج ليس بديلاً: يعيد
# التشغيل دون أن يتحقق أن النسخة الجديدة تتصل، ولا رجوع فيه.
#
# هنا: نسخة احتياطية ← تحديث ← هل تقبل الجديدة أعلام ecosystem.config.cjs؟ ←
# إعادة تشغيل التونيل ← هل يصل الطلب من الإنترنت فعلاً؟ أي فشل = رجوع للقديمة.
#
# الخروج: 0 لا تحديث أو نجح، 1 فشل وبقيت القديمة.

cd "$(dirname "$0")/.." || exit 1

CHECK_URL="${TUNNEL_CHECK_URL:-https://sms-api.talisham.com/health}"
TUNNEL_APP=cloudflared-tunnel

# pm2 سكربت يبدأ بـ #!/usr/bin/env node، و/usr/bin/env غير موجود على أندرويد
# خارج جلسة Termux التفاعلية (راجع termux-boot.sh) — وهذا يعمل تحت pm2 نفسه.
if [ -n "$PREFIX" ] && [ -f "$PREFIX/lib/node_modules/pm2/bin/pm2" ]; then
  PM2="$PREFIX/bin/node $PREFIX/lib/node_modules/pm2/bin/pm2"
else
  PM2=pm2
fi

bin=$(command -v cloudflared) || { echo "[cloudflared] غير مثبّت — لا شيء لتحديثه"; exit 0; }
before=$("$bin" --version 2>/dev/null)

# نفس ما يشغّله pm2: وسائط التطبيق من ecosystem.config.cjs بلا اسم التونيل.
flags_ok() {
  args=$(grep -o "args: 'tunnel[^']*'" ecosystem.config.cjs | head -1 | sed "s/^args: '//; s/'\$//")
  [ -n "$args" ] || return 0
  # shellcheck disable=SC2086 # تقسيم الوسائط مقصود
  "$bin" ${args% *} --help >/dev/null 2>&1
}

# 401 = وصل الطلب إلى الخدمة عبر التونيل (بلا مفتاح). 530 = التونيل ساقط.
tunnel_ok() {
  i=0
  while [ "$i" -lt 12 ]; do
    code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$CHECK_URL")
    case "$code" in 200 | 401 | 503) return 0 ;; esac
    i=$((i + 1))
    sleep 5
  done
  return 1
}

rollback() {
  echo "[cloudflared] $1 — رجوع إلى: $before"
  mv -f "$bin.prev" "$bin"
  $PM2 restart "$TUNNEL_APP" >/dev/null 2>&1
  exit 1
}

cp -f "$bin" "$bin.prev" || { echo "[cloudflared] تعذّر أخذ نسخة احتياطية — لا تحديث"; exit 1; }

if command -v dpkg >/dev/null 2>&1 && dpkg -S "$bin" >/dev/null 2>&1; then
  # مثبّت من حزم Termux: `cloudflared update` يرفض هذا بصمت ويخرج بـ 0.
  apt-get update >/dev/null 2>&1
  apt-get install -y --only-upgrade cloudflared >/dev/null 2>&1 || {
    rm -f "$bin.prev"
    echo "[cloudflared] فشل التحديث عبر apt — النسخة الحالية باقية"
    exit 1
  }
else
  # 11 = حُدِّث، 0 = لا جديد، 10 = خطأ (cmd/cloudflared/updater/update.go)
  "$bin" update >/dev/null 2>&1
  rc=$?
  if [ "$rc" -ne 0 ] && [ "$rc" -ne 11 ]; then
    [ -x "$bin" ] && "$bin" --version >/dev/null 2>&1 || mv -f "$bin.prev" "$bin"
    rm -f "$bin.prev"
    echo "[cloudflared] فشل التحديث (رمز $rc) — النسخة الحالية باقية"
    exit 1
  fi
fi

after=$("$bin" --version 2>/dev/null)
if [ "$after" = "$before" ]; then
  rm -f "$bin.prev"
  echo "[cloudflared] لا جديد: $before"
  exit 0
fi

flags_ok || rollback "النسخة الجديدة ($after) لا تقبل أعلام ecosystem.config.cjs"
$PM2 restart "$TUNNEL_APP" >/dev/null 2>&1 || rollback "تعذّرت إعادة تشغيل $TUNNEL_APP"
tunnel_ok || rollback "التونيل لم يعد يوصل الطلبات بعد التحديث ($CHECK_URL)"

rm -f "$bin.prev"
echo "[cloudflared] حُدِّث: $before ← $after"
