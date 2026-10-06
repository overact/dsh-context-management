// Web-preset rewriting shared by sync-presets.mjs and preflight.mjs.
//
// The Loader cannot patch rows nested in an agent preset's `config.plugins`
// (only `group: true` lists are indexed) and a patch cannot rename a row, so
// each shipped preset that mounts `@deepseek-ai/dsh-compaction-basic` is
// restated in a generated block of the profile patch with that one row name
// swapped.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

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

// DSH's plugin manager rewrites the profile patch with the `yaml` package, which
// folds long `!!js` scalars over several lines whenever a plugin is toggled. That
// changes the bytes but not the meaning, so freshness is judged on the parsed
// documents. A class instance keeps the `!!js` tag part of the value, so it still
// differs from the same text as a plain string.
class JsScalar { constructor(code) { this.code = code; } }
const JS_TAG = { tag: 'tag:yaml.org,2002:js', resolve: code => new JsScalar(code) };

function parseYaml(YAML, text) {
  const doc = YAML.parseDocument(text, { customTags: [JS_TAG], logLevel: 'silent' });
  if (doc.errors.length) throw doc.errors[0];
  return doc.toJS();
}

/**
 * Whether two patch texts say the same thing; layout and comments don't count.
 * `YAML` is the `yaml` module of the DSH install. Without it, or when either text
 * fails to parse, only byte-identical texts match (stale is the safe answer).
 */
export function sameYaml(YAML, a, b) {
  if (a === b) return true;
  try { return isDeepStrictEqual(parseYaml(YAML, a), parseYaml(YAML, b)); }
  catch { return false; }
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/**
 * Whether `current` states everything `generated` states, so the only difference
 * is what the profile added inside the block. The direction is the point: the
 * profile owns the file and may add (a `config` on a restated row, a whole row),
 * while a value the generator states differently — or one it states and the file
 * dropped — is stale. Rows are matched by `id` when they have one, so an inserted
 * row does not shift its neighbours. A key the profile carries that the generator
 * no longer states is indistinguishable from an addition, so a host-side removal
 * of exactly that key is not reported.
 */
function carries(current, generated) {
  if (isDeepStrictEqual(current, generated)) return true;
  if (Array.isArray(generated)) {
    if (!Array.isArray(current)) return false;
    const keyed = generated.every(item => isPlainObject(item) && typeof item.id === 'string');
    if (keyed) return generated.every(item => {
      const found = current.find(candidate => isPlainObject(candidate) && candidate.id === item.id);
      return found !== undefined && carries(found, item);
    });
    return generated.length <= current.length && generated.every((item, i) => carries(current[i], item));
  }
  if (isPlainObject(generated)) {
    if (!isPlainObject(current)) return false;
    return Object.entries(generated).every(([key, value]) => key in current && carries(current[key], value));
  }
  return false;
}

/** `carries`, on two patch texts. Same fallback as `sameYaml`: parse, or bytes. */
export function carriesYaml(YAML, current, generated) {
  if (current === generated) return true;
  try { return carries(parseYaml(YAML, current), parseYaml(YAML, generated)); }
  catch { return false; }
}

/** Ids of shipped presets that the profile already overrides outside the generated block. */
export function foreignOverrides(patchText, overrides) {
  const { before, after } = splitBlock(patchText);
  return overrides.filter(({ id }) => new RegExp(`^- id: ${id}$`, 'm').test(before + after)).map(o => o.id);
}
