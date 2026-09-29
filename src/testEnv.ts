import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Call before anything imports config.ts (every test does this, then imports
 * the module under test with `await import(...)`).
 *
 * DATA_DIR goes to a throwaway folder so a test never touches the live queue,
 * and each project in config/projects.json gets an API key — config.ts refuses
 * to load without one, which on a fresh checkout with no .env failed a test
 * file before a single test ran. The keys are read from projects.json itself:
 * the hand-kept list was copied into every test file, and a new project meant
 * editing all of them.
 */
export function useTestEnv(name: string): string {
  const dataDir = mkdtempSync(path.join(tmpdir(), `sms-api-${name}-`));
  process.env.DATA_DIR = dataDir;
  // Every run used to leave one folder per test file behind. Windows refuses
  // to delete the still-open SQLite file — that one stays, as before.
  process.on('exit', () => {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });
  const projects = JSON.parse(readFileSync(new URL('../config/projects.json', import.meta.url), 'utf-8')) as Array<{ id: string }>;
  for (const { id } of projects) process.env[`PROJECT_API_KEY_${id.toUpperCase()}`] ??= `test-${id}-key`;
  process.env.OTP_HASH_SECRET ??= 'test-otp-hash-secret';
  process.env.SESSION_BACKUP_ENCRYPTION_KEY ??= 'test-passphrase-for-backup-roundtrip';
  return dataDir;
}
