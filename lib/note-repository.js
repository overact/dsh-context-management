import { readFileSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { NotesStore } from './notes-store.js';

const LIMITS = { maxFiles: 64, maxTotalBytes: 4_000_000 };

/** Lazily read one bounded note snapshot from plugin-owned Harness-home storage,
 * independent of the session-persistence backend's private layout.
 * Do not write unknown event types: current DSH cannot reopen those logs.
 * Atomic replacement and a file lock cover concurrent writers and process restarts.
 */
export class NoteRepository {
  /** @param {() => string} [root] - notes directory; resolved per call so `$DSH_HOME` is honored. */
  constructor(root = () => dshHomePath('context-management', 'notes')) { this.root = root; }

  path(session) {
    if (typeof session.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(session.id)) {
      throw new Error('Context notes require a filesystem-safe DSH session id.');
    }
    return join(this.root(), `${session.id}.json`);
  }

  load(session) {
    const file = this.path(session);
    const store = new NotesStore(LIMITS);
    let data;
    try {
      if (statSync(file).size > 25_000_000) throw new Error('Context notes snapshot exceeds the encoded size limit.');
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return store;
      throw error;
    }
    if (data.version !== 1 || data.session_id !== session.id || !Array.isArray(data.files)) throw new Error('Invalid context notes snapshot.');
    for (const entry of data.files) {
      const canonical = store.resolvePath('self', entry.path);
      if (!canonical.startsWith('self/notes/') || store.files.has(canonical)) throw new Error('Invalid or duplicate note path in snapshot.');
      store.validateWrite(canonical, entry.content);
      if (!Number.isFinite(Date.parse(entry.created_at)) || !Number.isFinite(Date.parse(entry.updated_at))) throw new Error('Invalid note timestamp.');
      store.files.set(canonical, { content: entry.content, size_bytes: Buffer.byteLength(entry.content), created_at: entry.created_at, updated_at: entry.updated_at,
        ...(typeof entry.window_id === 'string' && /^win_\d+$/.test(entry.window_id) && Number.isSafeInteger(entry.source_seq) && entry.source_seq >= 0
          ? { window_id: entry.window_id, source_seq: entry.source_seq } : {}) });
    }
    return store;
  }

  async write(session, path, text, operation, signal, provenance = {}) {
    const file = this.path(session);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    return withFileLock(file, async () => {
      signal?.throwIfAborted();
      // Refresh under the lock so two processes never overwrite each other's notes.
      const store = this.load(session);
      const result = operation === 'append' ? store.appendToFile('self', path, text) : store.writeFile('self', path, text);
      Object.assign(store.files.get(path), provenance);
      const data = { version: 1, session_id: session.id,
        files: [...store.files].map(([path, meta]) => ({ path, ...meta })) };
      signal?.throwIfAborted();
      await writeFileAtomic(file, JSON.stringify(data), { mode: 0o600, dirMode: 0o700 });
      return { store, result };
    });
  }
}
