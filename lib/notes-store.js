/**
 * NotesStore — in-memory virtual notes for one session:
 * - 1,000,000 UTF-8 bytes limit per file
 * - Virtual path resolution (<agent_name>/notes/...)
 * - Line range slicing with 1-based and negative index support
 * Durable storage lives in NoteRepository.
 */

export const MAX_FILE_BYTES = 1_000_000;

const lineCount = text => (text.length === 0 ? 0 : text.split(/\r?\n/).length);

export class NotesStore {
  /**
   * @param {object} [options]
   * @param {number} [options.maxFiles]
   * @param {number} [options.maxTotalBytes]
   */
  constructor(options = {}) {
    this.options = options;
    /** @type {Map<string, { content: string, size_bytes: number, created_at: string, updated_at: string }>} */
    this.files = new Map();
  }

  /**
   * Resolve a virtual note path:
   * - Relative paths -> `<agent_name>/notes/<path>`
   * - Cross-agent / absolute paths -> `<agent_name>/notes/<path>` or `/<agent_name>/notes/<path>`
   * - Disallows empty, '.', and '..' components.
   * @returns {string} canonical virtual path
   */
  resolvePath(agentName = 'default', inputPath) {
    if (!inputPath || typeof inputPath !== 'string') {
      throw new Error('Path must be a non-empty string');
    }
    if (Buffer.byteLength(inputPath, 'utf8') > 512) throw new Error('Note paths must be at most 512 UTF-8 bytes.');

    const isLeadingSlash = inputPath.startsWith('/');
    const cleanPath = isLeadingSlash ? inputPath.replace(/^\/+/, '') : inputPath;
    const segments = cleanPath.split('/');
    for (const segment of segments) {
      if (segment === '' || segment === '.' || segment === '..') {
        throw new Error(`Invalid path component "${segment}". Empty, '.', and '..' are unsupported.`);
      }
    }

    const isAbsoluteNotesPattern = segments.length >= 3 && segments[1] === 'notes';
    if (isLeadingSlash && !isAbsoluteNotesPattern) {
      throw new Error(`Absolute path must match "<agentName>/notes/<path>", got: "${inputPath}"`);
    }
    if (isAbsoluteNotesPattern) return cleanPath;

    const cleanAgent = (agentName || 'default').trim();
    if (cleanAgent.includes('/') || cleanAgent === '.' || cleanAgent === '..') {
      throw new Error(`Invalid agent name: "${agentName}"`);
    }
    return `${cleanAgent}/notes/${cleanPath}`;
  }

  /** Resolve a virtual path prefix for listing and searching. */
  resolvePrefix(agentName = 'default', prefix = '') {
    if (!prefix) return `${agentName || 'default'}/notes/`;
    if (prefix === '/' || prefix === '*') return '';

    const isLeadingSlash = prefix.startsWith('/');
    const cleanPrefix = isLeadingSlash ? prefix.replace(/^\/+/, '') : prefix;
    const segments = cleanPrefix.split('/');
    segments.forEach((seg, i) => {
      if (i === segments.length - 1 && seg === '') return; // trailing slash is permitted for directory prefixes
      if (seg === '' || seg === '.' || seg === '..') {
        throw new Error(`Invalid prefix component "${seg}". Empty, '.', and '..' are unsupported.`);
      }
    });

    if (isLeadingSlash || (segments.length >= 2 && segments[1] === 'notes')) return cleanPrefix;
    return `${agentName || 'default'}/notes/${cleanPrefix}`;
  }

  /** Reject capacity exhaustion explicitly; never silently discard a note. */
  validateWrite(resolvedPath, text) {
    if (typeof text !== 'string') throw new Error('Text must be a string');
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_FILE_BYTES) throw new Error(`File size ${bytes} bytes exceeds limit of ${MAX_FILE_BYTES} UTF-8 bytes.`);
    if (!this.files.has(resolvedPath) && this.files.size >= (this.options.maxFiles ?? 256)) {
      throw new Error('Note file limit reached; reuse an existing note file.');
    }
    let total = bytes - (this.files.get(resolvedPath)?.size_bytes ?? 0);
    for (const file of this.files.values()) total += file.size_bytes;
    if (total > (this.options.maxTotalBytes ?? 4_000_000)) throw new Error('Total note byte limit reached; shorten existing notes.');
  }

  /** Store validated content, keeping the original creation time. */
  commit(resolvedPath, content, sizeBytes, status) {
    const now = new Date().toISOString();
    const createdAt = this.files.get(resolvedPath)?.created_at ?? now;
    this.files.set(resolvedPath, { content, size_bytes: sizeBytes, created_at: createdAt, updated_at: now });
    return { path: resolvedPath, size_bytes: sizeBytes, lines_count: lineCount(content), created_at: createdAt, updated_at: now, status };
  }

  /**
   * Create or replace a virtual note file.
   * @returns {{ path: string, size_bytes: number, lines_count: number, created_at: string, updated_at: string, status: string }}
   */
  writeFile(agentName, rawPath, text) {
    const resolvedPath = this.resolvePath(agentName, rawPath);
    this.validateWrite(resolvedPath, text);
    return this.commit(resolvedPath, text, Buffer.byteLength(text, 'utf8'), 'written');
  }

  /** Append text to a virtual note file, creating it if it does not exist. */
  appendToFile(agentName, rawPath, text) {
    const resolvedPath = this.resolvePath(agentName, rawPath);
    if (typeof text !== 'string') throw new Error('Text must be a string');
    const existing = this.files.get(resolvedPath);
    const content = (existing?.content ?? '') + text;
    const totalBytes = Buffer.byteLength(content, 'utf8');
    if (totalBytes > MAX_FILE_BYTES) {
      throw new Error(`Appending ${Buffer.byteLength(text, 'utf8')} bytes would exceed limit of ${MAX_FILE_BYTES} UTF-8 bytes (current: ${existing?.size_bytes ?? 0}).`);
    }
    this.validateWrite(resolvedPath, content);
    return this.commit(resolvedPath, content, totalBytes, 'appended');
  }

  /**
   * Read note file content with 1-based and negative line slicing support.
   * @param {number} [startLine] 1-based start line (or negative)
   * @param {number} [stopLine] 1-based stop line (or negative, inclusive)
   * @returns {{ path: string, content: string, total_lines: number, start_line: number, stop_line: number }}
   */
  readFile(agentName, rawPath, startLine, stopLine) {
    const path = this.resolvePath(agentName, rawPath);
    const entry = this.files.get(path);
    if (!entry) throw new Error(`Note file not found: ${path}`);

    const lines = entry.content.split(/\r?\n/);
    const totalLines = entry.content.length === 0 ? 0 : lines.length;
    if (startLine === undefined && stopLine === undefined) {
      return { path, content: entry.content, total_lines: totalLines, start_line: totalLines === 0 ? 0 : 1, stop_line: totalLines };
    }
    if (totalLines === 0) return { path, content: '', total_lines: 0, start_line: 0, stop_line: 0 };

    const toIndex = line => (line > 0 ? line - 1 : line < 0 ? totalLines + line : 0);
    const startIdx = startLine != null ? toIndex(startLine) : 0;
    const stopIdx = stopLine != null ? toIndex(stopLine) : totalLines - 1;
    if (startIdx > stopIdx || startIdx >= totalLines || stopIdx < 0) {
      return { path, content: '', total_lines: totalLines, start_line: Math.max(1, startIdx + 1), stop_line: Math.max(0, stopIdx + 1) };
    }
    // Here startIdx <= stopIdx, startIdx < totalLines and stopIdx >= 0, so the clamped range is never empty.
    const start = Math.max(0, startIdx);
    const stop = Math.min(totalLines - 1, stopIdx);
    return { path, content: lines.slice(start, stop + 1).join('\n'), total_lines: totalLines, start_line: start + 1, stop_line: stop + 1 };
  }

  /**
   * List files matching prefix with metadata.
   * @param {'updated_at'|'created_at'|'size_bytes'|'path'|'name'} [orderBy='updated_at']
   * @param {'asc'|'desc'|'ascending'|'descending'} [order='desc']
   * @returns {Array<{ path: string, size_bytes: number, created_at: string, updated_at: string }>}
   */
  listFilesByPrefix(agentName, prefix = '', maxResults = 50, orderBy = 'updated_at', order = 'desc') {
    const searchPrefix = this.resolvePrefix(agentName, prefix);
    const entries = [];
    for (const [path, meta] of this.files) {
      if (path.startsWith(searchPrefix)) {
        entries.push({ path, size_bytes: meta.size_bytes, created_at: meta.created_at, updated_at: meta.updated_at });
      }
    }
    const direction = order === 'asc' || order === 'ascending' ? 1 : -1;
    const compare = orderBy === 'created_at' ? (a, b) => a.created_at.localeCompare(b.created_at)
      : orderBy === 'size_bytes' || orderBy === 'size' ? (a, b) => a.size_bytes - b.size_bytes
        : orderBy === 'name' || orderBy === 'path' ? (a, b) => a.path.localeCompare(b.path)
          : (a, b) => a.updated_at.localeCompare(b.updated_at);
    entries.sort((a, b) => direction * compare(a, b));
    return Number.isFinite(maxResults) && maxResults > 0 ? entries.slice(0, maxResults) : entries;
  }

  /**
   * Search note contents by literal substring.
   * @returns {Array<{ path: string, matches: Array<{ line_number: number, line: string }>, total_matches: number, size_bytes: number, created_at: string, updated_at: string }>}
   */
  searchContents(agentName, query, pathPrefix, maxMatchesPerFile = 20, maxFiles = 20, recentFirst = false) {
    if (!query || typeof query !== 'string') {
      throw new Error('Query must be a non-empty string');
    }
    const searchPrefix = this.resolvePrefix(agentName, pathPrefix ?? '');
    const candidates = [...this.files].filter(([path]) => path.startsWith(searchPrefix));
    candidates.sort(recentFirst
      ? ([, a], [, b]) => b.updated_at.localeCompare(a.updated_at)
      : ([a], [b]) => a.localeCompare(b));

    const results = [];
    for (const [path, meta] of candidates) {
      if (results.length >= maxFiles) break;
      const lines = meta.content.split(/\r?\n/);
      const matches = [];
      let totalMatches = 0;
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes(query)) continue;
        totalMatches++;
        if (matches.length < maxMatchesPerFile) matches.push({ line_number: i + 1, line: lines[i] });
      }
      if (matches.length > 0) {
        results.push({ path, matches, total_matches: totalMatches, size_bytes: meta.size_bytes, created_at: meta.created_at, updated_at: meta.updated_at });
      }
    }
    return results;
  }
}
