import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateVariants, type TemplateOverrides } from './templates/templates.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

export interface ProjectConfig {
  id: string;
  brandName: string;
  apiKey: string;
  resendCooldownMinutes: number;
  otpExpiryMinutes: number;
  otpMaxAttempts: number;
  /** Hard ceiling on verification messages to one number per rolling 24h. */
  otpMaxPerDay: number;
  templates?: TemplateOverrides;
}

interface ProjectFileEntry {
  id: string;
  brandName: string;
  resendCooldownMinutes: number;
  otpExpiryMinutes: number;
  otpMaxAttempts: number;
  otpMaxPerDay?: number;
  templates?: TemplateOverrides;
}

// Enough for a genuine user who mistypes their number, gets a code late, and
// retries — and far below the volume that reads as abuse to WhatsApp or to
// whoever owns the number being messaged.
const DEFAULT_OTP_MAX_PER_DAY = 5;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

// The placeholders shipped in .env.example. That file is public on GitHub, so
// a value still starting with this is a value anyone can read.
const PLACEHOLDER_PREFIX = 'change-me';

// An API key IS the project's identity: a placeholder one let anyone who has
// read .env.example send WhatsApp messages from the brand's own number under
// that project's name. Refused at boot like every other misconfiguration here
// — scripts/preflight.sh then stops a deploy before the live service is
// touched.
function requireApiKey(name: string): string {
  const value = requireEnv(name);
  if (value.trim().toLowerCase().startsWith(PLACEHOLDER_PREFIX)) {
    throw new Error(
      `${name} is still the placeholder from .env.example — generate a real key (sh scripts/ensure-project-keys.sh after emptying it) and update the site that uses it`,
    );
  }
  return value;
}

// These two are only warned about, not refused: they never leave the phone
// (the OTP hash secret only matters if the database itself leaks), and
// changing the backup key makes the backups already written undecryptable
// until the next snapshot — not something to force on an unattended deploy.
function requireSecret(name: string): string {
  const value = requireEnv(name);
  if (value.trim().toLowerCase().startsWith(PLACEHOLDER_PREFIX)) {
    console.warn(`[config] ${name} ما زال القيمة المثالية من .env.example — استبدله بقيمة عشوائية طويلة`);
  }
  return value;
}

// `Number(process.env.X ?? fallback)` only falls back when X is UNSET — an
// empty string left in .env (`X=`) is not undefined, so `?? fallback` never
// triggers and `Number('')` silently evaluates to 0. A blank
// SEND_BATCH_SIZE or SEND_MIN_DELAY_MS this way doesn't throw anywhere; it
// just quietly zeroes a limit that was supposed to have a sane default.
//
// A value that is present but not a number is refused outright: Number('abc')
// is NaN, and NaN compares false against everything — SEND_MAX_PER_HOUR=abc
// silently stopped every WhatsApp send forever (`used < NaN`), and
// QUEUE_MAX_PENDING=abc silently removed the queue's cap (`pending >= NaN`).
//
// A number that parses but makes no sense is refused too. SEND_BATCH_SIZE=0
// fetched `LIMIT 0` rows forever — nothing was ever sent, and nothing said
// why — and a negative one is `LIMIT -1` in SQLite, i.e. the whole queue
// loaded into memory at once. Every limit below has a floor that keeps the
// service actually doing its job.
export function numberEnv(name: string, fallback: number, bounds: { min?: number; max?: number; integer?: boolean } = {}): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Env var ${name} must be a number, got "${raw}"`);
  if (bounds.integer && !Number.isInteger(value)) throw new Error(`Env var ${name} must be a whole number, got "${raw}"`);
  if (bounds.min !== undefined && value < bounds.min) throw new Error(`Env var ${name} must be >= ${bounds.min}, got "${raw}"`);
  if (bounds.max !== undefined && value > bounds.max) throw new Error(`Env var ${name} must be <= ${bounds.max}, got "${raw}"`);
  return value;
}

// Same fail-fast contract as requireEnv: a malformed template block stops the
// service at boot instead of surfacing as a broken message weeks later.
function requireValidTemplates(projectId: string, templates: TemplateOverrides | undefined): void {
  if (templates === undefined) return;
  if (typeof templates !== 'object' || Array.isArray(templates)) {
    throw new Error(`Project "${projectId}": "templates" must be an object mapping event -> array of variants`);
  }
  for (const [event, variants] of Object.entries(templates)) {
    const problem = validateVariants(event, variants);
    if (problem) throw new Error(`Project "${projectId}" templates: ${problem}`);
  }
}

// The numbers in projects.json were trusted as-is. A missing or mistyped one
// is undefined/NaN at runtime, and every comparison against NaN is false: a
// missing resendCooldownMinutes switched the cooldown OFF (`elapsed < NaN`),
// and a missing otpMaxAttempts wrote NULL into a NOT NULL column so every
// code request for that project failed with a 500. Checked once at boot,
// like the templates.
function requireNumber(projectId: string, field: string, value: unknown, min: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new Error(`Project "${projectId}": "${field}" must be an integer >= ${min}, got ${JSON.stringify(value)}`);
  }
  return value;
}

function loadProjects(): ProjectConfig[] {
  const raw = readFileSync(path.join(repoRoot, 'config', 'projects.json'), 'utf-8');
  const entries = JSON.parse(raw) as ProjectFileEntry[];
  const loaded = entries.map((entry) => {
    // The id becomes an env var name and a column value — anything outside
    // this set cannot be written as PROJECT_API_KEY_<ID> in a .env at all.
    if (typeof entry.id !== 'string' || !/^[a-z][a-z0-9_]*$/.test(entry.id)) {
      throw new Error(`Project id ${JSON.stringify(entry.id)} must be lowercase letters, digits and _`);
    }
    if (typeof entry.brandName !== 'string' || entry.brandName.trim() === '') {
      throw new Error(`Project "${entry.id}": "brandName" must be a non-empty string`);
    }
    const envKey = `PROJECT_API_KEY_${entry.id.toUpperCase()}`;
    requireValidTemplates(entry.id, entry.templates);
    return {
      ...entry,
      resendCooldownMinutes: requireNumber(entry.id, 'resendCooldownMinutes', entry.resendCooldownMinutes, 0),
      otpExpiryMinutes: requireNumber(entry.id, 'otpExpiryMinutes', entry.otpExpiryMinutes, 1),
      otpMaxAttempts: requireNumber(entry.id, 'otpMaxAttempts', entry.otpMaxAttempts, 1),
      // `??` rather than a spread default: an explicit null in the JSON would
      // otherwise slip through as null and disable the cap entirely.
      otpMaxPerDay: requireNumber(entry.id, 'otpMaxPerDay', entry.otpMaxPerDay ?? DEFAULT_OTP_MAX_PER_DAY, 1),
      apiKey: requireApiKey(envKey),
    };
  });

  // Keys are looked up in a Map: two projects sharing one key silently
  // collapsed into whichever was listed last, so one site's requests were
  // served — codes, quotas, /status — as the other's.
  const seenIds = new Set<string>();
  const seenKeys = new Map<string, string>();
  for (const project of loaded) {
    if (seenIds.has(project.id)) throw new Error(`Project id "${project.id}" is listed twice in projects.json`);
    seenIds.add(project.id);
    const other = seenKeys.get(project.apiKey);
    if (other) throw new Error(`Projects "${other}" and "${project.id}" have the same API key — each needs its own`);
    seenKeys.set(project.apiKey, project.id);
  }
  return loaded;
}

const projects = loadProjects();
const projectsById = new Map(projects.map((p) => [p.id, p]));
const projectsByApiKey = new Map(projects.map((p) => [p.apiKey, p]));

export function getProjectById(id: string): ProjectConfig | undefined {
  return projectsById.get(id);
}

export function getProjectByApiKey(apiKey: string): ProjectConfig | undefined {
  return projectsByApiKey.get(apiKey);
}

const sendMinDelayMs = numberEnv('SEND_MIN_DELAY_MS', 3000, { min: 0 });
const sendMaxDelayMs = numberEnv('SEND_MAX_DELAY_MS', 9000, { min: 0 });
if (sendMaxDelayMs < sendMinDelayMs) {
  throw new Error(`SEND_MAX_DELAY_MS (${sendMaxDelayMs}) must be >= SEND_MIN_DELAY_MS (${sendMinDelayMs})`);
}

export const config = {
  port: numberEnv('PORT', 3000, { min: 1, max: 65535, integer: true }),
  // Loopback only by default: cloudflared reaches the service at
  // localhost:3000 on the same phone, and nothing else needs to. Listening on
  // every interface put the API on whatever Wi-Fi the phone joined.
  host: process.env.HOST || '127.0.0.1',
  // `||`, not `??`: a blank `DATA_DIR=` is the same trap numberEnv describes —
  // it resolved to the repo root itself, and the database landed there.
  dataDir: path.resolve(repoRoot, process.env.DATA_DIR || './data'),
  otpHashSecret: requireSecret('OTP_HASH_SECRET'),
  whatsappNumber: process.env.WHATSAPP_NUMBER ?? '',

  whatsapp: {
    // Doubled from Baileys' 30s default: each keep-alive wakes the phone's
    // radio. Configurable because raising it too far lets the server drop the
    // socket as idle, which costs a reconnect — and reconnect churn on an
    // unofficial client is itself a ban signal.
    keepAliveIntervalMs: numberEnv('KEEP_ALIVE_INTERVAL_MS', 60_000, { min: 1_000, integer: true }),
  },

  // Ceiling on TOTAL messages leaving this service, independent of the
  // per-number caps.
  //
  // The per-number limits (otpMaxPerDay, resendCooldownMinutes) bound what any
  // ONE recipient can receive, but nothing bounded the aggregate: a campaign,
  // a launch, or a burst of signups could push hundreds of messages through a
  // single unofficial WhatsApp account in an hour. That volume pattern — not
  // any individual message — is what gets a sending number restricted, and
  // this account has already been hit with RESTRICT_ALL_COMPANIONS once.
  //
  // Exceeding it delays messages rather than dropping them: the queue simply
  // stops draining until the window rolls, and short-lived OTPs expire out on
  // their own TTL instead of arriving stale.
  sendRate: {
    maxPerHour: numberEnv('SEND_MAX_PER_HOUR', 120, { min: 1, integer: true }),
    // A freshly paired number is at its most fragile — this is exactly when a
    // re-pair after an enforcement happens. Its first hours run at a fraction
    // of the normal ceiling.
    warmupHours: numberEnv('SEND_WARMUP_HOURS', 24, { min: 0 }),
    warmupMaxPerHour: numberEnv('SEND_WARMUP_MAX_PER_HOUR', 30, { min: 1, integer: true }),
  },

  sessionBackup: {
    encryptionKey: requireSecret('SESSION_BACKUP_ENCRYPTION_KEY'),
    r2AccountId: process.env.R2_ACCOUNT_ID ?? '',
    r2AccessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
    r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
    r2Bucket: process.env.R2_BUCKET ?? 'sms-api-session-backup',
    get enabled() {
      return Boolean(this.r2AccountId && this.r2AccessKeyId && this.r2SecretAccessKey);
    },
  },

  sms: {
    provider: process.env.SMS_PROVIDER ?? '',
    apiUrl: process.env.SMS_API_URL ?? '',
    apiKey: process.env.SMS_API_KEY ?? '',
    get enabled() {
      return Boolean(this.provider);
    },
  },

  queue: {
    maxPending: numberEnv('QUEUE_MAX_PENDING', 5000, { min: 1, integer: true }),
    // Plan 9 point 2 bounded the AGGREGATE queue, shared by every project on
    // this one WhatsApp number, but nothing bounded what ONE of them could
    // occupy inside it — a leaked or misbehaving API key for a single project
    // could fill the shared queue and starve OTP delivery for every other
    // tenant. Default well below the aggregate cap so no single project can
    // come close to dominating it, while staying far above real traffic.
    maxPendingPerProject: numberEnv('QUEUE_MAX_PENDING_PER_PROJECT', 1000, { min: 1, integer: true }),
    sendBatchSize: numberEnv('SEND_BATCH_SIZE', 20, { min: 1, integer: true }),
    sendMinDelayMs,
    sendMaxDelayMs,
  },

  projects,
};

export { repoRoot };
