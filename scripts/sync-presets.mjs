#!/usr/bin/env node
// Keep the shipped Web presets mounting the windowing compaction engine
// (see presets.mjs for why the rows are restated). Writing and `--check` run
// the capability preflight first and refuse to proceed when it fails;
// `--remove` never does, so rollback always works.
//
//   node scripts/sync-presets.mjs [--profile web] [--dsh-dir <dir>] [--check | --remove]
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDshDir, profileDir, fromDsh, parseArgs } from './dsh-env.mjs';
import { NATIVE, WINDOWED, BEGIN, END, shippedOverrides, splitBlock, foreignOverrides } from './presets.mjs';
import { runPreflight, report } from './preflight.mjs';

async function main() {
  const args = parseArgs(process.argv.slice(2), ['--check', '--remove']);
  const patchFile = join(profileDir(args.profile), 'cordis.patch.yml');
  const current = readFileSync(patchFile, 'utf8');
  const { before, after } = splitBlock(current);
  let next;
  if (args.remove) {
    next = (before + after).replace(/\n+$/, '\n').replaceAll(WINDOWED, NATIVE);
  } else {
    const dshDir = resolveDshDir(args.dshDir);
    if (!report(await runPreflight({ dshDir, profile: args.profile }), { quiet: args.check })) {
      console.error('context-management: preflight failed; profile left unchanged.');
      process.exit(1);
    }
    const { version, overrides } = shippedOverrides(fromDsh(dshDir).packageDir('@deepseek-ai/dsh-web-app'));
    const foreign = foreignOverrides(current, overrides);
    if (foreign.length) throw new Error(`${patchFile} already overrides ${foreign.join(', ')} outside the generated block; merge that edit first.`);
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
    if (args.check) {
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

main().catch(error => {
  console.error(`sync-presets: ${error.message}`);
  process.exit(2);
});
