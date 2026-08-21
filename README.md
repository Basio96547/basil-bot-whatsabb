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

## 6) إضافة موقع جديد + قوالب خاصة به

كل موقع = مدخل في `config/projects.json` + متغيّر بيئة `PROJECT_API_KEY_<ID بأحرف كبيرة>` بـ `.env`. **بدون المتغيّر الخدمة ما تقلع أصلاً** (فشل مبكر مقصود بـ `src/config.ts`).

الحقل `templates` اختياري: تكتب فيه صيغ الرسائل الخاصة بالموقع، وأي حدث ما تذكره يرجع تلقائياً للقالب الافتراضي المشترك بـ `src/templates/templates.ts`:

```jsonc
{
  "id": "qareeb",
  "brandName": "Qareeb",
  "resendCooldownMinutes": 2,
  "otpExpiryMinutes": 10,
  "otpMaxAttempts": 5,
  "templates": {
    "otp": ["كود تفعيل رقمك في {brand}: {code}", "..."]   // عدة صيغ، يُختار واحد عشوائياً لكل إرسال
  }
}
```

القيود (تُفحص مرة واحدة عند الإقلاع، فالخطأ يظهر فوراً لا بعد أسابيع كرسالة مكسورة عند زبون):
- اسم الحدث لازم يكون معروفاً (`otp`, `password_reset`, `order_created`, `order_confirmed`, `out_for_delivery`, `delivered`)
- كل حدث لازم يكون مصفوفة نصوص غير فارغة
- المتغيّرات المسموحة لكل حدث = نفس متغيّرات قالبه الافتراضي + `{brand}` و `{expiryMinutes}` دائماً
- قوالب `otp` و `password_reset` لازم تحتوي `{code}`

**حالياً مسجَّل موقعان:** `store` (Talisham، بالقوالب الافتراضية) و `qareeb` (بقوالب تحقق خاصة به، وتهدئة إعادة إرسال أقصر ومهلة صلاحية أطول لأن التسجيل يحصل بلحظتها).

> بعد أي تعديل هنا: على الجوال اسحب التحديث، أضف المفتاح الجديد لـ `.env` هناك أيضاً، ثم `pm2 restart sms-api`.

## 7) لاحقاً: ربط مزوّد SMS حقيقي

عدّل `src/sms/provider.ts` — الشكل الحالي عام (POST JSON + Bearer token) ومصمم كنقطة بداية فقط، غالباً يحتاج تعديل ليطابق شكل استدعاء المزوّد الفعلي اللي تختاره (بند 6). بمجرد ملء `SMS_PROVIDER`/`SMS_API_URL`/`SMS_API_KEY` بـ `.env`، القناة تشتغل تلقائياً بلا أي تغيير بمكان ثاني.

## 8) الصمود: وش يتعافى وحده ووش يحتاجك

**يتعافى تلقائياً بلا أي تدخّل:**
- انقطاع الإنترنت أو تبديل الشبكة أو إعادة اتصال VPN — إعادة محاولة بتباعد 5 ← 15 ← 60 ثانية، بلا سقف لعدد المحاولات، والسلسلة تعيد تسليح نفسها حتى لو فشلت المحاولة نفسها برمي استثناء
- الإقلاع قبل رجوع الراوتر — الخدمة تقلع وتنتظر الشبكة، والـ HTTP يستمع فوراً بلا انتظار واتساب (فـ `/health` يرد بـ 503 نظيف بدل رفض الاتصال)
- قطع الكهرباء أثناء الكتابة — SQLite بوضع WAL، وملفات جلسة واتساب تُكتب كتابة ذرّية (ملف مؤقت + `fsync` + `rename`) بدل الكتابة فوق الملف الحيّ
- **جلسة واتساب ناقصة أو تالفة** — تُستعاد تلقائياً من R2 عند الإقلاع، وتُسجَّل في `/health`. سابقاً كانت تُولَّد هوية جديدة بصمت وتموت الجلسة بلا أي إشارة
- انقطاع طويل — الرسائل المعلّقة **لا تستهلك محاولاتها** بينما واتساب مقطوع (قبلاً كان انقطاع ~25 دقيقة يُفشل أقدم الرسائل نهائياً)، وأي رسالة تجاوزت صلاحيتها تُسقَط بدل أن تصل متأخرة (كود تحقق منتهي أسوأ من لا رسالة)

**يحتاجك أنت — لا يوجد حل برمجي:**
1. **الجوال إذا انطفأ لن يُقلع وحده** عند عودة الكهرباء. استخدم باور بانك/UPS يمنع البطارية من الوصول للصفر
2. **قفل الشاشة يمنع `Termux:Boot`** — على تشفير أندرويد لا يصل `BOOT_COMPLETED` قبل أول فتح للقفل. اختبرها: أعد الإقلاع، اترك الجهاز مقفلاً، وجرّب `/health` بعد دقيقتين
3. **مسح QR جديد** بعد تسجيل خروج فعلي — `/health` يرجع `whatsapp_needs_reauth` والمراقب يدفع إشعاراً

**نسخة R2 الاحتياطية** (`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` بـ `.env`): بدونها لا يوجد ما يُستعاد، وأي فقدان للجلسة = QR جديد. مع VPN تحديداً هذا ليس احتمالاً نظرياً — واتساب يتعامل مع IP مراكز البيانات وقفزات الدول كإشارة مريبة وقد ينهي الجلسة.

`npx tsx scripts/restore-session.ts` للاستعادة اليدوية (جهاز جديد، أو التأكد أن النسخة تُفك بالمفتاح الحالي).

## 9) المراقبة

`GET /health` يرجع 200 أو 503 مع مصفوفة `reasons` مسمّاة:

| السبب | المعنى |
|---|---|
| `whatsapp_needs_reauth` | الجلسة انتهت — يحتاج مسح QR (إعادة المحاولة لن تصلحه أبداً) |
| `whatsapp_disconnected` | مقطوع مؤقتاً — يعيد المحاولة وحده |
| `session_restored_from_backup` | استُعيدت من R2 ولم تتصل بعد (لوحده لا يُعتبر تدهوراً) |
| `queue_near_capacity` | الطابور تجاوز 80% من `QUEUE_MAX_PENDING` |

يستعلمه ووركر Qareeb كل 5 دقائق عبر Cron Trigger ويدفع إشعار Web Push للمشرفين **عند تغيّر الحالة فقط** — راجع `src/lib/healthMonitor.ts` هناك.

## 10) الاختبارات

```bash
npm test
```
