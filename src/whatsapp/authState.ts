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

async function writeAtomic(filePath: string, contents: string): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  const handle = await open(tmpPath, 'w');
  try {
    await handle.writeFile(contents, 'utf-8');
    // Without this the rename can land before the data does, which on a
    // power cut is exactly the torn file this whole function exists to avoid.
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmpPath, filePath);

  // rename() is atomic for concurrent READERS, but durability across a power
  // cut also needs the directory entry itself flushed — otherwise the file's
  // contents are on disk while the name still points at the old version (or
  // nowhere), leaving a stray .tmp behind. That is the crash case the header
  // cites as this function's whole reason to exist.
  //
  // Best-effort: some platforms refuse to open a directory for fsync (Windows
  // in particular), and there the write is still no worse than before.
  try {
    const dir = await open(path.dirname(filePath), 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch {
    /* directory fsync unsupported here — nothing further to do */
  }
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

  const creds: AuthenticationCreds = (await readData('creds.json')) || initAuthCreds();

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
