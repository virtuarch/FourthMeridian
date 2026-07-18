/**
 * components/ai/ai.test.ts  (AI Experience Convergence — AI-1)
 *
 * Guards for the AI presentation layer. Standalone tsx (house pattern):
 * npx tsx components/ai/ai.test.ts — exits 0/1. Auto-discovered by run-tests.
 * The components are React (no DOM runner in-repo), so this source-scans the
 * load-bearing boundaries: presentation-only (no fetch), no workspace/runtime
 * imports, no financial calculation, and the honest future-slot contract.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const AI_DIR = path.join(process.cwd(), "components", "ai");
const read = (f: string) => readFileSync(path.join(AI_DIR, f), "utf8");
const files = readdirSync(AI_DIR).filter((f) => (f.endsWith(".tsx") || f.endsWith(".ts")) && !f.endsWith(".test.ts"));

console.log("the named components exist");
{
  for (const f of ["AiShell.tsx", "ConversationView.tsx", "MessageCard.tsx", "AnswerCard.tsx", "Composer.tsx", "SuggestedPrompt.tsx", "KnowledgeGapCard.tsx", "index.ts"]) {
    check(`components/ai/${f} exists`, existsSync(path.join(AI_DIR, f)));
  }
}

console.log("presentation-only: no API calls, no persistence");
{
  for (const f of files) {
    const src = read(f);
    check(`${f} makes no fetch/XHR call`, !/\bfetch\s*\(|XMLHttpRequest|EventSource/.test(src));
    check(`${f} defines no API route / server action`, !/getServerSession|"use server"|from "@\/lib\/data\//.test(src));
  }
}

console.log("no workspace / runtime / semantic-authority imports");
{
  const forbidden = /@\/lib\/space\b|@\/components\/space\b|SpaceShell|useSpaceData|useSpaceNavigation|WORKSPACE_REGISTRY|@\/lib\/ai\/|@\/lib\/perspectives/;
  for (const f of files) {
    check(`${f} imports no workspace/AI-domain runtime`, !forbidden.test(read(f)));
  }
}

console.log("honest future-slot contract (AnswerCard)");
{
  const src = read("AnswerCard.tsx");
  // The v2.6 slots are declared as never[] (present in the type, un-populatable today).
  check("AnswerCard declares facts/evidence/actions as never[]",
    /facts\?:\s*never\[\]/.test(src) && /evidence\?:\s*never\[\]/.test(src) && /actions\?:\s*never\[\]/.test(src));
  // And renders ONLY message + the extras slot — never a facts/evidence/actions section.
  check("AnswerCard renders only message + children (no facts/evidence/actions rendering)",
    !/\{\s*facts\b|\{\s*evidence\b|\{\s*actions\b|facts\.map|evidence\.map|actions\.map/.test(src));
}

console.log("kit reuse (Composer on Atlas Textarea)");
{
  check("Composer builds on the Atlas Textarea (not a bare <textarea>)",
    /from "@\/components\/atlas\/fields"/.test(read("Composer.tsx")) && !/<textarea/.test(read("Composer.tsx")));
}

if (failures > 0) {
  console.error(`\nai.test: ${failures} failure(s).`);
  process.exit(1);
}
console.log("\nai.test: all passed.");
