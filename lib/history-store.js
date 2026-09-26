/** Bounded, session-local views over the immutable DSH event log.
 * No payload index, eviction, duplicate ingestion, or second history database.
 */
export const HISTORY_EVENT_TYPES = new Set([
  'user/message', 'assistant/message', 'tool/result', 'tool/code-dispatch',
  'tool/call', 'system/message', 'developer/message',
]);

export function extractContentText(content) {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) return content.map(block => {
    if (typeof block === 'string') return block;
    if (typeof block?.text === 'string') return block.text;
    if (block?.type === 'tool-result') return extractContentText(block.content);
    return JSON.stringify(block);
  }).join('\n');
  return JSON.stringify(content, null, 2);
}

export function parseToolIdentifiers(name = '') {
  const separator = name.includes('__') ? '__' : name.includes(':') ? ':' : null;
  if (!separator) return { toolName: name };
  const parts = name.split(separator);
  return { toolNamespace: parts.slice(0, -1).join(separator), toolName: parts.at(-1) };
}

function boundedInt(value, fallback, max, min = 0) {
  if (value == null) return fallback;
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`Expected an integer >= ${min}.`);
  return Math.min(value, max);
}

function eventInfo(event, resultNames) {
  if (!HISTORY_EVENT_TYPES.has(event.type)) return null;
  const data = event.data;
  const isTool = event.type === 'tool/result' || event.type === 'tool/code-dispatch';
  const role = isTool ? 'tool' : event.type === 'tool/call' ? 'assistant' : event.type.split('/')[0];
  const content = data.message?.content ?? data.content ?? data.arguments ?? data.result ?? '';
  const names = event.type === 'assistant/message'
    ? (Array.isArray(content) ? content.filter(b => b.type === 'tool-call').map(b => b.name) : [])
    : [data.name ?? data.toolName ?? resultNames?.get(event.seq)].filter(Boolean);
  return { role, content, names, tools: names.map(parseToolIdentifiers) };
}

export class HistoryStore {
  constructor(session, states) {
    this.session = session;
    this.states = states;
  }

  windowAt(seq, windows = this.states.get(this.session).windows) {
    let low = 0, high = windows.length;
    while (low + 1 < high) {
      const mid = (low + high) >>> 1;
      if (windows[mid].start_seq <= seq) low = mid;
      else high = mid;
    }
    return windows[low];
  }

  listWindows(args = {}) {
    const windows = this.states.get(this.session).windows;
    const list = args.recent_first === false ? windows : [...windows].reverse();
    return list.slice(0, boundedInt(args.limit, 20, 100)).map(w => ({ ...w, created_at: new Date(w.created_at).toISOString(), agent_name: this.session.id }));
  }

  metadata(event, info, windows) {
    return {
      item_id: `item_${event.seq}`,
      window_id: this.windowAt(event.seq, windows).window_id,
      role: info.role,
      event_type: event.type,
      agent_name: this.session.id,
      created_at: new Date(event.time).toISOString(),
      ordinal: event.seq,
      ...(info.names.length ? { tool_name: info.names.join(', '), tool_names: info.names } : {}),
      ...(info.tools[0]?.toolNamespace ? { tool_namespace: info.tools[0].toolNamespace } : {}),
    };
  }

  listItems(args = {}) { return this.query(args, false); }
  searchContents(args = {}) { return this.query(args, true); }

  query(args, search) {
    const state = this.states.get(this.session);
    const windows = state.windows;
    const key = search ? 'matches' : 'items';
    const window = args.window_id ? windows.find(w => w.window_id === args.window_id) : null;
    if (args.window_id && !window) return { [key]: [], has_more: false, next_cursor: null, scanned_events: 0 };
    if (search && (typeof args.query !== 'string' || !args.query.length || args.query.length > 256)) {
      throw new Error('Search query must contain 1–256 characters.');
    }
    const from = window?.start_seq ?? 0;
    const end = window ? (windows[windows.indexOf(window) + 1]?.start_seq ?? this.session.seq) : this.session.seq;
    const recent = args.recent_first !== false;
    const step = recent ? -1 : 1;
    let cursor = boundedInt(args.cursor, recent ? end - 1 : from, this.session.seq);
    const limit = boundedInt(args.limit, 20, 50);
    const chars = boundedInt(args.max_chars_per_item, 400, 1000);
    const output = [];
    let scanned = 0, scannedChars = 0, outputChars = 0;
    const needle = search ? (args.case_sensitive === false ? args.query.toLowerCase() : args.query) : '';
    while (cursor >= from && cursor < end && output.length < limit && scanned < 2000 && scannedChars < 2_000_000 && outputChars < 12_000) {
      const event = this.session.eventAt(cursor);
      cursor += step;
      scanned++;
      const info = eventInfo(event, state.resultNames);
      if (!info || (args.role && info.role !== args.role)) continue;
      if (args.tool_name && !info.names.includes(args.tool_name) && !info.tools.some(t => t.toolName === args.tool_name)) continue;
      if (args.tool_namespace && !info.tools.some(t => t.toolNamespace === args.tool_namespace)) continue;
      const content = extractContentText(info.content);
      scannedChars += content.length;
      const matchAt = search ? (args.case_sensitive === false ? content.toLowerCase() : content).indexOf(needle) : 0;
      if (matchAt < 0) continue;
      const offset = Math.max(0, matchAt - 80);
      const preview = content.slice(offset, offset + Math.min(chars, 12_000 - outputChars));
      outputChars += preview.length;
      output.push({ ...this.metadata(event, info, windows), truncated_content: preview, offset_chars: offset, total_chars: content.length });
    }
    const more = cursor >= from && cursor < end;
    return { [key]: output, has_more: more, next_cursor: more ? cursor : null, scanned_events: scanned };
  }

  readItem(args = {}) {
    const match = /^item_(0|[1-9]\d*)$/.exec(args.item_id ?? '');
    const seq = match ? Number(match[1]) : -1;
    if (!Number.isSafeInteger(seq) || seq < 0 || seq >= this.session.seq) return null;
    const event = this.session.eventAt(seq);
    const info = eventInfo(event, this.states.get(this.session).resultNames);
    if (!info) return null;
    const metadata = this.metadata(event, info);
    if (args.window_id && metadata.window_id !== args.window_id) return null;
    const content = args.format === 'json' ? JSON.stringify(event, null, 2) : extractContentText(info.content);
    const offset = boundedInt(args.offset_chars, 0, Number.MAX_SAFE_INTEGER);
    const limit = boundedInt(args.limit_chars, 8000, 20_000);
    const text = content.slice(offset, offset + limit);
    return { ...metadata, content: text, offset_chars: offset, total_chars: content.length,
      has_more: offset + text.length < content.length,
      next_offset_chars: offset + text.length < content.length ? offset + text.length : null };
  }
}
