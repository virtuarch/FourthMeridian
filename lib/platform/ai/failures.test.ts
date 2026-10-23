/**
 * lib/platform/ai/failures.test.ts  (OPERATIONALIZATION P0)
 *
 * The AI failure authority's pure fold: outcome groups → one health report the
 * alert engine and the overview read. DB-free.
 *
 *   npx tsx lib/platform/ai/failures.test.ts
 */
import { readFileSync } from "node:fs";
import { buildAiFailureHealth, aiFailureWhere } from "./failures";
import { AI_PAUSED_CODE } from "./paid-requests-admission";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const NOW = new Date("2026-10-07T12:00:00.000Z");
const t = (iso: string) => new Date(iso);

console.log("empty window");
{
  const h = buildAiFailureHealth([], 24, NOW);
  check("every count is zero", h.returned === 0 && h.failed === 0 && h.timeouts === 0 && h.rateLimited === 0 && h.quota === 0);
  check("no failure timestamps", h.lastFailureAt === null && h.lastQuotaAt === null);
  check("window + checkedAt stamped", h.windowHours === 24 && h.checkedAt === NOW.toISOString());
}

console.log("mixed outcomes");
{
  const h = buildAiFailureHealth([
    { outcome: "RETURNED", count: 40, lastAt: t("2026-10-07T11:59:00Z") },
    { outcome: "FAILED", count: 2, lastAt: t("2026-10-07T09:00:00Z") },
    { outcome: "TIMEOUT", count: 1, lastAt: t("2026-10-07T10:00:00Z") },
    { outcome: "RATE_LIMITED", count: 5, lastAt: t("2026-10-07T11:00:00Z") },
    { outcome: "QUOTA", count: 3, lastAt: t("2026-10-07T08:00:00Z") },
  ], 24, NOW);
  check("counts land on their own fields", h.returned === 40 && h.failed === 2 && h.timeouts === 1 && h.rateLimited === 5 && h.quota === 3);
  check("lastFailureAt is the newest NON-returned timestamp", h.lastFailureAt === "2026-10-07T11:00:00.000Z", h.lastFailureAt ?? "null");
  check("lastQuotaAt is the quota group's own", h.lastQuotaAt === "2026-10-07T08:00:00.000Z");
}

console.log("unknown outcome words are ignored, never counted as returned");
{
  const h = buildAiFailureHealth([{ outcome: "WEIRD", count: 9, lastAt: t("2026-10-07T11:00:00Z") }], 6, NOW);
  check("returned stays 0", h.returned === 0);
  check("…but it still counts as a failure timestamp (something non-RETURNED happened)", h.lastFailureAt === "2026-10-07T11:00:00.000Z");
}

console.log("OBS-006 — what the fold reads: this environment, customer surfaces, never a kill-switch refusal");
{
  const since = new Date("2026-10-06T12:00:00.000Z");
  const w = aiFailureWhere(since, "production");
  check("window + this deployment's rows only", w.occurredAt.gte === since && w.environment === "production");
  check("customer surfaces only (chat, brief) — harness traffic is out", w.surface.in.join(",") === "chat,brief");
  check("AI_PAUSED rows excluded; RETURNED rows (null errorCode) kept", JSON.stringify(w.OR) === JSON.stringify([{ errorCode: null }, { errorCode: { not: AI_PAUSED_CODE } }]));
  check("…and a preview deployment reads preview rows, not production's", aiFailureWhere(since, "preview").environment === "preview");
  const src = readFileSync("lib/platform/ai/failures.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("the real reader queries through that predicate with the live environment", /where: aiFailureWhere\(since, deploymentEnvironment\(\)\)/.test(src));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
