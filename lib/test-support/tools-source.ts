/**
 * lib/test-support/tools-source.ts — CQ-011
 *
 * THE TOOL LAYER'S SOURCE, AS ONE TEXT, FOR THE SOURCE SCANS THAT USED TO READ
 * `lib/ai/conversation/tools.ts` BY PATH.
 *
 * `tools.ts` was one 4,800-line module and some forty scans asserted over its
 * text — what it contains (a sentence in a tool description, a call to the
 * canonical authority) and, just as often, what it must NOT contain (a Prisma
 * client, a write op, a second copy of a helper, a second call site). CQ-011
 * split it into the facade plus domain modules under `tools/`. Every one of
 * those assertions is about THE TOOL LAYER, not about one file's line count, so
 * they now read this: the facade and every module, concatenated in a fixed order
 * that follows the original file's sections.
 *
 * ⚠️ NO MODULE CAN ESCAPE THE SCANS. `toolsSourceFiles()` throws if a `.ts` file
 * under `lib/ai/conversation/tools/` is not in `TOOLS_SOURCE_ORDER`, so a new
 * module cannot add a Prisma client or a write op that the negative assertions
 * never read. Listed files that do not exist are skipped (the split landed one
 * domain per commit).
 *
 * ⚠️ NEGATIVE ASSERTIONS GOT STRONGER, NOT WEAKER: "contains no X" over the
 * concatenation is "no module of the tool layer contains X".
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const TOOLS_FACADE = 'lib/ai/conversation/tools.ts';
const TOOLS_DIR = 'lib/ai/conversation/tools';

/** The facade first, then the modules in the order their sections had in the original file. */
export const TOOLS_SOURCE_ORDER: readonly string[] = [
  TOOLS_FACADE,
  `${TOOLS_DIR}/types.ts`,
  `${TOOLS_DIR}/shared/schema.ts`,
  `${TOOLS_DIR}/shared/values.ts`,
  `${TOOLS_DIR}/shared/read-window.ts`,
  `${TOOLS_DIR}/shared/reads.ts`,
  `${TOOLS_DIR}/shared/historical-snapshot.ts`,
  `${TOOLS_DIR}/shared/origin.ts`,
  `${TOOLS_DIR}/shared/cash-spine.ts`,
  `${TOOLS_DIR}/snapshot.ts`,
  `${TOOLS_DIR}/spending.ts`,
  `${TOOLS_DIR}/transactions.ts`,
  `${TOOLS_DIR}/income.ts`,
  `${TOOLS_DIR}/measures.ts`,
  `${TOOLS_DIR}/investments.ts`,
  `${TOOLS_DIR}/history.ts`,
  `${TOOLS_DIR}/projection.ts`,
  `${TOOLS_DIR}/scenario/setup.ts`,
  `${TOOLS_DIR}/scenario/present.ts`,
  `${TOOLS_DIR}/scenario/run.ts`,
  `${TOOLS_DIR}/scenario/goal-seek.ts`,
  `${TOOLS_DIR}/scenario/staging.ts`,
];

function walk(root: string, dir: string): string[] {
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  for (const name of readdirSync(abs)) {
    const rel = `${dir}/${name}`;
    if (statSync(join(root, rel)).isDirectory()) out.push(...walk(root, rel));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(rel);
  }
  return out;
}

/** Repo-relative paths of the tool layer, in scan order. Throws on an unlisted module. */
export function toolsSourceFiles(root: string = process.cwd()): string[] {
  const unlisted = walk(root, TOOLS_DIR).filter((f) => !TOOLS_SOURCE_ORDER.includes(f));
  if (unlisted.length > 0) {
    throw new Error(`tools-source: ${unlisted.map((f) => relative('.', f)).join(', ')} not in TOOLS_SOURCE_ORDER — `
      + 'add it so the tool-layer source scans read it');
  }
  return TOOLS_SOURCE_ORDER.filter((f) => existsSync(join(root, f)));
}

/** The facade and every tool module, concatenated (raw text, comments included). */
export function readToolsSource(root: string = process.cwd()): string {
  return toolsSourceFiles(root).map((f) => readFileSync(join(root, f), 'utf8')).join('\n');
}
