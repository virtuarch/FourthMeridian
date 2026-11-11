/**
 * lib/platform/incidents/incident-lifecycle-view.test.ts  (Incident detail — Lifecycle section, owner item 6)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/incidents/incident-lifecycle-view.test.ts
 *
 *   1. milestones per state: active, acknowledged (time + "by an operator",
 *      never who), recovering, stale-unverified (as of checkedAt), resolved,
 *      archived — read from the DTO, no verdict re-derived;
 *   2. closure kinds: recovered (verified, with evidence counts) vs operator
 *      fixed vs operator DISMISSED vs connection removed vs legacy — only the
 *      first is a verified recovery (Dismiss ≠ resolved);
 *   3. recurrence: generation N, previous / next episode links (opens in the
 *      drawer), a pruned neighbour is "No longer retained";
 *   4. events summarised by code: counts per type, key events worded from the
 *      registries, an unregistered code is never echoed;
 *   5. NO FREE TEXT: sentinels planted in `detail`, the provider message,
 *      resolution evidence, operator ids and an extra event field never reach
 *      the view-model or the rendered drawer — end to end through
 *      `investigate` → DTO → view → markup, on BOTH tiers;
 *   6. identity tier: no operator identity on either tier; the Lifecycle
 *      section carries no customer id even on the CS tier.
 *
 * Synthetic data; institution "Example Bank".
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UserRole } from "@prisma/client";
import { createIncidentAccessors, type IncidentFactsReader } from "./intelligence/index";
import { incidentAudienceFor, type CsToken, type OpsToken } from "./intelligence/audience";
import { incidentDetailDTO, type IncidentDetailDTO, type IncidentRowDTO } from "./investigation-dto";
import type { IncidentTimelineEvent } from "./intelligence/types";
import { IncidentDetailSurface } from "@/components/platform/incidents/IncidentsLead";
import {
  DISMISSED_HEADLINE, LEGACY_HEADLINE, OPERATOR_CLOSED_HEADLINE, OPERATOR_FIXED_HEADLINE, STALE_NOTE, SUBJECT_REMOVED_HEADLINE, VERIFIED_RECOVERY_HEADLINE,
  incidentLifecycleView, type LifecycleView,
} from "@/components/platform/incidents/lifecycle-model";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}

const NOW = new Date("2026-11-08T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const SENTINEL = "SENTINEL_FREE_TEXT_LC_9b2e";
const OPERATOR_ID = "u_operator_SENTINEL_LC_0001";

// ── fixture: an ACKNOWLEDGED second episode of a dismissed first one ──
const ITEM = { id: "item_lc", status: "ERROR", errorCode: "NO_ACCOUNTS", errorMessage: `${SENTINEL} provider message`, userId: "u_owner_00000000099", institutionName: "Example Bank" };
const KEY = "v1::PLAID::item:item_lc::transactions::plaid-item-error";
const BASE_ROW = {
  kind: "UPSERT_ERROR", provider: "PLAID", plaidItemId: ITEM.id, financialAccountId: null, plaidTransactionId: null,
  incidentKey: KEY, subjectUserId: ITEM.userId, causeStatus: null, causeCode: null, archivedAt: null, recoveringSince: null,
  acknowledgedById: OPERATOR_ID, resolvedById: OPERATOR_ID, resolutionNote: SENTINEL,
};
const PRIOR = {
  ...BASE_ROW, id: "inc_lc_prior",
  detail: { stage: "plaid-item-error", errorCode: "NO_ACCOUNTS", message: `${SENTINEL} prior detail` },
  resolved: true, previousIncidentId: null,
  createdAt: hoursAgo(200), firstOccurredAt: hoursAgo(200), lastOccurredAt: hoursAgo(150), resolvedAt: hoursAgo(120),
  resolutionKind: "OPERATOR_RESOLVED", resolutionReasonCode: "OPERATOR_NOT_ACTIONABLE",
  lifecycleState: "RESOLVED", acknowledgedAt: null,
  resolutionEvidence: { note: SENTINEL, operatorNote: SENTINEL }, _count: { occurrences: 2 },
};
const INCIDENT = {
  ...BASE_ROW, id: "inc_lc",
  detail: { stage: "plaid-item-error", errorCode: "NO_ACCOUNTS", message: `${SENTINEL} detail message`, errorMessage: SENTINEL, displayMessage: SENTINEL },
  resolved: false, previousIncidentId: PRIOR.id,
  createdAt: hoursAgo(30), firstOccurredAt: hoursAgo(30), lastOccurredAt: hoursAgo(2), resolvedAt: null, resolutionKind: null, resolutionReasonCode: null,
  lifecycleState: "ACKNOWLEDGED", acknowledgedAt: hoursAgo(20),
  resolutionEvidence: null, _count: { occurrences: 4 },
};
const ev = (id: string, h: number, o: Record<string, unknown>) => ({
  id, incidentId: INCIDENT.id, at: hoursAgo(h), type: "STATE_CHANGED", actorKind: "SYSTEM", actorId: null, auditId: null,
  fromState: null, toState: null, causeCode: null, actionCode: null, outcomeCode: null, refEventId: null, refreshExecutionId: null, jobRunId: null,
  note: SENTINEL, ...o,
});
const EVENTS = [
  ev("e1", 30, { type: "OBSERVED", toState: "ACTIVE" }),
  ev("e2", 20, { actorKind: "OPERATOR", actorId: OPERATOR_ID, auditId: "audit_1", fromState: "ACTIVE", toState: "ACKNOWLEDGED", actionCode: "ACKNOWLEDGE" }),
];
const rowsFor = (where: Record<string, unknown> | undefined) => {
  if (where && "id" in where && typeof where.id === "string") return [INCIDENT, PRIOR].filter((r) => r.id === where.id);
  if (where && "OR" in where) return [INCIDENT, PRIOR];
  return [];
};
const client: IncidentFactsReader = {
  syncIssue: { findMany: (async (a: { where?: Record<string, unknown> }) => rowsFor(a.where)) as never },
  syncIssueOccurrence: { findMany: (async () => []) as never, groupBy: (async () => []) as never },
  syncIssueArchive: { findMany: (async () => []) as never },
  syncIssueRelation: { findMany: (async () => []) as never },
  syncIssueEvent: { findMany: (async (a: { where?: { incidentId?: string } }) => EVENTS.filter((e) => e.incidentId === a.where?.incidentId).sort((x, y) => y.at.getTime() - x.at.getTime())) as never },
  financialAccount: { findMany: (async () => []) as never },
  plaidItem: { findMany: (async () => [ITEM]) as never },
  latestAttempts: (async () => []) as never,
  recentAttempts: (async () => []) as never,
};
const acc = createIncidentAccessors(client);
const ops = incidentAudienceFor({ user: { role: UserRole.USER }, grant: { area: "PLATFORM_OPS", level: "READ" } as never }) as OpsToken;
const cs = incidentAudienceFor({ user: { role: UserRole.USER }, grant: { area: "CUSTOMER_SUCCESS", level: "READ" } as never }) as CsToken;

function variant(base: IncidentDetailDTO, o: Partial<Omit<IncidentDetailDTO, "incident" | "summary">> & { incident?: Partial<IncidentRowDTO>; summary?: Partial<IncidentDetailDTO["summary"]> } = {}): IncidentDetailDTO {
  return { ...base, ...o, incident: { ...base.incident, ...o.incident }, summary: { ...base.summary, ...o.summary } };
}
const E = (at: number, o: Partial<IncidentTimelineEvent>): IncidentTimelineEvent => ({
  id: `x${at}`, at: hoursAgo(at).toISOString(), type: "STATE_CHANGED", actorKind: "SYSTEM", audited: false,
  fromState: null, toState: null, causeCode: null, actionCode: null, outcomeCode: null, refEventId: null, refreshExecutionId: null, jobRunId: null, ...o,
});
const keys = (v: LifecycleView) => v.milestones.map((m) => m.key);
const ms = (v: LifecycleView, k: string) => v.milestones.find((m) => m.key === k);
/** The Lifecycle section's markup only. */
function lifecycleHtml(html: string): string {
  const i = html.indexOf(">Lifecycle</h3>");
  return i < 0 ? "" : html.slice(i, html.indexOf("</section>", i));
}
const render = (d: IncidentDetailDTO) => renderToStaticMarkup(createElement(IncidentDetailSurface, { d, canWrite: true, onSelect: () => {}, onRecover: () => {}, onLifecycle: () => {} }));

async function main(): Promise<void> {
  const inv = await acc.investigate(ops, INCIDENT.id, { now: NOW });
  const csInv = await acc.investigate(cs, INCIDENT.id, { now: NOW });
  if (!inv || !csInv) { console.error("investigate returned null"); process.exit(1); }
  const d = incidentDetailDTO(inv, "ops", NOW);
  const dcs = incidentDetailDTO(csInv, "cs", NOW);
  const resolvedBase = (closure: NonNullable<IncidentRowDTO["closure"]>, reason: string | null, extra: Partial<IncidentDetailDTO> = {}) => variant(d, {
    incident: { state: "resolved", closure, closureDerived: false, resolvedAt: hoursAgo(1).toISOString(), brokenNow: false },
    summary: { resolvedAt: hoursAgo(1).toISOString(), displayStatus: "resolved", ongoing: false },
    resolutionReasonCode: reason, ...extra,
  });

  console.log("1. milestones per state");
  {
    check("fixture: acknowledged, episode 2", d.incident.state === "acknowledged" && d.incident.generation === 2, { state: d.incident.state, g: d.incident.generation });
    const v = incidentLifecycleView(d);
    check("acknowledged: detected → acknowledged → last observed, no closure", JSON.stringify(keys(v)) === JSON.stringify(["detected", "acknowledged", "last-observed"]) && v.closure === null, keys(v));
    const a = ms(v, "acknowledged");
    check("acknowledged time comes from the timeline event, worded 'by an operator (audited)'", a?.at === hoursAgo(20).toISOString() && a.note === "Ownership taken by an operator (audited)", a);
    check("first detected / last observed are the summary stamps", ms(v, "detected")?.at === d.summary.firstDetectedAt && ms(v, "last-observed")?.at === d.summary.lastObservedAt);
    const noEv = incidentLifecycleView(variant(d, { timeline: { source: "none", events: [], truncated: false } }));
    check("acknowledged state without an event ⇒ milestone, 'Time not recorded'", ms(noEv, "acknowledged")?.at === null && ms(noEv, "acknowledged")?.when === "Time not recorded");
    const active = incidentLifecycleView(variant(d, { incident: { state: "active" }, timeline: { source: "none", events: [], truncated: false } }));
    check("active: detected + last observed only", JSON.stringify(keys(active)) === JSON.stringify(["detected", "last-observed"]), keys(active));
    const rec = incidentLifecycleView(variant(d, {
      incident: { state: "recovering", recovery: { ...d.incident.recovery, proofCount: 1 } },
      timeline: { source: "events", truncated: false, events: [E(30, { type: "OBSERVED" }), E(5, { fromState: "ACTIVE", toState: "RECOVERING" })] },
    }));
    const rm = ms(rec, "recovering");
    check("recovering: 'Recovering since' the RECOVERING event, proof count noted", rm?.label === "Recovering since" && rm.at === hoursAgo(5).toISOString() && /1 success proof so far/.test(rm.note ?? ""), rm);
    const stale = incidentLifecycleView(variant(d, { incident: { state: "stale-unverified", freshness: "stale" }, timeline: { source: "none", events: [], truncated: false } }));
    const sm = ms(stale, "needs-verification");
    check("stale-unverified: 'Needs verification' as of checkedAt, fixed note, no time invented", sm?.at === null && sm.when.startsWith("As of ") && sm.note === STALE_NOTE && !keys(stale).includes("closed"), sm);
    const arch = incidentLifecycleView(resolvedBase("recovered", "BALANCE_OBSERVED", {
      incident: { ...d.incident, state: "archived", closure: "recovered", closureDerived: false, resolvedAt: hoursAgo(1).toISOString() },
      archive: { archived: true, archivedAt: hoursAgo(0.5).toISOString(), archiveDueAt: null, retainedUntil: "2027-12-08T12:00:00.000Z" },
    }));
    check("archived: closed then archived, retention noted", keys(arch).slice(-2).join(",") === "closed,archived" && /Summary kept until/.test(ms(arch, "archived")?.note ?? ""), keys(arch));
  }

  console.log("\n2. closure kinds — Dismiss ≠ resolved");
  {
    const evd = { rule: "TRANSACTIONS_SYNCED_V1", proofCount: 2, nonProofCount: 0, mayAdvance: true, lastProofAt: hoursAgo(1).toISOString(), removedSubjectState: null, subjectCount: 1, subjectsTruncated: false } as unknown as IncidentDetailDTO["evidence"];
    const recov = incidentLifecycleView(resolvedBase("recovered", "TRANSACTIONS_SYNC_SUCCEEDED", { evidence: evd }));
    check("recovered ⇒ verified recovery, registry reason, evidence counts", recov.closure?.verifiedRecovery === true && recov.closure.outcome === "verified-recovery" && recov.closure.headline === VERIFIED_RECOVERY_HEADLINE
      && recov.closure.reason === "A later transactions sync for the same connection succeeded" && recov.closure.evidence?.startsWith("2 success proofs") === true, recov.closure);
    check("recovered milestone: 'Resolved', ok tone", ms(recov, "closed")?.label === "Resolved" && ms(recov, "closed")?.tone === "ok");
    const fixed = incidentLifecycleView(resolvedBase("operator", "OPERATOR_FIXED", { evidence: evd }));
    check("operator fixed ⇒ NOT a verified recovery, says so, no evidence line", fixed.closure?.verifiedRecovery === false && fixed.closure.outcome === "operator-fixed" && fixed.closure.headline === OPERATOR_FIXED_HEADLINE && fixed.closure.evidence === null && ms(fixed, "closed")?.label === "Closed");
    for (const code of ["OPERATOR_NOT_ACTIONABLE", "OPERATOR_DUPLICATE", "OPERATOR_TEST_ACTIVITY"]) {
      const dis = incidentLifecycleView(resolvedBase("operator", code));
      check(`${code} ⇒ 'Dismissed', never 'Resolved'`, dis.closure?.outcome === "dismissed" && !dis.closure.verifiedRecovery && dis.closure.headline === DISMISSED_HEADLINE && ms(dis, "closed")?.label === "Dismissed" && ms(dis, "closed")?.tone === "muted");
    }
    const removed = incidentLifecycleView(resolvedBase("connection-removed", "SUBJECT_DELETED"));
    check("connection removed ⇒ closed, not a recovery", removed.closure?.outcome === "subject-removed" && !removed.closure.verifiedRecovery && removed.closure.headline === SUBJECT_REMOVED_HEADLINE);
    const derived = incidentLifecycleView(variant(resolvedBase("connection-removed", null), { incident: { state: "resolved", closure: "connection-removed", closureDerived: true } }));
    check("derived closure is flagged", derived.closure?.derived === true);
    const legacy = incidentLifecycleView(resolvedBase("legacy-resolved", null));
    check("legacy ⇒ closed, recovery not verified", legacy.closure?.outcome === "legacy" && !legacy.closure.verifiedRecovery && legacy.closure.headline === LEGACY_HEADLINE);
    const unreg = incidentLifecycleView(resolvedBase("operator", "NOT_A_REGISTERED_REASON"));
    check("unregistered reason code ⇒ flagged, never echoed", unreg.closure?.unregisteredReason === true && unreg.closure.reason === null && !JSON.stringify(unreg).includes("NOT_A_REGISTERED_REASON"));
    check("unregistered reason code ⇒ 'operator-closed' (not operator-fixed), generic headline, not a recovery", unreg.closure?.outcome === "operator-closed" && unreg.closure.headline === OPERATOR_CLOSED_HEADLINE && !unreg.closure.verifiedRecovery && ms(unreg, "closed")?.label === "Closed", unreg.closure);
    const absent = incidentLifecycleView(resolvedBase("operator", null));
    check("absent reason code ⇒ 'operator-closed', generic headline, not a recovery, not flagged unregistered", absent.closure?.outcome === "operator-closed" && absent.closure.headline === OPERATOR_CLOSED_HEADLINE && !absent.closure.verifiedRecovery && absent.closure.reason === null && !absent.closure.unregisteredReason && ms(absent, "closed")?.label === "Closed", absent.closure);
    const hAbsent = lifecycleHtml(render(resolvedBase("operator", null)));
    const hFixed = lifecycleHtml(render(resolvedBase("operator", "OPERATOR_FIXED")));
    check("rendered: operator-closed vs operator-fixed are distinguishable", hAbsent.includes('data-lifecycle-closure="operator-closed"') && hAbsent.includes('data-verified-recovery="no"') && hAbsent.includes(OPERATOR_CLOSED_HEADLINE)
      && hFixed.includes('data-lifecycle-closure="operator-fixed"') && hFixed.includes('data-verified-recovery="no"') && hFixed.includes(OPERATOR_FIXED_HEADLINE));
    const proto = incidentLifecycleView(resolvedBase("operator", "toString"));
    check("a prototype key is not a reason code", proto.closure?.reason === null && proto.closure.unregisteredReason && proto.closure.outcome === "operator-closed");
    const hDis = lifecycleHtml(render(resolvedBase("operator", "OPERATOR_NOT_ACTIONABLE")));
    const hRec = lifecycleHtml(render(resolvedBase("recovered", "TRANSACTIONS_SYNC_SUCCEEDED", { evidence: evd })));
    check("rendered: dismissed vs recovered are distinguishable", hDis.includes('data-lifecycle-closure="dismissed"') && hDis.includes('data-verified-recovery="no"') && hDis.includes(DISMISSED_HEADLINE)
      && hRec.includes('data-lifecycle-closure="verified-recovery"') && hRec.includes('data-verified-recovery="yes"') && !hDis.includes(VERIFIED_RECOVERY_HEADLINE));
  }

  console.log("\n3. recurrence");
  {
    const v = incidentLifecycleView(d);
    check("episode 2 links its previous episode (retained, dismissed outcome)", v.recurrence.generation === 2 && v.recurrence.previous?.id === PRIOR.id && v.recurrence.previous.retained && /operator/i.test(v.recurrence.previous.outcome) && /Episode 2/.test(v.recurrence.line), v.recurrence);
    const html = lifecycleHtml(render(d));
    check("rendered: previous episode opens in the drawer", html.includes(`data-lifecycle-episode="${PRIOR.id}"`) && html.includes("<button"));
    const first = incidentLifecycleView(variant(d, { incident: { generation: 1 }, related: [] }));
    check("first episode ⇒ 'First episode', no links", /^First episode/.test(first.recurrence.line) && !first.recurrence.previous && !first.recurrence.next);
    const g5 = incidentLifecycleView(variant(d, { incident: { generation: 5 }, related: [{ id: "inc_gone", kind: "PREVIOUS_EPISODE", incident: null }, { id: "inc_next", kind: "NEXT_EPISODE", incident: { ...d.incident, id: "inc_next", generation: 6 } }] }));
    check("generation N, pruned previous ⇒ 'No longer retained', next episode linked", /Episode 5/.test(g5.recurrence.line) && g5.recurrence.previous?.retained === false && g5.recurrence.previous.outcome === "No longer retained" && g5.recurrence.next?.generation === 6 && /recurred later/.test(g5.recurrence.line));
  }

  console.log("\n4. events summarised by code");
  {
    const v = incidentLifecycleView(d);
    check("counts per type", v.events.total === 2 && v.events.byType.map((b) => `${b.type}:${b.count}`).join(",") === "OBSERVED:1,STATE_CHANGED:1" && /2 events recorded · 1 failure observed · 1 state change/.test(v.events.line), v.events);
    check("key event worded from registries", v.events.key.length === 1 && v.events.key[0].parts.join("|") === "Active → Acknowledged|Operator took ownership|by an operator (audited)", v.events.key);
    const odd = incidentLifecycleView(variant(d, { timeline: { source: "events", truncated: true, events: [E(3, { type: "ZZ_ODD_TYPE", actionCode: "ZZ_ODD_ACTION", toState: "ZZ_ODD_STATE" }), E(2, { type: "ACTION_TAKEN", actionCode: "REOPEN", actorKind: "OPERATOR" })] } }));
    const oj = JSON.stringify(odd);
    check("unregistered type / code / state counted, never echoed", !oj.includes("ZZ_ODD") && odd.events.byType.some((b) => b.type === "UNREGISTERED") && odd.events.key[0].parts.includes("an unrecognised code (not shown)") && /\+ events/.test(odd.events.line));
    check("REOPEN action ⇒ 'Reopened' milestone", ms(odd, "reopened")?.note === "Reopened by an operator");
    const many = incidentLifecycleView(variant(d, { timeline: { source: "events", truncated: false, events: Array.from({ length: 12 }, (_, i) => E(20 - i, { actionCode: "RESYNC" })) } }));
    check("key events capped (newest kept)", many.events.key.length === 8 && many.events.keyTruncated && many.events.key[7].at === hoursAgo(9).toISOString());
    const html = render(d);
    check("rendered: key events sit inside the Timeline disclosure; strip first", html.indexOf("data-lifecycle-key-events") > html.indexOf('data-disclosure="timeline"') && html.indexOf("data-lifecycle-strip") < html.indexOf('data-disclosure="timeline"'));
  }

  console.log("\n5. NO FREE TEXT — sentinels (detail, provider message, resolution text, operator id, event extras)");
  {
    for (const [name, dto] of [["ops", d], ["cs", dcs]] as const) {
      const vj = JSON.stringify(incidentLifecycleView(dto));
      check(`${name}: view-model carries no sentinel`, !vj.includes(SENTINEL) && !vj.includes(OPERATOR_ID) && !vj.includes("detail message") && !vj.includes("provider message"));
      const html = render(dto);
      check(`${name}: rendered drawer carries no sentinel or operator id`, !html.includes(SENTINEL) && !html.includes(OPERATOR_ID));
    }
    const prInv = await acc.investigate(ops, PRIOR.id, { now: NOW });
    const prCs = await acc.investigate(cs, PRIOR.id, { now: NOW });
    check("fixture: prior episode is an operator dismissal", prInv?.verdict.closure === "operator" && prInv.resolutionReasonCode === "OPERATOR_NOT_ACTIONABLE", prInv?.verdict.closure);
    for (const [name, x, tier] of [["ops prior", prInv, "ops"], ["cs prior", prCs, "cs"]] as const) {
      if (!x) { check(`${name}: investigate`, false); continue; }
      const pd = incidentDetailDTO(x, tier, NOW);
      const pv = incidentLifecycleView(pd);
      const html = render(pd);
      check(`${name}: dismissed, no resolution free text in view or markup`, pv.closure?.outcome === "dismissed" && !JSON.stringify(pv).includes(SENTINEL) && !html.includes(SENTINEL) && !html.includes(OPERATOR_ID));
    }
  }

  console.log("\n6. identity tier");
  {
    for (const [name, dto] of [["ops", d], ["cs", dcs]] as const) {
      const vj = JSON.stringify(incidentLifecycleView(dto));
      const sec = lifecycleHtml(render(dto));
      check(`${name}: lifecycle names no operator and no customer`, !vj.includes(OPERATOR_ID) && !vj.includes(ITEM.userId) && !sec.includes(ITEM.userId) && !sec.includes(OPERATOR_ID) && sec.length > 0);
      check(`${name}: lifecycle names no institution`, !vj.includes("Example Bank") && !sec.includes("Example Bank"));
      check(`${name}: acknowledger worded by kind only`, ms(incidentLifecycleView(dto), "acknowledged")?.note === "Ownership taken by an operator (audited)");
    }
    check("both tiers produce the same lifecycle view", JSON.stringify(incidentLifecycleView(d)) === JSON.stringify(incidentLifecycleView(dcs)));
    check("control: the CS drawer names the customer in its summary by PRIV-ref only (never the raw id)", render(dcs).includes("data-incident-customer-ref") && !render(dcs).includes(ITEM.userId) && !render(d).includes(ITEM.userId));
    check("lifecycle adds no controls beyond episode links", !/data-lifecycle-action|data-recovery-action/.test(lifecycleHtml(render(d))));
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
