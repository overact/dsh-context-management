/**
 * History tools: paged recall over the caller's own DSH session log.
 *
 * Exposes 4 history tool actions:
 * - history_list_windows
 * - history_list_items
 * - history_read_item
 * - history_search_contents
 */

export const HISTORY_LIST_WINDOWS_TOOL_NAME = 'history_list_windows';
export const HISTORY_LIST_ITEMS_TOOL_NAME = 'history_list_items';
export const HISTORY_READ_ITEM_TOOL_NAME = 'history_read_item';
export const HISTORY_SEARCH_CONTENTS_TOOL_NAME = 'history_search_contents';

export const historyToolOutput = {
  schema: { type: 'object' },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
};

export const historyListWindowsToolDefinition = {
  name: HISTORY_LIST_WINDOWS_TOOL_NAME,
  description: 'List recorded context windows in the history store, including window IDs, item counts, and creation timestamps.',
  output: historyToolOutput,
  parameters: {
    type: 'object',
    properties: {
      agent_name: {
        type: 'string',
        description: 'Only the current session ID or self is accepted. Omit for the current session.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of windows to return.',
      },
      recent_first: {
        type: 'boolean',
        description: 'Whether to sort the most recent windows first. Defaults to true.',
      },
    },
    additionalProperties: false,
  },
};

export const historyListItemsToolDefinition = {
  name: HISTORY_LIST_ITEMS_TOOL_NAME,
  description: 'List history items in a context window or across windows with truncated previews and metadata.',
  output: historyToolOutput,
  parameters: {
    type: 'object',
    properties: {
      window_id: {
        type: 'string',
        description: 'Context window ID to list items from. If omitted, lists across all windows.',
      },
      role: {
        type: 'string',
        enum: ['user', 'assistant', 'tool', 'system', 'developer'],
        description: 'Filter by message role.',
      },
      tool_namespace: {
        type: 'string',
        description: 'Filter by tool namespace (e.g. "mcp", "fs").',
      },
      tool_name: {
        type: 'string',
        description: 'Filter by tool name (e.g. "bash", "read_file").',
      },
      agent_name: {
        type: 'string',
        description: 'Only the current session ID or self is accepted. Omit for the current session.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of items to return.',
      },
      recent_first: {
        type: 'boolean',
        description: 'Whether to return the most recent items first. Defaults to true.',
      },
      max_chars_per_item: {
        type: 'integer',
        description: 'Maximum characters of content to include in truncated_content. Defaults to 400, capped at 1000.',
      },
    },
    additionalProperties: false,
  },
};

export const historyReadItemToolDefinition = {
  name: HISTORY_READ_ITEM_TOOL_NAME,
  description: 'Read the full or paginated content of a specific history item by ID.',
  output: historyToolOutput,
  parameters: {
    type: 'object',
    properties: {
      item_id: {
        type: 'string',
        description: 'The unique ID of the history item to read.',
      },
      window_id: {
        type: 'string',
        description: 'Optional context window ID containing the item.',
      },
      offset_chars: {
        type: 'integer',
        description: 'Character offset to start reading from. Defaults to 0.',
      },
      limit_chars: {
        type: 'integer',
        description: 'Maximum number of characters to read from offset. Defaults to 8000, capped at 20000. Continue using next_offset_chars.',
      },
      agent_name: {
        type: 'string',
        description: 'Only the current session ID or self is accepted. Omit for the current session.',
      },
    },
    required: ['item_id'],
    additionalProperties: false,
  },
};

export const historySearchContentsToolDefinition = {
  name: HISTORY_SEARCH_CONTENTS_TOOL_NAME,
  description: 'Search for text across recorded history items in context windows.',
  output: historyToolOutput,
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Substring text query to search for within item contents.',
      },
      window_id: {
        type: 'string',
        description: 'Optional context window ID to restrict search to.',
      },
      role: {
        type: 'string',
        enum: ['user', 'assistant', 'tool', 'system', 'developer'],
        description: 'Filter by message role.',
      },
      tool_namespace: {
        type: 'string',
        description: 'Filter by tool namespace.',
      },
      tool_name: {
        type: 'string',
        description: 'Filter by tool name.',
      },
      agent_name: {
        type: 'string',
        description: 'Only the current session ID or self is accepted. Omit for the current session.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of matching items to return.',
      },
      recent_first: {
        type: 'boolean',
        description: 'Whether to return the most recent matches first. Defaults to true.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

// All scans and outputs are bounded. Cursors resume at exact log positions.
for (const definition of [historyListItemsToolDefinition, historySearchContentsToolDefinition]) {
  definition.parameters.properties.cursor = {
    type: 'integer', minimum: 0,
    description: 'Pass next_cursor from the preceding response with the same filters and ordering.',
  };
  definition.parameters.properties.max_chars_per_item = {
    type: 'integer', minimum: 0, maximum: 1000,
    description: 'Preview characters per item (default 400). Full output is available with history_read_item.',
  };
}
historySearchContentsToolDefinition.parameters.properties.case_sensitive = {
  type: 'boolean', description: 'Literal case-sensitive search by default. Set false for case-insensitive search.',
};
historyReadItemToolDefinition.parameters.properties.format = {
  type: 'string', enum: ['text', 'json'],
  description: 'text (default) reads normalized message content; json reads the complete original DSH event, including tool-call metadata.',
};

export const historyToolDefinitions = [
  historyListWindowsToolDefinition,
  historyListItemsToolDefinition,
  historyReadItemToolDefinition,
  historySearchContentsToolDefinition,
];

/** Resolve only the calling session; agent_name never authorizes another session. */
function resolveStore(source, args, exec) {
  const store = typeof source === 'function' ? source(exec) : source;
  if (args.agent_name && args.agent_name !== 'self' && args.agent_name !== store.session.id) {
    throw new Error('History access is limited to the current session.');
  }
  return store;
}

/**
 * The four history tool handlers.
 * @param {import('../history-store.js').HistoryStore | ((exec) => import('../history-store.js').HistoryStore)} source
 */
export function createHistoryHandlers(source) {
  const store = (args, exec) => resolveStore(source, args, exec);
  return {
    history_list_windows: async (args = {}, exec) => ({ windows: store(args, exec).listWindows(args) }),
    history_list_items: async (args = {}, exec) => store(args, exec).listItems(args),
    history_read_item: async (args = {}, exec) => store(args, exec).readItem(args)
      ?? { error: `History item not found in the current session: ${args.item_id}` },
    history_search_contents: async (args = {}, exec) => store(args, exec).searchContents(args),
  };
}
