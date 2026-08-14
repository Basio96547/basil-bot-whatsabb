import crypto from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { config } from '../config.ts';

// Plan 8, layer 6: encrypted backup of the Baileys auth-state folder to R2,
// uploaded on creds.update (not a fixed schedule) so a lost/corrupted phone
// never means re-scanning QR from zero. Debounced — creds.update fires often
// during normal operation and we don't need to re-upload every single time.

const AUTH_DIR = path.join(config.dataDir, 'auth-session');
const BACKUP_KEY = 'whatsapp-session.enc';
const DEBOUNCE_MS = 30_000;

function deriveKey(): Buffer {
  // Lets the operator set any passphrase in .env rather than a raw 32-byte
  // hex string — SHA-256 always yields the 32 bytes AES-256-GCM needs.
  return crypto.createHash('sha256').update(config.sessionBackup.encryptionKey).digest();
}

function bundleAuthFolder(): string {
  const files = readdirSync(AUTH_DIR);
  const bundle: Record<string, string> = {};
  for (const file of files) {
    bundle[file] = readFileSync(path.join(AUTH_DIR, file), 'utf-8');
  }
  return JSON.stringify(bundle);
}

// Layout: [12-byte IV][16-byte auth tag][ciphertext] — self-contained, no
// separate metadata file to lose track of.
export function encryptBundle(plaintext: string): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

export function decryptBundle(blob: Buffer): string {
  const iv = blob.subarray(0, 12);
  const authTag = blob.subarray(12, 28);
  const ciphertext = blob.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
}

let s3Client: S3Client | null = null;
function getS3(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${config.sessionBackup.r2AccountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.sessionBackup.r2AccessKeyId,
        secretAccessKey: config.sessionBackup.r2SecretAccessKey,
      },
    });
  }
  return s3Client;
}

export { BACKUP_KEY };

async function runBackup(): Promise<void> {
  const encrypted = encryptBundle(bundleAuthFolder());
  await getS3().send(
    new PutObjectCommand({ Bucket: config.sessionBackup.r2Bucket, Key: BACKUP_KEY, Body: encrypted }),
  );
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleSessionBackup(logger: { info: (msg: string) => void; error: (msg: string, err: unknown) => void }): void {
  if (!config.sessionBackup.enabled) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    runBackup().then(
      () => logger.info('[session-backup] uploaded encrypted session to R2'),
      (err) => logger.error('[session-backup] upload failed, will retry on next change', err),
    );
  }, DEBOUNCE_MS);
}
