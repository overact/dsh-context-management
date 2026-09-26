/**
 * NotesStore — in-memory virtual notes for one session:
 * - 1,000,000 UTF-8 bytes limit per file
 * - Virtual path resolution (<agent_name>/notes/...)
 * - Line range slicing with 1-based and negative index support
 * Durable storage lives in NoteRepository.
 */

export const MAX_FILE_BYTES = 1_000_000;

export class NotesStore {
  /**
   * In-memory note files for one session; persistence is NoteRepository's job.
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
   *
   * @param {string} [agentName='default']
   * @param {string} inputPath
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

    if (isLeadingSlash) {
      if (!isAbsoluteNotesPattern) {
        throw new Error(`Absolute path must match "<agentName>/notes/<path>", got: "${inputPath}"`);
      }
      return segments.join('/');
    }

    if (isAbsoluteNotesPattern) {
      return segments.join('/');
    }

    const cleanAgent = (agentName || 'default').trim();
    if (cleanAgent.includes('/') || cleanAgent === '.' || cleanAgent === '..') {
      throw new Error(`Invalid agent name: "${agentName}"`);
    }

    return `${cleanAgent}/notes/${cleanPath}`;
  }

  /**
   * Resolve virtual path prefix for listing and searching.
   *
   * @param {string} [agentName='default']
   * @param {string} [prefix='']
   * @returns {string}
   */
  resolvePrefix(agentName = 'default', prefix = '') {
    if (!prefix) {
      return `${agentName || 'default'}/notes/`;
    }
    if (prefix === '/' || prefix === '*') {
      return '';
    }

    const isLeadingSlash = prefix.startsWith('/');
    const cleanPrefix = isLeadingSlash ? prefix.replace(/^\/+/, '') : prefix;
    const segments = cleanPrefix.split('/');

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (i === segments.length - 1 && seg === '') {
        continue; // trailing slash is permitted for directory prefixes
      }
      if (seg === '' || seg === '.' || seg === '..') {
        throw new Error(`Invalid prefix component "${seg}". Empty, '.', and '..' are unsupported.`);
      }
    }

    if (isLeadingSlash) {
      return cleanPrefix;
    }

    if (segments.length >= 2 && segments[1] === 'notes') {
      return cleanPrefix;
    }

    return `${agentName || 'default'}/notes/${cleanPrefix}`;
  }

  /**
   * Create or replace a virtual note file.
   *
   * @param {string} agentName
   * @param {string} rawPath
   * @param {string} text
   * @returns {{ path: string, size_bytes: number, lines_count: number, created_at: string, updated_at: string, status: string }}
   */
  writeFile(agentName, rawPath, text) {
    const resolvedPath = this.resolvePath(agentName, rawPath);
    this.validateWrite(resolvedPath, text);
    const byteLength = Buffer.byteLength(text, 'utf8');

    const now = new Date().toISOString();
    const existing = this.files.get(resolvedPath);
    const createdAt = existing ? existing.created_at : now;

    const entry = {
      content: text,
      size_bytes: byteLength,
      created_at: createdAt,
      updated_at: now,
    };

    this.files.set(resolvedPath, entry);

    const linesCount = text.length === 0 ? 0 : text.split(/\r?\n/).length;

    return {
      path: resolvedPath,
      size_bytes: byteLength,
      lines_count: linesCount,
      created_at: createdAt,
      updated_at: now,
      status: 'written',
    };
  }

  /** Reject capacity exhaustion explicitly; never silently discard a note. */
  validateWrite(resolvedPath, text) {
    if (typeof text !== 'string') throw new Error('Text must be a string');
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_FILE_BYTES) throw new Error(`File size ${bytes} bytes exceeds limit of ${MAX_FILE_BYTES} UTF-8 bytes.`);
    if (!this.files.has(resolvedPath) && this.files.size >= (this.options.maxFiles ?? 256)) {
      throw new Error('Note file limit reached; reuse an existing note file.');
    }
    const total = [...this.files.values()].reduce((sum, file) => sum + file.size_bytes, 0)
      - (this.files.get(resolvedPath)?.size_bytes ?? 0) + bytes;
    if (total > (this.options.maxTotalBytes ?? 4_000_000)) throw new Error('Total note byte limit reached; shorten existing notes.');
  }

  /**
   * Append text to a virtual note file, creating it if it does not exist.
   *
   * @param {string} agentName
   * @param {string} rawPath
   * @param {string} text
   * @returns {{ path: string, size_bytes: number, lines_count: number, created_at: string, updated_at: string, status: string }}
   */
  appendToFile(agentName, rawPath, text) {
    const resolvedPath = this.resolvePath(agentName, rawPath);
    if (typeof text !== 'string') {
      throw new Error('Text must be a string');
    }

    const existing = this.files.get(resolvedPath);
    const prevContent = existing ? existing.content : '';
    const newContent = prevContent + text;

    const totalBytes = Buffer.byteLength(newContent, 'utf8');
    if (totalBytes > MAX_FILE_BYTES) {
      throw new Error(`Appending ${Buffer.byteLength(text, 'utf8')} bytes would exceed limit of ${MAX_FILE_BYTES} UTF-8 bytes (current: ${existing?.size_bytes ?? 0}).`);
    }
    this.validateWrite(resolvedPath, newContent);

    const now = new Date().toISOString();
    const createdAt = existing ? existing.created_at : now;

    const entry = {
      content: newContent,
      size_bytes: totalBytes,
      created_at: createdAt,
      updated_at: now,
    };

    this.files.set(resolvedPath, entry);

    const linesCount = newContent.length === 0 ? 0 : newContent.split(/\r?\n/).length;

    return {
      path: resolvedPath,
      size_bytes: totalBytes,
      lines_count: linesCount,
      created_at: createdAt,
      updated_at: now,
      status: 'appended',
    };
  }

  /**
   * Read note file content with 1-based and negative line slicing support.
   *
   * @param {string} agentName
   * @param {string} rawPath
   * @param {number} [startLine] 1-based start line (or negative)
   * @param {number} [stopLine] 1-based stop line (or negative, inclusive)
   * @returns {{ path: string, content: string, total_lines: number, start_line: number, stop_line: number }}
   */
  readFile(agentName, rawPath, startLine, stopLine) {
    const resolvedPath = this.resolvePath(agentName, rawPath);
    const entry = this.files.get(resolvedPath);
    if (!entry) {
      throw new Error(`Note file not found: ${resolvedPath}`);
    }

    const lines = entry.content.split(/\r?\n/);
    const totalLines = entry.content.length === 0 ? 0 : lines.length;

    if (startLine === undefined && stopLine === undefined) {
      return {
        path: resolvedPath,
        content: entry.content,
        total_lines: totalLines,
        start_line: totalLines === 0 ? 0 : 1,
        stop_line: totalLines,
      };
    }

    if (totalLines === 0) {
      return {
        path: resolvedPath,
        content: '',
        total_lines: 0,
        start_line: 0,
        stop_line: 0,
      };
    }

    const toZeroIndex = (lineNum) => {
      if (lineNum > 0) return lineNum - 1;
      if (lineNum < 0) return totalLines + lineNum;
      return 0;
    };

    const startIdx = startLine !== undefined && startLine !== null ? toZeroIndex(startLine) : 0;
    const stopIdx = stopLine !== undefined && stopLine !== null
      ? (stopLine > 0 ? stopLine - 1 : (stopLine < 0 ? totalLines + stopLine : 0))
      : totalLines - 1;

    if (startIdx > stopIdx || startIdx >= totalLines || stopIdx < 0) {
      return {
        path: resolvedPath,
        content: '',
        total_lines: totalLines,
        start_line: Math.max(1, startIdx + 1),
        stop_line: Math.max(0, stopIdx + 1),
      };
    }

    const clampedStart = Math.max(0, startIdx);
    const clampedStop = Math.min(totalLines - 1, stopIdx);

    if (clampedStart > clampedStop) {
      return {
        path: resolvedPath,
        content: '',
        total_lines: totalLines,
        start_line: clampedStart + 1,
        stop_line: clampedStop + 1,
      };
    }

    const sliced = lines.slice(clampedStart, clampedStop + 1);

    return {
      path: resolvedPath,
      content: sliced.join('\n'),
      total_lines: totalLines,
      start_line: clampedStart + 1,
      stop_line: clampedStop + 1,
    };
  }

  /**
   * List files matching prefix with metadata.
   *
   * @param {string} agentName
   * @param {string} [prefix='']
   * @param {number} [maxResults=50]
   * @param {'updated_at'|'created_at'|'size_bytes'|'path'|'name'} [orderBy='updated_at']
   * @param {'asc'|'desc'|'ascending'|'descending'} [order='desc']
   * @returns {Array<{ path: string, size_bytes: number, created_at: string, updated_at: string }>}
   */
  listFilesByPrefix(agentName, prefix = '', maxResults = 50, orderBy = 'updated_at', order = 'desc') {
    const searchPrefix = this.resolvePrefix(agentName, prefix);

    let entries = [];
    for (const [filePath, meta] of this.files.entries()) {
      if (filePath.startsWith(searchPrefix)) {
        entries.push({
          path: filePath,
          size_bytes: meta.size_bytes,
          created_at: meta.created_at,
          updated_at: meta.updated_at,
        });
      }
    }

    const isAsc = order === 'asc' || order === 'ascending';
    entries.sort((a, b) => {
      let cmp = 0;
      if (orderBy === 'created_at') {
        cmp = a.created_at.localeCompare(b.created_at);
      } else if (orderBy === 'size_bytes' || orderBy === 'size') {
        cmp = a.size_bytes - b.size_bytes;
      } else if (orderBy === 'name' || orderBy === 'path') {
        cmp = a.path.localeCompare(b.path);
      } else {
        cmp = a.updated_at.localeCompare(b.updated_at);
      }
      return isAsc ? cmp : -cmp;
    });

    if (Number.isFinite(maxResults) && maxResults > 0) {
      entries = entries.slice(0, maxResults);
    }

    return entries;
  }

  /**
   * Search note contents by literal substring.
   *
   * @param {string} agentName
   * @param {string} query
   * @param {string} [pathPrefix]
   * @param {number} [maxMatchesPerFile=20]
   * @param {number} [maxFiles=20]
   * @param {boolean} [recentFirst=false]
   * @returns {Array<{ path: string, matches: Array<{ line_number: number, line: string }>, total_matches: number, size_bytes: number, created_at: string, updated_at: string }>}
   */
  searchContents(agentName, query, pathPrefix, maxMatchesPerFile = 20, maxFiles = 20, recentFirst = false) {
    if (!query || typeof query !== 'string') {
      throw new Error('Query must be a non-empty string');
    }

    const searchPrefix = pathPrefix !== undefined && pathPrefix !== null
      ? this.resolvePrefix(agentName, pathPrefix)
      : this.resolvePrefix(agentName, '');

    const candidates = [];
    for (const [filePath, meta] of this.files.entries()) {
      if (filePath.startsWith(searchPrefix)) {
        candidates.push({ path: filePath, meta });
      }
    }

    if (recentFirst) {
      candidates.sort((a, b) => b.meta.updated_at.localeCompare(a.meta.updated_at));
    } else {
      candidates.sort((a, b) => a.path.localeCompare(b.path));
    }

    const results = [];
    for (const { path: filePath, meta } of candidates) {
      if (results.length >= maxFiles) break;

      const lines = meta.content.split(/\r?\n/);
      const matches = [];
      let totalMatches = 0;

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(query)) {
          totalMatches++;
          if (matches.length < maxMatchesPerFile) {
            matches.push({
              line_number: i + 1,
              line: lines[i],
            });
          }
        }
      }

      if (matches.length > 0) {
        results.push({
          path: filePath,
          matches,
          total_matches: totalMatches,
          size_bytes: meta.size_bytes,
          created_at: meta.created_at,
          updated_at: meta.updated_at,
        });
      }
    }

    return results;
  }

  /**
   * Check if a note file exists.
   *
   * @param {string} agentName
   * @param {string} rawPath
   * @returns {boolean}
   */
  hasFile(agentName, rawPath) {
    try {
      const resolved = this.resolvePath(agentName, rawPath);
      return this.files.has(resolved);
    } catch {
      return false;
    }
  }

  /**
   * Clear all notes in memory.
   */
  clear() {
    this.files.clear();
  }
}
