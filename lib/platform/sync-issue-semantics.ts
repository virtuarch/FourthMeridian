/**
 * lib/platform/sync-issue-semantics.ts
 *
 * THE single authority for what a SyncIssue row MEANS.
 *
 * PRE-V26-PLAID-CLOSE Phase 4. One `SyncIssue` table serves six unrelated
 * producers — transaction persistence, investment repair, instrument identity,
 * import rollback, BTC wallet sync, and balance reconciliation — and until now
 * every consumer re-guessed their significance from `kind` alone. `kind` is not
 * enough: `UPSERT_ERROR` alone spans a lost bank transaction (critical, financial
 * data missing) and a non-fatal BTC price-fetch retry (informational). Platform
 * Ops rendered them identically, and the member activity feed told users to
 * "reconnect" over an internal investment-repair failure.
 *
 * ── DERIVED, NEVER STORED ────────────────────────────────────────────────────
 * Domain, severity and nature are computed from data the row already carries
 * (`kind`, `provider`, `detail.stage`). They are deliberately NOT columns: a
 * stored severity drifts from the rule that produced it the moment the rule
 * changes, and every existing row would need a backfill. This mirrors
 * lib/debt/balance-semantics.ts — we do not store `amountOwed`, we derive it.
 * Consequence: no schema change and no migration for any of this.
 *
 * ── THE TWO AXES ─────────────────────────────────────────────────────────────
 * NATURE distinguishes a point-in-time RECORD from a standing CONDITION, and is
 * what lets expected provider churn stop rendering as active degradation without
 * lying that it was "resolved":
 *   • EVENT     — it happened; it is never open and never resolvable.
 *                 REMOVED_TOMBSTONE, BALANCE_TX_MISMATCH, INSTRUMENT_IDENTITY_CONFLICT.
 *   • CONDITION — true until something makes it untrue; `resolved` applies.
 *                 Transaction-persistence failures, investment MISSING_ACCOUNT.
 *
 * SEVERITY is semantic impact, never a UI colour:
 *   • critical — canonical financial data is unpersisted and a cursor is held
 *   • error    — a real operation failed, but no financial data is at risk
 *   • warning  — a detector fired; a human should look
 *   • info     — expected provider lifecycle; forensic evidence only
 *
 * ── WHY BALANCE_TX_MISMATCH IS AN EVENT ──────────────────────────────────────
 * It observes ONE refresh window. A later clean window does not prove the
 * earlier gap was filled, so it must never be auto-resolved — doing so would let
 * a "resolved" row still represent missing canonical financial data.
 *
 * PURE: no DB, no clock, no I/O.
 */

/** Which subsystem produced this issue. */
export type SyncIssueDomain =
  | "transactions"    // canonical bank-transaction persistence (Plaid /transactions/sync)
  | "investments"     // holdings / events / instrument identity / opening positions
  | "imports"         // user file-import rollback repair
  | "wallet"          // on-chain wallet sync (BTC)
  | "reconciliation"  // balance↔transaction detector
  | "unknown";        // unrecognised producer — fails LOUD, see classifySyncIssue

export type SyncIssueSeverity = "critical" | "error" | "warning" | "info";
export type SyncIssueNature   = "condition" | "event";

/**
 * What an operator should see this row AS, once its lifecycle and referents are
 * taken into account. Derived at read time; never persisted.
 */
export type SyncIssueState =
  /** An open CONDITION that still needs attention. */
  | "active"
  /** A CONDITION that has since been resolved — historical, not a problem now. */
  | "recovered"
  /** An EVENT: forensic evidence. Never active, never resolvable. */
  | "evidence"
  /** Produced by a rule that no longer exists — a known false positive. */
  | "superseded"
  /** Its subject (account / item) no longer exists, so it describes nothing. */
  | "orphaned";

export interface SyncIssueClassification {
  domain:   SyncIssueDomain;
  severity: SyncIssueSeverity;
  nature:   SyncIssueNature;
  /**
   * True only for issues a MEMBER can act on: their bank transaction sync is
   * degraded and reconnecting may genuinely help. Internal repair failures
   * (investments, imports, wallet) are operator concerns and are EXCLUDED from
   * member-facing surfaces entirely — not merely reworded. Telling someone to
   * reconnect their bank because an instrument-identity merge was refused is
   * noise that erodes trust in every other message we send.
   */
  customerActionable: boolean;
  /**
   * True when this issue caused a Plaid page to be held (Phase 1). ONLY these
   * are eligible for auto-recovery: a later successful sync proves the held page
   * replayed and every row persisted. A pre-Phase-1 failure has NO such proof —
   * its cursor already advanced — so it must never auto-resolve.
   */
  cursorBlocking: boolean;
}

/** The row shape this authority needs. `detail` is read but never re-exposed. */
export interface ClassifiableSyncIssue {
  kind:      string;
  provider?: string | null;
  detail?:   unknown;
  /**
   * STRUCTURAL discriminator, and the one that matters most for member-facing
   * surfaces: ONLY the two bank-transaction-sync producers
   * (lib/plaid/syncTransactions.ts) ever set this. Every investment / import /
   * wallet repair writer leaves it null. It is a scalar COLUMN, so a consumer
   * bound by the "never load SyncIssue.detail" privacy invariant — the member
   * activity route — can still reach the right verdict without touching `detail`.
   * Treated as authoritative when present; `detail.stage` refines the rest.
   */
  plaidTransactionId?: string | null;
}

/** `detail.stage` values, grouped by the subsystem that writes them. */
const STAGE_DOMAIN: Record<string, SyncIssueDomain> = {
  // lib/plaid/syncTransactions.ts — the only financial-data-critical producer.
  "transaction-persist":          "transactions",
  // lib/investments/*
  "opening-position-repair":      "investments",
  "investment-import-repair":     "investments",
  "investment-events-fetch":      "investments",
  "investment-events":            "investments",
  "investment-events-instrument": "investments",
  "reconstruction-repair":        "investments",
  "import-weak-ambiguous":        "investments",
  "import-strong-conflict":       "investments",
  // app/api/imports/[id]/rollback
  "import-rollback-repair":       "imports",
  // lib/crypto/btc-sync.ts (provider = WALLET)
  "discovery":                    "wallet",
  "balance":                      "wallet",
  "price":                        "wallet",
};

/** Narrow `detail` to a readable record without trusting its shape. */
function detailOf(row: ClassifiableSyncIssue): Record<string, unknown> {
  return row.detail && typeof row.detail === "object" && !Array.isArray(row.detail)
    ? (row.detail as Record<string, unknown>)
    : {};
}

export function stageOf(row: ClassifiableSyncIssue): string | null {
  const s = detailOf(row).stage;
  return typeof s === "string" ? s : null;
}

/**
 * Classify one row. Pure.
 *
 * Unrecognised-stage fallback is deliberately CONSERVATIVE for the two
 * transaction kinds: a `UPSERT_ERROR` / `MISSING_ACCOUNT` with no stage is a
 * pre-Phase-4 bank-transaction-sync row (those are the only producers that ever
 * omitted a stage), so it is treated as `transactions` / `critical`. Erring
 * toward "financial data may be missing" is the safe direction; erring the other
 * way would hide exactly the incident this whole initiative exists for.
 */
export function classifySyncIssue(row: ClassifiableSyncIssue): SyncIssueClassification {
  const stage    = stageOf(row);
  const provider = row.provider ?? "PLAID";
  const detail   = detailOf(row);

  // The wallet producer writes generic stage names ("balance") that would
  // otherwise be ambiguous, so provider disambiguates first.
  const domainFromStage: SyncIssueDomain | undefined =
    provider === "WALLET" ? "wallet" : (stage ? STAGE_DOMAIN[stage] : undefined);

  const cursorBlocking = detail.cursorBlocking === true;

  switch (row.kind) {
    case "REMOVED_TOMBSTONE":
      // Expected provider lifecycle: Plaid replaces a pending row with its
      // posted successor. We soft-delete and keep the tombstone as evidence.
      return { domain: "transactions", severity: "info", nature: "event", customerActionable: false, cursorBlocking: false };

    case "BALANCE_TX_MISMATCH":
      return { domain: "reconciliation", severity: "warning", nature: "event", customerActionable: false, cursorBlocking: false };

    case "INSTRUMENT_IDENTITY_CONFLICT":
      // A refused merge: both instruments preserved, nothing lost. Needs a human
      // eventually, but no data is missing and no member action helps.
      return { domain: domainFromStage ?? "investments", severity: "warning", nature: "event", customerActionable: false, cursorBlocking: false };

    case "UPSERT_ERROR":
    case "MISSING_ACCOUNT": {
      // A row naming a specific bank transaction IS bank-transaction sync,
      // whatever else it carries — the structural signal wins.
      const domain: SyncIssueDomain =
        row.plaidTransactionId ? "transactions" : (domainFromStage ?? "transactions");
      const isTransactionPersistence = domain === "transactions";
      // ASYMMETRIC by design. `domain`/`severity` fall back CONSERVATIVELY, so an
      // unclassifiable row shouts at an operator (fail loud). Member visibility
      // does the opposite: it requires an AFFIRMATIVE transaction signal —
      // either the row names a bank transaction, or it is explicitly stamped
      // `transaction-persist`. Never the fallback.
      //
      // Without that asymmetry the member activity route, which is forbidden
      // from loading `detail`, would classify every detail-less repair row as
      // transactions/critical and tell the member to reconnect their bank over
      // an internal investment retry — the exact bug this phase closes. Erring
      // loud is right for operators; erring quiet is right for members.
      const affirmativeTransaction = row.plaidTransactionId != null || stage === "transaction-persist";
      return {
        domain,
        // Only the bank-transaction path can leave canonical financial data
        // unpersisted behind a held cursor. Everything else is a failed
        // best-effort repair the system retries on its own schedule.
        severity: isTransactionPersistence ? "critical" : "error",
        nature:   "condition",
        customerActionable: isTransactionPersistence && affirmativeTransaction,
        cursorBlocking,
      };
    }

    // REPLAY_* are declared in the enum but have no emitters (reserved for the
    // auto-recovery mechanism that was never built). Classify defensively.
    case "REPLAY_ATTEMPTED":
    case "REPLAY_RECOVERED":
      return { domain: "transactions", severity: "info", nature: "event", customerActionable: false, cursorBlocking: false };
    case "REPLAY_FAILED":
      return { domain: "transactions", severity: "critical", nature: "condition", customerActionable: true, cursorBlocking };

    default:
      // An unrecognised kind is a real gap in this authority, not a non-event.
      return { domain: "unknown", severity: "warning", nature: "event", customerActionable: false, cursorBlocking: false };
  }
}

/**
 * True when this BALANCE_TX_MISMATCH was produced by the PRE-Phase-2
 * pending-inclusive rule, which compared a pending-inclusive transaction sum
 * against a posted-basis balance and therefore fired on ordinary pending→posted
 * churn. Phase 2 stamps `basis: "posted"`; rows lacking it predate the fix and
 * are known false positives (both events in the local database are exactly this).
 */
export function isSupersededMismatch(row: ClassifiableSyncIssue): boolean {
  return row.kind === "BALANCE_TX_MISMATCH" && detailOf(row).basis !== "posted";
}

/** Referent existence, resolved by the caller (one batched lookup, not per row). */
export interface SyncIssueReferents {
  /** False when the row names a financialAccountId / plaidItemId that no longer exists. */
  referentExists: boolean;
  resolved: boolean;
}

/**
 * Fold classification + lifecycle + referent existence into the one state an
 * operator surface should render.
 *
 * ORPHANED deserves explanation. A row whose `financialAccountId` or
 * `plaidItemId` does not resolve describes a subject that no longer exists — it
 * cannot be acted on and cannot represent live customer data. Two ways to get
 * there: (a) the referenced account was genuinely deleted since, or (b) the row
 * was never real, e.g. the eight `financialAccountId: "fa1"` rows written into
 * the dev database by a unit test whose mocked client leaked (closed in Phase 2).
 * Both are correctly "not an active incident", and deriving that requires NO row
 * mutation — we never rewrite production-shaped data to make a dashboard tidy.
 */
export function syncIssueState(
  row: ClassifiableSyncIssue,
  ctx: SyncIssueReferents,
): SyncIssueState {
  if (!ctx.referentExists)      return "orphaned";
  if (isSupersededMismatch(row)) return "superseded";
  const { nature } = classifySyncIssue(row);
  if (nature === "event")        return "evidence";
  return ctx.resolved ? "recovered" : "active";
}

/** The only state that means "someone should do something now". */
export function isActiveIncident(row: ClassifiableSyncIssue, ctx: SyncIssueReferents): boolean {
  return syncIssueState(row, ctx) === "active";
}

/** Operator-facing label. Never includes `detail`. */
export function describeSyncIssue(row: ClassifiableSyncIssue): string {
  const { domain, severity } = classifySyncIssue(row);
  const stage = stageOf(row);
  const kind  = row.kind.replace(/_/g, " ").toLowerCase();
  return `${severity} · ${domain} · ${kind}${stage ? ` (${stage})` : ""}`;
}
