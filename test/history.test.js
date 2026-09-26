import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, user, llm, fixture } from './helpers/dsh.js';
import { HistoryStore } from '../lib/history-store.js';
import { SessionStateStore } from '../lib/session-state.js';

test('history is isolated by live session, including explicit agent-name overrides', async t => {
  const f = await fixture(); t.after(f.dispose);
  const a = await f.agent('a'), b = await f.agent('b');
  user(a.session, 'A private task'); user(b.session, 'B private task');
  await f.execute(a, 'notes_write_file', { path: 'progress.md', text: 'A state' });
  await f.execute(b, 'notes_write_file', { path: 'progress.md', text: 'B state' });
  const items = await f.execute(a, 'history_list_items');
  assert.equal(items.isError, false);
  assert.equal(items.value.items.length, 1);
  assert.match(items.value.items[0].truncated_content, /A private/);
  assert.equal((await f.execute(a, 'history_list_items', { agent_name: 'b' })).isError, true);
  assert.equal((await f.execute(a, 'notes_read_file', { path: '/b/notes/progress.md' })).isError, true);
  assert.equal((await f.execute(a, 'notes_write_file', { path: '/b/notes/progress.md', text: 'overwrite' })).isError, true);
  assert.equal((await f.execute(b, 'notes_read_file', { path: 'progress.md' })).value.content, 'B state');
});

test('event IDs remain stable through repeated rotations; older history is not evicted', async t => {
  const f = await fixture(); t.after(f.dispose);
  const a = await f.agent(); const s = a.session;
  const first = user(s, 'FIRST RESULT ' + 'a'.repeat(40_000)); user(s, 'tail');
  await f.native.compactNow(a, new AbortController().signal);
  user(s, 'b'.repeat(40_000)); user(s, 'new tail');
  await f.native.compactNow(a, new AbortController().signal);
  const history = new HistoryStore(s, f.plugin.states);
  assert.equal(history.searchContents({ query: 'FIRST RESULT', window_id: 'win_001' }).matches.length, 1);
  assert.equal(history.readItem({ item_id: `item_${first.seq}`, window_id: 'win_001' }).content.slice(0, 12), 'FIRST RESULT');
  for (let i = 0; i < 2100; i++) user(s, 'later ' + i);
  assert.ok(history.readItem({ item_id: `item_${first.seq}` }));
  assert.equal(f.plugin.states.get(s).windows.length, 3);
});

test('bounded cursor scans find old matches without duplicate items or full-output search responses', () => {
  const s = Session.create('pagination');
  user(s, 'NEEDLE ' + 'x'.repeat(1_000_000));
  for (let i = 0; i < 2050; i++) s.append('assistant/chunk', { text: 'noise' });
  const h = new HistoryStore(s, new SessionStateStore());
  const page1 = h.searchContents({ query: 'NEEDLE' });
  assert.equal(page1.matches.length, 0); assert.equal(page1.scanned_events, 2000); assert.equal(page1.has_more, true);
  const page2 = h.searchContents({ query: 'NEEDLE', cursor: page1.next_cursor });
  assert.equal(page2.matches.length, 1); assert.equal(page2.has_more, false);
  assert.ok(JSON.stringify(page2).length < 2000);
  const read = h.readItem({ item_id: 'item_0' });
  assert.equal(read.content.length, 8000); assert.equal(read.next_offset_chars, 8000);
  assert.equal(h.searchContents({ query: 'needle', cursor: 0 }).matches.length, 0);
  assert.equal(h.searchContents({ query: 'needle', cursor: 0, case_sensitive: false }).matches.length, 1);
  assert.deepEqual(h.listItems({ window_id: 'missing' }).items, []);
});

test('real tool-result correlation and PTC dispatch events remain searchable and retrievable', () => {
  const s = Session.create('tools');
  s.append('assistant/message', { message: llm.createAssistantMessage({
    content: [{ type: 'tool-call', id: 'c', name: 'fs__read', arguments: '{"path":"a"}' }],
    source: { provider: 'fixture', model: 'fixture' },
  }) }, { surfaceOp: 'append' });
  const output = s.append('tool/result', { message: llm.createToolResultMessage({ callId: 'c', content: [{ type: 'text', text: 'EXACT RAW OUTPUT' }], isError: false }) }, { surfaceOp: 'append' });
  const ptc = s.append('tool/code-dispatch', { name: 'bash', arguments: { cmd: 'pwd' }, content: [{ type: 'text', text: 'PTC OUTPUT' }], isError: false });
  const h = new HistoryStore(s, new SessionStateStore());
  const results = h.listItems({ role: 'tool', tool_namespace: 'fs', tool_name: 'read' }).items;
  assert.equal(results.length, 1); assert.equal(results[0].item_id, `item_${output.seq}`);
  assert.equal(h.readItem({ item_id: `item_${output.seq}` }).content, 'EXACT RAW OUTPUT');
  const raw = JSON.parse(h.readItem({ item_id: `item_${ptc.seq}`, format: 'json' }).content);
  assert.equal(raw.data.arguments.cmd, 'pwd');
  assert.equal(h.searchContents({ query: 'PTC OUTPUT' }).matches.length, 1);
});

test('unchanged session projection performs zero repeat event reads', () => {
  const s = Session.create('incremental');
  for (let i = 0; i < 10000; i++) user(s, 'record ' + i);
  const states = new SessionStateStore(); states.get(s);
  let reads = 0; const eventAt = s.eventAt.bind(s);
  s.eventAt = seq => { reads++; return eventAt(seq); };
  states.get(s); assert.equal(reads, 0);
  user(s, 'tail'); states.get(s); assert.equal(reads, 1);
});
