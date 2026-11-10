/**
 * lib/platform/intelligence/ai/conversations/purge-health.test.ts  (PR D — retention proven operational, S2 / OD-7 activation (a))
 *
 * The purge-staleness verdict, the authority over injected ledger reads, and the
 * alert rule `platform-ai-purge-late` through the REAL engine. No database.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/ai/conversations/purge-health.test.ts
 */

import { readFileSync } from "node:fs";
import {
  PLATFORM_AI_PURGE_ON_DEMAND_JOB, PLATFORM_AI_PURGE_STALE_HOURS, evaluatePlatformAiPurgeHealth, isSuccessfulDispatchAudit,
  isSuccessfulOnDemandSummary, isSuccessfulPurgeRun, isSuccessfulPurgeSummary,
} from "./purge-health";
import { getPlatformAiPurgeHealth, type PurgeHealthReads } from "./purge-health.server";
import { ALERT_RULES, findAlertRule } from "@/lib/alerts/rules";
import { evaluateAlertRules } from "@/lib/alerts/evaluate";
import { cleanlyEvaluatedRules } from "@/lib/alerts/recovery";
import type { AuthorityOutputs } from "@/lib/alerts/authorities";

let failures = 0;
function check(name: string, ok: boolean, detail: unknown = ""): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== "" ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

const NOW = new Date("2026-11-10T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const runSummary = (p: Record<string, unknown>) => ({ purgedGoals: 0, retention: { platformAiConversations: p } });
const ZERO = { enabled: true, conversations: 0, messages: 0, batches: 1, exhausted: true };

console.log("1. the verdict");
{
  check("the window is 36 h", PLATFORM_AI_PURGE_STALE_HOURS === 36);
  check("ON + a success 35 h ago ⇒ OK", evaluatePlatformAiPurgeHealth({ conversationsOn: true, lastSuccessAt: hoursAgo(35), now: NOW }).state === "OK");
  check("ON + a success EXACTLY 36 h ago ⇒ OK (strictly more than 36 h is late)", evaluatePlatformAiPurgeHealth({ conversationsOn: true, lastSuccessAt: hoursAgo(36), now: NOW }).state === "OK");
  check("ON + the last success 36 h + 1 s ago ⇒ LATE", evaluatePlatformAiPurgeHealth({ conversationsOn: true, lastSuccessAt: new Date(hoursAgo(36).getTime() - 1000), now: NOW }).state === "LATE");
  check("ON + never a success ⇒ LATE (lastSuccessAt null)", (() => { const v = evaluatePlatformAiPurgeHealth({ conversationsOn: true, lastSuccessAt: null, now: NOW }); return v.state === "LATE" && v.lastSuccessAt === null; })());
  check("OFF ⇒ OFF whatever the ledger says (no signal)", evaluatePlatformAiPurgeHealth({ conversationsOn: false, lastSuccessAt: hoursAgo(500), now: NOW }).state === "OFF");
  check("a ZERO-COUNT enabled run is a SUCCESS", isSuccessfulPurgeSummary(runSummary(ZERO)));
  check("an errored run, a misordered run, a disabled run, a dry run (no section) are NOT successes",
    !isSuccessfulPurgeSummary(runSummary({ ...ZERO, error: "x" })) && !isSuccessfulPurgeSummary(runSummary({ ...ZERO, enabled: false, misordered: true }))
      && !isSuccessfulPurgeSummary(runSummary({ ...ZERO, enabled: false })) && !isSuccessfulPurgeSummary({ purgedGoals: 0, retention: {} }) && !isSuccessfulPurgeSummary(null));
  check("a manual-dispatch audit row (zero counts) is a success; a failed one, or a scheduled one, is not",
    isSuccessfulDispatchAudit({ conversations: 0, messages: 0, batches: 1, exhausted: true, actorType: "SYSTEM", trigger: "MANUAL_DISPATCH" })
      && !isSuccessfulDispatchAudit({ conversations: 2, messages: 4, batches: 1, exhausted: true, trigger: "MANUAL_DISPATCH", failed: true })
      && !isSuccessfulDispatchAudit({ conversations: 2, messages: 4, batches: 1, exhausted: true, actorType: "SYSTEM" }));
  // 2026-11-05 — an ON-DEMAND success counts as a purge run (GET /api/jobs/dispatch?only=platform-ai-purge).
  check("an on-demand JobRun summary (the counts shape, zero included) is a success; failed / disabled / misordered / errored / null are not",
    isSuccessfulOnDemandSummary(ZERO) && !isSuccessfulOnDemandSummary({ ...ZERO, failed: true }) && !isSuccessfulOnDemandSummary({ ...ZERO, enabled: false })
      && !isSuccessfulOnDemandSummary({ ...ZERO, enabled: false, misordered: true }) && !isSuccessfulOnDemandSummary({ ...ZERO, error: "x" }) && !isSuccessfulOnDemandSummary(null));
  check("isSuccessfulPurgeRun judges each job by ITS summary shape; any other job name is never a purge run",
    isSuccessfulPurgeRun({ jobName: "purge-trash", summary: runSummary(ZERO) }) && isSuccessfulPurgeRun({ jobName: PLATFORM_AI_PURGE_ON_DEMAND_JOB, summary: ZERO })
      && !isSuccessfulPurgeRun({ jobName: "purge-trash", summary: ZERO }) && !isSuccessfulPurgeRun({ jobName: PLATFORM_AI_PURGE_ON_DEMAND_JOB, summary: runSummary(ZERO) })
      && !isSuccessfulPurgeRun({ jobName: "sync-banks", summary: ZERO }) && PLATFORM_AI_PURGE_ON_DEMAND_JOB === "platform-ai-purge-on-demand");
}

async function sections(): Promise<void> {
  console.log("2. the authority (injected ledger reads)");
  {
    let reads = 0;
    const R = (runs: Array<{ jobName: string; startedAt: Date; completedAt: Date | null; summary: unknown }>, audits: Array<{ createdAt: Date; metadata: unknown }> = []): PurgeHealthReads => ({
      succeededPurgeRuns: async () => { reads++; return runs; },
      recentDispatchAudits: async () => { reads++; return audits; },
    });
    const off = await getPlatformAiPurgeHealth(NOW, { conversationsOn: false, reads: R([{ jobName: "purge-trash", startedAt: hoursAgo(100), completedAt: hoursAgo(100), summary: runSummary(ZERO) }]) });
    check("OFF ⇒ state OFF and the ledgers are NOT READ", off.state === "OFF" && reads === 0);
    const fresh = await getPlatformAiPurgeHealth(NOW, { conversationsOn: true, reads: R([{ jobName: "purge-trash", startedAt: hoursAgo(10), completedAt: hoursAgo(10), summary: runSummary(ZERO) }]) });
    check("ON + a zero-count scheduled run 10 h ago ⇒ OK", fresh.state === "OK" && fresh.lastSuccessAt === hoursAgo(10).toISOString());
    const stale = await getPlatformAiPurgeHealth(NOW, { conversationsOn: true, reads: R([
      { jobName: "purge-trash", startedAt: hoursAgo(5), completedAt: hoursAgo(5), summary: runSummary({ ...ZERO, enabled: false }) },   // purge was off
      { jobName: "purge-trash", startedAt: hoursAgo(40), completedAt: hoursAgo(40), summary: runSummary(ZERO) },
    ]) });
    check("ON + the newest run had the purge disabled and the last real purge 40 h ago ⇒ LATE", stale.state === "LATE" && stale.lastSuccessAt === hoursAgo(40).toISOString());
    const viaDispatch = await getPlatformAiPurgeHealth(NOW, { conversationsOn: true, reads: R([], [
      { createdAt: hoursAgo(2), metadata: { conversations: 1, messages: 2, batches: 1, exhausted: true, trigger: "MANUAL_DISPATCH", failed: true } },
      { createdAt: hoursAgo(20), metadata: { conversations: 0, messages: 0, batches: 1, exhausted: true, trigger: "MANUAL_DISPATCH" } },
    ]) });
    check("Preview shape (no JobRun): the newest NON-failed manual dispatch counts (20 h ago ⇒ OK); a failed one does not", viaDispatch.state === "OK" && viaDispatch.lastSuccessAt === hoursAgo(20).toISOString());
    const onDemand = await getPlatformAiPurgeHealth(NOW, { conversationsOn: true, reads: R([
      { jobName: PLATFORM_AI_PURGE_ON_DEMAND_JOB, startedAt: hoursAgo(3), completedAt: hoursAgo(3), summary: ZERO },
      { jobName: "purge-trash", startedAt: hoursAgo(40), completedAt: hoursAgo(40), summary: runSummary(ZERO) },
    ]) });
    check("ON + the scheduled purge last succeeded 40 h ago but an ON-DEMAND run succeeded 3 h ago ⇒ OK (the on-demand success counts)",
      onDemand.state === "OK" && onDemand.lastSuccessAt === hoursAgo(3).toISOString());
    const onDemandBad = await getPlatformAiPurgeHealth(NOW, { conversationsOn: true, reads: R([
      { jobName: PLATFORM_AI_PURGE_ON_DEMAND_JOB, startedAt: hoursAgo(3), completedAt: hoursAgo(3), summary: { ...ZERO, enabled: false } },
      { jobName: "purge-trash", startedAt: hoursAgo(40), completedAt: hoursAgo(40), summary: runSummary(ZERO) },
    ]) });
    check("…an on-demand row whose purge was not enabled does NOT count ⇒ LATE", onDemandBad.state === "LATE" && onDemandBad.lastSuccessAt === hoursAgo(40).toISOString());
    const never = await getPlatformAiPurgeHealth(NOW, { conversationsOn: true, reads: R([]) });
    check("ON + nothing recorded ⇒ LATE", never.state === "LATE");
    const src = readFileSync("lib/platform/intelligence/ai/conversations/purge-health.server.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    check("the authority reads ONLY JobRun (purge-trash + platform-ai-purge-on-demand, succeeded) and the purge AuditLog rows, through systemDb (fm_system) — never the global db, a conversation table or content",
      !/platformAiConversation|platformAiMessage|contentEncrypted/.test(src) && /systemDb\.jobRun\.findMany/.test(src) && /systemDb\.auditLog\.findMany/.test(src) && !/\bdb\./.test(src) && !/import \{ db \}/.test(src)
        && /select: \{ jobName: true, startedAt: true, completedAt: true, summary: true \}/.test(src)
        && /where: \{ jobName: \{ in: \[PLATFORM_AI_PURGE_JOB_NAME, PLATFORM_AI_PURGE_ON_DEMAND_JOB\] \}, status: "succeeded" \}/.test(src) && /select: \{ createdAt: true, metadata: true \}/.test(src));
    check("ON = the conversations flag set (fully enabled OR misordered without the purge)", /env\.isPlatformAiConversationsEnabled \|\| env\.isPlatformAiConversationsFlagSetWithoutPurge/.test(src));
  }

  console.log("3. the alert rule through the REAL engine");
  {
    const rule = findAlertRule("platform-ai-purge-late");
    check("the rule is registered, live, enabled by default, on its own authority", !!rule && rule.live && rule.defaultEnabled && rule.authority === "platform-ai-purge" && ALERT_RULES.filter((r) => r.id === "platform-ai-purge-late").length === 1);
    const base: AuthorityOutputs = { jobHealth: null, connectionHealth: null, resourceFreshness: null, aiFailures: null, aiSpend: null, syncIncidents: null };
    const fire = (h: AuthorityOutputs["platformAiPurge"]) => evaluateAlertRules({ ...base, platformAiPurge: h }, () => true).filter((s) => s.kind === "platform-ai-purge-late");
    const late = fire(evaluatePlatformAiPurgeHealth({ conversationsOn: true, lastSuccessAt: hoursAgo(50), now: NOW }));
    check("LATE ⇒ ONE critical signal, stable dedupe key, timestamps only in the summary",
      late.length === 1 && late[0].severity === "critical" && late[0].dedupeKey === "platform-ai-purge-late:late" && late[0].summary.includes(hoursAgo(50).toISOString()), late);
    check("OK ⇒ no signal", fire(evaluatePlatformAiPurgeHealth({ conversationsOn: true, lastSuccessAt: hoursAgo(1), now: NOW })).length === 0);
    check("OFF ⇒ no signal", fire(evaluatePlatformAiPurgeHealth({ conversationsOn: false, lastSuccessAt: null, now: NOW })).length === 0);
    check("the authority did not gather ⇒ no signal, and the rule is NOT 'cleanly evaluated' (never mistaken for healthy)",
      fire(null).length === 0 && !cleanlyEvaluatedRules({ ...base, platformAiPurge: null }, () => true, ALERT_RULES).has("platform-ai-purge-late")
        && cleanlyEvaluatedRules({ ...base, platformAiPurge: evaluatePlatformAiPurgeHealth({ conversationsOn: false, lastSuccessAt: null, now: NOW }) }, () => true, ALERT_RULES).has("platform-ai-purge-late"));
    const run = readFileSync("lib/alerts/run.ts", "utf8");
    check("the alert job gathers the authority once per cycle (failure ⇒ null, non-fatal)", /getPlatformAiPurgeHealth\(\)\.catch\(\(e\) => \(warn\("platform-ai-purge", e\), null\)\)/.test(run));
  }
}

sections().then(() => {
  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}).catch((e) => { console.error(e); process.exit(1); });
