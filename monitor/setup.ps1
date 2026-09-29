# يركّب مراقب sms-api على Cloudflare ويربطه بتنبيهات تيليجرام — من الكمبيوتر.
#
#   powershell -ExecutionPolicy Bypass -File "C:\Users\PC\sms-api-new\monitor\setup.ps1"
#
# آمن للتكرار: إعادة تشغيله تنشر آخر نسخة، وEnter عند سؤال تيليجرام يُبقي ضبطه.
# يحتاج الجوال موصولاً بـ USB مرة واحدة فقط، لقراءة مفتاح API من .env الجوال.

$ErrorActionPreference = 'Stop'
$adb = 'C:\Users\PC\Desktop\platform-tools\adb.exe'
Set-Location $PSScriptRoot

# ErrorActionPreference لا يوقف شيئاً عند فشل أمر خارجي — يُفحص رمز خروجه هنا.
function Invoke-Native {
    $exe, $rest = $args
    & $exe @rest
    if ($LASTEXITCODE -ne 0) { throw "$($args -join ' ') فشل (رمز $LASTEXITCODE)" }
}

Write-Host '=== 1) wrangler ===' -ForegroundColor Cyan
if (-not (Test-Path 'node_modules\.bin\wrangler.cmd')) { Invoke-Native npm install --no-audit --no-fund }
# whoami يخرج بنجاح حتى بلا تسجيل دخول، فالحكم من نصّه. و'Continue' حوله:
# wrangler يكتب تحذيراته على stderr، و2>&1 تحت 'Stop' في PowerShell 5.1 يجعل
# أول سطر منها خطأً قاتلاً.
$ErrorActionPreference = 'Continue'
$who = & npx wrangler whoami 2>&1 | Out-String
$ErrorActionPreference = 'Stop'
if ($who -match 'not authenticated') {
    Write-Host '  سجّل الدخول لحساب Cloudflare الذي فيه talisham.com (سيُفتح المتصفح)'
    Invoke-Native npx wrangler login
}

Write-Host '=== 2) مفتاح API من الجوال ===' -ForegroundColor Cyan
# مفتاح fireworks: مسجَّل في الخدمة ولا يستعمله أي موقع بعد، فتدويره لاحقاً لا
# يمسّ المراقب ولا المراقبُ يمسّه. المراقب يطلب /health وحده.
$key = $null
$ErrorActionPreference = 'Continue'
if (Test-Path $adb) {
    $line = & $adb shell 'run-as com.termux grep ^PROJECT_API_KEY_FIREWORKS= files/home/sms-api/.env' 2>$null | Select-Object -Last 1
    if ($line -match '^PROJECT_API_KEY_FIREWORKS=(.+)$') { $key = $Matches[1].Trim().Trim('"') }
}
$ErrorActionPreference = 'Stop'
if (-not $key) {
    Write-Host '  تعذّرت قراءته عبر adb (الجوال غير موصول؟). الصق قيمة أي PROJECT_API_KEY_… من .env الجوال:' -ForegroundColor Yellow
    $key = (Read-Host '  المفتاح').Trim()
}
if (-not $key) { throw 'لا مفتاح — لا يمكن للمراقب قراءة /health' }
Write-Host '  وُجد المفتاح'

Write-Host '=== 3) قناة التنبيهات (تيليجرام) ===' -ForegroundColor Cyan
# لا ntfy.sh: من شبكة Cloudflare يرفض الاتصال (522) أو يردّ 429 «نفدت الحصة
# اليومية» — عناوين Workers الصادرة مشتركة بين الجميع، فحصّة ntfy المجانية لكل
# عنوان تُستهلك قبل أول تنبيه (مقيس في 2026-09-29). تيليجرام يردّ من نفس المكان.
$secrets = @{ SMS_API_KEY = $key }
Write-Host '  أنشئ بوتاً: في تيليجرام افتح @BotFather ← /newbot ← انسخ التوكن الذي يعطيك إياه.'
Write-Host '  الصق التوكن هنا، أو اضغط Enter إن كان تيليجرام مضبوطاً من قبل:' -ForegroundColor Yellow
$botToken = (Read-Host '  التوكن').Trim()
if ($botToken) {
    try { $me = Invoke-RestMethod "https://api.telegram.org/bot$botToken/getMe" }
    catch { throw 'تيليجرام رفض التوكن — انسخه كاملاً من رسالة @BotFather' }
    Write-Host "  أرسل الآن أي رسالة إلى @$($me.result.username) في تيليجرام، ثم اضغط Enter هنا" -ForegroundColor Yellow
    Read-Host | Out-Null
    # معرّف المحادثة لا يُعرف إلا من رسالة وصلت البوت: هكذا يعرف إلى من يرسل.
    $updates = Invoke-RestMethod "https://api.telegram.org/bot$botToken/getUpdates"
    $chat = $updates.result | ForEach-Object { $_.message.chat } | Where-Object { $_ } | Select-Object -Last 1
    if (-not $chat) { throw "لم تصل رسالة إلى @$($me.result.username) بعد — أرسل له رسالة وأعد تشغيل السكربت" }
    $secrets.TELEGRAM_BOT_TOKEN = $botToken
    $secrets.TELEGRAM_CHAT_ID = [string]$chat.id
    Write-Host "  التنبيهات ستصل إلى: $($chat.first_name) $($chat.last_name)"
}

Write-Host '=== 4) النشر ===' -ForegroundColor Cyan
Invoke-Native npx wrangler deploy
# الأسرار بعد النشر لا قبله: secret put على Worker غير موجود يسأل سؤالاً
# تفاعلياً. وعبر stdin لا ملف مؤقت: المفتاح لا يُكتب على القرص. وما لم يُدخل
# (تيليجرام المضبوط سابقاً) لا يُرسل، فيبقى كما هو.
($secrets | ConvertTo-Json -Compress) | npx wrangler secret bulk
if ($LASTEXITCODE -ne 0) { throw 'تعذّر حفظ الأسرار في Cloudflare' }

Write-Host '=== 5) تشغيل الساعة ===' -ForegroundColor Cyan
# لا Cron (الخطة المجانية بلغت حدّها): أول منبّه يُسلَّح بطلب واحد لرابط الـ Worker.
# الطلب لا يفعل شيئاً إن كانت الساعة تعمل، فتكراره مع كل نشر آمن.
Invoke-WebRequest -Uri 'https://sms-api-monitor.basil0552106933.workers.dev' -Method Post -UseBasicParsing | Out-Null
Write-Host '  تعمل — فحص كل ٥ دقائق'

Write-Host ''
Write-Host '=== تم ===' -ForegroundColor Green
Write-Host '  خلال ٥ دقائق يصلك في تيليجرام «مراقب sms-api يعمل» (إن لم يكن قد وصل من قبل).'
Write-Host '  إن لم يصل: npx wrangler tail sms-api-monitor'
