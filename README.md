# sms-api

تنفيذ فعلي لـ [خطة-نظام-التحقق-والواتساب.md](./خطة-نظام-التحقق-والواتساب.md) — راجعها للتفاصيل والأسباب (كل قسم أدناه يشير لبند فيها).

## المتطلبات
- Node.js ≥ 22.5 (فيه `node:sqlite` مدمج بدون أي تثبيت إضافي)
- على الجوال: Termux + تطبيق Termux:Boot (كلاهما من F-Droid، لا من Google Play — نسخة Play Store قديمة ومحدودة)

## 1) التطوير على الكمبيوتر

```bash
npm install
cp .env.example .env
```

افتح `.env` واملأ:
- `PROJECT_API_KEY_STORE` — أي قيمة عشوائية طويلة تختارها، هذا هو مفتاح API اللي المتجر يستخدمه للاتصال
- `OTP_HASH_SECRET` و `SESSION_BACKUP_ENCRYPTION_KEY` — قيم عشوائية طويلة (`openssl rand -hex 32` أو أي مولّد كلمات مرور)
- باقي الحقول (R2, SMS) اتركها فارغة الآن، الخدمة تشتغل بدونها (تسجّل ذلك بوضوح عند الإقلاع)

```bash
npm run dev
```

أول تشغيل بيطبع كود QR بالتيرمنال — امسحه من واتساب: **الإعدادات → الأجهزة المرتبطة → ربط جهاز**. بعدها الجلسة تُحفظ بمجلد `data/auth-session` ولا تحتاج مسح QR كل مرة (بند 4.2).

## 2) النشر على الجوال (Termux)

```bash
pkg update && pkg install nodejs-lts git build-essential
git clone <رابط-المستودع-أو-انسخ-المجلد> ~/sms-api
cd ~/sms-api
npm install
cp .env.example .env   # واملأه بنفس القيم
npm install -g pm2
```

ثم فعّل الإعدادات اللي بند 7 يشترطها (كل هذي **ضرورية** لا اختيارية):
1. `termux-wake-lock` — شغّلها مرة، تمنع أندرويد يجمّد Termux
2. إعدادات النظام → البطارية → Termux → **بلا قيود**
3. ثبّت تطبيق **Termux:Boot** من F-Droid وشغّله مرة يدوياً (يطلب صلاحية بالمرة الأولى فقط)
4. انسخ `scripts/termux-boot.sh` إلى `~/.termux/boot/termux-boot.sh` وخلّه قابل للتنفيذ:
   ```bash
   mkdir -p ~/.termux/boot
   cp scripts/termux-boot.sh ~/.termux/boot/
   chmod +x ~/.termux/boot/termux-boot.sh
   ```
5. شاحن دائم + واي فاي مستقر

## 3) الشبكة — كيف يوصل ووركر المتجر للخدمة أصلاً

هذي نقطة ما تطرقت لها الخطة بالتفصيل: **جوالك غالباً بلا IP عام** (خاصة على نت الموبايل)، فمتجر Talisham (يشتغل على Cloudflare عالمياً) ما يقدر يتصل بـ `http://<IP-الجوال>:3000` مباشرة. الحل الأنسب لأنك أصلاً تملك دومين ومتجر على Cloudflare: **Cloudflare Tunnel** (مجاني، اتصال صادر من الجوال فقط، بلا فتح منافذ):

```bash
# داخل Termux
curl -Lo cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64
chmod +x cloudflared && mv cloudflared $PREFIX/bin/

cloudflared tunnel login          # يفتح رابط، افتحه بأي متصفح وسجّل دخول لنفس حساب Cloudflare بتاع المتجر
cloudflared tunnel create sms-api
cloudflared tunnel route dns sms-api sms-api.talisham.com
```

أنشئ `~/.cloudflared/config.yml`:
```yaml
tunnel: <المعرّف اللي طبعه أمر create>
credentials-file: /data/data/com.termux/files/home/.cloudflared/<المعرّف>.json
ingress:
  - hostname: sms-api.talisham.com
    service: http://localhost:3000
  - service: http_status:404
```

`ecosystem.config.cjs` يدير التونيل تلقائياً كعملية pm2 ثانية (نفس ضمانات إعادة التشغيل ببند 8) — لا تشغّله يدوياً بعد كذا.

## 4) تشغيل دائم عبر pm2

```bash
pm2 start ecosystem.config.cjs
pm2 save          # ضروري — بدونه pm2 resurrect (بسكربت الإقلاع) ما يعرف وش يرجّع
```

`pm2 logs`، `pm2 status`، `pm2 restart sms-api` للمتابعة اليومية.

## 5) واجهة الـ API

كل طلب يحتاج ترويسة `Authorization: Bearer <PROJECT_API_KEY_...>`. الأرقام دايماً بصيغة دولية بلا `+` وبلا صفر بداية (مثال: `963977712345`) — استخدم `toWhatsAppDigits` الموجودة أصلاً بـ `store/src/lib/whatsapp.ts` لتحويلها قبل الإرسال.

| Endpoint | الوصف |
|---|---|
| `POST /notify` | `{ event, to, payload?, channel? }` — event من: `order_created`, `order_confirmed`, `out_for_delivery`, `delivered`. يرجع `202 { id, status: "queued" }` أو `429` لو الطابور ممتلئ |
| `POST /otp/request` | `{ to }` — يولّد ويرسل كود تحقق. `429` مع `retryAfterSeconds` لو داخل فترة التهدئة (10 دقائق) |
| `POST /otp/verify` | `{ to, code }` — `200 { ok:true }` أو `400` مع سبب (`invalid_code`, `too_many_attempts`, `not_found_or_expired`) |
| `GET /status/:id` | حالة رسالة معيّنة (`pending`/`sent`/`failed`) |
| `GET /health` | حالة اتصال واتساب + حجم الطابور — `503` لو "degraded" (بند 9، نقطة 7) |

## 6) لاحقاً: ربط مزوّد SMS حقيقي

عدّل `src/sms/provider.ts` — الشكل الحالي عام (POST JSON + Bearer token) ومصمم كنقطة بداية فقط، غالباً يحتاج تعديل ليطابق شكل استدعاء المزوّد الفعلي اللي تختاره (بند 6). بمجرد ملء `SMS_PROVIDER`/`SMS_API_URL`/`SMS_API_KEY` بـ `.env`، القناة تشتغل تلقائياً بلا أي تغيير بمكان ثاني.

## 7) لو انفقدت جلسة واتساب

`npx tsx scripts/restore-session.ts` — يستعيدها من آخر نسخة احتياطية مشفّرة على R2 (يحتاج بيانات R2 مملوءة بـ `.env`، بند 8 طبقة 6). بدون هذي البيانات ما فيه نسخة تُستعاد، ويحتاج مسح QR من جديد.
