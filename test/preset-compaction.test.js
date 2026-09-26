import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, WindowingCompactionEngine, BasicCompactionEngine, user } from './helpers/dsh.js';

async function mountPreset(f, Engine, config = { auto: false, retainTokens: 800 }) {
  let native, calls = 0;
  const scope = f.ctx.isolate('compaction');
  const fiber = scope.plugin({ name: 'fixture-preset-compaction', apply(ctx) {
    native = new Engine(ctx, config);
    // A failing auxiliary summarizer must degrade to the extractive handoff.
    native.nativeSummarize = async () => { calls++; throw new Error('summarizer unavailable'); };
  } });
  await fiber.await();
  return { native, fiber, get calls() { return calls; } };
}

test('isolated preset engines rotate windows through the subclass seam', async t => {
  const f = await fixture({ noHostCompaction: true }); t.after(f.dispose);
  assert.equal(f.ctx.get('compaction'), undefined);
  assert.equal(f.ctx.tools.schemas().length, 10);
  const a = await mountPreset(f, WindowingCompactionEngine), b = await mountPreset(f, WindowingCompactionEngine);
  assert.equal(f.ctx.get('compaction'), undefined);
  assert.notEqual(a.native, b.native);
  const agent = await f.agent();
  user(agent.session, 'historical output '.repeat(4000)); user(agent.session, 'Keep the latest instruction.');
  await a.native.compactNow(agent, new AbortController().signal);
  const state = f.plugin.states.get(agent.session);
  assert.equal(state.windows.at(-1).window_id, 'win_002');
  assert.equal(state.windows[0].summary_kind, 'extractive');
  // The preset engine's pre-step marks the session as served, enabling new_context.
  await f.ctx.waterfall('agent/pre-step', { agent, signal: new AbortController().signal }, () => ({ kind: 'enter' }));
  assert.equal((await f.execute(agent, 'new_context')).isError, false);
  await a.fiber.dispose();
  // Host unload leaves surviving engines on the plain native path.
  await f.fiber.dispose();
  user(agent.session, 'more output '.repeat(4000)); user(agent.session, 'tail');
  const before = b.calls;
  await assert.rejects(() => b.native.compactNow(agent, new AbortController().signal));
  assert.ok(b.calls > before);
  assert.equal(f.plugin.states.get(agent.session).windows.length, 2);
});

test('new_context is refused for presets that mount only the native engine', async t => {
  const f = await fixture({ noHostCompaction: true }); t.after(f.dispose);
  await mountPreset(f, BasicCompactionEngine);
  const agent = await f.agent();
  await f.ctx.waterfall('agent/pre-step', { agent, signal: new AbortController().signal }, () => ({ kind: 'enter' }));
  const refused = await f.execute(agent, 'new_context');
  assert.equal(refused.isError, true);
  assert.match(JSON.stringify(refused), /does not mount the context-management compaction engine/);
  assert.equal(f.plugin.states.get(agent.session).pending, null);
});
