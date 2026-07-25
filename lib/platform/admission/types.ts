/**
 * lib/platform/admission/types.ts  (OPS-2D-3)
 *
 * The canonical vocabulary for one question, asked in one place:
 *
 *     May this operational work BEGIN under current platform conditions?
 *
 * WHAT THIS IS NOT
 * ----------------
 * Three questions already have authorities in this repository, and admission is
 * none of them. The distinction is not pedantry — collapsing any two of them
 * produces a specific, known bug:
 *
 *   AUTHORIZATION  "may this ACTOR request the operation?"
 *                  → requirePlatformAccess / hasPlatformAccess (403)
 *                  Collapsed into admission, a paused platform would read as a
 *                  permissions problem and operators would be granted more
 *                  access to fix an outage that grants cannot fix.
 *
 *   CONCURRENCY    "can another execution safely start right now?"
 *                  → claimPlaidItemSyncLock / withPlaidItemSyncLock (409)
 *                  Collapsed into admission, a routine in-flight sync would look
 *                  like a control-plane state and appear on operator surfaces as
 *                  a platform condition rather than as normal contention.
 *
 *   RATE / COOLDOWN "has this subject asked too recently?"
 *                  → checkManualRefreshCooldown, limitByUser
 *                  Collapsed into admission, per-item pacing would be reported
 *                  as a platform-wide fact.
 *
 * Admission answers only the fourth question, and it is the only one with no
 * authority today: has an OPERATOR declared a platform state under which this
 * class of work should not begin? An actor with WRITE may legitimately request
 * work that admission then denies; that is the system working, not a conflict.
 *
 * CONTROL vs ADMISSION
 * --------------------
 * CONTROL (OPS-2D-2) is the capability to CHANGE these facts. It is not a
 * bypass: a CONTROL holder who pauses ingestion is themselves subject to the
 * pause. Nothing in this module consults a capability, a role, or a session —
 * which is how that separation is kept structural rather than promised.
 * SYSTEM_ADMIN is likewise NOT an admission bypass; it bypasses AUTHORIZATION
 * only, and deliberately continues to do only that.
 */

// ── What may be admitted ──────────────────────────────────────────────────────

/**
 * The class of operational work being requested. One member today, and one
 * consumer: refresh-equivalent execution against a provider.
 *
 * A class — not an item id, a user, or a trigger. Admission asks about the
 * PLATFORM's state, not about the subject of the work; per-subject eligibility
 * (item status, account lifecycle, recovery age) is data-lifecycle logic that
 * already lives with each producer and is deliberately not absorbed here.
 */
export type OperationalWork = "REFRESH_EXECUTION";

export interface AdmissionRequest {
  work: OperationalWork;
}

// ── The decision ──────────────────────────────────────────────────────────────

/**
 * TWO states, not four.
 *
 * DEFER and SKIP were considered and rejected: the repository has no fact that
 * distinguishes them today. Every control-plane fact that exists is a reversible
 * operator declaration, so every denial is "not now" — and whether "not now"
 * means "the cron will retry" or "your request will not happen" is the
 * CONSUMER's interpretation of the same decision, not a different decision. A
 * scheduled producer treats a denial as a skipped tick (the cron is the retry);
 * a request producer reports it to the caller. Inventing the distinction here
 * would force every producer to handle a difference the evaluator cannot
 * actually observe.
 */
export type AdmissionDecision = "ADMIT" | "DENY";

/**
 * The reason registry — typed code → human label, in ONE place.
 *
 * This is the whole defence against stringly-typed policy: a producer cannot
 * invent a reason, because `AdmissionReason` is derived from these keys and
 * every non-admitted verdict must carry one. Guarded by admission-boundary.test.ts.
 */
export const ADMISSION_REASONS = {
  /** An operator declared platform-wide maintenance. */
  MAINTENANCE_MODE: "Platform maintenance is in effect.",
  /** An operator paused provider ingestion specifically. */
  INGESTION_PAUSED: "Provider ingestion is paused platform-wide.",
  /**
   * A control-plane setting exists but holds a value outside its contract.
   * Denied, NOT ignored: a pause flag we cannot interpret must not be read as
   * "not paused". See policy-core.ts for the tradeoff this makes explicit.
   */
  CONTROL_PLANE_UNREADABLE: "A control-plane setting holds a value that cannot be interpreted.",
  /** Control-plane state could not be read at all (store unreachable). */
  CONTROL_PLANE_UNAVAILABLE: "Control-plane state could not be read.",
} as const;

export type AdmissionReason = keyof typeof ADMISSION_REASONS;

// ── The facts admission is decided from ───────────────────────────────────────

/**
 * The five states any control-plane fact can be in. `MISSING` and `INVALID` are
 * kept apart on purpose: "no operator has ever set this" and "an operator set
 * something we cannot read" are different situations with different answers,
 * and a boolean|null cannot tell them apart.
 */
export type FactState = "ON" | "OFF" | "MISSING" | "INVALID" | "UNAVAILABLE";

export interface ControlPlaneFact {
  /** The PlatformSetting key this fact was resolved from. */
  key: string;
  state: FactState;
  /** Exactly what the store held. null when MISSING or UNAVAILABLE. */
  raw: string | null;
}

/**
 * Every control-plane fact admission consults. A record — not a list — so a new
 * fact cannot be added without the pure core failing to compile until it is
 * ordered in PRECEDENCE.
 */
export interface ControlPlaneFacts {
  maintenanceMode: ControlPlaneFact;
  ingestionPaused: ControlPlaneFact;
}

// ── The verdict ───────────────────────────────────────────────────────────────

/**
 * The pure verdict. Deliberately carries NO timestamp: a pure core that stamps
 * its own clock is not a pure core, and the same facts must always yield an
 * identical value (that is what makes determinism testable by equality). The
 * impure adapter stamps `evaluatedAt` — the same split OPS-2B's projections use.
 */
export interface AdmissionVerdict {
  decision: AdmissionDecision;
  /** null if and only if decision === "ADMIT". */
  reason: AdmissionReason | null;
  /** Human-readable, resolved from the registry. null iff ADMIT. */
  label: string | null;
  /** The fact that decided it — key, raw value, state. null iff ADMIT. */
  evidence: ControlPlaneFact | null;
  /** Where the facts came from. One authority today. */
  authority: "PlatformSetting";
}

/** A verdict as an impure caller sees it: the pure verdict plus when it was taken. */
export interface StampedAdmissionVerdict extends AdmissionVerdict {
  evaluatedAt: string;
}
