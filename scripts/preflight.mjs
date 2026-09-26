#!/usr/bin/env node
// Pre-install check: does the target DSH provide every capability this plugin
// uses, and does anything already in the profile collide with it?
//
// Nothing here compares version numbers. Requirements are derived from the
// lib/ sources (DSH imports, ctx.<service>.<method> calls, events, session-log
// event types, base-class hooks, tool and command names), so a new usage in
// the code is checked without editing this file.
//
//   node scripts/preflight.mjs [--profile web] [--dsh-dir <dir>]
// Exit code 1 when a blocking check fails; warnings do not fail.
import { readFileSync, readdirSync, existsSync, accessSync, realpathSync, constants } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveDshDir, profileDir, fromDsh, dshHome, parseArgs } from './dsh-env.mjs';
import { shippedOverrides, foreignOverrides } from './presets.mjs';
import { NOTES_TOOLS } from '../lib/tools/notes.js';
import { historyToolDefinitions } from '../lib/tools/history.js';
import { newContextToolDefinition } from '../lib/tools/new-context.js';
import { HISTORY_EVENT_TYPES } from '../lib/history-store.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** Which DSH package provides each host service used as ctx.<service>. */
const SERVICE_PACKAGES = {
  tools: '@deepseek-ai/dsh-tools',
  sessions: '@deepseek-ai/dsh-session',
  commands: '@deepseek-ai/dsh-commands',
  systemPrompt: '@deepseek-ai/dsh-system-prompt',
  settings: '@deepseek-ai/dsh-settings',
  llm: '@deepseek-ai/dsh-llm',
  tokenMeter: '@deepseek-ai/dsh-token-meter',
};
/** Cordis built-ins, not provided by a DSH package. */
const BUILTIN_SERVICES = new Set(['logger', 'effect', 'inject', 'on', 'reflect']);

// ------------------------------------------------------------ requirements --

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) return sources(file);
    return /\.m?js$/.test(entry.name) ? [{ file, text: readFileSync(file, 'utf8') }] : [];
  });
}

const all = (text, re) => [...text.matchAll(re)];
const uniq = values => [...new Set(values)].sort();

/** Everything the plugin relies on, read from its own code. */
export function requirements() {
  const files = sources(join(ROOT, 'lib'));
  const client = files.find(f => f.file.endsWith('client.js'));
  const host = files.filter(f => f !== client).map(f => f.text).join('\n');
  const imports = {};
  for (const [, names, pkg] of all(host, /import\s*\{([^}]+)\}\s*from\s*'(@deepseek-ai\/dsh-[\w-]+)'/g)) {
    (imports[pkg] ??= new Set());
    for (const name of names.split(',')) if (name.trim()) imports[pkg].add(name.trim().split(/\s+as\s+/)[0]);
  }
  const services = {};
  for (const [, service, method] of all(host, /\b(?:this\.)?ctx\.(\w+)\.(\w+)\b/g)) {
    if (!BUILTIN_SERVICES.has(service)) (services[service] ??= new Set()).add(method);
  }
  const clientServices = uniq(all(client.text, /\binject:\s*\[([^\]]*)\]/g)
    .flatMap(([, list]) => all(list, /'([^']+)'/g).map(m => m[1])));
  const index = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8');
  return {
    imports: Object.fromEntries(Object.entries(imports).map(([k, v]) => [k, [...v].sort()])),
    services: Object.fromEntries(Object.entries(services).map(([k, v]) => [k, [...v].sort()])),
    events: uniq(all(host, /\bctx\.on\('([^']+)'/g).map(m => m[1])),
    sessionTypes: uniq([...HISTORY_EVENT_TYPES,
      ...all(host, /event\.type === '([^']+)'/g).map(m => m[1]),
      ...all(host, /\.append\('([^']+)'/g).map(m => m[1])]),
    hooks: uniq(all(host, /super\.(\w+)\(/g).map(m => m[1])),
    tools: uniq([newContextToolDefinition.name, ...Object.values(NOTES_TOOLS).map(t => t.name),
      ...historyToolDefinitions.map(t => t.name)]),
    commands: all(index, /COMMAND_NAMES = \[([^\]]*)\]/g).flatMap(([, list]) => all(list, /'([^']+)'/g).map(m => m[1])),
    clientServices,
    clientPackages: SELF.dsh?.client?.inject ?? [],
  };
}

// ------------------------------------------------------------- code index --

/** Concatenated JS of a package (its own files only), cached per directory. */
const codeCache = new Map();
function packageCode(dir) {
  if (!codeCache.has(dir)) {
    const walk = at => readdirSync(at, { withFileTypes: true }).flatMap(entry => {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
      const file = join(at, entry.name);
      if (entry.isDirectory()) return walk(file);
      return /\.(m|c)?js$/.test(entry.name) ? [readFileSync(file, 'utf8')] : [];
    });
    codeCache.set(dir, existsSync(dir) ? walk(dir).join('\n') : '');
  }
  return codeCache.get(dir);
}

const escape = text => text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
const literal = name => new RegExp(`['"\`]${escape(name)}['"\`]`);

/** True when `code` defines a tool or command called `name`: an object literal
 * with `name: '<name>'` (or `name: CONST` where `CONST = '<name>'`) that also
 * carries something runnable or a schema. Plain `{ name, description }` pairs
 * (parameter docs, catalogs) do not count. */
export function definesName(code, name) {
  if (!literal(name).test(code)) return false;
  const values = [`['"\`]${escape(name)}['"\`]`,
    ...[...code.matchAll(new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s*=\\s*['"\`]${escape(name)}['"\`]`, 'g'))].map(m => `${escape(m[1])}\\b`)];
  const re = new RegExp(`\\bname\\s*:\\s*(?:${values.join('|')})`, 'g');
  for (const match of code.matchAll(re)) {
    let start = code.lastIndexOf('{', match.index);
    let depth = 0, end = start;
    for (; end < code.length && end - start < 4000; end++) {
      if (code[end] === '{') depth++;
      else if (code[end] === '}' && --depth === 0) break;
    }
    const body = code.slice(start, end + 1);
    if (/\b(handler|execute|run)\s*[:(]|\bdefinitionId\b|\binput_?[sS]chema\b|\bparameters\s*:\s*\{/.test(body)) return true;
  }
  return false;
}

function dshPackages(dshDir) {
  const scope = join(dshDir, 'node_modules', '@deepseek-ai');
  return readdirSync(scope).filter(n => n.startsWith('dsh')).map(n => ({ name: `@deepseek-ai/${n}`, dir: realpathSync(join(scope, n)) }));
}

/** Other plugins installed in the profile (this one excluded). */
function profilePlugins(profile) {
  const dir = profileDir(profile);
  const manifest = join(dir, 'package.json');
  if (!existsSync(manifest)) return [];
  const deps = Object.keys(JSON.parse(readFileSync(manifest, 'utf8')).dependencies ?? {});
  return deps.filter(name => name !== SELF.name).flatMap(name => {
    const at = join(dir, 'node_modules', name);
    return existsSync(join(at, 'package.json')) ? [{ name, dir: realpathSync(at) }] : [];
  });
}

// ----------------------------------------------------------------- checks --

/** Each check: { id, level: 'fail' | 'warn', run(env) -> detail string | throws }. */
function checks(req) {
  const list = [];
  const add = (id, level, run) => list.push({ id, level, run });

  for (const [pkg, names] of Object.entries(req.imports)) {
    add(`import ${pkg}`, 'fail', async ({ dsh }) => {
      const mod = await dsh.import(pkg);
      const missing = names.filter(n => typeof mod[n] !== 'function');
      if (missing.length) throw new Error(`missing export(s): ${missing.join(', ')}`);
      return names.join(', ');
    });
  }

  add('compaction hooks', 'fail', async ({ dsh }) => {
    const { BasicCompactionEngine } = await dsh.import('@deepseek-ai/dsh-compaction-basic');
    const missing = req.hooks.filter(h => typeof BasicCompactionEngine?.prototype?.[h] !== 'function');
    if (missing.length) throw new Error(`BasicCompactionEngine lacks ${missing.map(h => `${h}()`).join(', ')}`);
    return `BasicCompactionEngine has ${req.hooks.map(h => `${h}()`).join(', ')}`;
  });

  for (const [service, methods] of Object.entries(req.services)) {
    const pkg = SERVICE_PACKAGES[service];
    if (!pkg) {
      add(`service ${service}`, 'warn', () => { throw new Error(`no provider mapping; add "${service}" to SERVICE_PACKAGES in scripts/preflight.mjs`); });
      continue;
    }
    add(`service ${service}`, 'fail', async ({ dsh }) => {
      const mod = await dsh.import(pkg);
      const classes = Object.values(mod).filter(v => typeof v === 'function' && v.prototype);
      const missing = methods.filter(m => !classes.some(c => typeof c.prototype[m] === 'function'));
      if (missing.length) throw new Error(`${pkg} provides no ${missing.map(m => `${service}.${m}()`).join(', ')}`);
      return methods.map(m => `${service}.${m}()`).join(', ');
    });
  }

  add('host events', 'fail', ({ dshCode }) => {
    const missing = req.events.filter(e => !literal(e).test(dshCode()));
    if (missing.length) throw new Error(`no DSH package emits ${missing.join(', ')}`);
    return req.events.join(', ');
  });

  add('session log types', 'fail', ({ dshCode }) => {
    const missing = req.sessionTypes.filter(t => !literal(t).test(dshCode()));
    if (missing.length) throw new Error(`unknown to DSH: ${missing.join(', ')} (history/window tracking would miss them)`);
    return `${req.sessionTypes.length} event types`;
  });

  add('web presets', 'fail', ({ dsh }) => {
    const { overrides } = shippedOverrides(dsh.packageDir('@deepseek-ai/dsh-web-app'));
    if (!overrides.length) throw new Error('no shipped preset mounts @deepseek-ai/dsh-compaction-basic; the windowing engine cannot be mounted');
    return overrides.map(o => o.id).join(', ');
  });

  add('notes storage', 'fail', async ({ dsh }) => {
    const { dshHomePath } = await dsh.import('@deepseek-ai/dsh-home-paths');
    const target = dshHomePath('context-management', 'notes');
    if (!target.startsWith(dshHome())) throw new Error(`dshHomePath resolves outside $DSH_HOME (${target})`);
    let at = target;
    while (!existsSync(at)) at = dirname(at);
    accessSync(at, constants.W_OK);
    return `writable (${relative(dshHome(), target) || '.'} under $DSH_HOME)`;
  });

  add('client packages', 'warn', ({ dsh }) => {
    const missing = req.clientPackages.filter(p => { try { dsh.packageDir(p); return false; } catch { return true; } });
    if (missing.length) throw new Error(`settings page will not load: missing ${missing.join(', ')}`);
    return req.clientPackages.join(', ');
  });

  add('client services', 'warn', ({ dshPackagesList }) => {
    const clientCode = dshPackagesList().filter(p => p.name.startsWith('@deepseek-ai/dsh-client')).map(p => packageCode(p.dir)).join('\n');
    const missing = req.clientServices.filter(s => !literal(s).test(clientCode));
    if (missing.length) throw new Error(`no client package provides ${missing.join(', ')}; the settings page will not load (/ctx still works)`);
    return req.clientServices.join(', ');
  });

  // Collisions: DSH itself or another profile plugin registering the same names.
  const collide = (id, names) => add(id, 'fail', ({ dshPackagesList, plugins }) => {
    const owners = [...dshPackagesList(), ...plugins].flatMap(p =>
      names.filter(n => definesName(packageCode(p.dir), n)).map(n => `${n} (${p.name})`));
    if (owners.length) throw new Error(`already registered by ${owners.join(', ')}`);
    return `${names.length} free`;
  });
  collide('tool names', req.tools);
  collide('command names', req.commands);

  add('other compaction engines', 'warn', ({ plugins }) => {
    const rivals = plugins.filter(p => {
      const m = JSON.parse(readFileSync(join(p.dir, 'package.json'), 'utf8'));
      const deps = { ...m.dependencies, ...m.peerDependencies };
      return '@deepseek-ai/dsh-compaction-basic' in deps || /extends\s+BasicCompactionEngine\b/.test(packageCode(p.dir));
    });
    if (rivals.length) throw new Error(`${rivals.map(p => p.name).join(', ')} also build on the compaction engine; make sure they do not replace the same preset rows`);
    return 'none in profile';
  });

  add('preset ownership', 'fail', ({ dsh, profile }) => {
    const patch = join(profileDir(profile), 'cordis.patch.yml');
    if (!existsSync(patch)) return 'no profile patch yet';
    const { overrides } = shippedOverrides(dsh.packageDir('@deepseek-ai/dsh-web-app'));
    const foreign = foreignOverrides(readFileSync(patch, 'utf8'), overrides);
    if (foreign.length) throw new Error(`profile patch already overrides ${foreign.join(', ')} outside the generated block; merge that edit first`);
    return 'no foreign overrides';
  });

  return list;
}

// ------------------------------------------------------------------ runner --

export async function runPreflight({ dshDir, profile = 'web' } = {}) {
  const root = resolveDshDir(dshDir);
  const dsh = fromDsh(root);
  let pkgs, code;
  const dshPackagesList = () => (pkgs ??= dshPackages(root));
  const env = {
    dsh, profile, dshPackagesList,
    plugins: profilePlugins(profile),
    dshCode: () => (code ??= dshPackagesList().map(p => packageCode(p.dir)).join('\n')),
  };
  const results = [];
  for (const check of checks(requirements())) {
    try {
      results.push({ id: check.id, level: check.level, ok: true, detail: await check.run(env) });
    } catch (error) {
      results.push({ id: check.id, level: check.level, ok: false, detail: error.message });
    }
  }
  return { dshDir: root, profile, results };
}

/** Print results; `quiet` shows only problems plus the summary line. */
export function report({ dshDir, profile, results }, { quiet = false } = {}) {
  const failed = results.filter(r => !r.ok && r.level === 'fail');
  const warned = results.filter(r => !r.ok && r.level === 'warn');
  if (!quiet) console.log(`context-management preflight: DSH at ${dshDir}, profile "${profile}"`);
  for (const r of results) {
    if (quiet && r.ok) continue;
    const mark = r.ok ? 'ok  ' : r.level === 'fail' ? 'FAIL' : 'warn';
    console.log(`  ${mark} ${r.id.padEnd(40)} ${r.detail}`);
  }
  console.log(`context-management preflight: ${results.length - failed.length - warned.length} ok, ${warned.length} warning(s), ${failed.length} failure(s).`);
  return failed.length === 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    process.exit(report(await runPreflight(args)) ? 0 : 1);
  } catch (error) {
    console.error(`preflight: ${error.message}`);
    process.exit(2);
  }
}
