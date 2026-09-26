import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dshRoot } from './helpers/dsh.js';
import { runPreflight, requirements, definesName } from '../scripts/preflight.mjs';

/** A DSH install that links every real package except the stubbed ones, plus
 * an isolated $DSH_HOME whose web profile holds the given extra plugins. */
function fixture({ stubs = {}, plugins = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ctx-preflight-'));
  const dsh = join(root, 'dsh');
  const scope = join(dsh, 'node_modules', '@deepseek-ai');
  mkdirSync(scope, { recursive: true });
  writeFileSync(join(dsh, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }));
  const real = join(realpathSync(dshRoot), 'node_modules', '@deepseek-ai');
  for (const name of readdirSync(real)) {
    if (!stubs[name]) { symlinkSync(join(real, name), join(scope, name)); continue; }
    mkdirSync(join(scope, name));
    writeFileSync(join(scope, name, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, type: 'module', exports: './index.js' }));
    writeFileSync(join(scope, name, 'index.js'), stubs[name]);
  }
  const profile = join(root, 'home', 'profiles', 'web');
  mkdirSync(join(profile, 'node_modules'), { recursive: true });
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: Object.fromEntries(Object.keys(plugins).map(n => [n, '1.0.0'])) }));
  for (const [name, code] of Object.entries(plugins)) {
    mkdirSync(join(profile, 'node_modules', name));
    writeFileSync(join(profile, 'node_modules', name, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
    writeFileSync(join(profile, 'node_modules', name, 'index.js'), code);
  }
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = join(root, 'home');
  return {
    run: () => runPreflight({ dshDir: dsh, profile: 'web' }),
    dispose() {
      if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const failures = ({ results }) => results.filter(r => !r.ok && r.level === 'fail').map(r => r.id);

test('requirements are derived from the plugin sources', () => {
  const req = requirements();
  assert.deepEqual(req.commands, ['ctx']);
  assert.equal(req.tools.length, 10);
  assert.ok(req.hooks.includes('summarize') && req.hooks.includes('compactIfNeeded'));
  assert.ok(req.services.tools.includes('register'));
  assert.ok(req.events.includes('agent/pre-step'));
  assert.ok(req.imports['@deepseek-ai/dsh-llm'].includes('createUserMessage'));
  assert.ok(req.sessionTypes.includes('compaction/end'));
});

test('definesName needs a runnable definition, not a bare name/description pair', () => {
  assert.equal(definesName("tools.register({ name: 'new_context', description: 'x', execute() {} })", 'new_context'), true);
  assert.equal(definesName("const N = 'new_context'; const t = { name: N, parameters: { type: 'object' } };", 'new_context'), true);
  assert.equal(definesName("parameters: [{ name: 'ctx', description: 'Agent context.' }]", 'ctx'), false);
  assert.equal(definesName("say('ctx')", 'ctx'), false);
});

test('preflight passes on the real DSH', async () => {
  const env = fixture();
  try {
    assert.deepEqual(failures(await env.run()), []);
  } finally {
    env.dispose();
  }
});

test('preflight reports a missing compaction hook, not a version', async () => {
  const env = fixture({ stubs: { 'dsh-compaction-basic': 'export class BasicCompactionEngine { compactIfNeeded() {} }\n' } });
  try {
    const result = await env.run();
    assert.deepEqual(failures(result), ['compaction hooks']);
    assert.match(result.results.find(r => r.id === 'compaction hooks').detail, /summarize\(\)/);
  } finally {
    env.dispose();
  }
});

test('preflight reports tool and command names already taken in the profile', async () => {
  const env = fixture({ plugins: {
    rival: "module.exports = { apply(ctx) { ctx.tools.register({ name: 'new_context', execute() {} }); ctx.commands.register({ name: 'ctx', handler() {} }); } };\n",
  } });
  try {
    const result = await env.run();
    assert.deepEqual(failures(result), ['tool names', 'command names']);
    assert.match(result.results.find(r => r.id === 'tool names').detail, /new_context \(rival\)/);
  } finally {
    env.dispose();
  }
});
