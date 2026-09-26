import { requireSession } from '../session-state.js';

export const NEW_CONTEXT_TOOL_NAME = 'new_context';
export const newContextToolDefinition = {
  name: NEW_CONTEXT_TOOL_NAME,
  description: 'Request a fresh context window after this step’s tool results are recorded. Save a concise checkpoint first. Rotation occurs at the next safe step boundary; no environment files are cleared. Do not call for short tasks.',
  parameters: {
    type: 'object',
    properties: {
      notes_summary: { type: 'string', description: 'Optional checkpoint text (up to 8000 characters), saved as checkpoint.md before requesting rotation.' },
    },
    additionalProperties: false,
  },
  output: {
    schema: { type: 'object' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  },
};

export function createNewContextHandler(states, flush, checkEnabled = () => {}) {
  return async (args = {}, exec) => {
    exec.signal?.throwIfAborted();
    const session = requireSession(exec);
    if (args.notes_summary != null) {
      if (typeof args.notes_summary !== 'string' || args.notes_summary.length > 8000) throw new Error('notes_summary must be at most 8000 characters.');
      if (args.notes_summary.trim()) await states.writeNote(session, 'checkpoint.md', args.notes_summary, 'write', exec.signal);
    }
    await flush(session);
    exec.signal?.throwIfAborted();
    checkEnabled();
    const requestSeq = states.request(session);
    return { status: 'context_window_requested', request_seq: requestSeq,
      current_window_id: states.get(session).windows.at(-1).window_id,
      message: 'Rotation is scheduled for the next safe step boundary. The current context has not been replaced yet.' };
  };
}
