// Drop-in replacement for Baileys' useMultiFileAuthState, with two changes
// that matter on a phone that can lose power mid-write:
//
// 1. Writes are atomic. Baileys writes straight over the live file with a
//    plain writeFile, so a power cut during a creds.json write leaves a
//    truncated file. Here every write goes to a temp file, is fsync'd, and is
//    only then renamed into place — rename is atomic, so a reader always sees
//    either the whole old file or the whole new one, never a torn one.
//
// 2. A corrupt creds.json is reported, not swallowed. Baileys' readData
//    catches every error and returns null, which makes an unreadable
//    creds.json indistinguishable from a first run — it silently generates a
//    brand-new identity and the WhatsApp session is gone with no signal
//    anywhere. probeCreds() below lets the caller tell those two apart before
//    anything is generated.
//
// Everything else (file naming, the app-state-sync-key proto wrapping, the
// null-on-missing key reads) mirrors Baileys' own implementation deliberately
// — this is its storage layer, not a redesign of it.

import { open, readFile, rename, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys';

// Baileys' own name mangling — key ids can contain '/' and ':'.
function fixFileName(file: string): string {
  return file.replace(/\//g, '__').replace(/:/g, '-');
}

// Serializes access per file path. Baileys uses async-mutex for this; a
// promise chain does the same job without pulling in a dependency of its own.
const locks = new Map<string, Promise<unknown>>();

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  // Stored already-caught so one failed write can't poison every later write
  // to the same file; the caller still sees the real rejection via `next`.
  locks.set(key, next.then(() => undefined, () => undefined));
  return next;
}

/**
 * Flushes a directory's own entries — which names exist and what they point
 * at. rename() is atomic for concurrent READERS, but durability across a
 * power cut also needs this, or a file's contents can be on disk while its
 * name still points at the old version (or nowhere).
 *
 * Best-effort: some platforms refuse to open a directory for fsync (Windows
 * in particular), and there the write is still no worse than before.
 */
export async function syncDirectory(dirPath: string): Promise<void> {
  try {
    const dir = await open(dirPath, 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch {
    /* directory fsync unsupported here — nothing further to do */
  }
}

/**
 * Temp file + fsync + rename: a reader sees the whole old file or the whole
 * new one, never a torn one. `syncDir: false` is for callers writing many
 * files into one directory in a burst (a session restore) — they call
 * syncDirectory() once at the end instead of once per file.
 */
export async function writeAtomic(
  filePath: string,
  contents: string | Buffer,
  options: { syncDir?: boolean } = {},
): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  const handle = await open(tmpPath, 'w');
  try {
    await handle.writeFile(contents);
    // Without this the rename can land before the data does, which on a
    // power cut is exactly the torn file this whole function exists to avoid.
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmpPath, filePath);
  if (options.syncDir !== false) await syncDirectory(path.dirname(filePath));
}

export type CredsProbe = 'ok' | 'missing' | 'corrupt' | 'unreadable';

// Answers "is there a usable WhatsApp identity on disk?" without creating one.
// Call this BEFORE useAtomicMultiFileAuthState so a restore can run first.
export async function probeCreds(folder: string): Promise<CredsProbe> {
  const filePath = path.join(folder, 'creds.json');
  let raw: string;
  try {
    raw = await readFile(filePath, { encoding: 'utf-8' });
  } catch (error) {
    // ENOENT is a genuinely absent session. Anything else (EACCES, EBUSY,
    // EMFILE from the ~7500-file key folder, or Android's own filesystem
    // activity) means the file is there but momentarily unreadable — and
    // reporting that as 'missing' made the caller restore a possibly stale
    // backup OVER a healthy live session, losing every key rotated since.
    return (error as { code?: string }).code === 'ENOENT' ? 'missing' : 'unreadable';
  }
  try {
    JSON.parse(raw, BufferJSON.reviver);
    return 'ok';
  } catch {
    return 'corrupt';
  }
}

export interface AtomicAuthState {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}

export async function useAtomicMultiFileAuthState(folder: string): Promise<AtomicAuthState> {
  await mkdir(folder, { recursive: true });

  const writeData = (data: unknown, file: string): Promise<void> => {
    const filePath = path.join(folder, fixFileName(file));
    return withLock(filePath, () => writeAtomic(filePath, JSON.stringify(data, BufferJSON.replacer)));
  };

  const readData = async (file: string): Promise<any> => {
    const filePath = path.join(folder, fixFileName(file));
    return withLock(filePath, async () => {
      try {
        return JSON.parse(await readFile(filePath, { encoding: 'utf-8' }), BufferJSON.reviver);
      } catch {
        return null;
      }
    });
  };

  const removeData = (file: string): Promise<void> => {
    const filePath = path.join(folder, fixFileName(file));
    return withLock(filePath, async () => {
      try {
        await unlink(filePath);
      } catch {
        /* already gone */
      }
    });
  };

  // NOT readData(): that swallows every error into null, and null here means
  // "mint a brand-new identity", which the first creds.update then writes over
  // the real session. probeCreds() only narrows that window — creds.json can
  // still turn momentarily unreadable (EMFILE, EBUSY) between the probe and
  // this read. Only a genuinely absent file starts fresh; any other read error
  // throws, and connectWhatsApp's retry-with-backoff tries again later. A
  // corrupt file still starts fresh, as before: prepareSession has already
  // tried every backup by the time we get here.
  const credsPath = path.join(folder, 'creds.json');
  const creds: AuthenticationCreds = await withLock(credsPath, async () => {
    let raw: string;
    try {
      raw = await readFile(credsPath, { encoding: 'utf-8' });
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return initAuthCreds();
      throw error;
    }
    try {
      return (JSON.parse(raw, BufferJSON.reviver) as AuthenticationCreds | null) || initAuthCreds();
    } catch {
      return initAuthCreds();
    }
  });

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const data: { [id: string]: SignalDataTypeMap[T] } = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}.json`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              // Mirrors Baileys: a missing key is stored as null, and callers
              // are written to expect that despite the map's type.
              data[id] = value as SignalDataTypeMap[T];
            }),
          );
          return data;
        },
        set: async (data) => {
          const tasks: Promise<void>[] = [];
          for (const category in data) {
            const entries = data[category as keyof typeof data];
            for (const id in entries) {
              const value = entries[id];
              const file = `${category}-${id}.json`;
              tasks.push(value ? writeData(value, file) : removeData(file));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData(creds, 'creds.json'),
  };
}
