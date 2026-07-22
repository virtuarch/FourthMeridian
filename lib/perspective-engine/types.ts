/**
 * lib/perspective-engine/types.ts
 *
 * Perspective Engine contracts (foundation slice, commit 1 of the approved
 * plan in docs/investigations/PERSPECTIVE_ENGINE_FOUNDATION_INVESTIGATION.md).
 *
 * A "lens" is a pure async server-side function that answers one financial
 * question about one Space, deterministically, from already-visibility-
 * -redacted data. This file defines only the contracts; lens implementations
 * land in later commits (Liquidity, Debt), and consumers (API route, widget
 * wiring) later still. The engine is the core reusable layer — any HTTP
 * route added later is a consumer of computePerspective(), never the center
 * of the design. Future consumers: Space Dashboard, Meridian Analyst, Daily
 * Brief, AI context (D4), saved Perspectives.
 *
 * ── Contract rules (enforced by lib/perspective-engine/engine.test.ts) ──────
 * - Everything is serialisable: no Date instances, no functions, no class
 *   instances (same rule as lib/data/* and lib/brief-types.ts).
 * - Deterministic: identical inputs + injected clock → byte-identical JSON.
 * - Name-free: verdicts, metric labels, assumptions, redaction strings, and
 *   error payloads never contain account names or institution names.
 *   Provenance carries FinancialAccount ids only.
 * - Fail closed and fail shaped: a lens never throws to its caller, and a
 *   non-"ok" result is still a fully-formed, render-safe LensResult.
 * - No LLM anywhere: lens numbers are arithmetic over deterministic reads.
 *   Nothing under lib/perspective-engine/ may import lib/ai/provider or
 *   lib/plaid/encryption (guard-tested).
 *
 * ── Visibility posture (inherited, not reimplemented) ───────────────────────
 * Lenses read through lib/data/accounts.ts#getAccounts(), which already
 * enforces KD-19 redaction (FULL vs BALANCE_ONLY sanitization) over
 * SpaceAccountLink. SUMMARY_ONLY accounts contribute to NO numeric aggregate
 * (stricter than BALANCE_ONLY); they appear only in tierCounts and a
 * redaction line. See investigation §2.3 and §5.
 */

// ── Lens identity ─────────────────────────────────────────────────────────────

/**
 * Closed set of lens ids. Grows one approved lens at a time (feasibility
 * matrix, investigation §3). Commit 1 declares the approved first-slice ids;
 * their implementations land in commits 2–3. Registration — not membership
 * in this union — is what makes a lens computable (see registry.ts).
 */
export type LensId = "liquidity" | "debt";

// ── Scope ─────────────────────────────────────────────────────────────────────

/**
 * v1 scope: exactly one Space, viewed as one member. No cross-Space scopes,
 * no sub-Space account selections (both are explicitly out of scope for the
 * foundation slice — see investigation §5.7 on aggregate inference before
 * any sub-scope work).
 *
 * `userId` is the VIEWING member and drives visibility: callers must always
 * pass the requesting user, never a stored or elevated identity.
 */
export interface PerspectiveScope {
  spaceId: string;
  userId:  string;
}

// ── Completeness (A5-S1 — the single shared trust vocabulary) ─────────────────

/**
 * The canonical trust tiers, ordered best → worst (this ordering IS the trust
 * ranking used by worstTier() in ./completeness.ts):
 *   observed   — a provider or the user stated it for that date (live balance,
 *                posted transaction, same-day non-estimated SpaceSnapshot,
 *                PositionObservation.origin=OBSERVED).
 *   derived    — FM computed it deterministically from observed anchors
 *                (cash/card walk-backs, snapshot carry-forward, A4 reconstruction).
 *   estimated  — heuristic or flat-hold (non-cash held flat, FX walk-back miss,
 *                balance×APR/12, isEstimated=true snapshots).
 *   incomplete — the data cannot answer (before transaction depth, before first
 *                observation): a GAP statement, never a number presented as whole.
 *   unknown    — the method itself cannot be determined (SUMMARY_ONLY accounts,
 *                unrecognized types).
 *
 * This enum is THE trust vocabulary for the whole platform going forward.
 * `PositionObservation.completeness` (a reserved-null String column since A1)
 * MUST adopt these exact string values when A4 writes DERIVED rows — A4 imports
 * COMPLETENESS_TIERS from ./completeness and refuses any non-member value at
 * write time. Do not mint a parallel vocabulary (the drift A5 exists to prevent).
 */
export type CompletenessTier =
  | "observed"
  | "derived"
  | "estimated"
  | "incomplete"
  | "unknown";

/**
 * The trust envelope a Perspective result carries when it answers as-of a date.
 * Runtime-only — never a table (the ratified anti-`FinancialState` ruling).
 */
export interface Completeness {
  /** Worst tier among the contributing components (worstTier, ./completeness). */
  tier: CompletenessTier;
  /**
   * Orthogonal flag: two same-tier sources disagree (provider vs import,
   * residual beyond tolerance). A conflicted value may still have a tier; the
   * flag blocks aggregation and forces a drill-down surface. ORs upward through
   * propagation (propagateCompleteness, ./completeness).
   */
  conflict: boolean;
  /** One deterministic, name-free sentence explaining the tier. */
  reason: string;
  /** Earliest date this Perspective can answer for (YYYY-MM-DD), when bounded. */
  coverageFrom?: string;
  /** Per-metric / per-account tier detail, never collapsed away. */
  byComponent?: Record<string, CompletenessTier>;
}

// ── Result building blocks ────────────────────────────────────────────────────

export type LensStatus = "ok" | "empty" | "error";

/**
 * Tone vocabulary matches BriefTone (lib/brief-types.ts) minus "info" so a
 * future Daily Brief consumer maps 1:1 without translation.
 */
export type LensTone = "neutral" | "positive" | "warning" | "danger";

export interface LensMetric {
  id:      string;
  /** Human label. Never an account or institution name. */
  label:   string;
  value:   number | string;
  format:  "currency" | "percent" | "count" | "text" | "date";
  tone?:   LensTone;
  /**
   * True when the value is a heuristic/estimate (e.g. estimateMinimumPayment
   * from lib/debt.ts). UI must render estimated values labeled as such, and
   * a matching LensAssumption must be present in the result.
   */
  estimated?: boolean;
}

export interface LensAssumption {
  id:     string;
  /** One deterministic human sentence. Name-free. */
  text:   string;
  /**
   * Where the assumed value came from:
   *   default  — a lens-defined constant (e.g. "investments treated as
   *              accessible within days, before any tax or penalty")
   *   user     — a user-entered value (e.g. DebtProfile.apr)
   *   provider — a provider-reported value (e.g. FinancialAccount.interestRate)
   *   estimate — a computed heuristic (e.g. estimated minimum payment)
   */
  source: "default" | "user" | "provider" | "estimate";
}

export interface LensProvenance {
  /**
   * FinancialAccount ids that contributed to this result. Ids only — never
   * names. Sorted ascending so equal inputs serialize identically.
   */
  accountIds: string[];
  /**
   * How many contributing (or deliberately excluded) accounts sat at each
   * visibility tier, so the UI can say "4 accounts (1 balance-only)".
   * summaryOnly accounts are counted here and NOWHERE else numeric.
   */
  tierCounts: { full: number; balanceOnly: number; summaryOnly: number };
  /**
   * Oldest input freshness among contributing accounts (ISO string):
   * balanceLastUpdatedAt where known, else lastUpdated. Null when there are
   * no contributing accounts. UI renders "as of …" and never asserts
   * freshness beyond this.
   */
  dataAsOf: string | null;
  /**
   * What was deliberately withheld, phrased tier-safely and name-free,
   * e.g. "Rate detail withheld for 1 shared account". Empty when nothing
   * was withheld. Never phrased so as to reveal a hidden account's type or
   * existence beyond its tier count (investigation §5.4).
   */
  redactions: string[];
}

// ── Errors ────────────────────────────────────────────────────────────────────

/**
 * Category codes only — never raw error text, which could embed account
 * data. LENS_NOT_REGISTERED is produced by the engine itself when asked for
 * an id with no registered implementation (a caller/config error surfaced
 * shaped rather than thrown, so batch consumers degrade per-lens).
 */
export type LensErrorCode =
  | "DATA_UNAVAILABLE"
  | "COMPUTE_FAILED"
  | "LENS_NOT_REGISTERED";

// ── The result ────────────────────────────────────────────────────────────────

export interface LensResult {
  lensId: LensId;
  /**
   * Bumped when a lens's math or semantics change. Future saved Perspectives
   * and AI consumers key caching/trust off this; results themselves are
   * never persisted in this slice.
   */
  lensVersion: number;
  scope:       PerspectiveScope;
  /** ISO timestamp from the injected clock (see ComputeOptions.now). */
  computedAt:  string;
  status:      LensStatus;
  /**
   * One deterministic sentence, template-built from already-computed
   * metrics. Never includes account or institution names. Present only when
   * status === "ok".
   */
  verdict?: string;
  /** The single number the card leads with. Present only when status === "ok". */
  headline?: LensMetric;
  /**
   * MC1 Phase 3 Slice 5 (D-7) — true when any converted amount in this
   * lens's sums was estimated (rate walked back, or null-residue currency).
   * Emitted only by conversion-aware lenses when a ConversionContext was
   * supplied; absent otherwise (context-less results stay byte-identical — the
   * kill switch).
   */
  estimated?: boolean;
  /**
   * V25-FINAL-1 — stronger than `estimated`: true when at least one account in
   * this lens's sums had NO acceptable FX rate and was therefore EXCLUDED from
   * the totals (its native magnitude was never blended in, and it is NOT a real
   * zero). The lens totals are then an honest PARTIAL and the workspace must
   * disclose incompleteness, not merely the softer "≈ est." marker. Implies
   * `estimated`. Rides the same channel as `estimated`.
   */
  unconverted?: boolean;
  /**
   * A5-S1 — the trust envelope. Present whenever `asOf` was supplied (may be
   * present otherwise); absent on every current context-less call, so existing
   * results stay byte-identical (the kill switch). Downstream Perspectives build
   * it with the propagation helpers in ./completeness.ts, never by hand.
   */
  completeness?: Completeness;
  metrics:     LensMetric[];
  assumptions: LensAssumption[];
  provenance:  LensProvenance;
  /**
   * Present exactly when status === "empty". Static, name-free copy
   * (space-presets emptyHeadline convention). Must read identically whether
   * accounts are absent or merely invisible to the viewer — an empty state
   * must never whisper that hidden accounts exist (investigation §5.8).
   */
  empty?: { headline: string; subline: string };
  /** Present exactly when status === "error". */
  error?: { code: LensErrorCode };
}

// ── Lens function ─────────────────────────────────────────────────────────────

/**
 * Options passed by the engine into every lens invocation.
 *
 * `now` is the injected clock: lenses must derive computedAt (and any other
 * time-dependent value) from it, never from Date.now()/new Date() directly,
 * so tests can prove byte-identical determinism.
 */
export interface ComputeOptions {
  now: () => Date;
  /**
   * MC1 — optional display-currency override for read-time conversion. When
   * set, conversion-aware lenses build their context targeting THIS currency
   * instead of the Space's saved reporting currency, so the headline, verdict,
   * and metric sums all recompute consistently in the requested currency (the
   * Personal "view as" preview). Omitted ⇒ the Space's reporting currency —
   * byte-identical to today for every existing caller.
   */
  targetCurrency?: string;
  /**
   * A5-S1 — optional as-of valuation date (YYYY-MM-DD). When set, as-of-aware
   * lenses resolve balances to this historical date via the A5-S2 resolvers
   * (getSnapshotAsOf / getAccountsAsOf) and stamp the result with a
   * `completeness` envelope. Omitted ⇒ "now": byte-identical to today for every
   * existing caller (the kill switch). No lens consumes `asOf` in the S1/S2
   * slices — the field is the frozen contract the parallel A4/P1/P2/P3 streams
   * build against; the engine threads it to lenses unchanged (index.ts).
   */
  asOf?: string;
}

/**
 * A lens implementation: pure async function from scope to result.
 *
 * Must not throw — return a shaped "error" result instead. (The engine
 * additionally wraps every call and converts an escaped throw into
 * COMPUTE_FAILED, but relying on that wrapper is a bug, not a feature.)
 */
export type LensFn = (
  scope:   PerspectiveScope,
  options: ComputeOptions,
) => Promise<LensResult>;
