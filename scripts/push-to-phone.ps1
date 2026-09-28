# يدفع الكود المحدَّث إلى الجوال ويشغّل سكربت التبريد، من الكمبيوتر.
#
#   powershell -ExecutionPolicy Bypass -File "C:\Users\PC\sms api\scripts\push-to-phone.ps1"
#
# -ExecutionPolicy Bypass لهذا التشغيل وحده: سياسة ويندوز الافتراضية تمنع تشغيل
# أي سكربت .ps1، ولا حاجة لتغييرها على مستوى الجهاز.
#
# ~/sms-api على الجوال ليس مستودع git (نُقل بـ adb push لا git clone)، فلا
# يوجد `git pull` هناك. هذا هو طريق التحديث الوحيد.
#
# لا يُدفع أبداً: node_modules (فيه ثنائيات ويندوز، والجوال يحتاج بناء
# arm64 خاصاً به)، data (الجلسة الحيّة وقاعدة البيانات)، .env (المفاتيح).

$ErrorActionPreference = 'Stop'
$adb = 'C:\Users\PC\Desktop\platform-tools\adb.exe'
$repo = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $env:TEMP 'sms-api-update'
$logRemote = '/sdcard/claude-cooldown.log'
$logLocal = Join-Path $env:TEMP 'claude-cooldown.log'

# ErrorActionPreference لا يوقف شيئاً عند فشل أمر خارجي كـ adb — كان دفعٌ فاشل
# يمرّ بصمت، ثم يُعرض سجل التشغيل السابق كأنه نتيجة هذا التشغيل.
function Invoke-Adb {
    $output = & $adb @args
    if ($LASTEXITCODE -ne 0) { throw "adb $($args -join ' ') فشل (رمز $LASTEXITCODE): $output" }
    $output
}

Write-Host '=== 1) هل الجوال موصول؟ ===' -ForegroundColor Cyan
$devices = & $adb devices | Select-Object -Skip 1 | Where-Object { $_ -match '\sdevice$' }
if (-not $devices) {
    Write-Host 'لا يوجد جهاز. وصّل كيبل USB، وافتح قفل الشاشة، ووافق على تصحيح USB إن سُئلت.' -ForegroundColor Red
    exit 1
}
Write-Host "  $devices"

# الإدخال المحقون يذهب إلى العدم بصمت والشاشة مقفلة — تُفحص أولاً بدل
# تشخيص آلية الحقن لاحقاً.
$focus = & $adb shell "dumpsys window | grep mCurrentFocus"
Write-Host "  التركيز الحالي: $focus"
if ($focus -match 'NotificationShade|Keyguard|null') {
    Write-Host 'الشاشة تبدو مقفلة — افتح قفل الجوال ثم أعد التشغيل.' -ForegroundColor Red
    exit 1
}

Write-Host '=== 2) تجهيز الملفات ===' -ForegroundColor Cyan
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null
foreach ($dir in 'src', 'scripts', 'config') {
    robocopy (Join-Path $repo $dir) (Join-Path $stage $dir) /E /NFL /NDL /NJH /NJS /NC /NS | Out-Null
    # robocopy: 0-7 نجاح بدرجات، 8 فما فوق فشل.
    if ($LASTEXITCODE -ge 8) { throw "robocopy $dir فشل (رمز $LASTEXITCODE)" }
}
foreach ($file in 'package.json', 'package-lock.json', 'tsconfig.json', 'ecosystem.config.cjs') {
    Copy-Item (Join-Path $repo $file) $stage
}
Write-Host "  جاهزة في $stage"

Write-Host '=== 3) الدفع إلى الجوال ===' -ForegroundColor Cyan
# السجل القديم يُحذف أولاً: بقاؤه كان يعني أن تشغيلاً لم يبدأ أصلاً يُعرض
# بسجل التشغيل السابق كاملاً، منتهياً بـ RUNNER DONE.
Invoke-Adb shell "rm -rf /sdcard/sms-api-update $logRemote" | Out-Null
Invoke-Adb push $stage /sdcard/sms-api-update | Select-Object -Last 1

# سكربت وسيط: ينسخ الملفات داخل بيئة Termux المعزولة (التي لا يصلها adb
# مباشرة) ثم يشغّل التبريد، ويحوّل كل مخرجاته إلى /sdcard ليمكن سحبها —
# فلا حاجة إلى قراءة شاشة Termux بالصور.
#
# set -e: بدونه كان فشل cp أو npm install يُكمل إلى phone-cooldown، فيُنشر
# كود لم تُثبَّت حزمه. وعلامة FAILED تُكتب عند أي خروج بخطأ كي يعرف هذا
# السكربت أن ينتهي بدل أن ينتظر DONE لن تأتي.
$runner = @'
#!/data/data/com.termux/files/usr/bin/sh
exec > /sdcard/claude-cooldown.log 2>&1
set -e
trap 'code=$?; [ "$code" -eq 0 ] || echo "=== RUNNER FAILED (exit $code) ==="' EXIT
set -x
cp -r /sdcard/sms-api-update/. ~/sms-api/
cd ~/sms-api
npm install --omit=dev --no-audit --no-fund
sh scripts/phone-cooldown.sh
set +x
echo "=== RUNNER DONE ==="
'@
$runnerPath = Join-Path $env:TEMP 'claude-cooldown-runner.sh'
[System.IO.File]::WriteAllText($runnerPath, ($runner -replace "`r`n", "`n"))
Invoke-Adb push $runnerPath /sdcard/claude-cooldown.sh | Select-Object -Last 1

Write-Host '=== 4) التشغيل داخل Termux ===' -ForegroundColor Cyan
Invoke-Adb shell 'am start -n com.termux/com.termux.app.TermuxActivity' | Out-Null
Start-Sleep -Seconds 3
# %s مسافة حرفية لأداة input — مسافة عادية تُقسَم إلى وسيطين.
Invoke-Adb shell 'input text "sh%s/sdcard/claude-cooldown.sh"' | Out-Null
Invoke-Adb shell 'input keyevent 66' | Out-Null
Write-Host '  انطلق. السكربت يحتاج عادةً ~٣ دقائق (npm install ثم ٣٠ ثانية استقرار).'

Write-Host '=== 5) بانتظار النتيجة ===' -ForegroundColor Cyan
# انتظار العلامة نفسها لا ١٨٠ ثانية ثابتة: npm install بطيء كان يُعرض سجله
# ناقصاً، وتشغيل لم يبدأ (ضغطات ضاعت) كان يُعرض كأنه انتهى.
$outcome = $null
for ($i = 0; $i -lt 60 -and -not $outcome; $i++) {
    Start-Sleep -Seconds 10
    $marker = & $adb shell "grep -o 'RUNNER [A-Z]*' $logRemote 2>/dev/null | tail -1"
    if ($marker -match 'RUNNER (DONE|FAILED)') { $outcome = $Matches[1] }
}

# سجل غائب يجعل adb يكتب على stderr، وتحت 'Stop' يحوّل PowerShell 5.1 ذلك إلى
# خطأ قاتل قبل أن تصل الرسالة الواضحة أدناه — فالتحقق هنا برمز الخروج وحده.
$ErrorActionPreference = 'Continue'
& $adb pull $logRemote $logLocal | Out-Null
$pulled = $LASTEXITCODE -eq 0
$ErrorActionPreference = 'Stop'
if ($pulled) {
    # السجل UTF-8 بلا BOM؛ بلا -Encoding يقرؤه PowerShell 5.1 بترميز ANSI فيتشوّه العربي.
    Get-Content -Encoding UTF8 $logLocal
} else {
    Write-Host 'لا سجل على الجوال — السكربت لم يبدأ. هل وصلت الضغطات إلى Termux؟' -ForegroundColor Red
}

switch ($outcome) {
    'DONE' { Write-Host '=== انتهى بنجاح ===' -ForegroundColor Green }
    'FAILED' { Write-Host '=== فشل — السبب في السجل أعلاه؛ الخدمة الحالية لم تُمسّ إن فشل قبل الخطوة 4 ===' -ForegroundColor Red; exit 1 }
    default { Write-Host '=== لم ينتهِ خلال ١٠ دقائق — هذا ما وصل حتى الآن ===' -ForegroundColor Yellow; exit 1 }
}
