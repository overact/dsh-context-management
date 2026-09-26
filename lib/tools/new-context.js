import { requireSession } from '../session-state.js';

export const NEW_CONTEXT_TOOL_NAME = 'new_context';
export const newContextToolDefinition = {
  name: NEW_CONTEXT_TOOL_NAME,
  description: 'Request a fresh context window after this step’s tool results are recorded. The outgoing window is summarized into a handoff automatically. Rotation occurs at the next safe step boundary; no environment files are cleared. Do not call for short tasks.',
  parameters: {
    type: 'object',
    properties: {},
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
    await flush(session);
    exec.signal?.throwIfAborted();
    checkEnabled();
    const requestSeq = states.request(session);
    return { status: 'context_window_requested', request_seq: requestSeq,
      current_window_id: states.get(session).windows.at(-1).window_id,
      message: 'Rotation is scheduled for the next safe step boundary. The current context has not been replaced yet.' };
  };
}
