// Web-preset rewriting shared by sync-presets.mjs and preflight.mjs.
//
// The Loader cannot patch rows nested in an agent preset's `config.plugins`
// (only `group: true` lists are indexed) and a patch cannot rename a row, so
// each shipped preset that mounts `@deepseek-ai/dsh-compaction-basic` is
// restated in a generated block of the profile patch with that one row name
// swapped.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const NATIVE = "name: '@deepseek-ai/dsh-compaction-basic'";
export const WINDOWED = "name: '@local/dsh-context-management/compaction'";
export const BEGIN = '# >>> context-management preset overrides';
export const END = '# <<< context-management preset overrides';

/** Turn one shipped `- insert: [preset row]` file into a row override, or null. */
export function toOverride(file, text) {
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

/** The shipped web presets that mount the native engine, as overrides. */
export function shippedOverrides(webAppDir) {
  const version = JSON.parse(readFileSync(join(webAppDir, 'package.json'), 'utf8')).version;
  const presetsDir = join(webAppDir, 'presets');
  const overrides = readdirSync(presetsDir).filter(name => name.endsWith('.patch.yml')).sort()
    .map(name => toOverride(name, readFileSync(join(presetsDir, name), 'utf8'))).filter(Boolean);
  return { version, overrides };
}

export function splitBlock(text) {
  const start = text.indexOf(BEGIN);
  if (start < 0) return { before: text.replace(/\n*$/, '\n'), block: null, after: '' };
  const end = text.indexOf(END, start);
  if (end < 0) throw new Error('Generated block has a begin marker but no end marker.');
  const tail = text.indexOf('\n', end);
  return { before: text.slice(0, start), block: text.slice(start, tail < 0 ? text.length : tail + 1), after: tail < 0 ? '' : text.slice(tail + 1) };
}

/** Ids of shipped presets that the profile already overrides outside the generated block. */
export function foreignOverrides(patchText, overrides) {
  const { before, after } = splitBlock(patchText);
  return overrides.filter(({ id }) => new RegExp(`^- id: ${id}$`, 'm').test(before + after)).map(o => o.id);
}
