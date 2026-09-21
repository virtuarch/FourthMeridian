/**
 * lib/test-support/mutant-module.test.ts
 *
 * The mutation suites are only as honest as the loader under them: a loader that
 * returns a cached earlier mutant makes every later mutation look like a gap in
 * the tests. This pins the loader itself — distinct sources load as distinct
 * modules, and nothing is left on disk. Probes are written to a private temp dir,
 * never under lib/, so this suite can run beside the repo-wide source scanners.
 *
 * Run: npx tsx lib/test-support/mutant-module.test.ts
 */

import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mutantLoader } from './mutant-module';

let failures = 0, passed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`); }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'fm-mutant-'));
  try {
    const loader = mutantLoader(dir, 'probe');
    const seen: number[] = [];
    const paths: string[] = [];
    for (const v of [1, 2, 3]) {
      const m = await loader.load<{ V: number; FILE: string }>(
        `export const V = ${v};\nexport const FILE = __filename;\n`);
      seen.push(m.V);
      paths.push(m.FILE);
    }
    check('three sources load as three modules, in order (never the first one again)',
      JSON.stringify(seen) === '[1,2,3]', JSON.stringify(seen));
    check('each mutant has its own path', new Set(paths).size === 3, paths.join(' '));
    check(`the path carries the pid (${process.pid}) so concurrent runs cannot collide`,
      paths.every((p) => p.includes(`_mutant_${process.pid}_`)));
    check('nothing is left on disk after a load', readdirSync(dir).length === 0, readdirSync(dir).join(' '));

    let threw = false;
    try { await loader.load('throw new Error("mutant fails to evaluate");\n'); } catch { threw = true; }
    check('a mutant that throws while evaluating rejects the load', threw);
    check('…and is deleted all the same', readdirSync(dir).length === 0, readdirSync(dir).join(' '));
    check('no mutant is reported in flight once a load settles', loader.current === null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main();
