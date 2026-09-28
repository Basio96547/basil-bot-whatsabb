#!/data/data/com.termux/files/usr/bin/sh
# تشخيص سخونة الجوال ثم تطبيق الإصلاح. آمن للتكرار.
#
# الاستعمال داخل Termux:
#   sh ~/sms-api/scripts/phone-cooldown.sh
#
# يطبع قسم "قبل" كاملاً قبل أن يغيّر أي شيء — الرقم المهم فيه هو
# restarts: عدد ثلاثي أو أكثر مع وقت تشغيل قصير يعني أن pm2 كان يقتل الخدمة
# في حلقة، وهو أكبر مصدر حرارة ممكن في هذا الإعداد (كل قتلة = إقلاع Node
# وترجمة TypeScript وإعادة ربط واتساب من الصفر).

set -e
cd "$(dirname "$0")/.."

# لا يوقف السكربت: هذه أوامر قراءة قد لا تكون متاحة لتطبيق غير جذر على
# أندرويد حديث، وغيابها ليس فشلاً.
try() { "$@" 2>/dev/null || echo "  (غير متاح)"; }

echo "=========================================="
echo "=== قبل: ما الذي يحرق المعالج فعلاً؟   ==="
echo "=========================================="
date

echo ""
echo "--- حِمل المعالج ---"
try cat /proc/loadavg
echo "  (الرقم الأول = متوسط الحِمل في آخر دقيقة. فوق 4 على هذا الجهاز = سخونة مستمرة)"

echo ""
echo "--- حرارة الجهاز ---"
try sh -c 'for z in /sys/class/thermal/thermal_zone*/; do t=$(cat "$z/temp" 2>/dev/null) || continue; n=$(cat "$z/type" 2>/dev/null); [ -n "$t" ] && [ "$t" -gt 1000 ] && echo "  $n: $((t/1000))°C"; done | head -12'

echo ""
echo "--- حالة تطبيقات pm2 ---"
pm2 jlist > "$HOME/.pm2-jlist.json" 2>/dev/null || true
node -e '
try {
  const raw = require("fs").readFileSync(process.env.HOME + "/.pm2-jlist.json", "utf-8");
  const apps = JSON.parse(raw.slice(raw.indexOf("[")));
  if (!apps.length) { console.log("  لا توجد تطبيقات — pm2 فارغ أو ميت"); }
  for (const a of apps) {
    const e = a.pm2_env || {}, m = a.monit || {};
    const up = e.pm_uptime ? Math.round((Date.now() - e.pm_uptime) / 60000) : 0;
    console.log(`  ${a.name}: restarts=${e.restart_time ?? "?"} unstable=${e.unstable_restarts ?? 0} ` +
      `عمر=${up}د ذاكرة=${Math.round((m.memory || 0) / 1048576)}MB معالج=${m.cpu ?? "?"}% ` +
      `سقف=${e.max_memory_restart ? Math.round(e.max_memory_restart / 1048576) + "MB" : "بلا"} حالة=${e.status}`);
  }
} catch (err) { console.log("  تعذّرت قراءة pm2 jlist:", err.message); }
' || true

echo ""
echo "--- هل كان pm2 يقتل الخدمة لتجاوز الذاكرة؟ ---"
# الفحص على وجود الملف لا على `||` بعد أنبوب: حالة الأنبوب حالة sed، فكان
# «(لا سجل)» لا يُطبع أبداً حين يغيب السجل.
if [ -f "$HOME/.pm2/pm2.log" ]; then
  echo "  عدد مرات القتل المسجّلة: $(grep -c 'exceeds --max-memory-restart' "$HOME/.pm2/pm2.log" || true)"
  grep 'exceeds --max-memory-restart' "$HOME/.pm2/pm2.log" | tail -3 | sed 's/^/  /' || true
else
  echo "  (لا سجل)"
fi
# والوجه الآخر لنفس المشكلة: --max-old-space-size=256 يجعل V8 نفسه ينهار
# عند السقف بدل أن يقتله pm2 — ولا يظهر ذلك في pm2.log بل في سجل أخطاء الخدمة.
if [ -f "$HOME/.pm2/logs/sms-api-error.log" ]; then
  echo "  انهيارات نفاد كومة V8: $(grep -c 'heap out of memory' "$HOME/.pm2/logs/sms-api-error.log" || true)"
fi

echo ""
echo "--- حجم سجلات pm2 (كتابة متواصلة على الذاكرة الفلاشية) ---"
try du -sh "$HOME/.pm2/logs"

echo ""
echo "=========================================="
echo "=== التطبيق                            ==="
echo "=========================================="

echo "1) اختبار علم cloudflared قبل الاعتماد عليه"
# التونيل هو الطريق الوحيد للمتجر إلى هذه الخدمة. علم غير مدعوم في هذه
# النسخة يعني تونيلاً يفشل عند الإقلاع ومتجراً معطّلاً — فيُختبر أولاً،
# ويُتراجع عنه تلقائياً بدل أن يُكتشف بعد فوات الأوان. العدد يُقرأ من
# ecosystem.config.cjs نفسه: الاختبار كان مكتوباً بـ"1" بعد أن صار الملف "2"،
# فصار الرجوع لا يطابق شيئاً ويفشل بصمت.
#
# من سطر `args:` وحده: التعليق فوقه يذكر "--ha-connections 2" أيضاً، وكان
# أول تطابق في الملف هو التعليق لا القيمة الفعلية.
#
# والحكم من نص المخرجات لا من رمز الخروج: cloudflared يخرج بـ0 حتى مع علم
# مجهول ("flag provided but not defined")، فكان الاختبار ينجح دائماً ولا يصل
# التراجع أبداً.
ha=$(grep -E '^[[:space:]]*args:' ecosystem.config.cjs | grep -o -- '--ha-connections [0-9]*' | head -1 | grep -o '[0-9]*$' || true)
if [ -z "$ha" ]; then
  echo "   لا يوجد --ha-connections في الملف — لا شيء لاختباره"
elif cloudflared tunnel --no-autoupdate --ha-connections "$ha" run --help 2>&1 | grep -q 'not defined'; then
  echo "   غير مدعوم في هذه النسخة — التراجع إلى الصيغة القديمة"
  sed -i "s/tunnel --no-autoupdate --ha-connections [0-9]* run sms-api/tunnel --no-autoupdate run sms-api/" ecosystem.config.cjs
else
  echo "   مدعوم — سيُشغَّل بـ $ha اتصال QUIC"
fi

echo "2) مفاتيح المشاريع، وهل يُقلع الإعداد الجديد؟"
# قبل أي delete: مشروع بلا مفتاحه في .env = خدمة لا تُقلع. إن فشل الفحص
# نخرج هنا والخدمة الحالية ما زالت تعمل.
sh scripts/ensure-project-keys.sh
sh scripts/preflight.sh

echo "3) تفريغ السجلات المتراكمة"
pm2 flush >/dev/null 2>&1 || true

echo "4) إعادة إنشاء التطبيقات (delete ثم start، لا restart)"
# pm2 restart لا يقرأ ecosystem.config.cjs المعدَّل أبداً — يحتفظ بالقيم
# الملتقطة وقت أول تشغيل. لهذا كان سقف الذاكرة القديم يبدو "غير قابل
# للتعديل"، وهو تحديداً ما نحتاج التأكد من زواله هنا.
#
# تطبيقات هذا الملف فقط، لا `delete all`: wa-bot-fireworks يعمل على نفس
# الجوال، و`delete all` ثم `pm2 save` كان يحذفه ويحفظ القائمة بدونه.
pm2 delete ecosystem.config.cjs >/dev/null 2>&1 || true
pm2 start ecosystem.config.cjs
pm2 save >/dev/null

echo "5) انتظار الاستقرار (٣٠ ثانية)"
sleep 30

echo ""
echo "=========================================="
echo "=== بعد                                ==="
echo "=========================================="
pm2 status

echo ""
echo "--- الحِمل الآن ---"
try cat /proc/loadavg

echo ""
echo "--- الفحص المحلي ---"
# آخر تعريف (dotenv يأخذ الأخير)، وبلا \r أو علامات اقتباس — وإلا ذهبت إلى
# ترويسة Authorization وردّت الخدمة 401 وكأنها معطّلة.
key=$(grep '^PROJECT_API_KEY_STORE=' .env | tail -1 | cut -d= -f2- | tr -d '\r"')
# 127.0.0.1 صراحةً: الخدمة تستمع على الحلقة المحلية (HOST في .env).
curl -s -m 15 -H "Authorization: Bearer $key" http://127.0.0.1:3000/health || echo "(الخدمة لم تردّ)"
echo ""

echo ""
echo "=========================================="
echo "=== ما يجب أن تراه                     ==="
echo "=========================================="
echo "  * sms-api وcloudflared-tunnel وwa-bot-fireworks كلها online، وrestarts=0 للأوّلَين"
echo "  * الخدمة تردّ بـ whatsapp connected=true"
echo "  * سقف الذاكرة صار 400MB لا 200MB"
echo ""
echo "أعد تشغيل هذا السكربت بعد ساعة: إن كان restarts لا يزال 0 فحلقة"
echo "القتل انتهت فعلاً، وإن ارتفع فالسبب شيء آخر ويحتاج نظرة جديدة."
