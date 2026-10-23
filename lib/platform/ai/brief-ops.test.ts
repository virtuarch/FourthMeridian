/**
 * lib/platform/ai/brief-ops.test.ts  (PLATFORM OPS OBSERVABILITY)
 *
 * Daily Brief operations distinguish what the rows can prove:
 *   · GENERATED / FAILED / IN_PROGRESS / EMPTY from the nullable columns, with
 *     a failure counting only when newer than the generation (the product rule);
 *   · VERSION_STALE when the stored generation version is not the code's;
 *   · the generation reason recovered from the success correlationId;
 *   · economics joined 1:1 on correlationId, with the surface total and the
 *     uncorrelated count reported beside it — and cache reuse NOT counted.
 */

import { briefGenerationReason, classifyBriefRow, getBriefOps, type BriefInvocationFact, type BriefOpsReaders, type BriefRowFact } from "./brief-ops";
import { BRIEF_GENERATION_VERSION } from "@/lib/ai/brief/policy";
import { priceInvocation, type InvocationFact } from "./invocation-economics";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const D = (iso: string) => new Date(iso);
const now = D("2026-09-15T12:00:00.000Z");
const CURRENT = `${BRIEF_GENERATION_VERSION}+prompt-abc`;

function row(over: Partial<BriefRowFact>): BriefRowFact {
  return {
    spaceId: "space-aaaaaa111111", ownerUserId: "user-1", briefDay: "2026-09-15",
    generatedAt: D("2026-09-15T06:00:00.000Z"), generationStartedAt: null, lastFailedAt: null, lastFailureReason: null,
    model: "gpt-5.1", promptVersion: CURRENT, correlationId: "brief_daily_uuid-1", updatedAt: now, ...over,
  };
}
function inv(correlationId: string, over: Partial<Omit<InvocationFact, "correlationId">> = {}): BriefInvocationFact {
  return {
    provider: "OPENAI", model: "gpt-5.1", occurredAt: D("2026-09-15T06:00:00.000Z"), promptTokens: 20_000,
    cachedPromptTokens: 10_000, completionTokens: 1_000, reasoningTokens: 0, latencyMs: 3_000, toolCallCount: 0,
    environment: "development", correlationId, turnIndex: 0, surface: "brief", ...over,
  };
}

console.log("classifyBriefRow");
{
  check("generated", classifyBriefRow(row({}), now).state === "GENERATED");
  check("failed when the failure is newer than the generation",
    classifyBriefRow(row({ lastFailedAt: D("2026-09-15T08:00:00.000Z"), lastFailureReason: "TIMEOUT" }), now).state === "FAILED");
  check("a failure OLDER than the generation does not count",
    classifyBriefRow(row({ lastFailedAt: D("2026-09-15T05:00:00.000Z") }), now).state === "GENERATED");
  check("failed with no generation", classifyBriefRow(row({ generatedAt: null, lastFailedAt: D("2026-09-15T11:59:00.000Z") }), now).state === "FAILED");
  check("…and cooling down within the cooldown", classifyBriefRow(row({ generatedAt: null, lastFailedAt: D("2026-09-15T11:59:00.000Z") }), now).coolingDown === true);
  check("…but not after it", classifyBriefRow(row({ generatedAt: null, lastFailedAt: D("2026-09-15T11:00:00.000Z") }), now).coolingDown === false);
  check("in progress within the lease", classifyBriefRow(row({ generatedAt: null, generationStartedAt: D("2026-09-15T11:59:30.000Z") }), now).state === "IN_PROGRESS");
  check("a stale claim is not in progress", classifyBriefRow(row({ generatedAt: null, generationStartedAt: D("2026-09-15T11:00:00.000Z") }), now).state === "EMPTY");
  check("version stale when the stored version differs", classifyBriefRow(row({ promptVersion: "brief-generation-1+prompt-x" }), now).versionStale === true);
  check("current version is not stale", classifyBriefRow(row({}), now).versionStale === false);
  check("generation reason recovered from the id", briefGenerationReason("brief_change_x") === "change" && briefGenerationReason("brief_x") === null && briefGenerationReason(null) === null);
}

async function main(): Promise<void> {
console.log("getBriefOps");
{
  const rows: BriefRowFact[] = [
    row({}),
    row({ spaceId: "space-bbbbbb222222", correlationId: "brief_change_uuid-2", promptVersion: "brief-generation-1+p" }),
    row({ spaceId: "space-cccccc333333", generatedAt: null, correlationId: null, lastFailedAt: D("2026-09-15T11:58:00.000Z"), lastFailureReason: "PROVIDER_ERROR" }),
    row({ spaceId: "space-dddddd444444", briefDay: "2026-09-14", correlationId: "brief_daily_uuid-4" }),
  ];
  const joined = [inv("brief_daily_uuid-1"), inv("brief_change_uuid-2", { model: "unknown-model" })];
  const surface = [...joined, inv("brief_daily_uuid-orphan")];
  const asked: string[] = [];
  const readers: BriefOpsReaders = {
    now: () => now,
    rows: async (fromDay, take) => { asked.push(`rows:${fromDay}:${take}`); return rows; },
    invocationsFor: async (ids) => { asked.push(`join:${[...ids].sort().join("|")}`); return joined.filter((i) => ids.includes(i.correlationId)); },
    surfaceInvocations: async () => surface,
  };
  const r = await getBriefOps("7d", { readers });
  check("counts", r.counts.rows === 4 && r.counts.generated === 3 && r.counts.failed === 1 && r.counts.inProgress === 0 && r.counts.empty === 0);
  check("version stale counted", r.counts.versionStale === 1);
  check("cooling down counted", r.counts.coolingDown === 1);
  check("distinct spaces / owners", r.counts.distinctSpaces === 4 && r.counts.distinctOwners === 1);
  check("failure reasons tallied", r.failureReasons.PROVIDER_ERROR === 1);
  check("generation reasons tallied", r.generationReasons.daily === 2 && r.generationReasons.change === 1);
  check("by day newest first", r.byDay[0].day === "2026-09-15" && r.byDay[0].generated === 2 && r.byDay[0].failed === 1 && r.byDay[1].generated === 1);
  check("joined only on the rows' correlation ids", asked.some((a) => a === "join:brief_change_uuid-2|brief_daily_uuid-1|brief_daily_uuid-4"));
  check("correlated economics: 2 invocations, one unpriced", r.economics.correlated.invocations === 2 && r.economics.correlated.unpricedInvocations === 1);
  const expectedUsd = priceInvocation(joined[0]).usd;
  check("correlated usd = the priced invocation via the rate card", r.economics.correlated.usd === expectedUsd);
  check("surface total counts the orphan too", r.economics.surfaceTotal.invocations === 3);
  check("uncorrelated generations = successes with no invocation row", r.economics.uncorrelatedGenerations === 1);
  check("rows carry an opaque space ref, never the id or an owner", r.rows.every((x) => x.spaceRef.startsWith("…") && x.spaceRef.length === 7) && !JSON.stringify(r.rows).includes("user-1"));
  check("a generated row carries its invocation", r.rows[0].invocation !== null && r.rows[0].invocation!.latencyMs === 3_000);
  check("a failed row carries reason and no invocation", r.rows.find((x) => x.state === "FAILED")!.lastFailureReason === "PROVIDER_ERROR" && r.rows.find((x) => x.state === "FAILED")!.invocation === null);
  check("limits state what is not recorded", r.limits.reuseCounted === false && r.limits.generationDurationRecorded === false);
  check("window from is 7 days back", r.window.from === "2026-09-08T12:00:00.000Z");
  const empty = await getBriefOps("24h", { readers: { ...readers, rows: async () => [], surfaceInvocations: async () => [] } });
  check("no rows ⇒ zero counts, null usd, no join asked", empty.counts.rows === 0 && empty.economics.correlated.usd === null && empty.economics.surfaceTotal.invocations === 0);
}

}

main().then(() => {
  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}, (err) => { console.error(err); process.exit(1); });
