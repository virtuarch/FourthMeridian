/**
 * lib/platform/incidents/parity/legacy-readers.ts  (PB-1 §13 — today's readers, TEST-ONLY)
 *
 * Each adapter reproduces ONE existing reader's selection rule (the predicate of its
 * query, documented with the source line) and then calls that reader's REAL pure
 * logic, so the verdicts are what production computes today. Normalised to
 * `Verdict` so readers can be compared row by row.
 */

import { classifySyncIssue, syncIssueState, type SyncIssueState } from "@/lib/platform/sync-issue-semantics";
import { projectIncidents } from "@/lib/platform/customer/customer-core";
import type { CsIncidentVerdict } from "@/lib/platform/incidents/intelligence/types";
import { convergenceInstant, syncIssueOutcome } from "@/lib/platform/convergence/participants";
import { foldSyncIncidents } from "@/lib/alerts/sync-incidents";
import { evaluateSyncIncidentCritical } from "@/lib/alerts/evaluate";
import { ALERT_RULES } from "@/lib/alerts/rules";
import { projectVerdictForPlatform } from "@/lib/platform/incidents/platform-projection";
import { buildAttention } from "@/lib/platform/ops/attention-core";
import { foldAttention, incidentOwnersOf, type AttentionFacts } from "@/lib/platform/customer/attention-core";
import { moduleVerdicts } from "./module-adapter";
import type { World, WorldRow } from "./world";

export type ReaderId = "cs-panel" | "projection" | "convergence" | "alerts" | "ops-attention" | "cs-attention";

export interface Verdict {
  reader: ReaderId;
  rowId: string;
  /** "Shown as needing attention" in that reader's own sense. */
  open: boolean;
  state?: SyncIssueState;
  severity?: string;
  subjectUserId?: string | null;
  groupKey?: string;
}

const DAY = 86_400_000;
const itemExists = (w: World, id: string) => w.items.some((i) => i.id === id && !i.deleted);
const accountRowExists = (w: World, id: string) => w.accounts.some((a) => a.id === id && !a.hardDeleted);

/** R4 — projections.ts `referentExistence`: the account wins when set (deletedAt NOT honoured), else the item. */
function projectionReferentExists(w: World, r: WorldRow): boolean {
  if (r.financialAccountId) return accountRowExists(w, r.financialAccountId);
  if (r.plaidItemId) return itemExists(w, r.plaidItemId);
  return true;
}
/** R3 — convergence.ts:184: neither set, OR item exists, OR account exists. */
function convergenceReferentExists(w: World, r: WorldRow): boolean {
  if (!r.plaidItemId && !r.financialAccountId) return true;
  return (!!r.plaidItemId && itemExists(w, r.plaidItemId)) || (!!r.financialAccountId && accountRowExists(w, r.financialAccountId));
}

const classifiable = (r: WorldRow) => ({ kind: r.kind, provider: r.provider, detail: r.detail, plaidTransactionId: r.plaidTransactionId });

/**
 * R4 BASELINE — the projection AS IT WAS before its cutover (PB-1 R4):
 * resolved=false, then episodeStateOf with the account-else-item referent check
 * (deletedAt / REVOKED not honoured). Kept INLINE for the §13.2 sensitivity
 * checks; no production code implements this rule any more.
 */
export function projectionBaselineReader(w: World): Verdict[] {
  return w.rows.filter((r) => !r.resolved).map((r) => {
    const state = syncIssueState(classifiable(r), { referentExists: projectionReferentExists(w, r), resolved: r.resolved });
    return { reader: "projection", rowId: r.id, open: state === "active", state, severity: classifySyncIssue(classifiable(r)).severity };
  });
}

/**
 * R1+R2 BASELINE — the CS panel AS IT WAS before its cutover (PB-1 R1): the
 * customer-detail query (resolved=false; the user's items OR live-connection
 * accounts) and the raw `!resolved` open filter projectIncidents used to apply.
 * Kept INLINE as the historical record the §13.2 sensitivity checks prove
 * divergences against; no production code implements this rule any more.
 */
export function csPanelBaselineReader(w: World): Verdict[] {
  const out: Verdict[] = [];
  for (const userId of w.users) {
    const itemIds = new Set(w.items.filter((i) => i.userId === userId).map((i) => i.id));
    const accountIds = new Set(w.accounts.filter((a) => a.viaItemId && itemIds.has(a.viaItemId) && !a.softDeleted && !a.hardDeleted).map((a) => a.id));
    const selected = w.rows.filter((r) => !r.resolved && ((r.plaidItemId && itemIds.has(r.plaidItemId)) || (r.financialAccountId && accountIds.has(r.financialAccountId))));
    for (const r of selected) out.push({ reader: "cs-panel", rowId: r.id, open: true, subjectUserId: userId });
  }
  return out;
}

/**
 * R1+R2 — the CS panel AFTER its cutover: per customer, the module's
 * CUSTOMER_SUCCESS-tier verdicts attributed to them (what forCustomer returns),
 * through the REAL projectIncidents, which lists those that are brokenNow.
 */
export function csPanelReader(w: World): Verdict[] {
  const cs = moduleVerdicts(w, "CUSTOMER_SUCCESS") as CsIncidentVerdict[];
  const out: Verdict[] = [];
  for (const userId of w.users) {
    const mine = cs.filter((v) => v.rowClass === "incident" && v.subjectUserId === userId);
    for (const o of projectIncidents(mine, [], []).open) out.push({ reader: "cs-panel", rowId: o.id, open: true, subjectUserId: userId });
  }
  return out;
}

/**
 * R3 BASELINE — convergence AS IT WAS before its cutover (PB-1 R3): rows CREATED
 * in the window; the referent OR-rule; classification without plaidTransactionId.
 * Kept INLINE as the historical record the §13.2 sensitivity checks prove
 * divergences against; no production code implements this rule any more.
 */
export function convergenceBaselineReader(w: World): Verdict[] {
  const from = w.now.getTime() - w.windowDays * DAY;
  return w.rows.filter((r) => r.createdAt.getTime() >= from).map((r) => {
    const facts = { kind: r.kind, provider: r.provider, detail: r.detail }; // participants.ts:154 omits plaidTransactionId
    const state = syncIssueState(facts, { referentExists: convergenceReferentExists(w, r), resolved: r.resolved });
    const runId = (r.detail as { runId?: string } | null)?.runId ?? "legacy";
    return {
      reader: "convergence", rowId: r.id, open: state === "active", state, severity: classifySyncIssue(facts).severity,
      groupKey: `plaidItem:${r.plaidItemId ?? r.financialAccountId ?? `provider:${r.provider}`}|run:${runId}`,
    };
  });
}

/**
 * R3 — convergence AFTER its cutover: the module's Platform Ops verdicts for the
 * window (an OPEN incident whatever its dates — D6; a closed row only when its
 * instant sits in the window), through the REAL participant outcome rule.
 */
export function convergenceReader(w: World): Verdict[] {
  const from = w.now.getTime() - w.windowDays * DAY;
  return moduleVerdicts(w, "PLATFORM_OPS").filter((v) => {
    if (v.rowClass === "incident" && v.state !== "resolved" && v.state !== "archived") return true;
    const at = Date.parse(convergenceInstant(v));
    return at >= from && at <= w.now.getTime();
  }).map((v) => ({
    reader: "convergence" as const, rowId: v.id, open: syncIssueOutcome(v) === "degraded", severity: v.severity,
    groupKey: `plaidItem:${v.plaidItemId ?? v.financialAccountId ?? `provider:${v.provider}`}|episode:${v.episodeKey}`,
  }));
}

/**
 * R4 — the projection AFTER its cutover: getActiveIncidentPage reads the module's
 * `brokenNow` (CS / Ops token). R6a / R6b consume this page.
 */
export function projectionReader(w: World): Verdict[] {
  return moduleVerdicts(w, "PLATFORM_OPS").filter((v) => v.rowClass === "incident").map((v) => ({
    reader: "projection" as const, rowId: v.id, open: v.brokenNow, severity: v.severity,
  }));
}

/**
 * R4/R5 — alerts AFTER the cutover: the SYSTEM feed is the module's `alertable`
 * set (what `incidentAccessors.alertable` returns), through the REAL fold
 * (lib/alerts/sync-incidents.ts) and the REAL rule evaluator
 * (evaluateSyncIncidentCritical). A row is open when its group — the evaluator's
 * own dedupe key (per Plaid Item, else per episode) — produced a critical signal.
 * `feed` lets the gate hand the fold a WIDER page to prove the fold's own guard.
 */
export function alertsReader(w: World, feed: "alertable" | "all" = "alertable"): Verdict[] {
  const verdicts = moduleVerdicts(w, "SYSTEM").filter((v) => feed === "all" || v.alertable);
  const health = foldSyncIncidents(verdicts, false, w.now);
  const rule = ALERT_RULES.find((r) => r.id === "sync-incident-critical")!;
  const fired = new Set(evaluateSyncIncidentCritical(rule, health).map((sig) => sig.dedupeKey));
  return health.active.map((i) => {
    const groupKey = i.plaidItemId ? `item:${i.plaidItemId}` : `episode:${i.id}`;
    return {
      reader: "alerts" as const, rowId: i.id, severity: i.severity, groupKey,
      open: i.severity === "critical" && fired.has(`${rule.id}:${groupKey}`),
    };
  });
}

/**
 * R6a — Ops attention AFTER its cutover: the module's Ops-tier `brokenNow` page
 * (what `incidentAccessors.brokenNow` returns), through the REAL field-by-field
 * projection (projectVerdictForPlatform) and the REAL attention composition
 * (buildAttention → incidentItems). A row is open when it produced an attention
 * item. `feed` lets the gate hand the core a WIDER page to prove its own guard.
 */
export function opsAttentionReader(w: World, feed: "brokenNow" | "all" = "brokenNow"): Verdict[] {
  const verdicts = moduleVerdicts(w, "PLATFORM_OPS").filter((v) => feed === "all" || v.brokenNow);
  const items = verdicts.map((v) => projectVerdictForPlatform(v, { primary: null, secondary: null }, null));
  const shown = new Map(
    buildAttention({ connections: null, jobs: null, providers: null, resources: null, alerts: null, incidents: { items, activeTotal: items.length, truncated: false } }, w.now)
      .items.filter((x) => x.id.startsWith("incident:")).map((x) => [x.id.slice("incident:".length), x] as const),
  );
  return items.map((p) => ({
    reader: "ops-attention" as const, rowId: p.id, open: shown.has(p.id), severity: shown.get(p.id)?.severity ?? p.effectiveSeverity,
  }));
}

/**
 * R6b — CS attention AFTER its cutover: the module's CUSTOMER_SUCCESS-tier
 * `brokenNow` page (what `incidentAccessors.brokenNow` returns for a CS token),
 * through the REAL owner rule (incidentOwnersOf — the module's subjectUserId,
 * D4) and the REAL fold (foldAttention). A row is open when its owner lands in
 * the fold's `incident` reason. `feed` lets the gate hand the reader a WIDER page.
 */
const EMPTY_FUNNEL: AttentionFacts["funnel"] = {
  users: [], firstSessions: [], firstAiTurns: [], firstBriefViews: [], lastEngagements: [], plaidItems: [], walletConnections: [], manualAssets: [],
};
export function csAttentionReader(w: World, feed: "brokenNow" | "all" = "brokenNow"): Verdict[] {
  const verdicts = (moduleVerdicts(w, "CUSTOMER_SUCCESS") as CsIncidentVerdict[]).filter((v) => feed === "all" || v.brokenNow);
  const owners = incidentOwnersOf(verdicts);
  const fold = foldAttention({
    activeCustomerIds: new Set(w.users), funnel: EMPTY_FUNNEL,
    reconnectOwners: [], incidentOwners: owners, policyIssueOwners: [],
  }, w.now);
  return verdicts.map((v) => {
    const [owner] = incidentOwnersOf([v]);
    return { reader: "cs-attention" as const, rowId: v.id, severity: v.severity, subjectUserId: v.subjectUserId, open: !!owner && fold.sets.incident.has(owner) };
  });
}

export const LEGACY_READERS = {
  "cs-panel": csPanelReader,
  projection: projectionReader,
  convergence: convergenceReader,
  alerts: (w: World) => alertsReader(w),
  "ops-attention": (w: World) => opsAttentionReader(w),
  "cs-attention": (w: World) => csAttentionReader(w),
} as const;
