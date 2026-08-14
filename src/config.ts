import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

export interface ProjectConfig {
  id: string;
  brandName: string;
  apiKey: string;
  resendCooldownMinutes: number;
  otpExpiryMinutes: number;
  otpMaxAttempts: number;
}

interface ProjectFileEntry {
  id: string;
  brandName: string;
  resendCooldownMinutes: number;
  otpExpiryMinutes: number;
  otpMaxAttempts: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function loadProjects(): ProjectConfig[] {
  const raw = readFileSync(path.join(repoRoot, 'config', 'projects.json'), 'utf-8');
  const entries = JSON.parse(raw) as ProjectFileEntry[];
  return entries.map((entry) => {
    const envKey = `PROJECT_API_KEY_${entry.id.toUpperCase()}`;
    return { ...entry, apiKey: requireEnv(envKey) };
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
