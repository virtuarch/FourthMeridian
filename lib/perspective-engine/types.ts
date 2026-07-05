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
   * lens's sums was estimated (rate walked back / missing, or null-residue
   * currency). Emitted only by conversion-aware lenses when a
   * ConversionContext was supplied; absent otherwise (context-less results
   * stay byte-identical — the kill switch). Data-only until Phase 4.
   */
  estimated?: boolean;
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
