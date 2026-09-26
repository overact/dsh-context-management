import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NotesStore, MAX_FILE_BYTES } from '../lib/notes-store.js';
import {
  notes_list_files_by_prefix,
  notes_read_file,
  notes_search_contents,
  notes_append_to_file,
  notes_write_file,
  NOTES_TOOLS,
  createNotesExecutors,
} from '../lib/tools/notes.js';

describe('NotesStore — Write and Read Operations', () => {
  it('writes and reads a note file with default relative path', () => {
    const store = new NotesStore();
    const result = store.writeFile('agent1', 'todo.md', '# Todo\n- Task 1\n- Task 2\n- Task 3');

    assert.equal(result.path, 'agent1/notes/todo.md');
    assert.equal(result.lines_count, 4);
    assert.equal(result.size_bytes, Buffer.byteLength('# Todo\n- Task 1\n- Task 2\n- Task 3', 'utf8'));
    assert.ok(result.created_at);
    assert.ok(result.updated_at);
    assert.equal(result.status, 'written');

    const read = store.readFile('agent1', 'todo.md');
    assert.equal(read.content, '# Todo\n- Task 1\n- Task 2\n- Task 3');
    assert.equal(read.total_lines, 4);
    assert.equal(read.start_line, 1);
    assert.equal(read.stop_line, 4);
    assert.equal(String(read), '# Todo\n- Task 1\n- Task 2\n- Task 3');
  });

  it('overwriting an existing file updates content and updated_at while preserving created_at', async () => {
    const store = new NotesStore();
    const first = store.writeFile('agent1', 'doc.txt', 'Version 1');
    const firstCreatedAt = first.created_at;

    // Small delay to ensure timestamp progression
    await new Promise(r => setTimeout(r, 10));

    const second = store.writeFile('agent1', 'doc.txt', 'Version 2 with more text');
    assert.equal(second.created_at, firstCreatedAt);
    assert.ok(new Date(second.updated_at).getTime() >= new Date(first.updated_at).getTime());

    const read = store.readFile('agent1', 'doc.txt');
    assert.equal(read.content, 'Version 2 with more text');
  });

  it('handles empty string content gracefully', () => {
    const store = new NotesStore();
    const res = store.writeFile('agent1', 'empty.txt', '');
    assert.equal(res.size_bytes, 0);
    assert.equal(res.lines_count, 0);

    const read = store.readFile('agent1', 'empty.txt');
    assert.equal(read.content, '');
    assert.equal(read.total_lines, 0);
  });

  it('throws error when reading non-existent file', () => {
    const store = new NotesStore();
    assert.throws(
      () => store.readFile('agent1', 'missing.txt'),
      /Note file not found/
    );
  });
});

describe('NotesStore — Append Operations', () => {
  it('appends text to an existing file, preserving created_at', async () => {
    const store = new NotesStore();
    const init = store.writeFile('agent1', 'log.txt', 'entry 1\n');
    await new Promise(r => setTimeout(r, 10));

    const appended = store.appendToFile('agent1', 'log.txt', 'entry 2\n');
    assert.equal(appended.status, 'appended');
    assert.equal(appended.created_at, init.created_at);
    assert.ok(new Date(appended.updated_at).getTime() >= new Date(init.updated_at).getTime());

    const read = store.readFile('agent1', 'log.txt');
    assert.equal(read.content, 'entry 1\nentry 2\n');
  });

  it('appends text to a non-existent file, creating it', () => {
    const store = new NotesStore();
    const appended = store.appendToFile('agent1', 'new_log.txt', 'first line\n');

    assert.equal(appended.status, 'appended');
    assert.equal(appended.path, 'agent1/notes/new_log.txt');

    const read = store.readFile('agent1', 'new_log.txt');
    assert.equal(read.content, 'first line\n');
  });
});

describe('NotesStore — Size Limit (<= 1,000,000 bytes)', () => {
  it('validates MAX_FILE_BYTES constant is 1,000,000 bytes', () => {
    assert.equal(MAX_FILE_BYTES, 1_000_000);
  });

  it('rejects files exceeding MAX_FILE_BYTES (1,000,000 bytes) on write', () => {
    const store = new NotesStore();
    const hugeText = 'x'.repeat(MAX_FILE_BYTES + 10);
    assert.throws(
      () => store.writeFile('agent1', 'overflow.txt', hugeText),
      /exceeds limit of 1000000 UTF-8 bytes/
    );
    assert.equal(store.hasFile('agent1', 'overflow.txt'), false);
  });

  it('allows writing exactly 1,000,000 bytes', () => {
    const store = new NotesStore();
    const exact1MB = 'a'.repeat(MAX_FILE_BYTES);
    const result = store.writeFile('agent1', 'exact.txt', exact1MB);
    assert.equal(result.size_bytes, 1_000_000);

    const read = store.readFile('agent1', 'exact.txt');
    assert.equal(read.content.length, 1_000_000);
  });

  it('rejects appending when total size exceeds 1,000,000 bytes and keeps original content', () => {
    const store = new NotesStore();
    const initialText = 'a'.repeat(900_000);
    store.writeFile('agent1', 'grow.txt', initialText);

    const extra = 'b'.repeat(100_001);
    assert.throws(
      () => store.appendToFile('agent1', 'grow.txt', extra),
      /exceed limit of 1000000 UTF-8 bytes/
    );

    const read = store.readFile('agent1', 'grow.txt');
    assert.equal(read.content.length, 900_000);
    assert.equal(read.content, initialText);
  });
});

describe('NotesStore — Line Slicing (1-based & negative indices)', () => {
  const testLines = 'line 1\nline 2\nline 3\nline 4\nline 5';

  it('slices lines with positive 1-based start and stop lines', () => {
    const store = new NotesStore();
    store.writeFile('agent1', 'lines.txt', testLines);

    // Lines 2 to 4 (inclusive, 1-based)
    const mid = store.readFile('agent1', 'lines.txt', 2, 4);
    assert.equal(mid.content, 'line 2\nline 3\nline 4');
    assert.equal(mid.start_line, 2);
    assert.equal(mid.stop_line, 4);

    // Line 1 only
    const first = store.readFile('agent1', 'lines.txt', 1, 1);
    assert.equal(first.content, 'line 1');

    // Line 5 only
    const last = store.readFile('agent1', 'lines.txt', 5, 5);
    assert.equal(last.content, 'line 5');
  });

  it('slices lines with negative line indices counting from end', () => {
    const store = new NotesStore();
    store.writeFile('agent1', 'lines.txt', testLines);

    // Last 2 lines (-2 to -1)
    const tail2 = store.readFile('agent1', 'lines.txt', -2, -1);
    assert.equal(tail2.content, 'line 4\nline 5');

    // Last line only (-1 to -1)
    const last = store.readFile('agent1', 'lines.txt', -1, -1);
    assert.equal(last.content, 'line 5');

    // Last 3 lines (-3 to -1)
    const tail3 = store.readFile('agent1', 'lines.txt', -3, -1);
    assert.equal(tail3.content, 'line 3\nline 4\nline 5');
  });

  it('supports mixed positive start and negative stop lines', () => {
    const store = new NotesStore();
    store.writeFile('agent1', 'lines.txt', testLines);

    // Line 2 to second to last line (-2)
    const mid = store.readFile('agent1', 'lines.txt', 2, -2);
    assert.equal(mid.content, 'line 2\nline 3\nline 4');
  });

  it('handles partial line slice boundaries gracefully', () => {
    const store = new NotesStore();
    store.writeFile('agent1', 'lines.txt', testLines);

    // startLine given, stopLine omitted -> read through end
    const fromLine3 = store.readFile('agent1', 'lines.txt', 3);
    assert.equal(fromLine3.content, 'line 3\nline 4\nline 5');

    // stopLine beyond file length -> clamps to end
    const overEnd = store.readFile('agent1', 'lines.txt', 3, 100);
    assert.equal(overEnd.content, 'line 3\nline 4\nline 5');

    // startLine > stopLine -> returns empty string
    const inverted = store.readFile('agent1', 'lines.txt', 4, 2);
    assert.equal(inverted.content, '');

    // startLine beyond file length -> returns empty string
    const outOfBounds = store.readFile('agent1', 'lines.txt', 10, 20);
    assert.equal(outOfBounds.content, '');
  });
});

describe('NotesStore — Virtual Path Conventions & Validation', () => {
  it('resolves relative paths under <agentName>/notes/', () => {
    const store = new NotesStore();
    const res1 = store.writeFile('workerA', 'scratch.md', 'hello');
    assert.equal(res1.path, 'workerA/notes/scratch.md');

    const res2 = store.writeFile('workerA', 'deep/nested/note.txt', 'nested');
    assert.equal(res2.path, 'workerA/notes/deep/nested/note.txt');
  });

  it('rejects empty paths or non-string paths', () => {
    const store = new NotesStore();
    assert.throws(() => store.writeFile('agent1', '', 'content'), /Path must be a non-empty string/);
    assert.throws(() => store.writeFile('agent1', null, 'content'), /Path must be a non-empty string/);
  });

  it('rejects path components with .. or . or empty //', () => {
    const store = new NotesStore();
    assert.throws(() => store.writeFile('agent1', '../escape.txt', 'content'), /Invalid path component "\.\."/);
    assert.throws(() => store.writeFile('agent1', './dot.txt', 'content'), /Invalid path component "\."/);
    assert.throws(() => store.writeFile('agent1', 'foo/./bar.txt', 'content'), /Invalid path component "\."/);
    assert.throws(() => store.writeFile('agent1', 'foo//bar.txt', 'content'), /Invalid path component ""/);
  });

  it('rejects absolute paths with leading slash not matching <agentName>/notes/<path>', () => {
    const store = new NotesStore();
    assert.throws(
      () => store.writeFile('agent1', '/invalid/path.txt', 'content'),
      /Absolute path must match "<agentName>\/notes\/<path>"/
    );
  });
});

describe('NotesStore — Cross-Agent Paths', () => {
  it('allows cross-agent read and append via absolute path <agentName>/notes/<path>', () => {
    const store = new NotesStore();

    // Agent 1 creates a note
    store.writeFile('agent1', 'shared.md', '# Shared Knowledge\nCreated by agent1\n');

    // Agent 2 reads Agent 1's note using absolute path without leading slash
    const readByAgent2 = store.readFile('agent2', 'agent1/notes/shared.md');
    assert.match(readByAgent2.content, /Created by agent1/);

    // Agent 2 reads Agent 1's note using leading slash absolute path
    const readWithSlash = store.readFile('agent2', '/agent1/notes/shared.md');
    assert.equal(readWithSlash.content, readByAgent2.content);

    // Agent 2 appends to Agent 1's note using absolute path
    const appendRes = store.appendToFile('agent2', 'agent1/notes/shared.md', 'Appended by agent2\n');
    assert.equal(appendRes.path, 'agent1/notes/shared.md');

    // Verify Agent 1 sees the appended update
    const readByAgent1 = store.readFile('agent1', 'shared.md');
    assert.match(readByAgent1.content, /Appended by agent2/);

    // Agent 2 reading with relative path 'shared.md' searches agent2/notes/shared.md and fails
    assert.throws(
      () => store.readFile('agent2', 'shared.md'),
      /Note file not found: agent2\/notes\/shared\.md/
    );
  });
});

describe('NotesStore — Prefix Listing', () => {
  it('lists files matching relative prefix and returns full metadata', () => {
    const store = new NotesStore();
    store.writeFile('agent1', 'projects/p1.md', 'P1 details');
    store.writeFile('agent1', 'projects/p2.md', 'P2 details');
    store.writeFile('agent1', 'scratchpad.md', 'Scratch');

    // Relative prefix 'projects/'
    const projectFiles = store.listFilesByPrefix('agent1', 'projects/', 50, 'name', 'ascending');
    assert.equal(projectFiles.length, 2);
    assert.equal(projectFiles[0].path, 'agent1/notes/projects/p1.md');
    assert.equal(projectFiles[1].path, 'agent1/notes/projects/p2.md');
    assert.ok(projectFiles[0].size_bytes > 0);
    assert.ok(projectFiles[0].created_at);
    assert.ok(projectFiles[0].updated_at);
  });

  it('empty prefix lists all files for the calling agent', () => {
    const store = new NotesStore();
    store.writeFile('agent1', 'a.txt', 'A');
    store.writeFile('agent1', 'b.txt', 'B');
    store.writeFile('agent2', 'c.txt', 'C');

    const agent1Files = store.listFilesByPrefix('agent1', '');
    assert.equal(agent1Files.length, 2);
    assert.ok(agent1Files.every(f => f.path.startsWith('agent1/notes/')));
  });

  it('cross-agent prefix and root slash prefix work correctly', () => {
    const store = new NotesStore();
    store.writeFile('agent1', 'f1.txt', '1');
    store.writeFile('agent2', 'f2.txt', '2');

    // Cross-agent prefix
    const agent2Files = store.listFilesByPrefix('agent1', 'agent2/notes/');
    assert.equal(agent2Files.length, 1);
    assert.equal(agent2Files[0].path, 'agent2/notes/f2.txt');

    // Root slash prefix lists all notes across all agents
    const allFiles = store.listFilesByPrefix('agent1', '/');
    assert.equal(allFiles.length, 2);
  });

  it('supports ordering and maxResults', async () => {
    const store = new NotesStore();
    store.writeFile('agent1', 'a.txt', 'small');
    await new Promise(r => setTimeout(r, 10));
    store.writeFile('agent1', 'b.txt', 'a much larger file with more bytes');

    // Sort by size ascending
    const bySizeAsc = store.listFilesByPrefix('agent1', '', 50, 'size_bytes', 'asc');
    assert.equal(bySizeAsc[0].path, 'agent1/notes/a.txt');
    assert.equal(bySizeAsc[1].path, 'agent1/notes/b.txt');

    // Sort by path descending with maxResults = 1
    const byPathDesc = store.listFilesByPrefix('agent1', '', 1, 'path', 'desc');
    assert.equal(byPathDesc.length, 1);
    assert.equal(byPathDesc[0].path, 'agent1/notes/b.txt');
  });
});

describe('NotesStore — Substring Search', () => {
  it('searches contents by literal substring with line numbers', () => {
    const store = new NotesStore();
    store.writeFile('agent1', 'doc1.txt', 'Line 1: red apple\nLine 2: sweet banana\nLine 3: fresh cherry');
    store.writeFile('agent1', 'doc2.txt', 'First: banana split\nSecond: orange juice');

    const results = store.searchContents('agent1', 'banana');
    assert.equal(results.length, 2);

    const doc1Match = results.find(r => r.path === 'agent1/notes/doc1.txt');
    assert.ok(doc1Match);
    assert.equal(doc1Match.matches.length, 1);
    assert.equal(doc1Match.matches[0].line_number, 2);
    assert.equal(doc1Match.matches[0].line, 'Line 2: sweet banana');

    const doc2Match = results.find(r => r.path === 'agent1/notes/doc2.txt');
    assert.ok(doc2Match);
    assert.equal(doc2Match.matches[0].line_number, 1);
  });

  it('respects pathPrefix, maxMatchesPerFile, and maxFiles limits', () => {
    const store = new NotesStore();
    store.writeFile('agent1', 'groupA/n1.txt', 'target\ntarget\ntarget\ntarget');
    store.writeFile('agent1', 'groupA/n2.txt', 'target\nother');
    store.writeFile('agent1', 'groupB/n3.txt', 'target');

    // Filter by pathPrefix 'groupA/'
    const scoped = store.searchContents('agent1', 'target', 'groupA/', 2, 1);
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0].matches.length, 2); // maxMatchesPerFile capped at 2
    assert.equal(scoped[0].total_matches, 4);  // total count reflects all
  });

  it('rejects empty query string', () => {
    const store = new NotesStore();
    assert.throws(() => store.searchContents('agent1', ''), /Query must be a non-empty string/);
  });
});

describe('Notes Tools & Registration', () => {
  it('exports all 5 notes tool action definitions', () => {
    const tools = [
      notes_list_files_by_prefix,
      notes_read_file,
      notes_search_contents,
      notes_append_to_file,
      notes_write_file,
    ];

    for (const tool of tools) {
      assert.equal(tool.type, 'function');
      assert.ok(typeof tool.name === 'string');
      assert.ok(typeof tool.description === 'string');
      assert.equal(tool.parameters.type, 'object');
      assert.ok(tool.parameters.properties);
      assert.ok(tool.function);
    }

    assert.equal(NOTES_TOOLS.notes_write_file.name, 'notes_write_file');
    assert.deepEqual(notes_write_file.parameters.required, ['path', 'text']);
    assert.deepEqual(notes_append_to_file.parameters.required, ['path', 'text']);
    assert.deepEqual(notes_read_file.parameters.required, ['path']);
    assert.deepEqual(notes_search_contents.parameters.required, ['query']);
  });

  it('executes notes tools through createNotesExecutors', async () => {
    const store = new NotesStore();
    const executors = createNotesExecutors(store);
    const exec = { agent: { name: 'agentY' } };

    // Write
    const writeRes = await executors.notes_write_file({ path: 'summary.md', text: 'Line A\nLine B\nLine C' }, exec);
    assert.equal(writeRes.status, 'written');
    assert.equal(writeRes.path, 'agentY/notes/summary.md');

    // Append
    const appendRes = await executors.notes_append_to_file({ path: 'summary.md', text: '\nLine D' }, exec);
    assert.equal(appendRes.status, 'appended');

    // Read with line slice
    const readRes = await executors.notes_read_file({ path: 'summary.md', start_line: 2, stop_line: 3 }, exec);
    assert.equal(readRes.content, 'Line B\nLine C');

    // Search
    const searchRes = await executors.notes_search_contents({ query: 'Line B' }, exec);
    assert.equal(searchRes.length, 1);
    assert.equal(searchRes[0].matches[0].line_number, 2);

    // List by prefix
    const listRes = await executors.notes_list_files_by_prefix({ prefix: '' }, exec);
    assert.equal(listRes.length, 1);
    assert.equal(listRes[0].path, 'agentY/notes/summary.md');
  });
});
