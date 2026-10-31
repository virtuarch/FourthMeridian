/**
 * lib/entitlements/lifecycle.test.ts  (BETA LIFECYCLE L1 — the pure core, pinned)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/entitlements/lifecycle.test.ts
 *
 * Proves:
 *   1. READ_ONLY_VALUES — explicit, frozen, within ceilings; reads preserved
 *      (dailyBrief read gate on, one export), everything billable off/0/max;
 *   2. the resolver precedence matrix — ACTIVE (unchanged), PAUSED, ENDED,
 *      FREEZE on ACTIVE and on PAUSED, FREEZE+ENDED; Founder overlay and the
 *      per-customer AI override can never lift a restriction; fail closed beats
 *      the lifecycle; an unassigned customer follows the DEFAULT group's state;
 *   3. the billable decision — the same matrix, plus POLICY_UNAVAILABLE for a
 *      null / stale (>30 s) / last-good / code-fallback / lifecycle-unavailable
 *      catalogue, NO_OWNER, NOT_ENTITLED, and export (data access) never
 *      refused for lifecycle, freeze or an unreadable policy;
 *   4. the transition table — every valid move, every refused move, reopen needs a note;
 *   5. Space ownership — exactly one ACTIVE OWNER bills, else none;
 *   6. getBetaLifecycleState's pure core — ACTIVE / PAUSED / ENDED / UNKNOWN.
 */

import {
  BETA_FULL_ACCESS_V1, DEFAULT_POLICY_GROUP, DIMENSION_KEYS, ENTITLEMENT_DIMENSIONS, FAIL_CLOSED_VALUES, FOUNDER_INTERNAL_V1,
} from "./catalogue";
import {
  BILLABLE_DIMENSIONS, READ_ONLY_VALUES, lifecycleRestrictionOf, planLifecycleTransition,
  type LifecycleAction, type LifecycleState, type PolicyGroupLifecycleState,
} from "./lifecycle";
import { buildPolicyGroupCatalogue, codeFallbackCatalogue, CODE_CATALOGUE, type PolicyGroupCatalogue, type PolicyGroupLifecycleFacts } from "./policy-groups";
import { resolveEffectiveEntitlements, type AssignmentFacts } from "./resolve";
import {
  BILLABLE_OPERATIONS, OPERATION_CLASS, billedOwnerOf, decideBillable, isCatalogueFreshForBillable,
  type BillableOperation,
} from "./billable-gate-core";
import { betaLifecycleStateOf } from "./beta-lifecycle";
import { countLimit, refuseIfBillableRestricted, refuseIfDisabled, refuseIfFailClosed } from "./consume";
import { RESTRICTION_CODES, restrictionMessage, restrictionStatus } from "./restriction-messages";
import { isManualRefreshEntitled } from "@/lib/refresh/refresh-all";
import { describeRefreshOutcomes } from "@/lib/refresh/outcomes";
import { isKnownRefusalSentence, planUnavailableSentence } from "@/lib/ai/conversation/refusal-sentences";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

const NOW = new Date("2026-10-31T12:00:00.000Z");
const NOW_MS = NOW.getTime();
const BETA = BETA_FULL_ACCESS_V1.values;
const PRO = { ...BETA, exportsPerDay: 5, aiDailyUsdAllowance: 10 };

function catalogue(beta: Partial<PolicyGroupLifecycleFacts>, pro: Partial<PolicyGroupLifecycleFacts> = {}, at: Date = NOW): PolicyGroupCatalogue {
  const row = (key: string, isDefault: boolean) => ({ key, label: key, description: "", isDefault, builtIn: key === DEFAULT_POLICY_GROUP, archivedAt: null, currentVersion: 1 });
  const ver = (groupKey: string, values: unknown) => ({ groupKey, version: 1, values, createdAt: at });
  const life = (key: string, p: Partial<PolicyGroupLifecycleFacts>): PolicyGroupLifecycleFacts =>
    ({ key, lifecycle: "ACTIVE", costFrozen: false, endedTransition: null, lifecycleVersion: 0, ...p });
  return buildPolicyGroupCatalogue(
    [row(DEFAULT_POLICY_GROUP, true), row("PRO_V1", false)],
    [ver(DEFAULT_POLICY_GROUP, BETA), ver("PRO_V1", PRO)],
    at,
    [life(DEFAULT_POLICY_GROUP, beta), life("PRO_V1", pro)],
  );
}
const assigned = (policyGroup: string, overlay: string | null = null, override: number | null = null): AssignmentFacts =>
  ({ policyGroup, overlay, assignedAt: NOW, assignedById: null, aiDailyUsdAllowanceOverride: override });
const resolve = (c: PolicyGroupCatalogue, f: AssignmentFacts | null, failClosed = false) =>
  resolveEffectiveEntitlements(f, { aiDailyUsdAllowanceUsd: 15 }, { catalogue: c, failClosed });
const decide = (operation: BillableOperation, c: PolicyGroupCatalogue | null, f: AssignmentFacts | null, opts: { user?: string | null; failClosed?: boolean; now?: number } = {}) =>
  decideBillable({ operation, billedUserId: opts.user === undefined ? "u1" : opts.user, assignment: f, catalogue: c, failClosed: opts.failClosed ?? false, nowMs: opts.now ?? NOW_MS });
const reason = (d: ReturnType<typeof decideBillable>) => (d.allowed ? "ALLOWED" : d.reason);

async function main(): Promise<void> {
console.log("1. READ_ONLY_VALUES");
{
  check("frozen", Object.isFrozen(READ_ONLY_VALUES));
  check("covers every dimension", DIMENSION_KEYS.every((k) => k in READ_ONLY_VALUES));
  check("conversations off, every AI count and the allowance 0, no manual wallet sync, no new connection",
    READ_ONLY_VALUES.conversations === false && READ_ONLY_VALUES.aiTurnsPerMinute === 0 && READ_ONLY_VALUES.aiTurnsPerHour === 0
      && READ_ONLY_VALUES.aiDailyUsdAllowance === 0 && READ_ONLY_VALUES.manualWalletRefreshPerHour === 0 && READ_ONLY_VALUES.maxConnections === 0);
  check("bank refresh cooldown at the editor maximum (7 days)", READ_ONLY_VALUES.manualBankRefreshCooldownMinutes === 10_080);
  check("reads preserved: the Daily Brief READ gate stays on and one export per day remains", READ_ONLY_VALUES.dailyBrief === true && READ_ONLY_VALUES.exportsPerDay === 1);
  check("every value is within the platform ceiling", DIMENSION_KEYS.every((k) => {
    const d = ENTITLEMENT_DIMENSIONS[k]; const v = READ_ONLY_VALUES[k];
    return d.kind === "boolean" ? (!v || (d.ceiling as boolean)) : d.kind === "count" ? Number(v) <= (d.ceiling as number) : Number(v) >= (d.ceiling as number);
  }));
  check("today it equals FAIL_CLOSED_VALUES (both are 'safe read-only'), declared separately", JSON.stringify(READ_ONLY_VALUES) === JSON.stringify(FAIL_CLOSED_VALUES) && READ_ONLY_VALUES !== FAIL_CLOSED_VALUES);
  check("exportsPerDay is the only non-billable dimension", DIMENSION_KEYS.filter((k) => !BILLABLE_DIMENSIONS.has(k)).join() === "exportsPerDay");
}

console.log("2. resolver precedence matrix");
{
  const active = resolve(catalogue({}), assigned(DEFAULT_POLICY_GROUP));
  const beforeLifecycle = resolveEffectiveEntitlements(assigned(DEFAULT_POLICY_GROUP), { aiDailyUsdAllowanceUsd: 15 }, { catalogue: buildPolicyGroupCatalogue(
    [{ key: DEFAULT_POLICY_GROUP, label: DEFAULT_POLICY_GROUP, description: "", isDefault: true, builtIn: true, archivedAt: null, currentVersion: 1 }],
    [{ groupKey: DEFAULT_POLICY_GROUP, version: 1, values: BETA, createdAt: NOW }], NOW) });
  check("ACTIVE: no restriction, values exactly as before the lifecycle existed",
    active.lifecycleRestriction === null && active.lifecycle === "ACTIVE" && active.costFrozen === false
      && JSON.stringify(active.dimensions) === JSON.stringify(beforeLifecycle.dimensions));

  const paused = resolve(catalogue({ lifecycle: "PAUSED" }), assigned(DEFAULT_POLICY_GROUP));
  check("PAUSED: restriction BETA_PAUSED; billable dimensions READ_ONLY with source LIFECYCLE",
    paused.lifecycleRestriction === "BETA_PAUSED" && [...BILLABLE_DIMENSIONS].every((k) => paused.dimensions[k].value === READ_ONLY_VALUES[k] && paused.dimensions[k].source === "LIFECYCLE"));
  check("PAUSED: exports keep the plan's value (data access is not suspended)", paused.dimensions.exportsPerDay.value === BETA.exportsPerDay && paused.dimensions.exportsPerDay.source === "POLICY");
  check("PAUSED: countLimit honours the deliberate 0 (no new connection, no AI turns)", countLimit(paused, "maxConnections") === 0 && countLimit(paused, "aiTurnsPerHour") === 0);
  check("ACTIVE: countLimit unchanged (never below 1)", countLimit(active, "maxConnections") === BETA.maxConnections);

  const ended = resolve(catalogue({ lifecycle: "ENDED", endedTransition: "READ_ONLY" }), assigned(DEFAULT_POLICY_GROUP));
  check("ENDED: restriction BETA_ENDED; EVERY dimension READ_ONLY (the group grants nothing)",
    ended.lifecycleRestriction === "BETA_ENDED" && DIMENSION_KEYS.every((k) => ended.dimensions[k].value === READ_ONLY_VALUES[k] && ended.dimensions[k].source === "LIFECYCLE"));
  const endedFree = resolve(catalogue({ lifecycle: "ENDED", endedTransition: "FREE" }), assigned(DEFAULT_POLICY_GROUP));
  check("ENDED with FREE (reserved, no Free group yet) still resolves READ_ONLY", DIMENSION_KEYS.every((k) => endedFree.dimensions[k].value === READ_ONLY_VALUES[k]));

  const frozen = resolve(catalogue({ costFrozen: true }), assigned(DEFAULT_POLICY_GROUP));
  check("FREEZE on ACTIVE: restriction COST_FREEZE; billable dimensions READ_ONLY; lifecycle still ACTIVE",
    frozen.lifecycleRestriction === "COST_FREEZE" && frozen.lifecycle === "ACTIVE" && [...BILLABLE_DIMENSIONS].every((k) => frozen.dimensions[k].value === READ_ONLY_VALUES[k]));
  const frozenPaused = resolve(catalogue({ costFrozen: true, lifecycle: "PAUSED" }), assigned(DEFAULT_POLICY_GROUP));
  check("FREEZE on PAUSED: COST_FREEZE wins the reported restriction", frozenPaused.lifecycleRestriction === "COST_FREEZE" && frozenPaused.lifecycle === "PAUSED");
  const frozenEnded = resolve(catalogue({ costFrozen: true, lifecycle: "ENDED" }), assigned(DEFAULT_POLICY_GROUP));
  check("FREEZE on ENDED: COST_FREEZE reported, but the values are ENDED's (every dimension READ_ONLY)",
    frozenEnded.lifecycleRestriction === "COST_FREEZE" && DIMENSION_KEYS.every((k) => frozenEnded.dimensions[k].value === READ_ONLY_VALUES[k]));

  for (const [label, c] of [["PAUSED", catalogue({ lifecycle: "PAUSED" })], ["ENDED", catalogue({ lifecycle: "ENDED" })], ["FREEZE", catalogue({ costFrozen: true })]] as const) {
    const founder = resolve(c, assigned(DEFAULT_POLICY_GROUP, FOUNDER_INTERNAL_V1.key, 20));
    check(`${label}: the Founder overlay AND a $20 per-customer AI override lift nothing billable`,
      founder.dimensions.aiDailyUsdAllowance.value === 0 && founder.dimensions.aiTurnsPerMinute.value === 0 && founder.dimensions.maxConnections.value === 0
        && founder.dimensions.aiDailyUsdAllowance.source === "LIFECYCLE" && founder.dimensions.aiDailyUsdAllowance.overrideValue === 20,
      founder.dimensions.aiDailyUsdAllowance);
  }
  const founderActive = resolve(catalogue({}), assigned(DEFAULT_POLICY_GROUP, FOUNDER_INTERNAL_V1.key, 20));
  check("…while on ACTIVE the override still applies (unchanged)", founderActive.dimensions.aiDailyUsdAllowance.value === 20 && founderActive.dimensions.aiDailyUsdAllowance.source === "USER_OVERRIDE");

  const other = resolve(catalogue({ lifecycle: "PAUSED", costFrozen: true }), assigned("PRO_V1"));
  check("a PAUSED/FROZEN Beta never touches another group's members", other.lifecycleRestriction === null && other.dimensions.exportsPerDay.value === 5
    && other.dimensions.aiDailyUsdAllowance.value === 15 && other.dimensions.aiDailyUsdAllowance.source === "PLATFORM_SETTING", other.dimensions.aiDailyUsdAllowance);

  const unassigned = resolve(catalogue({ lifecycle: "PAUSED" }), null);
  check("unassigned (switch off): resolves to the DEFAULT group and follows its lifecycle", unassigned.policyGroup === DEFAULT_POLICY_GROUP && unassigned.lifecycleRestriction === "BETA_PAUSED");
  const unassignedEnforced = resolve(catalogue({ lifecycle: "PAUSED" }), null, true);
  check("unassigned (switch on): FAIL CLOSED first — no group in force, no lifecycle", unassignedEnforced.failClosed && unassignedEnforced.lifecycleRestriction === null && unassignedEnforced.lifecycle === null);
  const code = resolveEffectiveEntitlements(assigned(DEFAULT_POLICY_GROUP), undefined, { catalogue: CODE_CATALOGUE });
  check("the code catalogue resolves ACTIVE (no lifecycle facts)", code.lifecycleRestriction === null && code.lifecycle === "ACTIVE");
  check("lifecycleRestrictionOf precedence: freeze > ended > paused > none",
    lifecycleRestrictionOf({ lifecycle: "ENDED", costFrozen: true }) === "COST_FREEZE" && lifecycleRestrictionOf({ lifecycle: "ENDED", costFrozen: false }) === "BETA_ENDED"
      && lifecycleRestrictionOf({ lifecycle: "PAUSED", costFrozen: false }) === "BETA_PAUSED" && lifecycleRestrictionOf({ lifecycle: "ACTIVE", costFrozen: false }) === null);
}

console.log("3. the billable decision");
{
  const metered = BILLABLE_OPERATIONS.filter((o) => OPERATION_CLASS[o] === "METERED");
  check("every operation but export is METERED", metered.length === BILLABLE_OPERATIONS.length - 1 && OPERATION_CLASS.export === "DATA_ACCESS");
  const B = assigned(DEFAULT_POLICY_GROUP);
  const F = assigned(DEFAULT_POLICY_GROUP, FOUNDER_INTERNAL_V1.key, 20);
  const matrix: [string, PolicyGroupCatalogue, string][] = [
    ["ACTIVE", catalogue({}), "ALLOWED"],
    ["PAUSED", catalogue({ lifecycle: "PAUSED" }), "BETA_PAUSED"],
    ["ENDED", catalogue({ lifecycle: "ENDED" }), "BETA_ENDED"],
    ["FREEZE on ACTIVE", catalogue({ costFrozen: true }), "COST_FREEZE"],
    ["FREEZE on PAUSED", catalogue({ costFrozen: true, lifecycle: "PAUSED" }), "COST_FREEZE"],
    ["FREEZE on ENDED", catalogue({ costFrozen: true, lifecycle: "ENDED" }), "COST_FREEZE"],
  ];
  for (const [label, c, want] of matrix) {
    const got = metered.map((o) => reason(decide(o, c, B)));
    check(`${label}: every metered operation → ${want}`, got.every((g) => g === want), got);
    const gotF = metered.map((o) => reason(decide(o, c, F)));
    check(`${label}: the same for a Founder with a $20 AI override`, gotF.every((g) => g === want), gotF);
    check(`${label}: export (data access) stays allowed`, reason(decide("export", c, B)) === "ALLOWED");
  }
  check("a member of another group is unaffected by Beta's freeze", reason(decide("ai_chat", catalogue({ costFrozen: true }), assigned("PRO_V1"))) === "ALLOWED");
  check("unassigned, switch off: follows the default group (PAUSED ⇒ BETA_PAUSED)", reason(decide("plaid_sync", catalogue({ lifecycle: "PAUSED" }), null)) === "BETA_PAUSED");
  check("unassigned, switch on: NOT_ENTITLED (fail closed beats lifecycle)", reason(decide("plaid_sync", catalogue({ lifecycle: "PAUSED" }), null, { failClosed: true })) === "NOT_ENTITLED");
  check("unknown group: NOT_ENTITLED under the switch", reason(decide("ai_chat", catalogue({}), assigned("GONE_V1"), { failClosed: true })) === "NOT_ENTITLED");

  // Fail closed when the policy cannot be read fresh.
  const fresh = catalogue({});
  check("a fresh DB catalogue (≤ 30 s) is usable", isCatalogueFreshForBillable(fresh, NOW_MS + 30_000));
  const unavailable: [string, PolicyGroupCatalogue | null, number][] = [
    ["no catalogue (read failed)", null, NOW_MS],
    ["older than 30 s", fresh, NOW_MS + 30_001],
    ["the last-good copy", { ...fresh, servedFromLastGood: true }, NOW_MS],
    ["the code fallback", codeFallbackCatalogue(), NOW_MS],
    ["the code catalogue (no lifecycle facts)", CODE_CATALOGUE, NOW_MS],
    ["lifecycle facts unavailable", buildPolicyGroupCatalogue([], [], NOW, null), NOW_MS],
    ["values read without lifecycle facts", buildPolicyGroupCatalogue([], [], NOW), NOW_MS],
  ];
  for (const [label, c, now] of unavailable) {
    const got = metered.map((o) => reason(decide(o, c, B, { now })));
    check(`POLICY_UNAVAILABLE — ${label} (every metered operation)`, got.every((g) => g === "POLICY_UNAVAILABLE"), got);
    check(`…and export (a read) stays allowed — ${label}`, reason(decide("export", c, B, { now })) === "ALLOWED");
  }
  check("NO_OWNER: no customer to bill ⇒ metered refused", reason(decide("price_history", fresh, null, { user: null })) === "NO_OWNER");
  check("NO_OWNER does not apply to export", reason(decide("export", fresh, null, { user: null })) === "ALLOWED");
  check("NO_OWNER is decided before POLICY_UNAVAILABLE", reason(decide("wallet_sync", null, null, { user: null })) === "NO_OWNER");

  // NOT_ENTITLED by the operation's own entitlement.
  const off = buildPolicyGroupCatalogue(
    [{ key: DEFAULT_POLICY_GROUP, label: "B", description: "", isDefault: true, builtIn: true, archivedAt: null, currentVersion: 1 }],
    [{ groupKey: DEFAULT_POLICY_GROUP, version: 1, values: { ...BETA, conversations: false, dailyBrief: false, maxConnections: 0, exportsPerDay: 0 }, createdAt: NOW }],
    NOW, [{ key: DEFAULT_POLICY_GROUP, lifecycle: "ACTIVE", costFrozen: false, endedTransition: null, lifecycleVersion: 0 }]);
  check("Conversations off ⇒ ai_chat NOT_ENTITLED", reason(decide("ai_chat", off, B)) === "NOT_ENTITLED");
  check("Daily Brief off ⇒ daily_brief NOT_ENTITLED", reason(decide("daily_brief", off, B)) === "NOT_ENTITLED");
  check("0 connections ⇒ plaid_link and wallet_capture NOT_ENTITLED; syncs of existing connections allowed",
    reason(decide("plaid_link", off, B)) === "NOT_ENTITLED" && reason(decide("wallet_capture", off, B)) === "NOT_ENTITLED"
      && reason(decide("plaid_sync", off, B)) === "ALLOWED" && reason(decide("wallet_sync", off, B)) === "ALLOWED");
  check("0 exports ⇒ export NOT_ENTITLED", reason(decide("export", off, B)) === "NOT_ENTITLED");
}

console.log("4. the transition table");
{
  const S = (lifecycle: PolicyGroupLifecycleState, costFrozen = false): LifecycleState => ({ lifecycle, costFrozen, endedTransition: lifecycle === "ENDED" ? "READ_ONLY" : null });
  const ok = (from: LifecycleState, a: LifecycleAction, note = false) => planLifecycleTransition(from, a, note);
  const p1 = ok(S("ACTIVE"), "pause");
  check("pause: ACTIVE → PAUSED", p1.ok && p1.kind === "PAUSE" && p1.to.lifecycle === "PAUSED");
  check("pause refused when PAUSED or ENDED", !ok(S("PAUSED"), "pause").ok && !ok(S("ENDED"), "pause").ok);
  const r1 = ok(S("PAUSED"), "resume");
  check("resume: PAUSED → ACTIVE (no note needed)", r1.ok && r1.kind === "RESUME" && r1.to.lifecycle === "ACTIVE");
  check("resume refused when ACTIVE", !ok(S("ACTIVE"), "resume").ok);
  const r2 = ok(S("ENDED"), "resume");
  check("resume from ENDED (reopen) WITHOUT a note is refused (needsNote)", !r2.ok && r2.needsNote === true);
  const r3 = ok(S("ENDED"), "resume", true);
  check("resume from ENDED WITH a note: ENDED → ACTIVE, endedTransition cleared", r3.ok && r3.to.lifecycle === "ACTIVE" && r3.to.endedTransition === null);
  const e1 = ok(S("ACTIVE"), "end"), e2 = ok(S("PAUSED"), "end");
  check("end: ACTIVE or PAUSED → ENDED with endedTransition READ_ONLY",
    e1.ok && e2.ok && e1.to.lifecycle === "ENDED" && e1.to.endedTransition === "READ_ONLY" && e2.to.lifecycle === "ENDED");
  check("end refused when ENDED", !ok(S("ENDED"), "end").ok);
  for (const l of ["ACTIVE", "PAUSED", "ENDED"] as const) {
    const f = ok(S(l), "freeze"), u = ok(S(l, true), "unfreeze");
    check(`freeze / unfreeze on ${l} change only the freeze`, f.ok && f.to.costFrozen && f.to.lifecycle === l && u.ok && !u.to.costFrozen && u.to.lifecycle === l);
    check(`freeze refused when frozen, unfreeze refused when not (${l})`, !ok(S(l, true), "freeze").ok && !ok(S(l), "unfreeze").ok);
  }
  const pf = ok(S("ACTIVE", true), "pause");
  check("a lifecycle move never changes the freeze", pf.ok && pf.to.costFrozen === true);
}

console.log("5. Space ownership");
{
  check("exactly one ACTIVE OWNER bills", billedOwnerOf(["u1"]) === "u1" && billedOwnerOf(["u1", "u1"]) === "u1");
  check("none ⇒ null (NO_OWNER)", billedOwnerOf([]) === null);
  check("several ⇒ null (ambiguous ⇒ NO_OWNER, never a guess)", billedOwnerOf(["u1", "u2"]) === null);
}

console.log("6. getBetaLifecycleState (pure core)");
{
  check("ACTIVE", betaLifecycleStateOf(catalogue({}), NOW_MS) === "ACTIVE");
  check("PAUSED", betaLifecycleStateOf(catalogue({ lifecycle: "PAUSED" }), NOW_MS) === "PAUSED");
  check("ENDED", betaLifecycleStateOf(catalogue({ lifecycle: "ENDED" }), NOW_MS) === "ENDED");
  check("frozen does not change the lifecycle answer", betaLifecycleStateOf(catalogue({ costFrozen: true }), NOW_MS) === "ACTIVE");
  check("UNKNOWN: unreadable (null)", betaLifecycleStateOf(null, NOW_MS) === "UNKNOWN");
  check("UNKNOWN: stale (> 30 s)", betaLifecycleStateOf(catalogue({}), NOW_MS + 30_001) === "UNKNOWN");
  check("UNKNOWN: the last-good copy", betaLifecycleStateOf({ ...catalogue({}), servedFromLastGood: true }, NOW_MS) === "UNKNOWN");
  check("UNKNOWN: the code fallback / code catalogue", betaLifecycleStateOf(codeFallbackCatalogue(), NOW_MS) === "UNKNOWN" && betaLifecycleStateOf(CODE_CATALOGUE, NOW_MS) === "UNKNOWN");
  check("UNKNOWN: lifecycle facts unavailable", betaLifecycleStateOf(buildPolicyGroupCatalogue([], [], NOW, null), NOW_MS) === "UNKNOWN");
  check("UNKNOWN: no Beta ROW (only the code group)", betaLifecycleStateOf(buildPolicyGroupCatalogue([], [], NOW, []), NOW_MS) === "UNKNOWN");
}

console.log("7. POLICY_UNAVAILABLE — an unreadable lifecycle denies new billable work on every resolver-driven route");
{
  const B = assigned(DEFAULT_POLICY_GROUP, FOUNDER_INTERNAL_V1.key, 20);
  const cases: [string, PolicyGroupCatalogue][] = [
    ["the lifecycle read THREW (lifecycleSource UNAVAILABLE)", buildPolicyGroupCatalogue(
      [{ key: DEFAULT_POLICY_GROUP, label: "B", description: "", isDefault: true, builtIn: true, archivedAt: null, currentVersion: 1 }],
      [{ groupKey: DEFAULT_POLICY_GROUP, version: 1, values: BETA, createdAt: NOW }], NOW, null)],
    ["the served LAST-GOOD copy", { ...catalogue({}), servedFromLastGood: true }],
    ["the code FALLBACK", codeFallbackCatalogue()],
  ];
  for (const [label, c] of cases) {
    const e = resolve(c, B);
    check(`${label}: restriction POLICY_UNAVAILABLE; billable dimensions READ_ONLY even for a Founder with a $20 override`,
      e.lifecycleRestriction === "POLICY_UNAVAILABLE" && [...BILLABLE_DIMENSIONS].every((k) => e.dimensions[k].value === READ_ONLY_VALUES[k] && e.dimensions[k].source === "LIFECYCLE"), e.lifecycleRestriction);
    check(`${label}: READ dimensions keep their values (Brief reading on, exports per the plan + overlay)`,
      e.dimensions.dailyBrief.value === true && e.dimensions.exportsPerDay.value === FOUNDER_INTERNAL_V1.values.exportsPerDay);
    const refusal = refuseIfFailClosed(e, "Manual refresh");
    check(`${label}: the route seam refuses new paid work — 503 with the owner's wording`,
      refusal !== null && refusal.status === 503);
    check(`${label}: manual refresh (refresh-all, operator refresh) is not entitled`, !isManualRefreshEntitled(e));
  }
  const live = resolve(catalogue({}), B);
  check("a fresh DB read with lifecycle facts: no restriction, the seam lets paid work through", live.lifecycleRestriction === null && refuseIfFailClosed(live, "x") === null && isManualRefreshEntitled(live));
  const code0 = resolveEffectiveEntitlements(B, undefined, {});
  check("the code catalogue BY CONSTRUCTION (pure callers, previews) is not 'unavailable'", code0.lifecycleRestriction === null);
}

console.log("8. the one wording, through every seam");
{
  for (const kind of ["BETA_PAUSED", "BETA_ENDED", "COST_FREEZE", "POLICY_UNAVAILABLE"] as const) {
    const c = kind === "POLICY_UNAVAILABLE" ? { ...catalogue({}), servedFromLastGood: true }
      : catalogue(kind === "COST_FREEZE" ? { costFrozen: true } : { lifecycle: kind === "BETA_PAUSED" ? "PAUSED" : "ENDED" });
    const e = resolve(c, assigned(DEFAULT_POLICY_GROUP));
    const r1 = refuseIfFailClosed(e, "Manual refresh")!;
    const b1 = await r1.json() as { error: string; code: string; restriction: string };
    check(`${kind}: refuseIfFailClosed → "${restrictionMessage(kind)}" (${RESTRICTION_CODES[kind]}, ${restrictionStatus(kind)})`,
      b1.error === restrictionMessage(kind) && b1.code === RESTRICTION_CODES[kind] && b1.restriction === kind && r1.status === restrictionStatus(kind));
    const r2 = refuseIfDisabled(e, "conversations", "Conversations")!;
    const b2 = await r2.json() as { error: string };
    check(`${kind}: refuseIfDisabled(conversations) says the same, never "not on your plan"`, b2.error === restrictionMessage(kind) && !b2.error.includes("plan."));
    check(`${kind}: Conversations' recogniser knows the sentence (never fed back to the model)`, isKnownRefusalSentence(restrictionMessage(kind)));
    check(`${kind}: refuseIfBillableRestricted is the same seam`, refuseIfBillableRestricted === refuseIfFailClosed);
    const banner = describeRefreshOutcomes([{ decision: "REFUSED", reason: "PLAN_RESTRICTED", restriction: kind }]);
    check(`${kind}: the refresh banner uses the same words`, banner.includes(restrictionMessage(kind).replace(/\.$/, "")), banner);
  }
  const off = resolveEffectiveEntitlements(assigned(DEFAULT_POLICY_GROUP), undefined, { catalogue: buildPolicyGroupCatalogue(
    [{ key: DEFAULT_POLICY_GROUP, label: "B", description: "", isDefault: true, builtIn: true, archivedAt: null, currentVersion: 1 }],
    [{ groupKey: DEFAULT_POLICY_GROUP, version: 1, values: { ...BETA, conversations: false }, createdAt: NOW }], NOW,
    [{ key: DEFAULT_POLICY_GROUP, lifecycle: "ACTIVE", costFrozen: false, endedTransition: null, lifecycleVersion: 0 }]) });
  const r3 = await refuseIfDisabled(off, "conversations", "Conversations")!.json() as { error: string };
  check("a plan that simply excludes a feature still says \"not on your plan\" (no lifecycle involved)", r3.error === planUnavailableSentence("Conversations"));
}

if (failures > 0) { console.error(`\nlifecycle: ${failures} check(s) failed.`); process.exit(1); }
console.log("\nlifecycle: all checks passed.");
}
main().catch((e) => { console.error(e); process.exit(1); });
