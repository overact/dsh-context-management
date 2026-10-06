import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dshRoot } from './helpers/dsh.js';
import { sameYaml, carriesYaml, shippedOverrides } from '../scripts/presets.mjs';

const fromDsh = createRequire(join(realpathSync(dshRoot), 'package.json'));
const mod = await import(pathToFileURL(fromDsh.resolve('yaml')).href);
const YAML = mod.parseDocument ? mod : mod.default;

/** What DSH's plugin manager does to the profile patch on every plugin toggle. */
const rewrittenByDsh = text => String(YAML.parseDocument(text, { logLevel: 'silent', customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: s => s }] }));

const LONG = "process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:path').dirname(process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('@deepseek-ai/dsh-agent-preset/package.json')), 'skills')";
const patch = (code = LONG, extra = '') => `- id: preset-standard\n  config:\n    plugins:\n      - name: tool-skill\n        config:\n          customSkillDirs:\n            - !!js ${code}\n${extra}`;

test('a folded long !!js line is the same patch, a changed one is not', () => {
  const single = patch();
  const folded = rewrittenByDsh(single);
  assert.notEqual(folded, single, 'fixture must actually fold, or this test proves nothing');
  assert.ok(folded.split('\n').length > single.split('\n').length);
  assert.ok(sameYaml(YAML, single, folded));
  assert.ok(sameYaml(YAML, folded, single));
  assert.ok(!sameYaml(YAML, single, rewrittenByDsh(patch(LONG.replace("'skills'", "'other'")))));
});

test('layout and comments do not matter, values and the !!js tag do', () => {
  const base = patch();
  assert.ok(sameYaml(YAML, base, `# Source: dsh-web-app@0.2.0-rc.1\n\n${base}\n\n# trailing comment\n`));
  assert.ok(!sameYaml(YAML, base, patch(LONG, '      - name: extra\n')));
  assert.ok(!sameYaml(YAML, patch('foo'), patch('bar')));
  assert.ok(!sameYaml(YAML, '- !!js foo\n', '- foo\n'), 'the tag is part of the meaning');
});

test('unparseable text or a missing yaml module falls back to byte equality', () => {
  const single = patch(), folded = rewrittenByDsh(single);
  assert.ok(!sameYaml(YAML, single, 'id: [unclosed'));
  assert.ok(!sameYaml(null, single, folded));
  assert.ok(sameYaml(null, single, single));
  assert.ok(sameYaml(YAML, 'id: [unclosed', 'id: [unclosed'));
});

test('the shipped presets, restated and re-folded by DSH, still count as current', () => {
  const { overrides } = shippedOverrides(join(realpathSync(dshRoot), 'node_modules', '@deepseek-ai', 'dsh-web-app'));
  assert.ok(overrides.length > 0);
  const block = overrides.flatMap(({ text }) => ['', text]).join('\n') + '\n';
  assert.ok(sameYaml(YAML, block, rewrittenByDsh(block)));
  const swapped = block.replace("'@local/dsh-context-management/compaction'", "'@deepseek-ai/dsh-compaction-basic'");
  assert.notEqual(swapped, block);
  assert.ok(!sameYaml(YAML, block, rewrittenByDsh(swapped)), 'a real change in the restated preset is still stale');
});

// A profile may extend a restated row with its own keys; that is an edit the file
// keeps, so --check must not call it stale.
const RESTATED = [
  '- id: preset-standard',
  '  config:',
  '    plugins:',
  '      - id: plugin-one',
  "        name: '@deepseek-ai/dsh-plugin-one'",
  '      - id: plugin-two',
  "        name: '@deepseek-ai/dsh-plugin-two'",
  '',
].join('\n');
const EXTENDED = RESTATED.replace(
  "        name: '@deepseek-ai/dsh-plugin-one'\n",
  "        name: '@deepseek-ai/dsh-plugin-one'\n        config:\n          retries: 2\n",
);

test('a row the profile extended counts as current', () => {
  assert.notEqual(EXTENDED, RESTATED, 'fixture must actually add the config');
  assert.ok(!sameYaml(YAML, RESTATED, EXTENDED), 'sameYaml alone calls this stale');
  assert.ok(carriesYaml(YAML, EXTENDED, RESTATED));
  assert.ok(carriesYaml(YAML, rewrittenByDsh(EXTENDED), RESTATED), 'nor does DSH re-folding it');
  assert.ok(carriesYaml(YAML, RESTATED, RESTATED));
});

test('what the generator states must still be there, or it is stale', () => {
  const renamed = RESTATED.replace('dsh-plugin-two', 'dsh-plugin-other');
  assert.ok(!carriesYaml(YAML, renamed, RESTATED), 'a stated value that changed is stale');
  const droppedRow = RESTATED.replace("      - id: plugin-two\n        name: '@deepseek-ai/dsh-plugin-two'\n", '');
  assert.ok(!carriesYaml(YAML, droppedRow, RESTATED), 'a stated row the file dropped is stale');
  const droppedKey = RESTATED.replace("        name: '@deepseek-ai/dsh-plugin-two'\n", '');
  assert.ok(!carriesYaml(YAML, droppedKey, RESTATED), 'a stated key the file dropped is stale');
  assert.ok(!carriesYaml(YAML, '- foo\n', '- !!js foo\n'), 'the !!js tag is still part of the meaning');
});

test('an inserted row does not shift its neighbours', () => {
  const inserted = RESTATED.replace(
    '      - id: plugin-two\n',
    "      - id: plugin-extra\n        name: '@deepseek-ai/dsh-plugin-extra'\n      - id: plugin-two\n",
  );
  assert.notEqual(inserted, RESTATED);
  assert.ok(carriesYaml(YAML, inserted, RESTATED));
});

test('carriesYaml keeps the same parse-or-bytes fallback as sameYaml', () => {
  assert.ok(!carriesYaml(null, RESTATED, EXTENDED));
  assert.ok(carriesYaml(null, RESTATED, RESTATED));
  assert.ok(!carriesYaml(YAML, 'id: [unclosed', RESTATED));
  assert.ok(carriesYaml(YAML, 'id: [unclosed', 'id: [unclosed'));
});
