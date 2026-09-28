#!/data/data/com.termux/files/usr/bin/sh
# صيانة دورية بلا تدخّل. يشغّله pm2 كل ساعة (تطبيق maintenance في
# ecosystem.config.cjs) — لا عملية مقيمة: يعمل ثوانيَ ويخرج، فيظهر "stopped"
# في pm2 status بين الدورات، وهذا طبيعي.

cd "$(dirname "$0")/.." || exit 1

echo "[maintenance] $(date '+%Y-%m-%d %H:%M:%S')"
sh scripts/rotate-logs.sh

# cloudflared مرة كل ٣٠ يوماً بعد نجاح، ولا أكثر من مرة في اليوم بعد فشل: التحديث
# الفاشل يُرجَع عنه، ومحاولته كل ساعة كانت ستنزّل ~٤٠ ميغا في كل مرة.
STATE="$HOME/.sms-api-maintenance"
mkdir -p "$STATE"
recent() { [ -n "$(find "$STATE/$1" -mtime "-$2" 2>/dev/null)" ]; }

if ! recent cloudflared-ok 30 && ! recent cloudflared-tried 1; then
  touch "$STATE/cloudflared-tried"
  if sh scripts/update-cloudflared.sh; then
    touch "$STATE/cloudflared-ok"
  fi
fi
