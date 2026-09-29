# يركّب مراقب sms-api على Cloudflare ويربطه بتنبيهات ntfy — من الكمبيوتر.
#
#   powershell -ExecutionPolicy Bypass -File "C:\Users\PC\sms-api-new\monitor\setup.ps1"
#
# آمن للتكرار: إعادة تشغيله تنشر آخر نسخة وتُبقي نفس موضوع التنبيهات.
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

Write-Host '=== 3) موضوع التنبيهات (ntfy) ===' -ForegroundColor Cyan
# الموضوع هو كلمة السر الوحيدة لقناة ntfy: من يعرفه يقرأ التنبيهات. عشوائي،
# ويُحفظ هنا (خارج git) كي لا يتغيّر مع كل تشغيل فينقطع اشتراكك.
$topicFile = Join-Path $PSScriptRoot '.ntfy-topic'
if (Test-Path $topicFile) {
    $topic = (Get-Content $topicFile -Raw).Trim()
} else {
    $bytes = New-Object byte[] 12
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $topic = 'sms-api-' + (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
    Set-Content -Path $topicFile -Value $topic -NoNewline
}
Write-Host "  $topic"

Write-Host '=== 4) النشر ===' -ForegroundColor Cyan
Invoke-Native npx wrangler deploy
# الأسرار بعد النشر لا قبله: secret put على Worker غير موجود يسأل سؤالاً
# تفاعلياً. وعبر stdin لا ملف مؤقت: المفتاح لا يُكتب على القرص.
(@{ SMS_API_KEY = $key; NTFY_TOPIC = $topic } | ConvertTo-Json -Compress) | npx wrangler secret bulk
if ($LASTEXITCODE -ne 0) { throw 'تعذّر حفظ الأسرار في Cloudflare' }

Write-Host ''
Write-Host '=== تم ===' -ForegroundColor Green
Write-Host '  اشترك في التنبيهات على جوالك (ويفضَّل على الكمبيوتر أيضاً — الجوال نفسه قد يكون ما سقط):'
Write-Host "    تطبيق ntfy ← + ← الموضوع: $topic"
Write-Host "    أو في المتصفح: https://ntfy.sh/$topic"
Write-Host '  خلال ٥ دقائق يصلك «مراقب sms-api يعمل». إن لم يصل: npx wrangler tail sms-api-monitor'
