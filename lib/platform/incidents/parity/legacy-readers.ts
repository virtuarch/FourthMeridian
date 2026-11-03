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

/** R4 canonical projection (getActiveIncidentPage + episodeStateOf): active only. */
export function projectionReader(w: World): Verdict[] {
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

/** R3 — convergence: rows CREATED in the window; referent OR-rule; classification without plaidTransactionId. */
export function convergenceReader(w: World): Verdict[] {
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

/** R5 — alerts: the projection's active set, critical only, grouped per item. */
export function alertsReader(w: World): Verdict[] {
  return projectionReader(w).filter((v) => v.open && v.severity === "critical").map((v) => {
    const r = w.rows.find((x) => x.id === v.rowId)!;
    return { ...v, reader: "alerts", groupKey: r.plaidItemId ? `item:${r.plaidItemId}` : `episode:${r.id}` };
  });
}

/** R6a — ops attention: the projection's active set, severity 1:1, no identity. */
export function opsAttentionReader(w: World): Verdict[] {
  return projectionReader(w).filter((v) => v.open).map((v) => ({ ...v, reader: "ops-attention" }));
}

/** R6b — CS attention (customer/attention.ts:84-96): active set; owner via item→user, else account owner ?? createdBy. */
export function csAttentionReader(w: World): Verdict[] {
  return projectionReader(w).filter((v) => v.open).map((v) => {
    const r = w.rows.find((x) => x.id === v.rowId)!;
    const item = r.plaidItemId ? w.items.find((i) => i.id === r.plaidItemId) : undefined;
    const acct = !item && r.financialAccountId ? w.accounts.find((a) => a.id === r.financialAccountId && !a.hardDeleted) : undefined;
    return { ...v, reader: "cs-attention", subjectUserId: item?.userId ?? acct?.ownerUserId ?? acct?.createdByUserId ?? null };
  });
}

export const LEGACY_READERS = {
  "cs-panel": csPanelReader,
  projection: projectionReader,
  convergence: convergenceReader,
  alerts: alertsReader,
  "ops-attention": opsAttentionReader,
  "cs-attention": csAttentionReader,
} as const;
