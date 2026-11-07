/**
 * lib/platform/incidents/subjects-core.ts  (PB-1 S3 — removed-subject rule, pure)
 *
 * THE ONE RULE for "the thing this incident observed has been removed"
 * (docs/plans/PB1-INCIDENT-LIFECYCLE.md §5 + §12 P2.2). Used by BOTH the
 * persisting closure (lifecycle.ts `resolveBySubjectRemoval`, this slice) and,
 * in Phase 2, the shared incident reader's read-time backstop — so the write and
 * the read cannot disagree about what "removed" means.
 *
 * A subject is REMOVED when:
 *   - FinancialAccount.deletedAt IS NOT NULL          → DELETED
 *   - PlaidItem.status = REVOKED                      → REVOKED
 *   - the row is genuinely missing (hard delete/purge) → MISSING
 *
 * Connection health is NEVER an input. "Up to date" proves nothing about an
 * incident (owner rule), and neither does ACTIVE.
 *
 * ── ITEM-SCOPED INCIDENTS (§12 P2.2) ─────────────────────────────────────────
 * An item-scoped episode can name several ACCOUNT subjects across its
 * occurrences (`reconstruction-repair` names one per occurrence). The rule is
 * per subject — every subject must be PROVEN or REMOVED:
 *   - the item itself removed                       → SUBJECT_REMOVED
 *   - all named account subjects removed            → SUBJECT_REMOVED
 *   - ≥1 proven and every other one removed         → AUTOMATIC_RECOVERY (S4/S5 supply `proven`)
 *   - anything else                                 → stays OPEN
 * S3 has no evidence resolvers, so every caller here passes `proven: false`.
 *
 * Pure: no I/O, no clock.
 */

import type { RemovedSubjectState } from "./invariant";

export type SubjectState = "LIVE" | RemovedSubjectState;

export interface SubjectRef {
  kind: "PLAID_ITEM" | "FINANCIAL_ACCOUNT";
  id: string;
}

/** The facts a removal decision reads, gathered by the caller in batched lookups. */
export interface SubjectFacts {
  /** PlaidItem id → status (only ids that exist). */
  itemStatus: ReadonlyMap<string, string>;
  /** FinancialAccount id → deletedAt (only ids that exist). */
  accountDeletedAt: ReadonlyMap<string, Date | null>;
}

export function itemState(id: string, facts: SubjectFacts): SubjectState {
  const status = facts.itemStatus.get(id);
  if (status === undefined) return "MISSING";
  return status === "REVOKED" ? "REVOKED" : "LIVE";
}

export function accountState(id: string, facts: SubjectFacts): SubjectState {
  if (!facts.accountDeletedAt.has(id)) return "MISSING";
  return facts.accountDeletedAt.get(id) ? "DELETED" : "LIVE";
}

export interface IncidentSubjectRow {
  plaidItemId: string | null;
  financialAccountId: string | null;
}

/** Per-subject basis, recorded in resolutionEvidence so a closure explains itself. */
export interface SubjectBasis extends SubjectRef {
  state: SubjectState;
  proven: boolean;
}

export type SubjectVerdict =
  | { verdict: "OPEN"; subjects: SubjectBasis[] }
  /** `subject` is the one that decided it (the item, or the first removed account). */
  | { verdict: "SUBJECT_REMOVED"; subject: SubjectRef & { state: RemovedSubjectState }; subjects: SubjectBasis[] }
  | { verdict: "AUTOMATIC_RECOVERY"; subjects: SubjectBasis[] }
  /** The row names no subject at all — nothing can dangle, nothing can be removed. */
  | { verdict: "UNSCOPED"; subjects: [] };

/**
 * Decide removal for one incident row.
 *
 * @param occurrenceAccountIds  account ids named in the episode's occurrence
 *   `detail.financialAccountId` (item-scoped rows only). Pass [] when not read.
 * @param provenAccountIds      account subjects a resolver PROVED recovered (S4/S5); S3 passes none.
 */
export function subjectVerdict(
  row: IncidentSubjectRow,
  facts: SubjectFacts,
  occurrenceAccountIds: readonly string[] = [],
  provenAccountIds: ReadonlySet<string> = new Set(),
): SubjectVerdict {
  const accountIds = [...new Set([row.financialAccountId, ...occurrenceAccountIds].filter((x): x is string => !!x))];
  const accounts: SubjectBasis[] = accountIds.map((id) => ({
    kind: "FINANCIAL_ACCOUNT", id, state: accountState(id, facts), proven: provenAccountIds.has(id),
  }));

  if (row.plaidItemId) {
    const item: SubjectBasis = { kind: "PLAID_ITEM", id: row.plaidItemId, state: itemState(row.plaidItemId, facts), proven: false };
    const subjects = [item, ...accounts];
    if (item.state !== "LIVE") {
      return { verdict: "SUBJECT_REMOVED", subject: { kind: item.kind, id: item.id, state: item.state }, subjects };
    }
    return perSubject(accounts, subjects);
  }
  if (accounts.length === 0) return { verdict: "UNSCOPED", subjects: [] };
  return perSubject(accounts, accounts);
}

/** §12 P2.2 — every subject proven OR removed; removed-only ⇒ SUBJECT_REMOVED. */
function perSubject(accounts: readonly SubjectBasis[], subjects: SubjectBasis[]): SubjectVerdict {
  if (accounts.length === 0) return { verdict: "OPEN", subjects };
  const removed = accounts.filter((a) => a.state !== "LIVE");
  const proven = accounts.filter((a) => a.state === "LIVE" && a.proven);
  if (removed.length + proven.length !== accounts.length) return { verdict: "OPEN", subjects };
  if (proven.length > 0) return { verdict: "AUTOMATIC_RECOVERY", subjects };
  const first = removed[0];
  return { verdict: "SUBJECT_REMOVED", subject: { kind: first.kind, id: first.id, state: first.state as RemovedSubjectState }, subjects };
}

/** True when the subject is gone (the closure here; the Phase-2 read-time backstop later). */
export function isSubjectRemoved(v: SubjectVerdict): boolean {
  return v.verdict === "SUBJECT_REMOVED";
}

/** `detail.financialAccountId` of one occurrence, when it is a non-empty string. */
export function occurrenceAccountId(detail: unknown): string | null {
  if (typeof detail !== "object" || detail === null) return null;
  const v = (detail as Record<string, unknown>).financialAccountId;
  return typeof v === "string" && v !== "" ? v : null;
}
