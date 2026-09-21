/**
 * lib/test-support/mutant-module.ts
 *
 * ONE MUTANT, ONE MODULE IDENTITY. The loader the forecast mutation suites use to
 * import a deliberately broken copy of the module under test.
 *
 * The suites used to write every mutant to the SAME path and cache-bust with a
 * query string — `import('./__engine_mutant__?v=N')`. Whether `?v=N` makes a new
 * module is the runtime's decision, not ours: Node 24/26 (under tsx) load each
 * variant, Node 22 hands back the FIRST mutant every time. Every later mutation
 * then asserted against the wrong code and reported "the mutant passed — the test
 * does not actually pin this": 12 + 5 + 2 + 4 false failures, and on a runtime
 * that happened to agree, nothing would have noticed the loader at all.
 *
 * Here each mutant gets its own file — `__<stem>_mutant_<pid>_<n>__.ts` — so its
 * identity is its path, which every module cache keys on. `pid` keeps two
 * concurrent runs in one checkout apart; `n` keeps mutants within a run apart.
 * The file is written beside the original (the mutant keeps its relative
 * imports), imported by absolute path, and deleted as soon as the import
 * settles — on success, on a throw during evaluation, and on process exit.
 */

import { existsSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface MutantLoader {
  /** Write `source` as a fresh module beside the original, import it, delete it. */
  load<T>(source: string): Promise<T>;
  /** Path of the mutant currently on disk (only while `load` is in flight). */
  readonly current: string | null;
}

export function mutantLoader(dir: string, stem: string): MutantLoader {
  let seq = 0;
  let current: string | null = null;
  const remove = (file: string) => { if (existsSync(file)) unlinkSync(file); };
  process.on('exit', () => { if (current) remove(current); });

  return {
    get current() { return current; },
    async load<T>(source: string): Promise<T> {
      const file = join(dir, `__${stem}_mutant_${process.pid}_${++seq}__.ts`);
      writeFileSync(file, source, 'utf8');
      current = file;
      try {
        return (await import(file)) as T;
      } finally {
        remove(file);
        current = null;
      }
    },
  };
}
