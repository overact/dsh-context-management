import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, user, dsh } from './helpers/dsh.js';

test('native SettingsForms toggles schemas and /ctx uses the same authoritative state', async t => {
  const f = await fixture(); t.after(f.dispose);
  const a = await f.agent();
  assert.equal(f.ctx.tools.schemas().length, 10);
  await f.ctx.settings.update('context-management', { enabled: false });
  await Promise.resolve();
  assert.equal(f.plugin.enabled, false); assert.equal(f.ctx.tools.schemas().length, 0);
  assert.equal((await f.execute(a, 'notes_write_file', { path: 'x', text: 'x' })).isError, true);
  const command = await f.ctx.commands.execute(a, '/ctx', [], new AbortController().signal);
  assert.equal(command.result.kind, 'success');
  assert.equal(f.ctx.settings.describe().find(s => s.ns === 'context-management')?.value.enabled, true);
  assert.equal(f.ctx.tools.schemas().length, 10);
  await Promise.all([
    f.ctx.commands.execute(a, '/ctx', [], new AbortController().signal),
    f.ctx.commands.execute(a, '/ctx', [], new AbortController().signal),
  ]);
  assert.equal(f.ctx.settings.describe().find(s => s.ns === 'context-management')?.value.enabled, true);
});

test('injectTools:false safely delegates manual /compact to the native summarizer', async t => {
  const f = await fixture({ config: { injectTools: false } }); t.after(f.dispose);
  const a = await f.agent(); user(a.session, 'x'.repeat(40_000)); user(a.session, 'latest');
  const commands = await dsh('dsh-command-compact');
  await f.ctx.plugin(commands).await();
  assert.equal(f.ctx.tools.schemas().length, 0);
  const result = await f.ctx.commands.execute(a, '/compact', [], new AbortController().signal);
  assert.equal(result.result.kind, 'success'); assert.equal(f.legacyCalls, 1);
  assert.equal(f.plugin.states.get(a.session).windows.length, 1);
});

test('disabled-at-load remains configurable, and unloading the host returns the engine to native summaries', async t => {
  const f = await fixture({ config: { enabled: false } }); t.after(f.dispose);
  assert.equal(f.ctx.tools.schemas().length, 0);
  await f.ctx.settings.update('context-management', { enabled: true }); await Promise.resolve();
  assert.equal(f.ctx.tools.schemas().length, 10);
  await f.fiber.dispose();
  assert.equal(f.ctx.get('contextWindows'), undefined);
  const a = await f.agent(); user(a.session, 'x'.repeat(30_000)); user(a.session, 'tail');
  await f.native.compactNow(a, new AbortController().signal);
  assert.equal(f.legacyCalls, 1);
  assert.equal(f.ctx.tools.schemas().length, 0);
  assert.equal(f.ctx.settings.describe().find(s => s.ns === 'context-management')?.value, undefined);
});

test('live override changes affect manual compaction without replacing the DSH service', async t => {
  const f = await fixture(); t.after(f.dispose);
  await f.ctx.settings.update('context-management', { overrideCompaction: false }); await Promise.resolve();
  const a = await f.agent(); user(a.session, 'x'.repeat(30_000)); user(a.session, 'tail');
  await f.native.compactNow(a, new AbortController().signal);
  assert.equal(f.legacyCalls, 1);
  assert.equal(f.plugin.states.get(a.session).windows.length, 1);
});

test('disabling cancels queued rotations so re-enabling cannot execute stale control actions', async t => {
  const f = await fixture(); t.after(f.dispose);
  const a = await f.agent();
  await f.execute(a, 'new_context');
  assert.ok(f.plugin.states.get(a.session).pending);
  await f.ctx.settings.update('context-management', { enabled: false }); await Promise.resolve();
  await f.ctx.settings.update('context-management', { enabled: true }); await Promise.resolve();
  assert.equal(f.plugin.states.get(a.session).pending, null);
});
