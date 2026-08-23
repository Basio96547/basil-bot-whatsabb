# يدفع الكود المحدَّث إلى الجوال ويشغّل سكربت التبريد، من الكمبيوتر.
#
#   powershell -File "C:\Users\PC\sms api\scripts\push-to-phone.ps1"
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
}
foreach ($file in 'package.json', 'package-lock.json', 'tsconfig.json', 'ecosystem.config.cjs') {
    Copy-Item (Join-Path $repo $file) $stage
}
Write-Host "  جاهزة في $stage"

Write-Host '=== 3) الدفع إلى الجوال ===' -ForegroundColor Cyan
& $adb shell 'rm -rf /sdcard/sms-api-update'
& $adb push $stage /sdcard/sms-api-update | Select-Object -Last 1

# سكربت وسيط: ينسخ الملفات داخل بيئة Termux المعزولة (التي لا يصلها adb
# مباشرة) ثم يشغّل التبريد، ويحوّل كل مخرجاته إلى /sdcard ليمكن سحبها —
# فلا حاجة إلى قراءة شاشة Termux بالصور.
$runner = @'
#!/data/data/com.termux/files/usr/bin/sh
exec > /sdcard/claude-cooldown.log 2>&1
set -x
cp -r /sdcard/sms-api-update/. ~/sms-api/
cd ~/sms-api
npm install --omit=dev --no-audit --no-fund
sh scripts/phone-cooldown.sh
echo "=== RUNNER DONE ==="
'@
$runnerPath = Join-Path $env:TEMP 'claude-cooldown-runner.sh'
[System.IO.File]::WriteAllText($runnerPath, ($runner -replace "`r`n", "`n"))
& $adb push $runnerPath /sdcard/claude-cooldown.sh | Select-Object -Last 1

Write-Host '=== 4) التشغيل داخل Termux ===' -ForegroundColor Cyan
& $adb shell 'am start -n com.termux/com.termux.app.TermuxActivity' | Out-Null
Start-Sleep -Seconds 3
# %s مسافة حرفية لأداة input — مسافة عادية تُقسَم إلى وسيطين.
& $adb shell 'input text "sh%s/sdcard/claude-cooldown.sh"'
& $adb shell 'input keyevent 66'
Write-Host '  انطلق. السكربت يحتاج ~٣ دقائق (npm install ثم ٣٠ ثانية استقرار).'

Write-Host '=== 5) بانتظار النتيجة ===' -ForegroundColor Cyan
Start-Sleep -Seconds 180
& $adb pull /sdcard/claude-cooldown.log (Join-Path $env:TEMP 'claude-cooldown.log') | Out-Null
Get-Content (Join-Path $env:TEMP 'claude-cooldown.log')
