/**
 * lib/ai/snapshot-modeled-real-assets.test.ts   (RWA-2B)
 *
 * When the history engine's MODELED real-asset days reach the AI's snapshot
 * paths, they are never described as observed — through FACTS IN THE DATA, not
 * instruction text:
 *   - the canonical read's `realAssetsModeled` survives projectSnapshotSection
 *     (present only when true; every other point byte-identical);
 *   - get_net_worth_history flags the point and counts them in coverage;
 *   - explain_net_worth_composition's historical snapshot carries the flag + note;
 *   - find_in_balance_history flags a matched net-worth day and qualifies its
 *     "observed only" basis sentence ONLY when a searched day is modeled; the
 *     other metrics never compose real assets and are untouched;
 *   - no AI instruction text changed.
 *
 *   npx tsx lib/ai/snapshot-modeled-real-assets.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { projectSnapshotSection } from "@/lib/ai/assemblers/snapshot";
import type { Snapshot } from "@/types";
import { readToolsSource } from "@/lib/test-support/tools-source";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const code = (...p: string[]) => strip(readFileSync(join(process.cwd(), ...p), "utf8"));

function snap(date: string, over: Partial<Snapshot> = {}): Snapshot {
  return {
    date, netWorth: 150_000, totalAssets: 160_000, totalDebt: 10_000, totalCash: 5_000, totalSavings: 5_000,
    totalInvestments: 40_000, totalCrypto: 10_000, cashOnHand: 5_000, netLiquid: 0, isEstimated: true, currency: "USD",
    ...over,
  } as Snapshot;
}

console.log("1. the projection carries the flag, present only when true");
{
  const section = projectSnapshotSection([
    snap("2026-09-01"),
    snap("2026-09-02", { realAssetsModeled: true }),
    snap("2026-09-03", { isEstimated: false }),
  ], "full")!;
  check("modeled point flagged", section.history[1].realAssetsModeled === true);
  check("other points carry NO key (byte-identical payloads)",
    !("realAssetsModeled" in section.history[0]) && !("realAssetsModeled" in section.history[2]));
  check("values untouched", section.history[1].netWorth === 150_000 && section.history[1].totalAssets === 160_000);
  check("latest/brief projection unchanged in shape", projectSnapshotSection([snap("2026-09-01")], "brief")!.latest!.netWorth === 150_000);
}

console.log("2. the tools state the fact where it applies — and only there");
{
  const TOOLS = strip(readToolsSource()); // CQ-011: the tool layer (facade + lib/ai/conversation/tools/**)
  check("get_net_worth_history: each point carries realAssetsModeled only when set",
    /\.\.\.\(p\.realAssetsModeled \? \{ realAssetsModeled: true \} : \{\}\)/.test(TOOLS));
  check("…and coverage counts them with a note that names the unaffected metrics",
    /pointsWithModeledRealAssets: modeledRealAssets/.test(TOOLS)
      && /liquid, checking, investments, digitalAssets and debt on '\s*\+ 'those dates are unaffected/.test(TOOLS)
      && /never observed/.test(TOOLS));
  check("…conditionally: a range with no modeled day adds nothing", /\.\.\.\(modeledRealAssets > 0 \? \{/.test(TOOLS));
  check("historical snapshot (composition as of a past date): flag + note on coverage",
    /\.\.\.\(point\.realAssetsModeled\s*\? \{ realAssetsModeled: true,\s*realAssetsNote:/.test(TOOLS));
  check("find_in_balance_history: only netWorth composes real assets",
    /const modeledDates = metric === 'netWorth'\s*\? new Set\(inRange\.filter\(\(p\) => p\.realAssetsModeled\)/.test(TOOLS));
  check("…the matched day is flagged when modeled", /\.\.\.\(modeledDates\.has\(matchDate\) \? \{ realAssetsModeled: true \} : \{\}\)/.test(TOOLS));
  check("…the 'observed only' basis sentence is kept and qualified ONLY when a searched day is modeled",
    /basis: 'Observed daily snapshots only — nothing between two observations is modelled\. '/.test(TOOLS)
      && /\+ \(modeledDates\.size > 0\s*\? ` Exception: on \$\{modeledDates\.size\} searched day\(s\) the real-asset part of net worth is MODELED `/.test(TOOLS)
      && /: ''\)/.test(TOOLS));
  check("…coverage discloses the count only when non-zero",
    /\.\.\.\(modeledDates\.size > 0 \? \{ observationsWithModeledRealAssets: modeledDates\.size \} : \{\}\)/.test(TOOLS));
  const ASSEMBLER = code("lib", "ai", "assemblers", "snapshot.ts");
  check("the assembler carries the read boundary's verdict and decides nothing",
    /\.\.\.\(r\.realAssetsModeled === true \? \{ realAssetsModeled: true as const \} : \{\}\)/.test(ASSEMBLER)
      && !/valueOn|resolveAnchors|loadHistoriesFor/.test(ASSEMBLER));
}

console.log("3. no instruction text changed");
{
  const changed = ["lib/ai/types.ts", "lib/ai/assemblers/snapshot.ts", "lib/ai/conversation/tools.ts"];
  const INSTRUCTION_FILES = ["lib/ai/conversation/instructions.ts", "lib/ai/conversation/system-prompt.ts", "lib/ai/prompts.ts"];
  check("the RWA-2B AI change touches data/tool payloads only (instruction modules are not among the edited files)",
    INSTRUCTION_FILES.every((f) => !changed.includes(f)));
}

if (failures > 0) { console.error(`\nsnapshot-modeled-real-assets: ${failures} failure(s).`); process.exit(1); }
console.log("\nsnapshot-modeled-real-assets: all passed.");
