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

function loadProjects(): ProjectConfig[] {
  const raw = readFileSync(path.join(repoRoot, 'config', 'projects.json'), 'utf-8');
  const entries = JSON.parse(raw) as ProjectFileEntry[];
  return entries.map((entry) => {
    const envKey = `PROJECT_API_KEY_${entry.id.toUpperCase()}`;
    requireValidTemplates(entry.id, entry.templates);
    return {
      ...entry,
      // `??` rather than a spread default: an explicit null in the JSON would
      // otherwise slip through as null and disable the cap entirely.
      otpMaxPerDay: entry.otpMaxPerDay ?? DEFAULT_OTP_MAX_PER_DAY,
      apiKey: requireEnv(envKey),
    };
  });
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

export const config = {
  port: Number(process.env.PORT ?? 3000),
  dataDir: path.resolve(repoRoot, process.env.DATA_DIR ?? './data'),
  otpHashSecret: requireEnv('OTP_HASH_SECRET'),
  whatsappNumber: process.env.WHATSAPP_NUMBER ?? '',

  whatsapp: {
    // Doubled from Baileys' 30s default: each keep-alive wakes the phone's
    // radio. Configurable because raising it too far lets the server drop the
    // socket as idle, which costs a reconnect — and reconnect churn on an
    // unofficial client is itself a ban signal.
    keepAliveIntervalMs: Number(process.env.KEEP_ALIVE_INTERVAL_MS ?? 60_000),
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
    maxPerHour: Number(process.env.SEND_MAX_PER_HOUR ?? 120),
    // A freshly paired number is at its most fragile — this is exactly when a
    // re-pair after an enforcement happens. Its first hours run at a fraction
    // of the normal ceiling.
    warmupHours: Number(process.env.SEND_WARMUP_HOURS ?? 24),
    warmupMaxPerHour: Number(process.env.SEND_WARMUP_MAX_PER_HOUR ?? 30),
  },

  sessionBackup: {
    encryptionKey: requireEnv('SESSION_BACKUP_ENCRYPTION_KEY'),
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
    maxPending: Number(process.env.QUEUE_MAX_PENDING ?? 5000),
    sendBatchSize: Number(process.env.SEND_BATCH_SIZE ?? 20),
    sendMinDelayMs: Number(process.env.SEND_MIN_DELAY_MS ?? 3000),
    sendMaxDelayMs: Number(process.env.SEND_MAX_DELAY_MS ?? 9000),
  },

  projects,
};

export { repoRoot };
