/**
 * components/platform/widgets/refresh-format.ts  (OPS-2C-2)
 *
 * The PRESENTATION ADAPTER for the three Refresh workspace widgets — the single
 * place where a route response becomes display text. Pure: no fetch, no React,
 * no Prisma. Mirrors the existing components/platform/widgets/job-health-format.ts
 * precedent, and sits strictly DOWNSTREAM of the 2C-1 route responses so those
 * contracts stay free of labels, colours and copy.
 *
 * It formats. It does not aggregate, re-derive, or decide health.
 *
 * ── THE HONESTY RULES THIS MODULE EXISTS TO ENFORCE ───────────────────────────
 * Five states must never collapse into one another, and the collapse is easy to
 * write by accident because they all look like "nothing to show":
 *
 *   loading          the request is in flight            (the widget's own state)
 *   error            the request failed                  (the widget's own state)
 *   UNOBSERVED       tier "unknown" — no rows existed     → "not observed"
 *   ZERO             a real counted 0 over real rows      → "0"
 *   UNAVAILABLE      a null metric (mean of nothing)      → "—"
 *
 * `tier: "unknown"` is the projection saying *there was nothing to look at*. It
 * is NOT health, and it must never render as green, "healthy", "0%", or "all
 * clear". Conversely a counted zero over real observations IS a fact and must
 * render as 0 — suppressing it would hide a genuine "nothing failed".
 *
 * The discriminator is the tier, never the number: `isUnobserved(tier)` decides
 * whether numbers may be shown at all; once shown, zeros are real.
 */

import type { OperationalTier } from "@/lib/platform/history/types";
import type { ProjectionEnvelope } from "@/lib/platform/refresh/types";

/** The em-dash used for a value that exists but cannot be computed (null). */
export const UNAVAILABLE = "—";
/** Copy for a projection that observed no rows at all. */
export const UNOBSERVED_LABEL = "not observed";

/**
 * True when the projection observed NOTHING (`tier: "unknown"`). Callers must
 * suppress numeric rendering in this state — a zero would be indistinguishable
 * from a real counted zero.
 */
export function isUnobserved(tier: OperationalTier): boolean {
  return tier === "unknown";
}

/** A null metric — computable in principle, absent in fact. Never rendered as 0. */
export function formatNullable(value: number | null | undefined): string {
  return value == null ? UNAVAILABLE : String(value);
}

/** Durations. null → "—" (never "0ms", which would claim an instant run). */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return UNAVAILABLE;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

/**
 * The window + reproducibility line.
 *
 * An open or unfinalised window is NEVER formatted as completion: the
 * projection's own `indeterminacyReason` is surfaced verbatim rather than
 * reduced to a badge, because the reason is the operationally useful part
 * ("still RUNNING" and "window ends today" call for different actions).
 */
export function describeWindow(env: ProjectionEnvelope): {
  window: string;
  reproducible: boolean;
  detail: string;
} {
  return {
    window: `${env.window.from} → ${env.window.to}`,
    reproducible: env.deterministic,
    detail: env.deterministic
      ? "reproducible — closed window, no open executions"
      : (env.indeterminacyReason ?? "not reproducible"),
  };
}

/** One display row from a `Record<string, number>` tally, in stable key order. */
export interface TallyEntry {
  key: string;
  count: number;
}

/**
 * Turn a projection tally into display rows. Key order is already stable from
 * the projection core; this preserves it rather than re-sorting, so the widget
 * and the API agree. Zero-valued entries are KEPT — a status counted zero times
 * simply will not appear in the record at all, so anything present is real.
 */
export function tallyEntries(rec: Readonly<Record<string, number>>): TallyEntry[] {
  return Object.keys(rec).map((key) => ({ key, count: rec[key] }));
}

/**
 * The single-line summary a widget shows when it has data. Returns null when the
 * projection observed nothing, so the caller renders the unobserved state
 * instead of a sentence full of zeros.
 */
export function summaryLine(
  tier: OperationalTier,
  parts: readonly string[],
): string | null {
  if (isUnobserved(tier)) return null;
  return parts.join(" · ");
}

/** Human label for a coverage/endpoint status token, without inventing meaning. */
export function humanizeToken(token: string): string {
  return token
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
}

/** Percentage of a whole, or null when the whole is zero (never "0%" by division). */
export function ratio(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 100);
}

// ── Deployment identity (OPS-2C-4) ──────────────────────────────────────────────
//
// DEPLOYMENT IS EVIDENCE ON AN EXECUTION, NEVER A SUBJECT.
//
//   Execution → deploymentSha        ✅ an observed attribute of the object
//   Deployment → execution summary   ❌ the inversion this must never become
//
// The distinction is enforced by the SHAPE of the API below, not by discipline:
// `isDeploymentBoundary` answers a per-index yes/no about an already-ordered
// sequence. It returns no buckets, no keys, and no groups, so there is nothing
// for a caller to render as a deployment heading that owns rows. The list stays
// flat and time-ordered; deployment only annotates the point where it changed.

/** Copy for an execution whose deployment was not observable when it was written. */
export const DEPLOYMENT_UNKNOWN = "unknown";

/** The operator-legible short form. `null` stays honestly unknown, never blank. */
export function shortSha(sha: string | null | undefined): string {
  if (sha == null) return DEPLOYMENT_UNKNOWN;
  const trimmed = sha.trim();
  return trimmed.length === 0 ? DEPLOYMENT_UNKNOWN : trimmed.slice(0, 7);
}

/**
 * Does the row at `index` sit on a deployment boundary — i.e. does its
 * deployment differ from the row immediately before it in the SAME rendered
 * order?
 *
 * Index 0 is never a boundary: the first row has no predecessor, and calling it
 * one would imply a deployment started there, which the ledger does not say. A
 * change to-or-from `null` IS a boundary — moving between "observed" and "not
 * observed" is a real change in what is known, and hiding it would silently
 * merge two different epistemic states.
 */
export function isDeploymentBoundary(
  rows: readonly { deploymentSha: string | null }[],
  index: number,
): boolean {
  if (index <= 0 || index >= rows.length) return false;
  return rows[index].deploymentSha !== rows[index - 1].deploymentSha;
}

// ── Provider operations (OPS-2C-5) ──────────────────────────────────────────────

/**
 * An honest one-line reading of an operation's attempt ordinals.
 *
 * `attempt` counts every external request of an operation within one execution.
 * For a PAGINATED operation the Proxy cannot tell a retry from a page, so a high
 * ordinal may mean "the 4th page", not "the 3rd retry" — and this must never be
 * narrated as retrying. The projection flags that per operation; this renders the
 * flag rather than guessing, and says nothing at all when every attempt was the
 * first (there is no story to tell).
 */
export function describeAttempts(op: {
  maxAttempt: number;
  paginationConfounded: boolean;
}): string | null {
  if (op.maxAttempt <= 1) return null;
  return op.paginationConfounded
    ? `up to ${op.maxAttempt} requests per execution — pages and retries are not distinguishable`
    : `up to ${op.maxAttempt} attempts per execution`;
}

/**
 * Provider-neutral display name for one observed operation. The provider and
 * operation are the PROVIDER'S OWN vocabulary carried through from the ledger —
 * this only joins them, and hardcodes no provider anywhere.
 */
export function operationLabel(op: { provider: string; operation: string }): string {
  return `${op.provider.toLowerCase()}.${op.operation}`;
}

// `deploymentRelation` (execution-vs-running comparison) was REMOVED rather than
// kept unused: the only available basis was the client bundle's env, which reads
// `unknown` whenever just the non-public var is set. Speculative UI backed by an
// unreliable comparison is worse than none. It returns only if a canonical
// server-side contract ever exposes current runtime deployment identity.
