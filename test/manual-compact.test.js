import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, user, dsh, llm } from './helpers/dsh.js';
import { HistoryStore } from '../lib/history-store.js';

const signal = () => new AbortController().signal;

/** Mount the real human-facing `/compact` command over the fixture engine. */
async function withCompactCommand(f) {
  const commands = await dsh('dsh-command-compact');
  await f.ctx.plugin(commands).await();
}

/** One closed turn with a tool call, so the token meter and the compaction
 * transaction both accept the history as idle. */
function turn(session, n, output) {
  const turn = { turn: n, step: 1 };
  session.append('turn/start', { turn: n });
  session.append('step/start', turn);
  session.append('assistant/message', { ...turn, message: llm.createAssistantMessage({
    content: [{ type: 'tool-call', id: `c${n}`, name: 'bash', arguments: '{}' }],
    source: { provider: 'fixture', model: 'fixture' },
  }) }, { surfaceOp: 'append' });
  session.append('tool/result', { ...turn, message: llm.createToolResultMessage({
    callId: `c${n}`, content: [{ type: 'text', text: output }], isError: false,
  }) }, { surfaceOp: 'append' });
  session.append('step/end', turn);
  session.append('turn/end', { turn: n });
}

/** A long session whose auxiliary summary is the size a real one produces. */
async function longSession(f, summaryChars = 18_624) {
  const agent = await f.agent(); const s = agent.session;
  s.append('request/header', { reason: 'initial', header: { config: { provider: 'fixture', model: 'fixture' } } });
  s.append('goal/change', { goal: { phase: 'active', objective: 'Keep the rotation honest' } });
  s.append('todo/write', { todos: [{ content: 'Verify /compact', status: 'in_progress' }] });
  await f.plugin.states.writeNote(s, 'sentinel2-task.md', 'x'.repeat(900));
  await f.plugin.states.writeNote(s, 'current-template-task.md', 'y'.repeat(900));
  user(s, 'Long first task. ' + 'noise '.repeat(9_000));
  turn(s, 1, 'output '.repeat(2_500));
  turn(s, 2, 'more output '.repeat(2_000));
  user(s, 'Now compress manually.');
  f.native.nativeSummarize = async () => {
    const summary = [{ type: 'text', text: '## Primary Request and Intent\n' + 'S'.repeat(summaryChars) }];
    return { summary, rawOutput: summary, provider: 'fixture-provider', model: 'fixture-summarizer',
      maxTokens: 4000, llmStreamCall: true, usage: { inputTokens: 20_000, outputTokens: 5_000 } };
  };
  return { agent, s };
}

test('manual /compact rotates a window instead of summarizing natively', async t => {
  const f = await fixture({ config: { handoffMaxChars: 16000 } }); t.after(f.dispose);
  await withCompactCommand(f);
  const { agent, s } = await longSession(f);
  const meter = f.ctx.tokenMeter;
  const before = meter.measure(s).totalTokens;
  const result = await f.ctx.commands.execute(agent, '/compact', [], signal());
  await f.plugin.handoffWrites;
  assert.equal(result.result.kind, 'success');
  // The manual path runs the same windowing engine as automatic pressure.
  assert.equal(f.plugin.states.get(s).windows.at(-1).window_id, 'win_002');
  assert.equal(f.plugin.states.get(s).windows[0].summary_kind, 'generated');
  assert.equal(f.legacyCalls, 0, 'the windowing summarizer handled the manual request');
  assert.equal(f.plugin.states.get(s).notes.readFile('self', 'handoff.md').content.split('\n')[0],
    '# Latest handoff: win_001 → win_002');
  const after = meter.measure(s).totalTokens;
  assert.ok(after < before * 0.25, `${after} is not well below ${before}`);
});

test('the manual handoff spends its declared budget instead of stranding it', async t => {
  const f = await fixture({ config: { handoffMaxChars: 16000 } }); t.after(f.dispose);
  await withCompactCommand(f);
  const { agent, s } = await longSession(f);
  await f.ctx.commands.execute(agent, '/compact', [], signal());
  await f.plugin.handoffWrites;
  const event = s.snapshotEvents().filter(e => e.type === 'compaction/summary').at(-1);
  const header = event.data.summary[0].text;
  const body = header.match(/<generated_handoff>\n([\s\S]*?)\n<\/generated_handoff>/)?.[1] ?? '';
  assert.ok(header.length <= 16000, `${header.length} > 16000`);
  // Regression guard: the snapshot allowance used to strand ~5k characters while
  // the body was pinned near 7.5k at every cap.
  assert.ok(body.length > 9_000, `body ${body.length} did not reclaim the unused reserve`);
  assert.match(header, /Session goal \[item_\d+\] phase=active/);
  assert.match(header, /Session checklist \[item_\d+\]/);
  assert.match(header, /^Note self\/notes\//m);
  // A successful auxiliary call keeps its real envelope on the durable record.
  assert.equal(event.data.provider, 'fixture-provider');
  assert.equal(event.data.model, 'fixture-summarizer');
  assert.deepEqual(event.data.usage, { inputTokens: 20_000, outputTokens: 5_000 });
  assert.equal((event.data.rawOutput?.[0]?.text ?? '').length >= 18_624, true);
  // The ID this handoff advertises must resolve through the real tool surface.
  const read = await f.execute(agent, 'history_read_item', { item_id: `item_${event.seq}` });
  assert.equal(read.isError, false);
  assert.match(read.value.content, /<context_window id="win_002"/);
  const history = new HistoryStore(s, f.plugin.states);
  assert.ok(history.readItem({ item_id: history.listWindows({ recent_first: false })[0].summary_item_id }));
});
