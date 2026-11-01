/**
 * lib/platform/connections/removed-connections.core.ts  (PB-5)
 *
 * THE PURE FOLD behind Platform Ops → Providers → Connections → "Removed".
 *
 * Connection diagnostics (lib/platform/connection-diagnostics.ts) lists LIVE
 * connections only — it loads with `status: { not: REVOKED }` — so a removed
 * connection simply vanished from Platform Ops, and the Provider cleanup widget
 * reduced the whole population to two numbers. This module answers the
 * questions an operator asks about one removal: what was it, whose was it, when,
 * who removed it, and did Plaid confirm.
 *
 * ══ NO NEW FACT IS RECORDED FOR THIS LIST ════════════════════════════════════
 * Every column is derived from rows that already exist (no schema change):
 *
 *   removed?        PlaidItem.status REVOKED · a revocation marker exists ·
 *                   a wallet Connection that is REVOKED or has accounts but
 *                   none live (exactly the customer hub's own rule —
 *                   lib/sync/wallet-connections.ts drops it as "removed wallet")
 *   removed at      the PLAID_ITEM_STATUS_CHANGED → REVOKED transition (CH-2),
 *                   else the FIRST revocation marker, else the latest
 *                   AccountConnection.deletedAt. Null when nothing records it —
 *                   rendered as "—", never as a guessed date.
 *   removed by      see deriveRemovedBy below (operator > customer > provider >
 *                   system > unknown), each from its own audit fact
 *   Plaid outcome   lib/platform/plaid/provider-cleanup.core.ts cleanupVerdicts —
 *                   the SAME verdict the Provider cleanup widget counts, so the
 *                   list and the widget cannot disagree (pinned by test)
 *
 * ⚠️ `status === REVOKED` IS NEVER READ AS PROVIDER CLEANUP. It only admits a
 * row to the list; the outcome column comes from the markers alone — the rule
 * provider-cleanup.ts states and f339e57 established.
 *
 * ══ PRIVACY ════════════════════════════════════════════════════════════════
 * The DTO carries the same opaque owner reference connection diagnostics does
 * (`user …<last6>`) and NO customer identity. The owner's display label is
 * resolved by the UI through the ONE Customer Success–gated route
 * (/api/platform/customer-success/connection-owners, owner decision D4) —
 * exactly how the connection-health table shows owners — so a PLATFORM_OPS-only
 * operator never sees who a removed connection belonged to. Operator names ARE
 * shown (username → name → opaque, never an email), as the Platform Ops
 * activity feed already shows them (lib/platform/activity/operator-feed.ts).
 * No balances, no transaction content, no token, no address.
 *
 * Pure: no DB, no clock (`now` is handed in).
 */

import { AuditAction } from "@/lib/audit-actions";
import { cleanupVerdicts, type CleanupVerdict, type MarkerRow } from "@/lib/platform/plaid/provider-cleanup.core";

// ── Vocabulary ───────────────────────────────────────────────────────────────

export const REMOVED_PROVIDERS = ["PLAID", "WALLET"] as const;
export type RemovedProvider = (typeof REMOVED_PROVIDERS)[number];

/**
 * The provider question, in words.
 *   CONFIRMED_REMOVED  newest marker CONFIRMED (outcome REMOVED, or a legacy
 *                      CONFIRMED row that pre-dates the outcome word)
 *   ALREADY_GONE       newest marker CONFIRMED with outcome ALREADY_GONE
 *   CLEANUP_OWED       newest marker UNCONFIRMED — Plaid still holds the Item
 *   NOT_RECORDED       a REVOKED Plaid item with no marker at all (revoked by
 *                      the provider's webhook, or before markers existed)
 *   NOT_APPLICABLE     a self-custody wallet: watch-only, nothing to revoke
 */
export const REMOVED_OUTCOMES = ["CONFIRMED_REMOVED", "ALREADY_GONE", "CLEANUP_OWED", "NOT_RECORDED", "NOT_APPLICABLE"] as const;
export type RemovedOutcome = (typeof REMOVED_OUTCOMES)[number];

export const REMOVED_OUTCOME_LABEL: Record<RemovedOutcome, string> = {
  CONFIRMED_REMOVED: "Confirmed removed",
  ALREADY_GONE:      "Already gone",
  CLEANUP_OWED:      "Cleanup owed",
  NOT_RECORDED:      "Not recorded",
  NOT_APPLICABLE:    "Not applicable",
};

/**
 * Who removed it.
 *   OPERATOR  a CONNECTION_REMOVED_BY_OPERATOR operator action targets it
 *   CUSTOMER  RECORDED: a CONNECTION_DISCONNECTED row names this connection;
 *             INFERRED: the owner's own disconnect / account-remove row, written
 *             within REMOVAL_MATCH_WINDOW_MS of the removal (rows written before
 *             the connection id was recorded carry only the institution)
 *   PROVIDER  a Plaid item REVOKED while its accounts are still live — the
 *             USER_PERMISSION_REVOKED webhook path, which leaves them in place
 *   SYSTEM    a revocation marker with no customer or operator act: a job or
 *             script revoked an already-orphaned item
 *   UNKNOWN   none of the above
 */
export type RemovedBy =
  | { kind: "OPERATOR"; operator: string; reason: string | null }
  | { kind: "CUSTOMER"; attribution: "RECORDED" | "INFERRED" }
  | { kind: "PROVIDER" }
  | { kind: "SYSTEM" }
  | { kind: "UNKNOWN" };
export type RemovedByKind = RemovedBy["kind"];

/** How close a legacy customer act must be to the removal to be attributed to it. */
export const REMOVAL_MATCH_WINDOW_MS = 10 * 60_000;

export interface RemovedConnectionRow {
  /** The operator handle — PlaidItem.id or Connection.id (the connection-owners route keys on it). */
  id: string;
  provider: RemovedProvider;
  /** Institution label, or the wallet's opaque label. Never an address. */
  source: string;
  /** Distinct accounts the connection held. */
  accountCount: number;
  /** PLATFORM OPS PRIVACY — opaque, as connection diagnostics: `user …<last6>`, "—" when unknown. */
  ownerRef: string;
  removedAtISO: string | null;
  removedBy: RemovedBy;
  outcome: RemovedOutcome;
  /** Plaid only: UNCONFIRMED attempts ever, and the provider's latest code. */
  cleanup: { attemptCount: number; latestErrorCode: string | null } | null;
  /** True when the PlaidItem row no longer exists (the marker outlives it). */
  itemGone: boolean;
  /** True when a removed Plaid item has since been re-linked (status left REVOKED). */
  relinked: boolean;
  /** An owed cleanup with an item to retry — the existing provider-cleanup POST. */
  retryEligible: boolean;
}

// ── Inputs (exactly what the reader selects) ─────────────────────────────────

export interface AccountLinkFact {
  financialAccountId: string;
  deletedAt: Date | null;
  accountDeletedAt: Date | null;
}
export interface PlaidItemFact {
  id: string; userId: string; institutionName: string | null; status: string;
  links: AccountLinkFact[];
}
export interface WalletFact {
  id: string; userId: string; externalConnectionId: string | null; status: string;
  links: AccountLinkFact[];
}
export interface AuditFact {
  action: string;
  userId: string | null;
  createdAt: Date;
  performedByAdminId?: string | null;
  metadata: unknown;
}

export interface RemovedConnectionsInputs {
  plaidItems: PlaidItemFact[];
  wallets: WalletFact[];
  /** Both revocation markers, ASCENDING (provider-cleanup's read). */
  markers: MarkerRow[];
  /** PLAID_ITEM_STATUS_CHANGED rows whose `to` is REVOKED. */
  revokedTransitions: AuditFact[];
  /** CONNECTION_DISCONNECTED / ACCOUNT_REMOVE rows by the owners in scope. */
  customerActs: AuditFact[];
  /** CONNECTION_REMOVED_BY_OPERATOR operator actions. */
  operatorActs: AuditFact[];
  /** Operator id → display label (username → name → opaque), null when unresolved. */
  operatorLabel: (userId: string) => string | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const meta = (r: { metadata: unknown }) => (r.metadata ?? {}) as Record<string, unknown>;

/** Opaque owner reference — the connection-diagnostics form, character for character. */
export function ownerRefOf(userId: string | null | undefined): string {
  return userId ? `user …${userId.slice(-6)}` : "—";
}

/** The wallet label connection diagnostics shows. Never the address. */
export function walletLabel(externalConnectionId: string | null): string {
  if (!externalConnectionId) return "Self-custody wallet";
  return `Self-custody wallet …${externalConnectionId.slice(-6)}`;
}

const isLive = (l: AccountLinkFact) => l.deletedAt === null && l.accountDeletedAt === null;
const distinctAccounts = (links: AccountLinkFact[]) => new Set(links.map((l) => l.financialAccountId)).size;
const latestDeletedAt = (links: AccountLinkFact[]): Date | null =>
  links.map((l) => l.deletedAt).filter((d): d is Date => d !== null).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

/** The target id an operator-action row names (the envelope's target, then the legacy detail key). */
function operatorTargetId(r: AuditFact): string | null {
  const m = meta(r);
  const target = m.target as { id?: unknown } | undefined;
  return str(target?.id) ?? str(m.connectionId);
}

/**
 * Who removed it — ONE precedence, stated once.
 *
 * Operator first: an operator removal is the only one that names its actor in
 * the row itself, and it is the reason this list exists. A customer act that
 * names the connection beats an inferred one. PROVIDER is a Plaid item revoked
 * with its accounts still live. SYSTEM needs positive evidence (a marker) — a
 * row with nothing recorded is UNKNOWN, never guessed.
 */
export function deriveRemovedBy(input: {
  connectionId: string;
  provider: RemovedProvider;
  ownerUserId: string | null;
  source: string;
  removedAt: Date | null;
  hasLiveAccounts: boolean;
  hasMarker: boolean;
  customerActs: readonly AuditFact[];
  operatorActs: readonly AuditFact[];
  operatorLabel: (userId: string) => string | null;
}): RemovedBy {
  const op = input.operatorActs
    .filter((r) => operatorTargetId(r) === input.connectionId && meta(r).result !== "FAILURE" && meta(r).result !== "REFUSED")
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (op) {
    const id = op.performedByAdminId ?? null;
    const reason = str(meta(op).removalReason);
    return { kind: "OPERATOR", operator: (id && input.operatorLabel(id)) ?? (id ? `user …${id.slice(-6)}` : "an operator"), reason };
  }

  const own = input.customerActs.filter((r) => input.ownerUserId !== null && r.userId === input.ownerUserId);
  if (own.some((r) => r.action === AuditAction.CONNECTION_DISCONNECTED && str(meta(r).connectionId) === input.connectionId)) {
    return { kind: "CUSTOMER", attribution: "RECORDED" };
  }

  if (input.provider === "PLAID" && input.hasLiveAccounts) return { kind: "PROVIDER" };

  if (input.removedAt) {
    const at = input.removedAt.getTime();
    const near = own.filter((r) => Math.abs(r.createdAt.getTime() - at) <= REMOVAL_MATCH_WINDOW_MS);
    const matches = near.some((r) => {
      if (r.action === AuditAction.ACCOUNT_REMOVE) return true;
      if (r.action !== AuditAction.CONNECTION_DISCONNECTED) return false;
      // A row that names ANOTHER connection is not this one's evidence.
      const named = str(meta(r).connectionId);
      if (named) return false;
      const inst = str(meta(r).institution);
      return inst === null || inst === input.source || (input.provider === "WALLET" && inst === "Self-custody wallet");
    });
    if (matches) return { kind: "CUSTOMER", attribution: "INFERRED" };
  }

  if (input.hasMarker) return { kind: "SYSTEM" };
  return { kind: "UNKNOWN" };
}

/** The verdict → outcome mapping. Wallets never reach a marker. */
export function outcomeOf(provider: RemovedProvider, verdict: CleanupVerdict | undefined): RemovedOutcome {
  if (provider === "WALLET") return "NOT_APPLICABLE";
  if (!verdict) return "NOT_RECORDED";
  if (verdict.verdict === "OWED") return "CLEANUP_OWED";
  return verdict.outcome === "ALREADY_GONE" ? "ALREADY_GONE" : "CONFIRMED_REMOVED";
}

// ── The fold ─────────────────────────────────────────────────────────────────

/**
 * Every removed connection, newest removal first (unknown dates last).
 * Unfiltered and unpaged — `queryRemovedConnections` does that, so the totals
 * it reports are over the whole population.
 */
export function foldRemovedConnections(input: RemovedConnectionsInputs): RemovedConnectionRow[] {
  const verdicts = cleanupVerdicts(input.markers);

  // Earliest marker per item — "when the provider question was first asked".
  const firstMarkerAt = new Map<string, Date>();
  for (const m of input.markers) {
    const id = str(meta(m).plaidItemId);
    if (id && !firstMarkerAt.has(id)) firstMarkerAt.set(id, m.createdAt);
  }
  // Newest → REVOKED transition per item.
  const revokedAt = new Map<string, Date>();
  for (const t of input.revokedTransitions) {
    const id = str(meta(t).plaidItemId);
    if (!id || meta(t).to !== "REVOKED") continue;
    const prev = revokedAt.get(id);
    if (!prev || t.createdAt > prev) revokedAt.set(id, t.createdAt);
  }

  const rows: RemovedConnectionRow[] = [];
  const itemIds = new Set(input.plaidItems.map((p) => p.id));

  for (const p of input.plaidItems) {
    const verdict = verdicts.get(p.id);
    const isRevoked = p.status === "REVOKED";
    // Admitted by product status OR by a marker (a re-linked item keeps its
    // markers, and the cleanup widget still counts them — so does this list).
    if (!isRevoked && !verdict) continue;
    const removedAt = revokedAt.get(p.id) ?? firstMarkerAt.get(p.id) ?? latestDeletedAt(p.links);
    const source = p.institutionName ?? "(unknown institution)";
    const outcome = outcomeOf("PLAID", verdict);
    rows.push({
      id: p.id, provider: "PLAID", source,
      accountCount: distinctAccounts(p.links),
      ownerRef: ownerRefOf(p.userId),
      removedAtISO: removedAt?.toISOString() ?? null,
      removedBy: deriveRemovedBy({
        connectionId: p.id, provider: "PLAID", ownerUserId: p.userId, source, removedAt,
        hasLiveAccounts: isRevoked && p.links.some(isLive), hasMarker: verdict !== undefined,
        customerActs: input.customerActs, operatorActs: input.operatorActs, operatorLabel: input.operatorLabel,
      }),
      outcome,
      cleanup: verdict ? { attemptCount: verdict.attemptCount, latestErrorCode: verdict.latestErrorCode } : null,
      itemGone: false,
      relinked: !isRevoked,
      retryEligible: outcome === "CLEANUP_OWED",
    });
  }

  // A marker deliberately OUTLIVES its item (AuditLog is not cascaded). Its row
  // stays in the list — dropping it would hide an obligation, and would make
  // this list count fewer verdicts than the cleanup widget does.
  for (const [id, verdict] of verdicts) {
    if (itemIds.has(id)) continue;
    const outcome = outcomeOf("PLAID", verdict);
    const removedAt = firstMarkerAt.get(id) ?? null;
    rows.push({
      id, provider: "PLAID", source: "(item deleted)", accountCount: 0, ownerRef: "—",
      removedAtISO: removedAt?.toISOString() ?? null,
      removedBy: deriveRemovedBy({
        connectionId: id, provider: "PLAID", ownerUserId: null, source: "(item deleted)", removedAt,
        hasLiveAccounts: false, hasMarker: true,
        customerActs: [], operatorActs: input.operatorActs, operatorLabel: input.operatorLabel,
      }),
      outcome,
      cleanup: { attemptCount: verdict.attemptCount, latestErrorCode: verdict.latestErrorCode },
      itemGone: true, relinked: false,
      // Nothing left to revoke: the retry route answers ITEM_GONE for it.
      retryEligible: false,
    });
  }

  for (const w of input.wallets) {
    const removed = w.status === "REVOKED" || (w.links.length > 0 && !w.links.some(isLive));
    if (!removed) continue;
    const source = walletLabel(w.externalConnectionId);
    const removedAt = latestDeletedAt(w.links);
    rows.push({
      id: w.id, provider: "WALLET", source,
      accountCount: distinctAccounts(w.links),
      ownerRef: ownerRefOf(w.userId),
      removedAtISO: removedAt?.toISOString() ?? null,
      removedBy: deriveRemovedBy({
        connectionId: w.id, provider: "WALLET", ownerUserId: w.userId, source, removedAt,
        hasLiveAccounts: false, hasMarker: false,
        customerActs: input.customerActs, operatorActs: input.operatorActs, operatorLabel: input.operatorLabel,
      }),
      outcome: "NOT_APPLICABLE",
      cleanup: null, itemGone: false, relinked: false, retryEligible: false,
    });
  }

  return rows.sort((a, b) => {
    if (a.removedAtISO && b.removedAtISO && a.removedAtISO !== b.removedAtISO) return b.removedAtISO.localeCompare(a.removedAtISO);
    if (a.removedAtISO && !b.removedAtISO) return -1;
    if (!a.removedAtISO && b.removedAtISO) return 1;
    return a.id.localeCompare(b.id);
  });
}

// ── Filters + paging ─────────────────────────────────────────────────────────

export const REMOVED_PAGE_SIZE_DEFAULT = 25;
export const REMOVED_PAGE_SIZE_MAX = 100;
/** The owner filter is the opaque reference's six characters — the only owner token this surface holds. */
const OWNER_REF_SHAPE = /^[A-Za-z0-9_-]{6}$/;

export interface RemovedConnectionsQuery {
  /** The six characters of an `ownerRef` (`user …<these>`). */
  owner: string | null;
  provider: RemovedProvider | null;
  outcome: RemovedOutcome | null;
  page: number;
  pageSize: number;
}

/** Parse untrusted query params. Returns the query or the reason it is malformed (400). */
export function parseRemovedConnectionsQuery(params: URLSearchParams): { query: RemovedConnectionsQuery } | { error: string } {
  const owner = params.get("owner")?.trim() || null;
  if (owner !== null && !OWNER_REF_SHAPE.test(owner)) return { error: "owner must be the six characters of an owner reference" };
  const providerRaw = params.get("provider")?.trim() || null;
  if (providerRaw !== null && !(REMOVED_PROVIDERS as readonly string[]).includes(providerRaw)) return { error: `provider must be one of ${REMOVED_PROVIDERS.join(", ")}` };
  const outcomeRaw = params.get("outcome")?.trim() || null;
  if (outcomeRaw !== null && !(REMOVED_OUTCOMES as readonly string[]).includes(outcomeRaw)) return { error: `outcome must be one of ${REMOVED_OUTCOMES.join(", ")}` };
  const page = params.get("page") === null ? 1 : Number(params.get("page"));
  if (!Number.isInteger(page) || page < 1 || page > 10_000) return { error: "page must be a positive integer" };
  const pageSize = params.get("pageSize") === null ? REMOVED_PAGE_SIZE_DEFAULT : Number(params.get("pageSize"));
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > REMOVED_PAGE_SIZE_MAX) return { error: `pageSize must be 1–${REMOVED_PAGE_SIZE_MAX}` };
  return {
    query: {
      owner, page, pageSize,
      provider: providerRaw as RemovedProvider | null,
      outcome: outcomeRaw as RemovedOutcome | null,
    },
  };
}

export interface RemovedConnectionsPage {
  rows: RemovedConnectionRow[];
  page: number;
  pageSize: number;
  /** Rows matching the filters (all pages). */
  total: number;
  /** Over the WHOLE population, unfiltered — the figures the cleanup widget shows must equal these. */
  totals: {
    all: number;
    byOutcome: Record<RemovedOutcome, number>;
    byRemovedBy: Record<RemovedByKind, number>;
  };
  /** The provider-cleanup counts for the same verdicts: owed = CLEANUP_OWED, confirmed = CONFIRMED_REMOVED + ALREADY_GONE. */
  cleanup: { owedCount: number; confirmedCount: number };
}

export function queryRemovedConnections(all: readonly RemovedConnectionRow[], q: RemovedConnectionsQuery): RemovedConnectionsPage {
  const byOutcome = Object.fromEntries(REMOVED_OUTCOMES.map((o) => [o, 0])) as Record<RemovedOutcome, number>;
  const byRemovedBy: Record<RemovedByKind, number> = { OPERATOR: 0, CUSTOMER: 0, PROVIDER: 0, SYSTEM: 0, UNKNOWN: 0 };
  for (const r of all) { byOutcome[r.outcome]++; byRemovedBy[r.removedBy.kind]++; }

  const matched = all.filter((r) =>
    (q.provider === null || r.provider === q.provider)
    && (q.outcome === null || r.outcome === q.outcome)
    && (q.owner === null || r.ownerRef === `user …${q.owner}`));
  const start = (q.page - 1) * q.pageSize;
  return {
    rows: matched.slice(start, start + q.pageSize),
    page: q.page,
    pageSize: q.pageSize,
    total: matched.length,
    totals: { all: all.length, byOutcome, byRemovedBy },
    cleanup: { owedCount: byOutcome.CLEANUP_OWED, confirmedCount: byOutcome.CONFIRMED_REMOVED + byOutcome.ALREADY_GONE },
  };
}
