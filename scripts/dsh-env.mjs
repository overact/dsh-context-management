// Locate the DSH install and profile the scripts operate on, and load modules
// from that install (not from this checkout's dev dependencies).
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { dirname, join, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/** The DSH install: explicit dir, $DSH_PACKAGE_DIR, then the `dsh` found on PATH. */
export function resolveDshDir(explicit) {
  const given = explicit ?? process.env.DSH_PACKAGE_DIR;
  if (given) return realpathSync(given);
  const names = process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh'];
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const bin = join(dir, name);
      if (!existsSync(bin)) continue;
      for (let at = dirname(realpathSync(bin)); at !== dirname(at); at = dirname(at)) {
        const manifest = join(at, 'package.json');
        if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === '@deepseek-ai/dsh') return at;
        const nested = join(at, 'node_modules', '@deepseek-ai', 'dsh');
        if (existsSync(join(nested, 'package.json'))) return realpathSync(nested);
      }
    }
  }
  throw new Error('Could not locate the @deepseek-ai/dsh package; pass --dsh-dir or set DSH_PACKAGE_DIR.');
}

/** `$DSH_HOME`, defaulting like DSH itself. */
export function dshHome() {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
}

export function profileDir(profile) {
  return join(dshHome(), 'profiles', profile);
}

/** Resolve and import packages as the given DSH install sees them. */
export function fromDsh(dshDir) {
  const require = createRequire(join(dshDir, 'package.json'));
  return {
    resolve: spec => require.resolve(spec),
    packageDir: name => dirname(require.resolve(`${name}/package.json`)),
    import: spec => import(pathToFileURL(require.resolve(spec)).href),
  };
}

/** Parse `--profile <p> --dsh-dir <d>` plus the given boolean flags. */
export function parseArgs(argv, flags = []) {
  const args = { profile: 'web' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--profile') args.profile = argv[++i];
    else if (arg === '--dsh-dir') args.dshDir = argv[++i];
    else if (flags.includes(arg)) args[arg.slice(2)] = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}
