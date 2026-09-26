import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, user, llm, Session, dsh } from './helpers/dsh.js';
import { SessionStateStore } from '../lib/session-state.js';
import { HistoryStore } from '../lib/history-store.js';
const signal = () => new AbortController().signal;

function header(session) {
  session.append('request/header', { reason: 'initial', header: { config: { provider: 'fixture', model: 'fixture' } } });
}
function startTurn(session) { session.append('turn/start', { turn: 1 }); }
function assistantCalls(session, names) {
  session.append('step/start', { turn: 1, step: 1 });
  session.append('assistant/message', { turn: 1, step: 1, message: llm.createAssistantMessage({
    content: names.map((name, index) => ({ type: 'tool-call', name, id: `call-${index}`, arguments: '{}' })),
    source: { provider: 'fixture', model: 'fixture' },
  }) }, { surfaceOp: 'append' });
}
function result(session, id, text) {
  session.append('tool/result', { turn: 1, step: 1, message: llm.createToolResultMessage({
    callId: id, content: [{ type: 'text', text }], isError: false,
  }) }, { surfaceOp: 'append' });
}

test('real DSH manual transaction shrinks context, preserves corrections/notes and restores after replay', async t => {
  const f = await fixture(); t.after(f.dispose);
  const agent = await f.agent(); const session = agent.session;
  const first = user(session, 'Implement CSV support.\n' + 'diagnostic data '.repeat(6000));
  user(session, 'Cancel CSV; implement YAML only.');
  const write = await f.execute(agent, 'notes_write_file', { path: 'progress.md', text: 'YAML parser is implemented; next run validation.' });
  assert.equal(write.isError, false);
  const before = f.ctx.tokenMeter.measure(session).totalTokens;
  const rotation = await f.native.compactNow(agent, signal());
  assert.ok(rotation);
  assert.ok(f.ctx.tokenMeter.measure(session).totalTokens < before / 2);
  assert.equal(f.legacyCalls, 1);
  const visible = session.deriveMessages().map(m => JSON.stringify(m.content)).join('\n');
  assert.match(visible, /YAML only/);
  assert.match(visible, /next run validation/);
  assert.match(visible, /Later user instructions supersede earlier/);
  assert.equal(f.plugin.states.get(session).windows.at(-1).window_id, 'win_002');
  assert.equal(f.plugin.states.get(session).windows[0].summary_kind, 'generated');
  const recorded = f.persisted.get(session.id);
  assert.ok(recorded.some(e => e.type === 'compaction/end'));
  const restored = Session.create(session.id, recorded);
  const recovered = new SessionStateStore(f.plugin.states.repository);
  assert.equal(recovered.get(restored).windows.at(-1).window_id, 'win_002');
  assert.match(recovered.get(restored).notes.readFile('self', 'progress.md').content, /YAML parser/);
  assert.equal(new HistoryStore(restored, recovered).readItem({ item_id: `item_${first.seq}` }).total_chars, first.data.content[0].text.length);
});

test('new_context waits for sibling tool results and rotates via the real pre-step hook', async t => {
  const f = await fixture(); t.after(f.dispose);
  const agent = await f.agent(); const s = agent.session;
  user(s, 'Investigate the parser. ' + 'historical output '.repeat(4000));
  header(s); startTurn(s); assistantCalls(s, ['new_context', 'bash']);
  const before = [...s.surface.nodes];
  const requested = await f.execute(agent, 'new_context', {});
  assert.equal(requested.isError, false);
  assert.equal(requested.value.status, 'context_window_requested');
  assert.deepEqual(s.surface.nodes, before);
  result(s, 'call-0', JSON.stringify(requested.value)); result(s, 'call-1', 'Sibling command finished.');
  s.append('step/end', { turn: 1, step: 1 });
  await f.ctx.waterfall('agent/pre-step', { agent, signal: signal() }, () => ({ kind: 'enter' }));
  assert.equal(f.plugin.states.get(s).windows.at(-1).window_id, 'win_002');
  assert.equal(f.plugin.states.get(s).pending, null);
  const { toolPairingBalancedAfter } = await dsh('dsh-compaction');
  assert.equal(toolPairingBalancedAfter(s, s.surface.nodes.at(-1)), true);
  assert.match(JSON.stringify(s.deriveMessages()), /Sibling command finished/);
  assert.equal(f.legacyCalls, 1);
});

test('automatic rotation uses one generated handoff', async t => {
  const f = await fixture({ capacity: 20_000 }); t.after(f.dispose);
  const agent = await f.agent(); const s = agent.session;
  user(s, 'a'.repeat(58_000)); header(s); startTurn(s);
  const step = () => f.ctx.waterfall('agent/pre-step', { agent, signal: signal() }, () => ({ kind: 'enter' }));
  await step(); await step();
  user(s, 'b'.repeat(16_000));
  await step();
  assert.equal(f.plugin.states.get(s).windows.at(-1).window_id, 'win_002');
  assert.equal(f.legacyCalls, 1);
  assert.equal(f.plugin.states.get(s).windows[0].summary_kind, 'generated');
});

test('generated handoffs keep the summarizer identity and are recognized after replay', async t => {
  const f = await fixture(); t.after(f.dispose);
  const agent = await f.agent(); const s = agent.session;
  user(s, 'Old exploration. ' + 'noise '.repeat(8000)); user(s, 'Now ship the YAML parser.');
  assert.ok(await f.native.compactNow(agent, signal()));
  assert.equal(f.legacyCalls, 1);
  const event = s.snapshotEvents().find(e => e.type === 'compaction/summary');
  assert.equal(event.data.provider, 'fixture'); assert.equal(event.data.model, 'fixture');
  const text = event.data.summary[0].text;
  assert.match(text, /^<context_window id="win_002"/);
  assert.match(text, /<generated_handoff>\nFixture legacy summary\.\n<\/generated_handoff>/);
  assert.match(text, /Recent user instructions/);
  const restored = Session.create(s.id, f.persisted.get(s.id));
  const recovered = new SessionStateStore(f.plugin.states.repository).get(restored);
  assert.equal(recovered.windows.at(-1).window_id, 'win_002');
  assert.equal(recovered.windows[0].summary_kind, 'generated');
  assert.match(recovered.windows[0].summary, /Fixture legacy summary/);
});

test('extractive handoff mode never calls the auxiliary summarizer', async t => {
  const f = await fixture({ config: { handoffSummary: 'extractive' } }); t.after(f.dispose);
  const agent = await f.agent(); const s = agent.session;
  user(s, 'x'.repeat(40_000)); user(s, 'latest');
  assert.ok(await f.native.compactNow(agent, signal()));
  assert.equal(f.legacyCalls, 0);
  assert.equal(f.plugin.states.get(s).windows[0].summary_kind, 'extractive');
  assert.equal(s.snapshotEvents().find(e => e.type === 'compaction/summary').data.provider, 'context-management');
});

test('manual cancellation, busy admission and unbalanced cuts do not advance a window', async t => {
  const f = await fixture(); t.after(f.dispose);
  const agent = await f.agent(); const s = agent.session;
  user(s, 'a'.repeat(30_000)); user(s, 'latest');
  const before = [...s.surface.nodes];
  const abort = new AbortController(); abort.abort(new Error('cancelled'));
  await assert.rejects(async () => f.native.compactNow(agent, abort.signal), /cancelled/);
  agent.setBusy(true);
  await assert.rejects(async () => f.native.compactNow(agent, signal()), /idle agent/);
  agent.setBusy(false);
  assert.deepEqual(s.surface.nodes, before);
  startTurn(s); assistantCalls(s, ['bash']);
  await assert.rejects(() => f.native.compactRegion(s.surface.nodes[0], s.surface.nodes.at(-1), agent, signal()), /balanced/);
  assert.equal(f.plugin.states.get(s).windows.length, 1);
});

test('tiny histories fail honestly, do not advance windows, and settle pending requests', async t => {
  const f = await fixture(); t.after(f.dispose);
  const agent = await f.agent(); const s = agent.session;
  user(s, 'hello'); header(s); startTurn(s);
  await f.execute(agent, 'new_context');
  await f.ctx.waterfall('agent/pre-step', { agent, signal: signal() }, () => ({ kind: 'enter' }));
  assert.equal(f.plugin.states.get(s).windows.length, 1);
  assert.equal(f.plugin.states.get(s).pending, null);
  assert.match(JSON.stringify(s.deriveMessages()), /unchanged/);
});

test('explicit requests still work when DSH auto compaction is disabled', async t => {
  const f = await fixture({ auto: false }); t.after(f.dispose);
  const agent = await f.agent(); const s = agent.session;
  user(s, 'x'.repeat(60_000)); user(s, 'latest'); header(s); startTurn(s);
  await f.execute(agent, 'new_context');
  await f.ctx.waterfall('agent/pre-step', { agent, signal: signal() }, () => ({ kind: 'enter' }));
  assert.equal(f.plugin.states.get(s).windows.at(-1).window_id, 'win_002');
});

test('note read and search outputs remain bounded even for a one-megabyte line', async t => {
  const f = await fixture(); t.after(f.dispose);
  const agent = await f.agent();
  assert.equal((await f.execute(agent, 'notes_write_file', { path: 'large', text: 'x'.repeat(1_000_000) })).isError, false);
  const read = await f.execute(agent, 'notes_read_file', { path: 'large' });
  assert.equal(read.isError, false); assert.equal(read.value.content.length, 8000);
  assert.equal(read.value.next_offset_chars, 8000);
  const search = await f.execute(agent, 'notes_search_contents', { query: 'x' });
  assert.equal(search.isError, false); assert.ok(JSON.stringify(search.value).length < 1500);
});

test('every committed rotation replaces handoff.md and appends one handoff-log line', async t => {
  const f = await fixture(); t.after(f.dispose);
  const agent = await f.agent(); const s = agent.session;
  const notes = () => f.plugin.states.get(s).notes;
  user(s, 'First task. ' + 'noise '.repeat(8000)); user(s, 'Ship the YAML parser.');
  assert.ok(await f.native.compactNow(agent, signal()));
  await f.plugin.handoffWrites;
  const first = notes().readFile('self', 'handoff.md').content;
  assert.match(first, /^# Latest handoff: win_001 → win_002/);
  assert.match(first, /generated by fixture\/fixture/);
  assert.match(first, /Fixture legacy summary\./);
  user(s, 'Second task. ' + 'noise '.repeat(8000)); user(s, 'Now add JSON.');
  assert.ok(await f.native.compactNow(agent, signal()));
  await f.plugin.handoffWrites;
  assert.match(notes().readFile('self', 'handoff.md').content, /^# Latest handoff: win_002 → win_003/);
  const log = notes().readFile('self', 'handoff-log.md').content.trim().split('\n');
  assert.deepEqual(log.map(line => line.split(' ')[1]), ['win_002', 'win_003']);
  // The body is already in the window header; the note is not injected a second time.
  const header = s.snapshotEvents().filter(e => e.type === 'compaction/summary').at(-1).data.summary[0].text;
  assert.doesNotMatch(header, /Note self\/notes\/handoff/);
  // Durable: a fresh store reads the same notes from disk.
  const recovered = new SessionStateStore(f.plugin.states.repository).get(Session.create(s.id, f.persisted.get(s.id)));
  assert.match(recovered.notes.readFile('self', 'handoff.md').content, /win_002 → win_003/);
});

test('handoff notes are not written while context management is disabled or for a cancelled compaction', async t => {
  const f = await fixture(); t.after(f.dispose);
  const agent = await f.agent(); const s = agent.session;
  user(s, 'a'.repeat(30_000)); user(s, 'latest');
  const abort = new AbortController(); abort.abort(new Error('cancelled'));
  await assert.rejects(async () => f.native.compactNow(agent, abort.signal), /cancelled/);
  await f.plugin.handoffWrites;
  assert.equal(f.plugin.states.get(s).notes.files.has('self/notes/handoff.md'), false);
});
