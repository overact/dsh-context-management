import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
let dshRoot = process.env.DSH_PACKAGE_DIR;
if (!dshRoot) {
  try { dshRoot = dirname(require.resolve('@deepseek-ai/dsh/package.json')); }
  catch { throw new Error('Install the DSH dev dependency, or set DSH_PACKAGE_DIR to the installed @deepseek-ai/dsh package directory.'); }
}
const fromDsh = createRequire(join(dshRoot, 'package.json'));
export { dshRoot };
export async function dsh(name) { return import(pathToFileURL(fromDsh.resolve('@deepseek-ai/' + name)).href); }
export const { Context } = await dsh('cordis');
export const { Session, SessionStore } = await dsh('dsh-session');
export const { TokenMeter } = await dsh('dsh-token-meter');
export const { BasicCompactionEngine } = await dsh('dsh-compaction-basic');
export const { WindowingCompactionEngine } = await import('../../lib/compaction.js');
export const { SettingsProvider } = await dsh('dsh-settings');
export const { SystemPrompt } = await dsh('dsh-system-prompt');
export const llm = await dsh('dsh-llm');

export function user(session, text) {
  return session.append('user/message', llm.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' });
}
export const { SessionProjectionRegistry } = await dsh('dsh-session-projection');
export const { ToolRuntime } = await dsh('dsh-tools');
export const { CommandRuntime } = await dsh('dsh-commands');

import { installSettings } from './native-settings-fixture.mjs';

export async function fixture(options = {}) {
  const ctx = new Context();
  ctx.provide('llm', {
    resolveModelInfo: async () => ({ context: { contextWindow: options.capacity ?? 20_000 } }),
    imageRequestPricing: () => undefined,
  });
  new SessionProjectionRegistry(ctx);
  new SessionStore(ctx);
  new TokenMeter(ctx);
  new SystemPrompt(ctx, {});
  new ToolRuntime(ctx);
  new CommandRuntime(ctx);
  const attach = await installSettings(ctx, dsh);
  // A test durability listener records the exact immutable snapshot crossing the
  // real SessionStore flush seam. A separate JSONL test exercises disk restore.
  const persisted = new Map();
  const root = options.diskRoot ?? mkdtempSync(join(tmpdir(), 'dsh-context-fixture-'));
  // Notes live under the Harness home; keep every fixture inside its temporary root.
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  const storageModule = await dsh('dsh-session-persistence-jsonl');
  const JsonlSessionPersistence = storageModule.JsonlSessionPersistence ?? storageModule.default;
  const storage = new JsonlSessionPersistence(ctx, { root, compression: 'none', packChunks: true });
  ctx.on('session/flush', session => { persisted.set(session.id, structuredClone(session.snapshotEvents())); });
  const handles = new Map();
  const handleApi = typeof storage.open === 'function';
  const native = options.noHostCompaction ? null : new WindowingCompactionEngine(ctx, { auto: options.auto ?? true, retainTokens: 800, headroomTokens: 1024 });
  let legacyCalls = 0;
  // Stand-in for the base LLM summarizer; tests never call a paid model.
  if (native) native.nativeSummarize = async () => {
    legacyCalls++;
    const summary = [{ type: 'text', text: 'Fixture legacy summary.' }];
    return { summary, rawOutput: summary, provider: 'fixture', model: 'fixture' };
  };
  let plugin;
  const module = await import('../../lib/index.js');
  const fiber = ctx.plugin({ ...module.default, apply(child, config) { plugin = module.apply(child, config); } }, options.config ?? {});
  await fiber.await();
  attach('context-management', fiber, options.config ?? {});
  if (!plugin) throw new Error('Plugin did not activate');
  async function agent(id = 'test-agent') {
    const session = ctx.sessions.prepare(id);
    if (handleApi) handles.set(id, await storage.create(session.header));
    ctx.effect(() => {
      const detach = ctx.sessions.enter(session);
      ctx.sessions.announce(session);
      return detach;
    });
    // Real agents pass agent/pre-step, where a windowing engine marks the
    // session as served, before any tool call.
    if (native) plugin.contextWindows.serve(session);
    let busy = false;
    return { id, session, options: { provider: 'fixture', model: 'fixture' },
      runMaintenance(task) {
        if (busy) throw new Error('agent is busy');
        busy = true;
        return Promise.resolve().then(() => task(new AbortController().signal)).finally(() => { busy = false; });
      },
      setBusy(value) { busy = value; },
    };
  }
  async function execute(agent, name, args = {}) {
    return ctx.tools.execute({ agent, name, arguments: args, callId: 'test-call', signal: new AbortController().signal });
  }
  let closed = false;
  return { ctx, native, plugin, fiber, agent, execute, persisted, storage, root,
    notesRoot: () => join(root, 'context-management', 'notes'),
    get legacyCalls() { return legacyCalls; },
    dispose: async () => {
      if (closed) return;
      closed = true;
      if (handleApi) {
        await storage.flush();
        for (const handle of handles.values()) await handle.close();
      }
      await ctx.fiber.dispose();
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
      if (!options.diskRoot) rmSync(root, { recursive: true, force: true });
    },
  };
}
