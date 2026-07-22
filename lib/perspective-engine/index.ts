/**
 * lib/perspective-engine/index.ts
 *
 * Public surface of the Perspective Engine (foundation slice, commit 1).
 *
 * computePerspective() / computePerspectives() are THE reusable entry
 * points: the Space Dashboard's future API route, Daily Brief, D4 AI
 * context, Meridian Analyst, and future saved Perspectives all consume
 * these functions. Any HTTP route added later is a thin consumer — the
 * engine never imports from app/, never reads request objects, and never
 * depends on being called over HTTP.
 *
 * Guarantees this module enforces on top of the lens contract:
 *  - Never throws: an escaped lens exception becomes a shaped
 *    COMPUTE_FAILED result. The original error is logged server-side only
 *    (console.error) and NEVER placed in the result — error text can embed
 *    account data (investigation §5.8).
 *  - Never mis-shaped: a lens result that violates the structural contract
 *    (validateLensResult) is replaced by COMPUTE_FAILED, fail-closed.
 *  - Deterministic: the clock is injectable via ComputeOptions.now; the
 *    default is the real clock.
 */

import { getLens, listRegisteredLenses } from "./registry";
import type {
  ComputeOptions,
  LensErrorCode,
  LensId,
  LensResult,
  PerspectiveScope,
} from "./types";

export * from "./types";
export { registerLens, getLens, listRegisteredLenses } from "./registry";

// ---------------------------------------------------------------------------
// Shaped-result builders (exported for lens modules, commits 2–3)
// ---------------------------------------------------------------------------

/**
 * Fully-shaped error result. Category code only — never raw error text.
 */
export function makeErrorResult(
  lensId: LensId,
  lensVersion: number,
  scope: PerspectiveScope,
  options: ComputeOptions,
  code: LensErrorCode,
): LensResult {
  return {
    lensId,
    lensVersion,
    scope,
    computedAt: options.now().toISOString(),
    status: "error",
    metrics: [],
    assumptions: [],
    provenance: {
      accountIds: [],
      tierCounts: { full: 0, balanceOnly: 0, summaryOnly: 0 },
      dataAsOf: null,
      redactions: [],
    },
    error: { code },
  };
}

/**
 * Fully-shaped empty result. Copy must be static per lens and must read
 * identically whether accounts are absent or merely invisible to the
 * viewer (investigation §5.8) — hence copy is a parameter the lens defines
 * as a constant, never derived from withheld rows.
 */
export function makeEmptyResult(
  lensId: LensId,
  lensVersion: number,
  scope: PerspectiveScope,
  options: ComputeOptions,
  empty: { headline: string; subline: string },
): LensResult {
  return {
    lensId,
    lensVersion,
    scope,
    computedAt: options.now().toISOString(),
    status: "empty",
    metrics: [],
    assumptions: [],
    provenance: {
      accountIds: [],
      tierCounts: { full: 0, balanceOnly: 0, summaryOnly: 0 },
      dataAsOf: null,
      redactions: [],
    },
    empty,
  };
}

// ---------------------------------------------------------------------------
// Structural contract validation
// ---------------------------------------------------------------------------

/**
 * Structural checks on a lens result — the machine-checkable half of the
 * contract (name-freedom is proven per-lens by fixture tests instead).
 * Returns a list of violation descriptions; empty means valid.
 *
 * Exported for tests. computePerspective() applies it and converts any
 * violation into COMPUTE_FAILED, so a buggy lens fails closed rather than
 * shipping a half-shaped object to a render surface.
 */
export function validateLensResult(result: LensResult): string[] {
  const problems: string[] = [];
  const p = result.provenance;

  if (!p || !Array.isArray(p.accountIds) || !p.tierCounts || !Array.isArray(p.redactions)) {
    problems.push("provenance is missing or mis-shaped");
  }
  if (!Array.isArray(result.metrics))     problems.push("metrics must be an array");
  if (!Array.isArray(result.assumptions)) problems.push("assumptions must be an array");
  if (Number.isNaN(Date.parse(result.computedAt))) {
    problems.push("computedAt must be an ISO date string");
  }

  switch (result.status) {
    case "ok":
      if (result.empty) problems.push('status "ok" must not carry empty copy');
      if (result.error) problems.push('status "ok" must not carry an error');
      break;
    case "empty":
      if (!result.empty?.headline || !result.empty?.subline) {
        problems.push('status "empty" requires empty.headline and empty.subline');
      }
      if (result.verdict !== undefined || result.headline !== undefined) {
        problems.push('status "empty" must not carry verdict/headline');
      }
      if (result.error) problems.push('status "empty" must not carry an error');
      break;
    case "error":
      if (!result.error?.code) problems.push('status "error" requires error.code');
      if (result.verdict !== undefined || result.headline !== undefined) {
        problems.push('status "error" must not carry verdict/headline');
      }
      if (result.empty) problems.push('status "error" must not carry empty copy');
      break;
    default:
      problems.push(`unknown status "${(result as { status: string }).status}"`);
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Compute
// ---------------------------------------------------------------------------

/** Version reported on engine-built error results for unregistered lenses. */
const UNREGISTERED_LENS_VERSION = 0;

function defaultOptions(options?: Partial<ComputeOptions>): ComputeOptions {
  // Preserve targetCurrency (MC1 view-as override) and asOf (A5-S1 as-of date)
  // alongside the injected clock. Both default to undefined: undefined
  // targetCurrency ⇒ lenses target the Space's reporting currency; undefined
  // asOf ⇒ "now" (the kill switch — byte-identical to today). Threading asOf
  // here is what makes the contract real: without it the engine would silently
  // drop the field before any as-of-aware lens (S3, P2/P3) could read it.
  return {
    now: options?.now ?? (() => new Date()),
    targetCurrency: options?.targetCurrency,
    asOf: options?.asOf,
  };
}

/**
 * Compute one lens for one scope. Never throws.
 *
 * `options.now` is the injectable clock for deterministic tests; production
 * callers omit it.
 */
export async function computePerspective(
  lensId: LensId,
  scope: PerspectiveScope,
  options?: Partial<ComputeOptions>,
): Promise<LensResult> {
  const opts = defaultOptions(options);
  const lens = getLens(lensId);

  if (!lens) {
    return makeErrorResult(
      lensId, UNREGISTERED_LENS_VERSION, scope, opts, "LENS_NOT_REGISTERED",
    );
  }

  let result: LensResult;
  try {
    result = await lens(scope, opts);
  } catch (err) {
    // Server-side log only — the error object never enters the result
    // (raw error text can embed account names/data).
    console.error(`[perspective-engine] lens "${lensId}" threw:`, err);
    return makeErrorResult(lensId, UNREGISTERED_LENS_VERSION, scope, opts, "COMPUTE_FAILED");
  }

  const problems = validateLensResult(result);
  if (problems.length > 0) {
    console.error(
      `[perspective-engine] lens "${lensId}" returned a contract-violating result: ` +
      problems.join("; "),
    );
    return makeErrorResult(
      lensId, result.lensVersion ?? UNREGISTERED_LENS_VERSION, scope, opts, "COMPUTE_FAILED",
    );
  }

  return result;
}

/**
 * Compute every registered lens for one scope, in registration order.
 * Per-lens failures degrade to shaped error results — one bad lens never
 * takes down the batch (the future route returns whatever computed).
 */
export async function computePerspectives(
  scope: PerspectiveScope,
  options?: Partial<ComputeOptions>,
): Promise<LensResult[]> {
  const ids = listRegisteredLenses();
  return Promise.all(ids.map((id) => computePerspective(id, scope, options)));
}
