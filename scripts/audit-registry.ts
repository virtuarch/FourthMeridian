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
 *   OPERATIONAL    A TOOL, not an audit (REVIEW-3 W3 extended the governed
 *                  shapes to backfill-* / repair-* / diagnose-*). A maintained
 *                  migration, remediation, or diagnostic command — dry-run by
 *                  default where it writes, run by an operator on purpose.
 *                  NEVER run by CI or by --tier=all (a tool is not a gate);
 *                  classified here so an ungoverned script shape cannot
 *                  accumulate again and so the inventory says why each exists.
 *
 *   RETIRED        Its job is done — a pre-migration check for a migration that
 *                  is applied, a companion to a completed backfill, a one-time
 *                  data fix. Kept for the historical record and explicitly
 *                  marked so nobody mistakes it for a live gate. Never run by CI.
 *                  An entry with `tombstone: true` records a retired script
 *                  whose FILE was also deleted (REVIEW-3 W3): the entry is the
 *                  historical record, and the runner fails if the name ever
 *                  reappears on disk without a conscious re-classification.
 *
 * The rule every REQUIRED script obeys, and the one this arc had to repair in
 * four of them: **the symbol and the exit code agree.** ✗ means the process
 * exits 1. If it does not, the audit is lying, and an audit that lies is worse
 * than no audit — it manufactures confidence.
 */

export type AuditTier = "REQUIRED" | "INFORMATIONAL" | "OPERATIONAL" | "RETIRED";

export interface AuditEntry {
  /** Script basename under scripts/, without the .ts. */
  name: string;
  tier: AuditTier;
  /** What invariant it asserts (REQUIRED) or what it reports (otherwise). */
  what: string;
  /** For RETIRED: what completed, making it historical. */
  retiredBecause?: string;
  /** RETIRED only: the script file itself was deleted; this entry is the record. */
  tombstone?: true;
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
    name: "audit-debt-payment-attestation", tier: "REQUIRED", needsDb: true,
    what: "every counted debt payment is POSITIVELY attested — an owned liability counterparty " +
          "or a proven liability destination TYPE; absence of contradiction never admits",
  },
  {
    name: "audit-cashflow-debt-defect", tier: "REQUIRED", needsDb: true,
    what: "no transfer is counted as a debt payment, no leg is double-counted, and every " +
          "creditor group is an owned liability account",
  },
  {
    name: "audit-ai-read-parity", tier: "REQUIRED", needsDb: true,
    what: "the AI reads the SAME population the product does — bankingTransactionWhere windowed " +
          "on economicDate — with no superseded observation, no gate drift, and no drilldown row " +
          "the model can cite but no surface can show",
  },
  {
    name: "audit-transfer-identification", tier: "REQUIRED", needsDb: true,
    what: "the identification rung only NARROWS a qualifying candidate set, and never names an " +
          "account that contradicts a counterparty an approved repair already persisted",
  },
  {
    name: "audit-snapshot-window-claims", tier: "REQUIRED", needsDb: true,
    what: "a snapshot section's spanDays is the TRUE calendar distance between its endpoints " +
          "(never the row count), and its canonicalChange is reproducible by the same " +
          "compareToForPreset authority the Space launcher and the inside-Space selector use",
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
  {
    // W2 — goals tombstone. Source-only: the corpus it audits is the repository.
    name: "audit-goals-tombstone", tier: "REQUIRED", needsDb: false,
    what: "no runtime path reads, writes, or speaks retired goal state — Goals/Retirement are " +
          "schema-only residue awaiting the migration train; intent-shaped deficit causes stay " +
          "structurally unreachable; the W2 deletion set stays deleted",
  },
  {
    // W5 — crypto current-value authority. Source-only: the corpus is the repo.
    name: "audit-crypto-holding-tombstone", tier: "REQUIRED", needsDb: false,
    what: "one current-value authority for positions, crypto included — no production read " +
          "path touches the legacy Holding table; the crypto bridge, its dedup rule and " +
          "btc-sync's Holding dual-write stay deleted; wallets ride the PositionObservation " +
          "spine valued at dated archive prices, and a wallet without observations is " +
          "honestly absent (the last Holding toucher is the documented reader-less " +
          "brokerage projection writer, awaiting its own deletion condition)",
  },
  {
    // W1 (D6) — INV-19. Source-only: the corpus it audits is the repository.
    name: "audit-read-identity-consumers", tier: "REQUIRED", needsDb: false,
    what: "no product READ derives transaction identity from a non-event key — the fingerprint " +
          "module is importable by write paths only, the similarity evidence defers to " +
          "TransactionEvent (cross-event exclusion + DF-4 raw-descriptor key), and " +
          "wallet/crypto rows stay outside the banking event domain",
  },

  // ── INFORMATIONAL — reports and investigations, never a gate ──────────────
  {
    name: "audit-surface-independence", tier: "INFORMATIONAL", needsDb: false,
    what: "v2.6-REVIEW-1 source census: where a RENDERING surface does the financial arithmetic " +
          "itself — aggregation, ratio, or a threshold verdict. Candidates to read, not defects; " +
          "the measure of whether judgment has actually left the components",
  },
  {
    name: "audit-seed-coverage", tier: "INFORMATIONAL", needsDb: true,
    what: "v2.6-SEED-1: WHICH architectural states a corpus contains — the acceptance contract " +
          "for a reseed (every PRESENT state must survive; names may change, coverage may not " +
          "shrink). Passing invariants prove nothing on a corpus that cannot express their " +
          "failure mode; this measures the states that let them bite",
  },
  {
    name: "audit-emergency-fund-footprint", tier: "INFORMATIONAL", needsDb: true,
    what: "v2.6-LEGACY-1 census: what a user can actually create (only `family` and `custom` are " +
          "live), how many Spaces carry each category, and every remaining Emergency Fund " +
          "reference classified CODE / SCHEMA / SEED-ONLY / TEST — the measurement that showed " +
          "the EF surfaces are unreachable and the goal primitive lived in the goal tables " +
          "(retired W2; schema residue awaits the migration train)",
  },
  {
    name: "audit-ef-hero-coverage-divergence", tier: "INFORMATIONAL", needsDb: true,
    what: "v2.6-ASSESS-4 census: the Overview EF hero's numerator (a stored snapshot's SAVINGS " +
          "component) against the canonical liquidity numerator (REACHABLE checking+savings) — " +
          "the measurement that showed the hero is a SECOND judgment, not a baseline divergence, " +
          "and that converging its denominator alone would align two disagreeing answers' divisors",
  },
  {
    name: "audit-coverage-fraction-divergence", tier: "INFORMATIONAL", needsDb: true,
    what: "v2.6-ASSESS-2 census: BOTH halves of \"months of expenses covered\" per Space — the " +
          "reachable-vs-ledger numerators and the declared-vs-measured denominators — so a " +
          "convergence is aimed at the half that actually moves (measured: numerators agree, " +
          "denominators do not)",
  },
  {
    name: "audit-coverage-baseline-divergence", tier: "INFORMATIONAL", needsDb: true,
    what: "v2.6-ASSESS-1 census: the DECLARED monthly-expense baseline (the emergency_fund_progress " +
          "config the Liquidity workspace and the EF hero divide by) against the MEASURED one " +
          "(computeAverageMonthlySpending, which the assessment engine divides by) — two baselines " +
          "for one judgment. A corpus count, not an invariant; the refusal invariant it led to is " +
          "pinned in CI by lib/ai/intelligence/liquidity-baseline-refusal.test.ts",
  },
  {
    name: "audit-brief-assessment-parity", tier: "INFORMATIONAL", needsDb: true,
    what: "v2.6-BRIEF-1: varies ONLY scopeHint and reports which computeAssessment " +
          "conclusions move on the hint alone — a corpus drift count, not an invariant. " +
          "The invariant it led to (the engine must not grade a truncated payload) is " +
          "pinned in CI by lib/ai/intelligence/brief-scope-adequacy.test.ts",
  },
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

  // ── OPERATIONAL — maintained tools under the extended governance ──────────
  // backfill-* / repair-* / diagnose-* shapes require classification here
  // (REVIEW-3 W3). The completed one-shots and closed-incident forensics were
  // deleted in the same wave; these are the ones with a live reason to exist.
  {
    name: "backfill-flowtype", tier: "OPERATIONAL", needsDb: true,
    what: "the ownership-scoped flow reclassification tool — the remediation path the REQUIRED " +
          "audit-flow-desync gate names verbatim for version-stale CLASSIFIER-owned rows " +
          "(--only-version=<N> --apply --exclude-deleted); dry-run by default, idempotent",
  },
  {
    name: "backfill-fx-rates", tier: "OPERATIONAL", needsDb: true,
    what: "historical FX rate backfill + archive spot-check (MC1 P1 S3); " +
          "docs/operations/background-jobs.md names it as the FX-gap self-heal path",
  },
  {
    name: "backfill-economic-date", tier: "OPERATIONAL", needsDb: true,
    what: "populates Transaction.economicDate from the proven read authority (L8-A); " +
          "re-runnable companion to the economicDate persistence gates (npm run backfill:economic-date)",
  },
  {
    name: "backfill-event-identity", tier: "OPERATIONAL", needsDb: true,
    what: "reconstructs observations and logical events from corpus evidence (L8 Part 5); " +
          "the event system is undeployed to production — REQUIRED at event-migration deploy time",
  },
  {
    name: "backfill-ai-agents", tier: "OPERATIONAL", needsDb: true,
    what: "creates an AiAgent row for any Space missing one; idempotent bootstrap " +
          "(npm run backfill:ai-agents)",
  },
  {
    name: "backfill-snapshots", tier: "OPERATIONAL", needsDb: true,
    what: "manual runner for the historical snapshot backfill (D2.x S4) " +
          "(npm run backfill:snapshots)",
  },
  {
    name: "backfill-merchant-intelligence", tier: "OPERATIONAL", needsDb: true,
    what: "Merchant Intelligence M3 historical backfill — offline migration utility " +
          "(npm run backfill:merchant-intelligence)",
  },
  {
    name: "backfill-personal-sections", tier: "OPERATIONAL", needsDb: true,
    what: "ensures every Personal Space has the hidden `personal` template's section rows " +
          "(SP-2A-3) (npm run backfill:personal-sections)",
  },
  {
    name: "repair-event-identity-adoption-artifacts", tier: "OPERATIONAL", needsDb: true,
    what: "repairs live-data residue of the fingerprint-adoption defect v2.6-EVENT-2 fixed at " +
          "the write path; RETAIN UNTIL the event-migration production deploy completes — " +
          "production has no TransactionEvent table yet, so the residue may still be created there",
  },
  {
    name: "repair-event-projection-drift", tier: "OPERATIONAL", needsDb: true,
    what: "re-derives stored TransactionEvent projections that disagree with their observations " +
          "(v2.6-EVENT-1); RETAIN UNTIL the event-migration production deploy completes",
  },
  {
    name: "diagnose-invalid-plaid-tokens", tier: "OPERATIONAL", needsDb: true,
    what: "READ-ONLY diagnostic for PlaidItem rows whose encryptedToken is neither v1 nor v2; " +
          "step 2 of the key-rotation runbook (docs/operations/key-rotation.md)",
  },
  {
    name: "check-schema-drift", tier: "OPERATIONAL", needsDb: true,
    what: "READ-ONLY comparison of prisma/migrations/ against the target database's " +
          "_prisma_migrations ledger (npm run db:drift); exits 1 on pending, unfinished, " +
          "rolled-back, or unknown-to-the-repo migrations. A TOOL, not a gate: the build is " +
          "`prisma generate && next build`, so nothing deploys schema and a deploy can ship " +
          "code ahead of its columns — that gap ran for ten hours on 2026-07-26. Applying is " +
          "a separate, deliberate step (npm run db:migrate:safe, which backs up first)",
  },

  // ── RETIRED — their job is done ───────────────────────────────────────────
  // All five below are TOMBSTONES: the files were deleted in REVIEW-3 W3, the
  // entries remain as the historical record, and the runner refuses a script
  // reappearing under a tombstoned name.
  {
    name: "check-external-id-duplicates", tier: "RETIRED", tombstone: true, needsDb: true,
    what: "pre-migration duplicate check for the BTC identity backstop unique index",
    retiredBecause: "migration 20260727_v26pre_b4_btc_identity_backstop is applied; the index " +
                    "now enforces what this checked",
  },
  {
    name: "audit-visibility-levels", tier: "RETIRED", tombstone: true, needsDb: true,
    what: "KD-1 pre-flight: no SpaceAccountLink carries the legacy SHARED visibility",
    retiredBecause: "KD-1 shipped; TRANSACTION_DETAIL_VISIBILITY is enforced in every read path " +
                    "and pinned by lib/visibility-resolver-parity.test.ts",
  },
  {
    name: "verify-provider-account-identity-backfill", tier: "RETIRED", tombstone: true, needsDb: true,
    what: "companion validation for the D2 Step 1C ProviderAccountIdentity backfill",
    retiredBecause: "the backfill is applied and ProviderAccountIdentity is written at connect time",
  },
  {
    name: "verify-orphaned-plaid-items", tier: "RETIRED", tombstone: true, needsDb: true,
    what: "companion validation for the orphaned-PlaidItem cleanup",
    retiredBecause: "the incident is closed; account deletion now revokes or holds (PRE-BETA-OPS-CLOSE)",
  },
  {
    name: "verify-seed-emails", tier: "RETIRED", tombstone: true, needsDb: true,
    what: "one-time data fix marking the four dev seed users' emails verified",
    retiredBecause: "prisma/seed.ts sets emailVerified itself; despite the `verify-` prefix this " +
                    "script WROTE, so it must never be mistaken for an audit",
  },

  // ── RETIRED — the AI conversation harnesses ───────────────────────────────
  // ⚠️ FOURTEEN TOMBSTONES FROM ONE DECISION. Every one measured the behaviour of
  // the conversation architecture removed in the AI conversation reset; each was a
  // paid, stochastic OPERATIONAL tool, never a gate. They are recorded rather than
  // erased so the next conversation layer can see what was being measured, and so
  // the runner refuses a script quietly reappearing under one of these names.
  {
    name: "audit-retrieval-plan", tier: "RETIRED", tombstone: true, needsDb: false,
    what: "CF-8 — reported the difference between the retrieval plan and what production assembled",
    retiredBecause: "the retrieval planner was deleted with the conversation layer; the AI conversation reset removed the architecture it measured (docs/plans/AI-CONVERSATION-RESET.md)",
  },
  {
    name: "audit-temporal-framing", tier: "RETIRED", tombstone: true, needsDb: false,
    what: "CF-2 — ran a temporal ask corpus through the real production prompt and reported the four authorities as rendered",
    retiredBecause: "there is no production prompt to render; the temporal AUTHORITIES survive and are pinned by lib/ai/temporal-scope.test.ts. the AI conversation reset removed the architecture it measured (docs/plans/AI-CONVERSATION-RESET.md)",
  },
  {
    name: "audit-bounded-disclosure", tier: "RETIRED", tombstone: true, needsDb: false,
    what: "CF-1 — rendered the real system prompt per Space and reported what every bounded list disclosed",
    retiredBecause: "the system prompt was deleted; boundedSelection survives and is pinned by lib/ai/bounded-selection.test.ts. the AI conversation reset removed the architecture it measured (docs/plans/AI-CONVERSATION-RESET.md)",
  },
  {
    name: "check-evidence-awareness", tier: "RETIRED", tombstone: true, needsDb: false,
    what: "CF-5 — asked a live model what evidence exists and graded five failure modes",
    retiredBecause: "the prompt path it exercised is gone; the coverage envelope survives and is pinned by lib/ai/coverage-envelope.test.ts. the AI conversation reset removed the architecture it measured (docs/plans/AI-CONVERSATION-RESET.md)",
  },
  {
    name: "check-conversation-scope", tier: "RETIRED", tombstone: true, needsDb: false,
    what: "CF-4 — held live multi-turn conversations and failed on temporal drift or robotic restatement",
    retiredBecause: "conversation scope was conversation machinery and went with it; the AI conversation reset removed the architecture it measured (docs/plans/AI-CONVERSATION-RESET.md)",
  },
  {
    name: "check-temporal-conformance", tier: "RETIRED", tombstone: true, needsDb: false,
    what: "CF-2 — graded a live model for temporal overreach and over-hedging against the real prompt",
    retiredBecause: "the AI conversation reset removed the architecture it measured (docs/plans/AI-CONVERSATION-RESET.md)",
  },
  {
    name: "check-bounded-superlatives", tier: "RETIRED", tombstone: true, needsDb: false,
    what: "CF-1 — graded a live model's superlative claims against the rendered bounded list",
    retiredBecause: "the AI conversation reset removed the architecture it measured (docs/plans/AI-CONVERSATION-RESET.md)",
  },
  {
    name: "check-conformance-scenarios", tier: "RETIRED", tombstone: true, needsDb: false,
    what: "A4.2 — the multi-turn and cross-Space half of the assessment conformance harness",
    retiredBecause: "the AI conversation reset removed the architecture it measured (docs/plans/AI-CONVERSATION-RESET.md)",
  },
  {
    name: "check-assessment-conformance", tier: "RETIRED", tombstone: true, needsDb: false,
    what: "A4 — measured whether the model followed the deterministic assessment and the A3 precedence contract",
    retiredBecause: "the assessment SURVIVES (lib/ai/intelligence) and is pinned by its own unit tests; what was measured here was the model's obedience to a prompt that no longer exists. the AI conversation reset removed the architecture it measured (docs/plans/AI-CONVERSATION-RESET.md)",
  },
  {
    name: "check-forecast-conformance", tier: "RETIRED", tombstone: true, needsDb: false,
    what: "FORECAST-11 — measured whether the model narrated the deterministic forecast block or computed its own",
    retiredBecause: "the forecast ENGINE survives (lib/forecast, lib/ai/forecast) with its own unit suite; the narration it graded does not. the AI conversation reset removed the architecture it measured (docs/plans/AI-CONVERSATION-RESET.md)",
  },
  {
    name: "check-forecast-multiturn", tier: "RETIRED", tombstone: true, needsDb: false,
    what: "FORECAST-12 — forecast acceptance across a conversation rather than a turn",
    retiredBecause: "the AI conversation reset removed the architecture it measured (docs/plans/AI-CONVERSATION-RESET.md)",
  },
  {
    name: "check-answer-boundary", tier: "RETIRED", tombstone: true, needsDb: false,
    what: "V26-REASONING Slice 1 — measured the typed answer boundary end to end on seven adversarial cases",
    retiredBecause: "the typed answer boundary was deleted; the AI conversation reset removed the architecture it measured (docs/plans/AI-CONVERSATION-RESET.md)",
  },
  {
    name: "check-conversation-gate", tier: "RETIRED", tombstone: true, needsDb: false,
    what: "V26-REASONING Slice 4 — one seven-turn conversation asking whether the product worked",
    retiredBecause: "the scenario lifecycle it drove was deleted; the QUESTION it asked is the right one and should shape the exemplar conversations the next layer is designed from. the AI conversation reset removed the architecture it measured (docs/plans/AI-CONVERSATION-RESET.md)",
  },
  {
    name: "compare-plans", tier: "RETIRED", tombstone: true, needsDb: false,
    what: "V26-REASONING Slice 5 — ran the typed planner and the legacy routing over 112 real questions and reported agreement per class",
    retiredBecause: "it shipped with a deletion condition and both planners are now gone; the AI conversation reset removed the architecture it measured (docs/plans/AI-CONVERSATION-RESET.md)",
  },
];

export const REQUIRED_AUDITS = AUDITS.filter((a) => a.tier === "REQUIRED");
export const INFORMATIONAL_AUDITS = AUDITS.filter((a) => a.tier === "INFORMATIONAL");
export const OPERATIONAL_TOOLS = AUDITS.filter((a) => a.tier === "OPERATIONAL");
export const RETIRED_AUDITS = AUDITS.filter((a) => a.tier === "RETIRED");
