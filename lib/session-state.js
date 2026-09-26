import { NotesStore } from './notes-store.js';
import { HISTORY_EVENT_TYPES } from './history-store.js';

export const TEMPLATE_PROVIDER = 'context-management';
export const TEMPLATE_MODEL = 'window-v1';
const SUMMARY_KINDS = new Set(['checkpoint', 'generated', 'extractive']);

export function requireSession(exec) {
  const session = exec?.agent?.session;
  if (!session || typeof session.eventAt !== 'function' || !Number.isSafeInteger(session.seq)) {
    throw new Error('Context management requires a live DSH agent session.');
  }
  return session;
}

export function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(block => block?.type === 'text').map(block => block.text).join('\n');
}

/** One incremental projection per live Session, rebuilt from its durable log on resume.
 * History payloads are never copied into this cache. Weak keys follow DSH session lifetimes.
 */
export class SessionStateStore {
  constructor(repository) {
    this.repository = repository;
    this.states = new WeakMap();
  }

  get(session) {
    let state = this.states.get(session);
    if (!state) {
      state = {
        cursor: 0,
        notes: this.repository?.load(session) ?? new NotesStore({ maxFiles: 64, maxTotalBytes: 4_000_000 }),
        windows: [{ window_id: 'win_001', start_seq: 0, created_at: session.header.createdAt, item_count: 0 }],
        latestUsers: [],
        goal: null,
        goalSeq: null,
        todos: [],
        todoSeq: null,
        pending: null,
        candidates: new Map(),
        openCalls: new Map(),
        resultNames: new Map(),
        remindedWindow: null,
      };
      this.states.set(session, state);
    }
    while (state.cursor < session.seq) {
      const event = session.eventAt(state.cursor);
      this.fold(state, event);
      state.cursor++;
    }
    return state;
  }

  fold(state, event) {
    const data = event.data;
    const current = state.windows.at(-1);
    if (event.type === 'assistant/message') {
      const text = textContent(data.message?.content);
      if (text.trim()) current.last_assistant = { seq: event.seq, text: clip(text.trim(), 500) };
      for (const block of data.message?.content ?? []) {
        if (block.type === 'tool-call') state.openCalls.set(block.id, block.name);
      }
    } else if (event.type === 'tool/result') {
      const id = data.message?.source?.callId;
      const name = state.openCalls.get(id) ?? event.sourceEventSeqs?.map(seq => state.resultNames.get(seq)).find(Boolean);
      if (name) state.resultNames.set(event.seq, name);
      state.openCalls.delete(id);
    }
    if (event.type === 'todo/write') {
      state.todos = data.todos;
      state.todoSeq = event.seq;
    } else if (event.type === 'goal/change') {
      state.goal = data.goal ?? null;
      state.goalSeq = event.seq;
    } else if (event.type === 'compaction/summary') {
      // Template handoffs carry this plugin's provider pair; generated handoffs keep
      // the real summarizer's pair and are recognized by their structured record.
      const template = data.provider === TEMPLATE_PROVIDER && data.model === TEMPLATE_MODEL;
      const text = textContent(data.summary);
      const match = text.match(/^<context_window id="(win_\d+)" previous_window_id="(win_\d+)">/);
      if (match) {
        const recordLine = text.split('\n')[1];
        let record;
        try {
          const encoded = /^<window_record>(.*)<\/window_record>$/.exec(recordLine ?? '');
          const parsed = encoded && JSON.parse(encoded[1]);
          if (parsed?.version === 2 && parsed.window_id === match[2] && typeof parsed.summary === 'string'
              && parsed.summary.length <= 1200 && SUMMARY_KINDS.has(parsed.summary_kind)) record = parsed;
        } catch { /* Legacy summaries have no structured window record. */ }
        if (template || record) state.candidates.set(data.compactionId, { id: match[1], previous: match[2], summarySeq: event.seq, record });
      }
    } else if (event.type === 'user/message') {
      const rotation = (data.source?.kind === 'compact-checkpoint' || data.source?.plugin === 'compact') && state.candidates.get(data.source.compactionId);
      if (rotation && rotation.previous === state.windows.at(-1).window_id) {
        const outgoing = state.windows.at(-1);
        outgoing.end_seq = event.seq;
        outgoing.summary = rotation.record?.summary ?? 'Legacy window checkpoint; retrieve its summary item for details.';
        outgoing.summary_kind = rotation.record?.summary_kind ?? 'legacy';
        outgoing.summary_item_id = `item_${rotation.summarySeq}`;
        outgoing.summary_through_seq = rotation.record?.through_seq;
        state.windows.push({ previous_window_id: outgoing.window_id, window_id: rotation.id, start_seq: event.seq, created_at: event.time, item_count: 0 });
        state.pending = null;
        state.remindedWindow = null;
      }
      // Plugin/system snapshots are not new user instructions. Preserve recent human
      // corrections in chronological order instead of permanently pinning the first task.
      if (data.source?.kind === 'user' || data.source?.kind === 'human') {
        const window = state.windows.at(-1);
        window.topic ??= clip(textContent(data.content).trim(), 200);
        window.latest_user = { seq: event.seq, text: clip(textContent(data.content).trim(), 400) };
        state.latestUsers.push({ seq: event.seq });
        if (state.latestUsers.length > 4) state.latestUsers.shift();
      }
      if ((data.source?.kind === 'plugin:context-management-reminder' || data.source?.plugin === 'context-management-reminder')) state.remindedWindow = state.windows.at(-1).window_id;
    } else if (event.type === 'compaction/end') {
      state.candidates.delete(data.compactionId);
    }
    if (HISTORY_EVENT_TYPES.has(event.type)) state.windows.at(-1).item_count++;
  }

  /** Commit persistent notes before exposing the new cache state. */
  writeNote(session, path, text, operation = 'write', signal) {
    if (typeof text !== 'string') throw new Error('Text must be a string');
    const state = this.get(session);
    const canonical = state.notes.resolvePath('self', path);
    if (!canonical.startsWith('self/notes/')) throw new Error('Notes are private to the current session. Use a relative path.');
    if (this.repository) {
      return this.repository.write(session, canonical, text, operation, signal, { window_id: state.windows.at(-1).window_id, source_seq: session.seq }).then(({ store, result }) => {
        state.notes = store;
        return result;
      });
    }
    // Pure in-memory fixtures use the same limits; the plugin always supplies a repository.
    const result = operation === 'append' ? state.notes.appendToFile('self', canonical, text) : state.notes.writeFile('self', canonical, text);
    Object.assign(state.notes.files.get(canonical), { window_id: state.windows.at(-1).window_id, source_seq: session.seq });
    return result;
  }

  request(session) {
    const state = this.get(session);
    state.pending ??= { seq: session.seq };
    return state.pending.seq;
  }

  finishRequest(session, requestSeq) {
    const state = this.get(session);
    if (state.pending?.seq === requestSeq) state.pending = null;
  }
}

/** Bounded text is an excerpt, never a claim of complete semantic recall. */
export function clip(text, budget) {
  text = String(text ?? '');
  return text.length <= budget ? text : text.slice(0, Math.max(0, budget - 15)) + '… [truncated]';
}

export function windowOverview(window) {
  if (window.summary) return window.summary;
  return clip([
    window.topic && `Topic: ${window.topic}`,
    window.latest_user && `Latest user [item_${window.latest_user.seq}]: ${window.latest_user.text}`,
    window.last_assistant && `Latest assistant excerpt [item_${window.last_assistant.seq}]: ${window.last_assistant.text}`,
  ].filter(Boolean).join('\n') || 'No user/assistant text recorded in this window.', 1000);
}
