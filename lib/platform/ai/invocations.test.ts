/**
 * lib/platform/ai/invocations.test.ts  (OPERATIONALIZATION P0)
 *
 * The AI operations reader prices and counts BILLED rows only, reports failures
 * as their own counts, and states truthfully what it records. Injected readers,
 * no database.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/ai/invocations.test.ts
 */
import { readFileSync } from "node:fs";
import { getAiOperations, buildAiFailureCounts, type AiOperationsReaders } from "./invocations";
import type { InvocationGroup } from "./invocations-core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const G: InvocationGroup = { provider: "OPENAI", model: "gpt-5.1", surface: "chat", environment: "production", day: "2026-10-07",
  invocations: 4, promptTokens: 4000, cachedPromptTokens: 1000, completionTokens: 400, reasoningTokens: 0, toolCalls: 2, latencyMsTotal: 8000, latencyMsMax: 3000 };

async function main() {
  console.log("fold of failure groups");
  {
    const f = buildAiFailureCounts([{ outcome: "FAILED", count: 2 }, { outcome: "QUOTA", count: 1 }, { outcome: "RATE_LIMITED", count: 5 }, { outcome: "TIMEOUT", count: 1 }, { outcome: "RETURNED", count: 99 }]);
    check("each outcome on its own field, RETURNED excluded", f.failed === 2 && f.quota === 1 && f.rateLimited === 5 && f.timeouts === 1 && f.total === 9);
    check("empty → zeros", buildAiFailureCounts([]).total === 0);
  }

  console.log("reader composition");
  {
    const calls: string[] = [];
    const readers: AiOperationsReaders = {
      now: () => new Date("2026-10-07T12:00:00Z"),
      groups: async () => { calls.push("groups"); return [G]; },
      recent: async () => { calls.push("recent"); return []; },
      failures: async () => { calls.push("failures"); return [{ outcome: "QUOTA", count: 3 }]; },
    };
    const r = await getAiOperations({ window: "24h" }, { readers });
    check("billed totals come from the RETURNED groups only (4 invocations, 4,400 tokens)", r.totals.invocations === 4 && r.totals.promptTokens === 4000 && r.totals.completionTokens === 400);
    check("failures reported beside, not inside, the billed count", r.failures.quota === 3 && r.failures.total === 3 && r.totals.invocations === 4);
    check("the failures reader is consulted", calls.includes("failures"));
    check("limits say failures ARE recorded and user/Space are recorded-not-exposed",
      r.limits.failuresRecorded === true && r.limits.userDimension === "RECORDED_NOT_EXPOSED" && r.limits.spaceDimension === "RECORDED_NOT_EXPOSED");
    check("the note does not claim the ledger holds returned calls only", !/returned provider calls only/.test(r.limits.note) && /RETURNED/.test(r.limits.note));
  }

  console.log("source: the billed SQL filters on outcome; user/Space are not exposed");
  {
    const src = readFileSync("lib/platform/ai/invocations.ts", "utf8");
    check("the grouped query restricts to outcome = 'RETURNED'", /AND "outcome" = 'RETURNED'/.test(src));
    check("the failures query excludes RETURNED", /outcome: \{ not: "RETURNED" \}/.test(src));
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    check("no userId / spaceId is selected or filtered by this fleet-level reader (per-user is P1)", !/userId:\s*true|spaceId:\s*true|userId\s*=|spaceId\s*=/.test(stripped));
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}
main();
