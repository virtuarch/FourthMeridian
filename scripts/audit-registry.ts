/**
 * scripts/audit-registry.ts
 *
 * v2.6-OWN-2 — THE inventory of every architecture audit, and what each one is
 * allowed to do to a build.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The repository accumulated 25 audit/check/verify scripts and CI executed
 * exactly zero of them. Every architectural proof in docs/plans/ was a snapshot
 * of a moment nothing preserved: a regression could merge while every invariant
 * silently failed, and one (`audit:flow-desync`) was in fact failing, unnoticed,
 * with a remediation that would have reverted approved repairs.
 *
 * The fix is not "run everything in CI". Most of these scripts are not gates —
 * they are corpus reports, one-off investigations, or companions to migrations
 * that landed months ago. Running them all would produce noise that teaches the
 * team to ignore red, which is the same failure in a new costume.
 *
 * So each script is classified ONCE, here, and the classification is what CI
 * reads. The tiers:
 *
 *   REQUIRED       An INVARIANT. It must hold on ANY corpus — a fresh seed,
 *                  the dev database, production. It exits non-zero iff the
 *                  invariant is breached. CI runs it on every PR and the build
 *                  fails if it does. Corpus-specific expectations are forbidden
 *                  here; a number that is true of one database is a report, not
 *                  an invariant.
 *
 *   INFORMATIONAL  A REPORT. It describes a corpus, proposes repairs, or
 *                  measures an investigation. It may legitimately have findings.
 *                  It must never print ✗ (findings are ⚠), and CI does not run
 *                  it. Runnable on demand.
 *
 *   RETIRED        Its job is done — a pre-migration check for a migration that
 *                  is applied, a companion to a completed backfill, a one-time
 *                  data fix. Kept for the historical record and explicitly
 *                  marked so nobody mistakes it for a live gate. Never run by CI.
 *
 * The rule every REQUIRED script obeys, and the one this arc had to repair in
 * four of them: **the symbol and the exit code agree.** ✗ means the process
 * exits 1. If it does not, the audit is lying, and an audit that lies is worse
 * than no audit — it manufactures confidence.
 */

export type AuditTier = "REQUIRED" | "INFORMATIONAL" | "RETIRED";

export interface AuditEntry {
  /** Script basename under scripts/, without the .ts. */
  name: string;
  tier: AuditTier;
  /** What invariant it asserts (REQUIRED) or what it reports (otherwise). */
  what: string;
  /** For RETIRED: what completed, making it historical. */
  retiredBecause?: string;
  /** True when the script reads a database. Everything here does except one. */
  needsDb: boolean;
}

export const AUDITS: readonly AuditEntry[] = [
  // ── REQUIRED — architecture invariants, corpus-independent ────────────────
  {
    name: "audit-flow-desync", tier: "REQUIRED", needsDb: true,
    what: "every flowType value names the authority that produced it (INV-A/B/C), " +
          "and every CLASSIFIER-owned row is reproducible by the canonical classifier",
  },
  {
    name: "audit-crypto-banking-leak", tier: "REQUIRED", needsDb: true,
    what: "no CRYPTO_LEDGER row enters a banking population or a banking meaning, and income " +
          "attribution refuses one even given maximally income-like evidence (INV-C4)",
  },
  {
    name: "audit-banking-population", tier: "REQUIRED", needsDb: true,
    what: "the SQL population fragment and the row-level predicate denote the SAME set, " +
          "per flow value and by id — and an unclassified row stays reachable (INV-P1/P2/P3)",
  },
  {
    name: "audit-economic-date-persistence", tier: "REQUIRED", needsDb: true,
    what: "every row's persisted economicDate equals what the economic-date authority derives",
  },
  {
    name: "audit-chronology-basis", tier: "REQUIRED", needsDb: true,
    what: "flow measures read the economic date and balance measures read the posting date — " +
          "no flow aggregate is keyed on posting, every economic date is FX-enumerable, and the " +
          "DTO date seam documents the basis it implements (INV-B1/B2/B3)",
  },
  {
    name: "audit-chronology-cutover", tier: "REQUIRED", needsDb: true,
    what: "every row carries an economic date, CONTRADICTORY rows stay on posting, " +
          "keyset paging returns every row exactly once, and count == list population per filter",
  },
  {
    name: "audit-event-identity", tier: "REQUIRED", needsDb: true,
    what: "the eight structural event-identity invariants, incl. one live row per event " +
          "and no crypto observation in the banking tables",
  },
  {
    name: "audit-event-reader-cutover", tier: "REQUIRED", needsDb: true,
    what: "the event-projection filter removes no row and moves no headline total",
  },
  {
    name: "audit-pending-posted-desync", tier: "REQUIRED", needsDb: true,
    what: "no live pending row has a live posted successor (the double-count guard)",
  },
  {
    name: "audit-lifecycle-identity", tier: "REQUIRED", needsDb: true,
    what: "lifecycle resolution and transaction identity hold across the corpus",
  },
  {
    name: "audit-ui-truth-convergence", tier: "REQUIRED", needsDb: true,
    what: "every presentation surface reads its canonical authority — debt membership, " +
          "income taxonomy, issuer credits, and cross-surface debt parity",
  },
  {
    name: "audit-cashflow-debt-defect", tier: "REQUIRED", needsDb: true,
    what: "no transfer is counted as a debt payment, no leg is double-counted, and every " +
          "creditor group is an owned liability account",
  },
  {
    name: "audit-transfer-authority", tier: "REQUIRED", needsDb: true,
    what: "the admission census balances, no leg id or account id is fabricated, and every " +
          "unresolved row carries a named limitation (ladder DISTRIBUTIONS are advisory)",
  },
  {
    name: "check-snapshot-integrity", tier: "REQUIRED", needsDb: true,
    what: "a stored balance component is a magnitude — never negative, never non-finite",
  },

  // ── INFORMATIONAL — reports and investigations, never a gate ──────────────
  {
    name: "audit-unattested-debt-payments", tier: "INFORMATIONAL", needsDb: true,
    what: "investigation: which counted debt payments rest on provider assertion rather than " +
          "structural destination evidence",
  },
  {
    name: "audit-economic-date-calibration", tier: "INFORMATIONAL", needsDb: true,
    what: "re-derives the transfer authority's windows on the economic chronology; a one-off " +
          "calibration, kept so the derivation is re-runnable",
  },
  {
    name: "audit-snapshot-integrity", tier: "INFORMATIONAL", needsDb: true,
    what: "repository-wide snapshot component-to-stored equality report; the production runbook " +
          "reads it before authorising a regeneration",
  },
  {
    name: "audit-ciphertext-versions", tier: "INFORMATIONAL", needsDb: true,
    what: "encryption-at-rest format census per table.field (SEC-1 / KD-6)",
  },
  {
    name: "check-price-coverage", tier: "INFORMATIONAL", needsDb: true,
    what: "historical price coverage against owned instruments",
  },
  {
    name: "check-quantity-replay-readiness", tier: "INFORMATIONAL", needsDb: true,
    what: "whether the corpus can support a historical quantity replay",
  },
  {
    name: "check-acquisition-plan", tier: "INFORMATIONAL", needsDb: true,
    what: "price-acquisition planning dry run",
  },
  {
    name: "check-job-health", tier: "INFORMATIONAL", needsDb: false,
    what: "operator CLI over the dead-job detector; reports RUNTIME state, which is not a " +
          "property of the code under test",
  },
  {
    name: "verify-flow-ownership", tier: "INFORMATIONAL", needsDb: true,
    what: "before/after proof for the v2.6-OWN-1 ownership stamp: the FINANCIAL fingerprint " +
          "must not move while the OWNERSHIP fingerprint does",
  },

  // ── RETIRED — their job is done ───────────────────────────────────────────
  {
    name: "check-external-id-duplicates", tier: "RETIRED", needsDb: true,
    what: "pre-migration duplicate check for the BTC identity backstop unique index",
    retiredBecause: "migration 20260727_v26pre_b4_btc_identity_backstop is applied; the index " +
                    "now enforces what this checked",
  },
  {
    name: "audit-visibility-levels", tier: "RETIRED", needsDb: true,
    what: "KD-1 pre-flight: no SpaceAccountLink carries the legacy SHARED visibility",
    retiredBecause: "KD-1 shipped; TRANSACTION_DETAIL_VISIBILITY is enforced in every read path " +
                    "and pinned by lib/visibility-resolver-parity.test.ts",
  },
  {
    name: "verify-provider-account-identity-backfill", tier: "RETIRED", needsDb: true,
    what: "companion validation for the D2 Step 1C ProviderAccountIdentity backfill",
    retiredBecause: "the backfill is applied and ProviderAccountIdentity is written at connect time",
  },
  {
    name: "verify-orphaned-plaid-items", tier: "RETIRED", needsDb: true,
    what: "companion validation for the orphaned-PlaidItem cleanup",
    retiredBecause: "the incident is closed; account deletion now revokes or holds (PRE-BETA-OPS-CLOSE)",
  },
  {
    name: "verify-seed-emails", tier: "RETIRED", needsDb: true,
    what: "one-time data fix marking the four dev seed users' emails verified",
    retiredBecause: "prisma/seed.ts sets emailVerified itself; despite the `verify-` prefix this " +
                    "script WRITES, so it must never be mistaken for an audit",
  },
];

export const REQUIRED_AUDITS = AUDITS.filter((a) => a.tier === "REQUIRED");
export const INFORMATIONAL_AUDITS = AUDITS.filter((a) => a.tier === "INFORMATIONAL");
export const RETIRED_AUDITS = AUDITS.filter((a) => a.tier === "RETIRED");
