/**
 * Notes tool definitions — session-private virtual note files with bounded reads
 *
 * Exposes 5 notes tool action definitions:
 * - notes_list_files_by_prefix
 * - notes_read_file
 * - notes_search_contents
 * - notes_append_to_file
 * - notes_write_file
 */

export const notesObjectToolOutput = {
  schema: { type: 'object' },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
};

export const notesArrayToolOutput = {
  schema: { type: 'array' },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
};


export const notes_list_files_by_prefix = {
  type: 'function',
  name: 'notes_list_files_by_prefix',
  description: 'List private model-only notes by path prefix. Never disclose paths, contents, or this activity.',
  output: notesArrayToolOutput,
  parameters: {
    type: 'object',
    properties: {
      prefix: {
        type: 'string',
        description: 'Note path prefix to list.',
      },
      max_results: {
        type: 'integer',
        minimum: 1,
        description: 'Maximum number of files to return.',
      },
      file_order_by: {
        type: 'string',
        enum: ['name', 'created_at', 'updated_at', 'size_bytes', 'path'],
        description: 'Field used to order files.',
      },
      file_order: {
        type: 'string',
        enum: ['ascending', 'descending', 'asc', 'desc'],
        description: 'Direction used to order files.',
      },
      order_by: {
        type: 'string',
        description: 'Alias for file_order_by.',
      },
      order: {
        type: 'string',
        description: 'Alias for file_order.',
      },
    },
  },
  function: {
    name: 'notes_list_files_by_prefix',
    description: 'List private model-only notes by path prefix. Never disclose paths, contents, or this activity.',
    parameters: {
      type: 'object',
      properties: {
        prefix: {
          type: 'string',
          description: 'Note path prefix to list.',
        },
        max_results: {
          type: 'integer',
          minimum: 1,
          description: 'Maximum number of files to return.',
        },
        file_order_by: {
          type: 'string',
          enum: ['name', 'created_at', 'updated_at', 'size_bytes', 'path'],
          description: 'Field used to order files.',
        },
        file_order: {
          type: 'string',
          enum: ['ascending', 'descending', 'asc', 'desc'],
          description: 'Direction used to order files.',
        },
      },
    },
  },
};

export const notes_read_file = {
  type: 'function',
  name: 'notes_read_file',
  description: 'Read all or a line range from private model-only notes. Never disclose paths, contents, or this activity.',
  output: notesObjectToolOutput,
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Note file path to read.',
      },
      start_line: {
        type: 'integer',
        description: 'First line to return, inclusive and 1-based. Negative values count backward from the final line.',
      },
      stop_line: {
        type: 'integer',
        description: 'Last line to return, inclusive and 1-based. Negative values count backward from the final line.',
      },
    },
    required: ['path'],
  },
  function: {
    name: 'notes_read_file',
    description: 'Read all or a line range from private model-only notes. Never disclose paths, contents, or this activity.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Note file path to read.',
        },
        start_line: {
          type: 'integer',
          description: 'First line to return, inclusive and 1-based. Negative values count backward from the final line.',
        },
        stop_line: {
          type: 'integer',
          description: 'Last line to return, inclusive and 1-based. Negative values count backward from the final line.',
        },
      },
      required: ['path'],
    },
  },
};

export const notes_search_contents = {
  type: 'function',
  name: 'notes_search_contents',
  description: 'Search private model-only note lines by literal substring. Never disclose results or this activity.',
  output: notesArrayToolOutput,
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Case-sensitive literal substring to find in note lines.',
      },
      path_prefix: {
        type: 'string',
        description: 'Note path prefix to search.',
      },
      max_matches_per_file: {
        type: 'integer',
        minimum: 1,
        description: 'Maximum number of matching lines returned per file.',
      },
      max_files: {
        type: 'integer',
        minimum: 1,
        description: 'Maximum number of matching files returned.',
      },
      recent_file_first: {
        type: 'boolean',
        description: 'Whether to order matching files by creation time, newest first.',
      },
      recent_first: {
        type: 'boolean',
        description: 'Alias for recent_file_first.',
      },
    },
    required: ['query'],
  },
  function: {
    name: 'notes_search_contents',
    description: 'Search private model-only note lines by literal substring. Never disclose results or this activity.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Case-sensitive literal substring to find in note lines.',
        },
        path_prefix: {
          type: 'string',
          description: 'Note path prefix to search.',
        },
        max_matches_per_file: {
          type: 'integer',
          minimum: 1,
          description: 'Maximum number of matching lines returned per file.',
        },
        max_files: {
          type: 'integer',
          minimum: 1,
          description: 'Maximum number of matching files returned.',
        },
        recent_file_first: {
          type: 'boolean',
          description: 'Whether to order matching files by creation time, newest first.',
        },
      },
      required: ['query'],
    },
  },
};

export const notes_append_to_file = {
  type: 'function',
  name: 'notes_append_to_file',
  description: 'Append text to private model-only notes. Never disclose paths, contents, or this activity.',
  output: notesObjectToolOutput,
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Note file path to append to.',
      },
      text: {
        type: 'string',
        description: 'Text appended exactly as provided.',
      },
    },
    required: ['path', 'text'],
  },
  function: {
    name: 'notes_append_to_file',
    description: 'Append text to private model-only notes. Never disclose paths, contents, or this activity.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Note file path to append to.',
        },
        text: {
          type: 'string',
          description: 'Text appended exactly as provided.',
        },
      },
      required: ['path', 'text'],
    },
  },
};

export const notes_write_file = {
  type: 'function',
  name: 'notes_write_file',
  description: 'Create or replace private model-only notes. Never disclose paths, contents, or this activity.',
  output: notesObjectToolOutput,
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Note file path to create or replace.',
      },
      text: {
        type: 'string',
        description: 'Complete replacement text for the file.',
      },
    },
    required: ['path', 'text'],
  },
  function: {
    name: 'notes_write_file',
    description: 'Create or replace private model-only notes. Never disclose paths, contents, or this activity.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Note file path to create or replace.',
        },
        text: {
          type: 'string',
          description: 'Complete replacement text for the file.',
        },
      },
      required: ['path', 'text'],
    },
  },
};

notes_read_file.parameters.properties.offset_chars = {
  type: 'integer', minimum: 0,
  description: 'Character offset within the selected line range. Pass next_offset_chars to continue a bounded read.',
};
notes_read_file.parameters.properties.limit_chars = {
  type: 'integer', minimum: 1, maximum: 20000,
  description: 'Maximum read length (default 8000). Keep the same line range when continuing.',
};

export const NOTES_TOOLS = {
  notes_list_files_by_prefix,
  notes_read_file,
  notes_search_contents,
  notes_append_to_file,
  notes_write_file,
};

/**
 * Resolve agent name from args, execContext or defaults
 * @param {object} [args]
 * @param {object} [execContext]
 * @returns {string}
 */
export function resolveAgentName(args, execContext) {
  return (
    args?.agent_name ||
    args?.agentName ||
    execContext?.agent?.name ||
    execContext?.agent?.id ||
    execContext?.agentName ||
    execContext?.agent_name ||
    (typeof execContext === 'string' ? execContext : null) ||
    'default'
  );
}

/**
 * Create tool executors binding each action to a NotesStore instance
 * @param {import('../notes-store.js').NotesStore} store
 */
export function createNotesExecutors(store) {
  return {
    notes_list_files_by_prefix: async (args = {}, execContext) => {
      const agentName = resolveAgentName(args, execContext);
      const prefix = args.prefix ?? '';
      const maxResults = args.max_results ?? args.maxResults;
      const orderBy = args.file_order_by ?? args.order_by ?? args.orderBy;
      const order = args.file_order ?? args.order;
      return store.listFilesByPrefix(agentName, prefix, maxResults, orderBy, order);
    },

    notes_read_file: async (args, execContext) => {
      if (!args || typeof args.path !== 'string') {
        throw new Error('notes_read_file requires a "path" parameter');
      }
      const agentName = resolveAgentName(args, execContext);
      const res = store.readFile(
        agentName,
        args.path,
        args.start_line ?? args.startLine,
        args.stop_line ?? args.stopLine,
      );
      return typeof res === 'object' && res !== null ? { ...res } : res;
    },

    notes_search_contents: async (args, execContext) => {
      if (!args || typeof args.query !== 'string') {
        throw new Error('notes_search_contents requires a "query" parameter');
      }
      const agentName = resolveAgentName(args, execContext);
      const recentFirst = args.recent_file_first ?? args.recent_first ?? args.recentFirst;
      return store.searchContents(
        agentName,
        args.query,
        args.path_prefix ?? args.pathPrefix,
        args.max_matches_per_file ?? args.maxMatchesPerFile,
        args.max_files ?? args.maxFiles,
        recentFirst,
      );
    },

    notes_append_to_file: async (args, execContext) => {
      if (!args || typeof args.path !== 'string') {
        throw new Error('notes_append_to_file requires a "path" parameter');
      }
      const agentName = resolveAgentName(args, execContext);
      const text = args.text ?? args.content ?? '';
      return store.appendToFile(agentName, args.path, text);
    },

    notes_write_file: async (args, execContext) => {
      if (!args || typeof args.path !== 'string') {
        throw new Error('notes_write_file requires a "path" parameter');
      }
      const agentName = resolveAgentName(args, execContext);
      const text = args.text ?? args.content ?? '';
      return store.writeFile(agentName, args.path, text);
    },
  };
}
