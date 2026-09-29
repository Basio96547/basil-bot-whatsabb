import { statfsSync } from 'node:fs';
import { config } from './config.ts';

// /health كان يقرأ فقط، فلا يرى القرص الممتلئ أبداً: كل طلب كود يرجع 500
// و/health يقول ok، ومراقب mokhdam-app صامت. إشارتان:
//   disk_low        — المساحة الحرة دون العتبة: إنذار مبكر والخدمة ما زالت تعمل
//   storage_failing — كتابة فعلية فشلت مؤخراً: الزبائن يرون الخطأ الآن

// ما تقوله node:sqlite حين لا يمكن الكتابة في القاعدة أصلاً.
const STORAGE_FAILURE_RE = /database or disk is full|disk I\/O error|readonly database|unable to open database file/i;
// بلا حركة لا تحدث كتابات تفشل، فالإشارة تبقى هذه المدة بعد آخر فشل ثم تسقط.
// وكتابة ناجحة (noteStorageSuccess) تُسقطها فوراً.
const FAILING_WINDOW_MS = 15 * 60_000;
// لا تتذبذب حول العتبة: disk_low لا تزول إلا فوقها بربع.
const LOW_CLEAR_FACTOR = 1.25;

let lastFailureAt: number | null = null;
let low = false;

export function noteStorageFailure(err: unknown): void {
  const text = err instanceof Error ? err.message : String(err);
  if (STORAGE_FAILURE_RE.test(text)) lastFailureAt = Date.now();
}

export function noteStorageSuccess(): void {
  lastFailureAt = null;
}

export function freeDiskBytes(dir: string = config.dataDir): number | null {
  try {
    const s = statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return null; // نظام ملفات لا يدعم statfs — لا نخمّن
  }
}

export interface StorageStatus {
  failing: boolean;
  lastFailureAt: string | null;
  low: boolean;
  freeBytes: number | null;
}

export function storageStatus(now: number = Date.now(), freeBytes: number | null = freeDiskBytes()): StorageStatus {
  const threshold = config.storage.diskLowBytes;
  if (freeBytes !== null) {
    if (freeBytes < threshold) low = true;
    else if (freeBytes > threshold * LOW_CLEAR_FACTOR) low = false;
  }
  return {
    failing: lastFailureAt !== null && now - lastFailureAt < FAILING_WINDOW_MS,
    lastFailureAt: lastFailureAt === null ? null : new Date(lastFailureAt).toISOString(),
    low,
    freeBytes,
  };
}
