import crypto from 'node:crypto';

// Plan 4.5: several phrasings per event, picked at random per send. Wording,
// emoji, and order vary — order number / amount / code never do.
const VARIANTS: Record<string, string[]> = {
  password_reset: [
    'رمز إعادة تعيين كلمة المرور في {brand}: {code}. صالح {expiryMinutes} دقائق. لا تشاركه مع أحد.',
    '{code} هو كود تغيير كلمة المرور لحسابك في {brand}. صالح {expiryMinutes} دقائق.',
    'كود استعادة كلمة المرور لـ {brand}: {code} (صالح {expiryMinutes} دقائق) 🔐',
  ],
  otp: [
    'رمز التحقق الخاص بك في {brand}: {code}. صالح لمدة {expiryMinutes} دقائق.',
    '{code} هو كود التحقق من {brand}. لا تشاركه مع أحد. صالح {expiryMinutes} دقائق.',
    'كود الدخول لـ {brand}: {code} (صالح {expiryMinutes} دقائق)',
  ],
  order_created: [
    'استلمنا طلبك رقم #{order} بقيمة {amount}. سنتواصل معك للتأكيد قريباً',
    'شكراً {name}! طلبك #{order} وصلنا بقيمة {amount}، وراح نتأكد منه قريباً',
    'تم استلام طلب #{order} ({amount})، بانتظار التأكيد',
  ],
  order_confirmed: [
    'تم تأكيد طلبك رقم #{order}، جاري التجهيز الآن 👍',
    'طلبك #{order} مؤكد ✅ وراح نبدأ التجهيز',
    'أخبار حلوة {name}، طلبك #{order} تأكد وبنجهزه',
    'تأكدنا من طلبك #{order}، جاري التحضير حالياً',
  ],
  out_for_delivery: [
    'طلبك #{order} مع المندوب اليوم. المبلغ المطلوب: {amount}. جهّز المبلغ نقداً',
    'بالطريق إليك 🚚 طلب #{order}، المبلغ عند الاستلام {amount}',
    'طلبك #{order} خرج للتوصيل، التحصيل {amount} نقداً عند الاستلام',
  ],
  delivered: [
    'شكراً لثقتك {name}! تم تسليم طلبك #{order}. قيّم تجربتك',
    'وصل طلبك #{order} بنجاح ✅ نتمنى لك تجربة ممتعة',
    'تم التسليم! طلب #{order} وصل. تقييمك يسعدنا',
  ],
};

export type TemplateEvent = keyof typeof VARIANTS;

// These events are triggered only by dedicated endpoints (/otp/request,
// /password-reset/request) — never by the generic /notify route.
const INTERNAL_EVENTS = new Set(['otp', 'password_reset']);

export function knownEvents(): string[] {
  return Object.keys(VARIANTS).filter(e => !INTERNAL_EVENTS.has(e));
}

export function renderTemplate(
  event: string,
  data: Record<string, string | number>,
): { text: string; variantIndex: number } {
  const variants = VARIANTS[event];
  if (!variants) throw new Error(`Unknown template event: ${event}`);

  const variantIndex = crypto.randomInt(0, variants.length);
  const text = variants[variantIndex].replace(/\{(\w+)\}/g, (match, key) =>
    key in data ? String(data[key]) : match,
  );
  return { text, variantIndex };
}
