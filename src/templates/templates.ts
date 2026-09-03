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

// Per-project overrides from config/projects.json — a project supplies its own
// phrasings for some events and silently keeps the defaults above for the rest.
export type TemplateOverrides = Record<string, string[]>;

// These events are triggered only by dedicated endpoints (/otp/request,
// /password-reset/request) — never by the generic /notify route.
const INTERNAL_EVENTS = new Set(['otp', 'password_reset']);

export function knownEvents(): string[] {
  return Object.keys(VARIANTS).filter(e => !INTERNAL_EVENTS.has(e));
}

const PLACEHOLDER_RE = /\{(\w+)\}/g;

function placeholdersIn(text: string): string[] {
  return Array.from(text.matchAll(PLACEHOLDER_RE), (m) => m[1]);
}

// Always injected by the worker for every event, so an override may use them
// even when no default variant of that event happens to.
const AMBIENT_PLACEHOLDERS = ['brand', 'expiryMinutes'];

// Checked once at boot (config.ts) rather than at send time — a typo'd
// placeholder would otherwise ship silently and reach a customer as the
// literal text "{cod}" inside their verification message.
export function validateVariants(event: string, variants: unknown): string | null {
  const defaults = VARIANTS[event];
  if (!defaults) return `unknown event "${event}" (known: ${Object.keys(VARIANTS).join(', ')})`;
  if (!Array.isArray(variants) || variants.length === 0) return `"${event}" must be a non-empty array of strings`;

  const allowed = new Set([...AMBIENT_PLACEHOLDERS, ...defaults.flatMap(placeholdersIn)]);

  for (const variant of variants) {
    if (typeof variant !== 'string' || variant.trim() === '') return `"${event}" contains an empty or non-string variant`;

    const used = placeholdersIn(variant);
    const unknown = used.find((p) => !allowed.has(p));
    if (unknown) return `"${event}" uses unknown placeholder {${unknown}} (allowed: ${[...allowed].join(', ')})`;

    // The code IS the message for these two — a variant missing it would send
    // a perfectly well-formed but useless verification message.
    if (INTERNAL_EVENTS.has(event) && !used.includes('code')) return `"${event}" variant is missing the {code} placeholder`;
  }
  return null;
}

function variantsFor(event: string, overrides?: TemplateOverrides): string[] | undefined {
  return overrides?.[event] ?? VARIANTS[event];
}

/**
 * Placeholders the caller must supply for at least one variant of `event` to
 * be renderable — empty when the payload is already sufficient.
 *
 * `AMBIENT_PLACEHOLDERS` are excluded because the worker injects them at send
 * time, after this check runs.
 *
 * Exists so /notify can refuse an incomplete payload at the API boundary. The
 * alternative is what used to happen: the message was accepted, queued, and
 * delivered with the placeholder still in it — a real customer receiving
 * "المبلغ المطلوب: {amount}".
 */
export function missingPlaceholders(
  event: string,
  payload: Record<string, unknown>,
  overrides?: TemplateOverrides,
): string[] {
  const variants = variantsFor(event, overrides);
  if (!variants || variants.length === 0) return [];

  const missingPerVariant = variants.map((variant) =>
    placeholdersIn(variant).filter(
      (name) => !AMBIENT_PLACEHOLDERS.includes(name) && !(name in payload),
    ),
  );

  // Any fully-satisfied variant means the send can go ahead — renderTemplate
  // will pick among exactly those.
  if (missingPerVariant.some((missing) => missing.length === 0)) return [];

  // None can be rendered: report the smallest set that would fix it, so the
  // caller is told the minimum it must add rather than every name in use.
  const smallest = missingPerVariant.reduce((a, b) => (b.length < a.length ? b : a));
  return [...new Set(smallest)];
}

export function renderTemplate(
  event: string,
  data: Record<string, string | number>,
  overrides?: TemplateOverrides,
): { text: string; variantIndex: number } {
  const variants = variantsFor(event, overrides);
  if (!variants) throw new Error(`Unknown template event: ${event}`);

  // Only variants whose every placeholder is present are eligible. Picking at
  // random across ALL of them meant an optional field (talisham's `name` and
  // `amount` are both optional in its own types) turned into literal
  // "{amount}" in the customer's WhatsApp — and only for the variants that
  // happened to use it, so the same call site failed intermittently.
  const eligible = variants
    .map((text, index) => ({ text, index }))
    .filter(({ text }) => placeholdersIn(text).every((name) => name in data));

  if (eligible.length === 0) {
    throw new Error(
      `No renderable variant for "${event}": missing ${missingPlaceholders(event, data, overrides).join(', ')}`,
    );
  }

  const chosen = eligible[crypto.randomInt(0, eligible.length)];
  const text = chosen.text.replace(/\{(\w+)\}/g, (match, key) =>
    key in data ? String(data[key]) : match,
  );
  return { text, variantIndex: chosen.index };
}
