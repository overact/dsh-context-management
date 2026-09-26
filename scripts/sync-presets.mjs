#!/usr/bin/env node
// Keep the shipped Web presets mounting the windowing compaction engine.
//
// The Loader cannot patch rows nested in an agent preset's `config.plugins`
// (only `group: true` lists are indexed) and a patch cannot rename a row, so
// each shipped preset that mounts `@deepseek-ai/dsh-compaction-basic` is
// restated in a generated block of the profile patch with that one row name
// swapped. Re-run after every DSH upgrade; `--check` reports staleness.
//
//   node scripts/sync-presets.mjs [--profile web] [--dsh-dir <dir>] [--check | --remove]
import { readFileSync, writeFileSync, readdirSync, realpathSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

const NATIVE = "name: '@deepseek-ai/dsh-compaction-basic'";
const WINDOWED = "name: '@local/dsh-context-management/compaction'";
const BEGIN = '# >>> context-management preset overrides';
const END = '# <<< context-management preset overrides';

function parseArgs(argv) {
  const args = { profile: 'web', mode: 'write' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--profile') args.profile = argv[++i];
    else if (arg === '--dsh-dir') args.dshDir = argv[++i];
    else if (arg === '--check') args.mode = 'check';
    else if (arg === '--remove') args.mode = 'remove';
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

/** The running DSH install: explicit dir, $DSH_PACKAGE_DIR, then the `dsh` on PATH. */
function resolveDshDir(explicit) {
  if (explicit ?? process.env.DSH_PACKAGE_DIR) return realpathSync(explicit ?? process.env.DSH_PACKAGE_DIR);
  let dir = dirname(realpathSync(execFileSync('bash', ['-lc', 'command -v dsh'], { encoding: 'utf8' }).trim()));
  while (dir !== dirname(dir)) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === '@deepseek-ai/dsh') return dir;
    dir = dirname(dir);
  }
  throw new Error('Could not locate the @deepseek-ai/dsh package; pass --dsh-dir.');
}

/** Turn one shipped `- insert: [preset row]` file into a row override. */
function toOverride(file, text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const insertAt = lines.indexOf('- insert:');
  if (insertAt < 0 || lines.indexOf('- insert:', insertAt + 1) >= 0) throw new Error(`${file}: expected exactly one top-level "- insert:"`);
  const row = lines.slice(insertAt + 1);
  const ids = row.filter(line => /^    - id: preset-[a-z0-9-]+$/.test(line));
  if (ids.length !== 1) throw new Error(`${file}: expected exactly one preset row`);
  for (const line of row) {
    if (line.trim() && !line.startsWith('    ')) throw new Error(`${file}: unexpected line outside the preset row: ${line}`);
  }
  const body = row.map(line => line.slice(Math.min(4, line.length - line.trimStart().length)));
  const matches = body.filter(line => line.trim() === NATIVE).length;
  if (matches > 1) throw new Error(`${file}: more than one compaction-basic row`);
  if (matches === 0) return null;
  const id = ids[0].trim().slice('- id: '.length);
  const swapped = body.map(line => line.trim() === NATIVE ? line.replace(NATIVE, WINDOWED) : line);
  while (swapped.at(-1) === '') swapped.pop();
  return { id, text: [...lines.slice(0, insertAt).filter(line => line.startsWith('#')), ...swapped].join('\n') };
}

function splitBlock(text) {
  const start = text.indexOf(BEGIN);
  if (start < 0) return { before: text.replace(/\n*$/, '\n'), block: null, after: '' };
  const end = text.indexOf(END, start);
  if (end < 0) throw new Error('Generated block has a begin marker but no end marker.');
  const tail = text.indexOf('\n', end);
  return { before: text.slice(0, start), block: text.slice(start, tail < 0 ? text.length : tail + 1), after: tail < 0 ? '' : text.slice(tail + 1) };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  const patchFile = join(home, 'profiles', args.profile, 'cordis.patch.yml');
  const current = readFileSync(patchFile, 'utf8');
  const { before, block, after } = splitBlock(current);
  const outside = before + after;
  let next;
  if (args.mode === 'remove') {
    next = outside.replace(/\n+$/, '\n').replaceAll(WINDOWED, NATIVE);
  } else {
    const dshDir = resolveDshDir(args.dshDir);
    const webApp = join(dshDir, 'node_modules', '@deepseek-ai', 'dsh-web-app');
    const version = JSON.parse(readFileSync(join(webApp, 'package.json'), 'utf8')).version;
    const presetsDir = join(webApp, 'presets');
    const overrides = readdirSync(presetsDir).filter(name => name.endsWith('.patch.yml')).sort()
      .map(name => toOverride(name, readFileSync(join(presetsDir, name), 'utf8'))).filter(Boolean);
    for (const { id } of overrides) {
      if (new RegExp(`^- id: ${id}$`, 'm').test(outside)) {
        throw new Error(`${patchFile} already overrides ${id} outside the generated block; merge that edit first.`);
      }
    }
    const generated = [
      `${BEGIN} (generated; do not edit)`,
      `# Source: @deepseek-ai/dsh-web-app@${version}. Regenerate after every DSH upgrade:`,
      '#   node scripts/sync-presets.mjs   (in the @local/dsh-context-management checkout)',
      ...overrides.flatMap(({ text }) => ['', text]),
      '',
      END,
      '',
    ].join('\n');
    // Profile-authored presets (for example router-spec) are swapped in place.
    next = before.replaceAll(NATIVE, WINDOWED) + (before.endsWith('\n\n') ? '' : '\n') + generated + after.replaceAll(NATIVE, WINDOWED);
    if (args.mode === 'check') {
      if (next !== current) {
        console.error(`context-management: preset overrides in ${patchFile} are stale for dsh-web-app@${version}; run scripts/sync-presets.mjs`);
        process.exit(1);
      }
      console.log(`context-management: preset overrides are current (dsh-web-app@${version}, ${overrides.map(o => o.id).join(', ')}).`);
      return;
    }
    console.log(`Generated overrides for ${overrides.map(o => o.id).join(', ')} from dsh-web-app@${version}.`);
  }
  if (next === current) {
    console.log('No changes.');
    return;
  }
  writeFileSync(`${patchFile}.pre-sync`, current);
  writeFileSync(`${patchFile}.tmp`, next);
  renameSync(`${patchFile}.tmp`, patchFile);
  console.log(`Updated ${patchFile} (previous version: ${patchFile}.pre-sync).`);
}

try {
  main();
} catch (error) {
  console.error(`sync-presets: ${error.message}`);
  process.exit(2);
}
