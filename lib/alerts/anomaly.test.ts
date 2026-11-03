/**
 * lib/alerts/anomaly.test.ts — quota/cost anomaly (anomaly@1).
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/alerts/anomaly.test.ts
 *
 * Pure + injected I/O only: no database, no email. Synthetic figures and ids.
 */
process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET || "synthetic-test-secret-not-a-real-one";

import { readFileSync } from "fs";
import { join } from "path";
import { ANOMALY_DEFINITION, ANOMALY_DEFINITION_ID, judgeAnomaly, median, type AnomalyWindow } from "@/lib/alerts/anomaly";
import { ALERT_RULES, findAlertRule } from "@/lib/alerts/rules";
import {
  decideDeliveries, evaluateAiSpendAnomaly, evaluateAiSpendUserAnomaly, evaluateAlertRulesDetailed,
  evaluatePlaidCallAnomaly, DEFAULT_RENOTIFY_HOURS,
} from "@/lib/alerts/evaluate";
import type { AiSpendAnomalyFacts, AuthorityOutputs, PlaidCallAnomalyFacts } from "@/lib/alerts/authorities";
import { latestAlertEvaluation, notEvaluableNow, firingNow } from "@/lib/alerts/latest-evaluation";
import { buildAiSpendAnomalyFacts, fleetWindowOf, getAiSpendAnomalyFacts } from "@/lib/platform/ai/spend-anomaly";
import { foldSpendGroups, type UserSpendGroup } from "@/lib/platform/ai/spend-health";
import { buildPlaidCallAnomalyFacts } from "@/lib/platform/anomaly/plaid-calls";
import { evaluatePlatformAlerts } from "@/lib/alerts/run";

let failures = 0, passes = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { passes++; console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const V = (value: number): AnomalyWindow => ({ kind: "VALUE", value });
const IDLE: AnomalyWindow = { kind: "IDLE" };
const UNPRICED: AnomalyWindow = { kind: "UNPRICED", unpricedInvocations: 2 };
const base7 = (v: number): AnomalyWindow[] => Array.from({ length: 7 }, () => V(v));
const CHECKED = "2026-03-10T12:30:00.000Z";
const rule = (id: string) => findAlertRule(id)!;

const fleetFacts = (current: AnomalyWindow, baseline: AnomalyWindow[], customers: AiSpendAnomalyFacts["customers"] = []): AiSpendAnomalyFacts =>
  ({ checkedAt: CHECKED, windowHours: 24, fleet: { current, baseline }, customers });
const plaidFacts = (current: AnomalyWindow, baseline: AnomalyWindow[]): PlaidCallAnomalyFacts =>
  ({ checkedAt: CHECKED, dayISO: "2026-03-09", current, baseline });

async function main(): Promise<void> {
  console.log("1. the definition (anomaly@1)");
  {
    check("named + versioned", ANOMALY_DEFINITION_ID === "anomaly@1");
    check("thresholds: ×3, 7 baseline windows, ≥5 active, floors $1 / $1 / 20 calls",
      ANOMALY_DEFINITION.ratio === 3 && ANOMALY_DEFINITION.baselineWindows === 7 && ANOMALY_DEFINITION.minBaselineWindows === 5
      && ANOMALY_DEFINITION.floors.aiFleetUsd === 1 && ANOMALY_DEFINITION.floors.aiCustomerUsd === 1 && ANOMALY_DEFINITION.floors.plaidCalls === 20);
    check("median: odd and even", median([3, 1, 2]) === 2 && median([1, 2, 3, 4]) === 2.5);
    const j = (current: AnomalyWindow, baseline: AnomalyWindow[], floor = 1) => judgeAnomaly({ current, baseline, floor });
    check("FIRE: $12 vs median $2 (×6)", j(V(12), base7(2)).verdict === "ANOMALOUS" && j(V(12), base7(2)).multiple === 6);
    check("exactly ×3 fires (≥)", j(V(6), base7(2)).verdict === "ANOMALOUS");
    check("below ×3 is normal", j(V(5.9), base7(2)).verdict === "NORMAL");
    check("NOT FIRE below the absolute floor: $0.80 vs $0.10 (×8) is normal", j(V(0.8), base7(0.1)).verdict === "NORMAL" && j(V(0.8), base7(0.1)).multiple === 8);
    check("NOT EVALUABLE: current unpriced", j(UNPRICED, base7(2)).verdict === "NOT_EVALUABLE" && /unpriced/.test(j(UNPRICED, base7(2)).reason ?? ""));
    check("NOT EVALUABLE: current idle (unavailable, never $0)", j(IDLE, base7(2)).verdict === "NOT_EVALUABLE" && /never \$0/.test(j(IDLE, base7(2)).reason ?? ""));
    check("NOT EVALUABLE: a baseline window unpriced", j(V(50), [UNPRICED, ...base7(2).slice(1)]).verdict === "NOT_EVALUABLE");
    const short = j(V(50), [V(2), V(2), V(2), V(2), IDLE, IDLE, IDLE]);
    check("NOT EVALUABLE: short history (4 of 7 active < 5)", short.verdict === "NOT_EVALUABLE" && /short history: 4 of 7/.test(short.reason ?? "") && short.activeBaselineWindows === 4);
    const enough = j(V(50), [V(2), V(2), V(2), V(2), V(2), IDLE, IDLE]);
    check("idle baseline windows count as measured zeros once history suffices", enough.verdict === "ANOMALOUS" && enough.median === 2);
    check("too few baseline windows provided ⇒ not evaluable", j(V(50), base7(2).slice(0, 6)).verdict === "NOT_EVALUABLE");
  }

  console.log("\n2. fleet AI spend rule");
  {
    const r = evaluateAiSpendAnomaly(rule("ai-spend-anomaly"), fleetFacts(V(12.4), base7(2.1)));
    const s = r.signals[0];
    check("fires one WARNING", r.signals.length === 1 && s.severity === "warning" && r.notEvaluable === null);
    check("dedupe key per UTC day", s.dedupeKey === "ai-spend-anomaly:fleet:2026-03-10");
    check("summary carries the basis", s.summary.includes("24h $12.40 vs 7-day median $2.10, ×5.9 (anomaly@1)"), s.summary);
    check("summary links the AI calls drilldown for the judged window",
      s.summary.includes(`/dashboard/platform/PLATFORM_OPS?workspace=platform-ai&aicalls=budget&aiuntil=${Date.parse(CHECKED)}`));
    check("below floor ⇒ no signal, evaluable", (() => { const x = evaluateAiSpendAnomaly(rule("ai-spend-anomaly"), fleetFacts(V(0.9), base7(0.1))); return x.signals.length === 0 && x.notEvaluable === null; })());
    const un = evaluateAiSpendAnomaly(rule("ai-spend-anomaly"), fleetFacts(UNPRICED, base7(2)));
    check("unpriced ⇒ not evaluable, says so, no signal", un.signals.length === 0 && /^anomaly@1: current window: 2 call\(s\) on an unpriced model/.test(un.notEvaluable ?? ""), un.notEvaluable ?? "");
  }

  console.log("\n3. per-customer AI spend rule (opaque refs only)");
  {
    const RAW = "cust-raw-id-0000000000000001";
    const RAW2 = "cust-raw-id-0000000000000002";
    // Build the facts through the REAL fold + reader classification over synthetic groups.
    const day = "2026-10-10"; // a day the synthetic model has a rate (rates are dated)
    const g = (userId: string, completionTokens: number, model = "gpt-5-mini"): UserSpendGroup =>
      ({ userId, provider: "OPENAI", model, surface: "chat", day, invocations: 1, promptTokens: 0, cachedPromptTokens: 0, completionTokens });
    const heavy = 2_000_000, light = 200_000;
    const folds = [
      foldSpendGroups([g(RAW, heavy), g(RAW2, light)]),            // current: RAW jumps ×10, RAW2 steady
      ...Array.from({ length: 7 }, () => foldSpendGroups([g(RAW, light), g(RAW2, light)])),
    ];
    const facts = buildAiSpendAnomalyFacts(folds, new Date(CHECKED), 24);
    const flat = JSON.stringify(facts);
    check("the facts never carry a raw user id", !flat.includes(RAW) && !flat.includes(RAW2));
    check("each customer carries an opaque ref + dedupe token", facts.customers.length === 2 && facts.customers.every((c) => /^user #[0-9a-f]{8}$/.test(c.ref) && /^[0-9a-f]{8}$/.test(c.dedupe)));
    const r = evaluateAiSpendUserAnomaly(rule("ai-spend-user-anomaly"), facts);
    check("only the jumping customer fires (warning)", r.signals.length === 1 && r.signals[0].severity === "warning", JSON.stringify(r.signals));
    const s = r.signals[0];
    const c0 = facts.customers.find((c) => s.dedupeKey.endsWith(c.dedupe))!;
    check("dedupe key = rule:day:opaqueDedupeToken", !!c0 && s.dedupeKey === `ai-spend-user-anomaly:2026-03-10:${c0.dedupe}`);
    check("summary names the opaque ref, never the raw id", s.summary.includes(c0.ref) && !s.summary.includes(RAW) && !s.dedupeKey.includes(RAW));
    check("summary carries the basis with ×10.0", /vs 7-day median \$[0-9.]+, ×10\.0 \(anomaly@1\)/.test(s.summary), s.summary);
    // A new customer with no history is not judged; an unpriced window makes the whole rule not evaluable.
    const newcomer = buildAiSpendAnomalyFacts([foldSpendGroups([g(RAW, heavy)]), ...Array.from({ length: 7 }, () => foldSpendGroups([g(RAW2, light)]))], new Date(CHECKED), 24);
    const nr = evaluateAiSpendUserAnomaly(rule("ai-spend-user-anomaly"), newcomer);
    check("a customer without 5 active prior windows never fires", nr.signals.length === 0 && /none of the 1 active customer/.test(nr.notEvaluable ?? ""));
    const unpricedFolds = [foldSpendGroups([g(RAW, heavy), g(RAW2, light, "no-such-model")]), ...folds.slice(1)];
    const uf = buildAiSpendAnomalyFacts(unpricedFolds, new Date(CHECKED), 24);
    check("reader: an unpriced call makes the window UNPRICED (never priced at $0)", uf.fleet.current.kind === "UNPRICED" && uf.customers.length === 0);
    check("…and the per-customer rule is not evaluable", /cannot price/.test(evaluateAiSpendUserAnomaly(rule("ai-spend-user-anomaly"), uf).notEvaluable ?? ""));
    check("reader: no invocations ⇒ IDLE", fleetWindowOf(foldSpendGroups([])).kind === "IDLE");
  }

  console.log("\n4. reader windows — window 0 is the fleet rule's window; no overlap");
  {
    const now = new Date(CHECKED);
    const asked: Array<[number, number]> = [];
    await getAiSpendAnomalyFacts({ now, groups: async (s, u) => { asked.push([s.getTime(), u.getTime()]); return []; } });
    const H = 3_600_000;
    check("8 windows read", asked.length === 8);
    check("window 0 = [now − 24 h, now] (same as getAiSpendHealth(24))", asked[0][0] === now.getTime() - 24 * H && asked[0][1] === now.getTime());
    check("each baseline window ends 1 ms before the next starts (no double count)",
      asked.slice(1).every(([, u], i) => u === asked[i][0] - 1) && asked.every(([s, u]) => u - s <= 24 * H));
  }

  console.log("\n5. Plaid calls rule");
  {
    const today = new Date(Date.UTC(2026, 2, 10));
    const day = (k: number) => new Date(today.getTime() - k * 86_400_000);
    const rows = [
      { day: day(0), count: 999 },               // today (partial) — never read
      { day: day(1), count: 400 },               // yesterday = current
      ...[2, 3, 4, 5, 6, 7, 8].map((k) => ({ day: day(k), count: BigInt(50) })),
    ];
    const f = buildPlaidCallAnomalyFacts(rows, today, new Date(CHECKED));
    check("current = the last COMPLETE UTC day; today's partial count ignored", f.dayISO === "2026-03-09" && f.current.kind === "VALUE" && (f.current as { value: number }).value === 400);
    check("baseline = the 7 days before it", f.baseline.length === 7 && f.baseline.every((w) => w.kind === "VALUE"));
    const r = evaluatePlaidCallAnomaly(rule("plaid-call-anomaly"), f);
    check("fires a WARNING: 400 vs median 50 (×8)", r.signals.length === 1 && r.signals[0].severity === "warning"
      && r.signals[0].summary.includes("day 400 calls vs 7-day median 50 calls, ×8.0 (anomaly@1)"), r.signals[0]?.summary);
    check("dedupe per day; links Plaid usage", r.signals[0].dedupeKey === "plaid-call-anomaly:2026-03-09"
      && r.signals[0].summary.includes("/dashboard/platform/PLATFORM_OPS?workspace=platform-providers"));
    const small = evaluatePlaidCallAnomaly(rule("plaid-call-anomaly"), plaidFacts(V(15), base7(3)));
    check("below the 20-call floor: 15 vs 3 (×5) does not fire", small.signals.length === 0 && small.notEvaluable === null);
    const short = evaluatePlaidCallAnomaly(rule("plaid-call-anomaly"), plaidFacts(V(400), [V(50), V(50), IDLE, IDLE, IDLE, IDLE, IDLE]));
    check("short history ⇒ not evaluable, no signal", short.signals.length === 0 && /short history: 2 of 7/.test(short.notEvaluable ?? ""));
  }

  console.log("\n6. dedupe — the existing suppress-while-open path");
  {
    const s = evaluateAiSpendAnomaly(rule("ai-spend-anomaly"), fleetFacts(V(12), base7(2))).signals;
    const now = Date.parse(CHECKED);
    check("a breach delivered 2 h ago is suppressed", decideDeliveries(s, new Map([[s[0].dedupeKey, now - 2 * 3_600_000]]), now).suppressed.length === 1);
    check("…and re-notifies after the window", decideDeliveries(s, new Map([[s[0].dedupeKey, now - (DEFAULT_RENOTIFY_HOURS + 1) * 3_600_000]]), now).toSend.length === 1);
  }

  console.log("\n7. the canonical evaluation + latest-evaluation view");
  {
    const empty: AuthorityOutputs = { jobHealth: null, connectionHealth: null, resourceFreshness: null, aiFailures: null, aiSpend: null, syncIncidents: null };
    const det = evaluateAlertRulesDetailed({ ...empty, aiSpendAnomaly: fleetFacts(UNPRICED, base7(2)), plaidCallAnomaly: plaidFacts(V(400), base7(50)) }, () => true);
    check("not-evaluable reasons are reported per rule", /unpriced/.test(det.notEvaluable.get("ai-spend-anomaly") ?? "") && det.notEvaluable.has("ai-spend-user-anomaly"));
    check("an anomaly authority that did not gather is not evaluable (not silent)", /did not gather/.test(evaluateAlertRulesDetailed(empty, () => true).notEvaluable.get("plaid-call-anomaly") ?? ""));
    check("the plaid rule still fires in the same cycle", det.signals.some((s) => s.ruleId === "plaid-call-anomaly"));

    const summary = await evaluatePlatformAlerts({
      now: new Date(CHECKED),
      gatherAuthorities: async () => ({ ...empty, aiSpendAnomaly: fleetFacts(UNPRICED, base7(2)), plaidCallAnomaly: plaidFacts(V(400), base7(50)) }),
      loadSettings: async () => new Map(),
      loadRecentRuns: async () => [],
      resolveDestination: () => "ops@example.invalid",
      sendAlertEmail: async () => ({ status: "captured" }),
      environment: "test",
      ledgerStartWriteFailed: () => false,
    });
    const latest = latestAlertEvaluation([summary]);
    const outcome = (id: string) => latest?.rules.find((r) => r.id === id);
    check("latest evaluation: the firing anomaly is firing (warning)", outcome("plaid-call-anomaly")?.firing === true && outcome("plaid-call-anomaly")?.severity === "warning"
      && firingNow(latest).some((r) => r.id === "plaid-call-anomaly"));
    check("latest evaluation: the unpriced rule shows not-evaluable with its reason, and is not firing",
      outcome("ai-spend-anomaly")?.firing === false && /anomaly@1: current window/.test(outcome("ai-spend-anomaly")?.notEvaluable ?? ""));
    check("notEvaluableNow lists it", notEvaluableNow(latest).some((r) => r.id === "ai-spend-anomaly"));
    check("a rule that judged carries no notEvaluable key", !("notEvaluable" in (outcome("plaid-call-anomaly") ?? {})) && !("notEvaluable" in (outcome("job-failing") ?? {})));
    check("the delivered breach is recorded with the basis", summary.fired.some((f) => f.ruleId === "plaid-call-anomaly" && /anomaly@1/.test(f.summary)));
  }

  console.log("\n8. pins");
  {
    const anomalyRules = ALERT_RULES.filter((r) => /anomaly$/.test(r.id));
    check("three anomaly rules, live, enabled by default", anomalyRules.length === 3 && anomalyRules.every((r) => r.live && r.defaultEnabled));
    const src = readFileSync(join(process.cwd(), "lib/alerts/evaluate.ts"), "utf8");
    const block = src.slice(src.indexOf("// ── Quota / cost anomaly"), src.indexOf("// ── THE canonical evaluation"));
    check("anomaly signals are warning only (never critical)", !/"critical"/.test(block) && (block.match(/severity: "warning"/g) ?? []).length === 3);
    check("the evaluators judge through the ONE anomaly rule", (block.match(/judgeAnomaly\(/g) ?? []).length === 3);
    const reader = readFileSync(join(process.cwd(), "lib/platform/ai/spend-anomaly.ts"), "utf8");
    check("the AI windows use THE fleet fold + grouped read", /foldSpendGroups\(await read\(start, end\)\)/.test(reader) && /readUserSpendGroups/.test(reader));
    const health = readFileSync(join(process.cwd(), "lib/platform/ai/spend-health.ts"), "utf8");
    check("the fleet health report uses the same fold", /= foldSpendGroups\(groups, rates\);/.test(health));
  }

  console.log(failures === 0 ? `\nanomaly (anomaly@1): ${passes} checks passed.` : `\n${failures} check(s) failed`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
