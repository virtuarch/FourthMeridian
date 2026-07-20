/**
 * lib/charts/chart-palette.ts
 *
 * The single categorical chart palette + a STABLE colour-assignment strategy.
 *
 * ── The defect this replaces ──────────────────────────────────────────────────
 * Colour used to be assigned by ARRAY INDEX (`DEFAULT_PALETTE[i % n]`). Every
 * categorical chart in the product sorts value-descending and drops empty
 * entries, so a colour meant nothing: it named a RANK, not a thing.
 *
 *   • A user with no crypto saw "Real assets" render amber — because
 *     `assetClassItems` / `wealthCompositionItems` filter zero-value classes and
 *     everything after the hole shifts up one slot. The treemap/strip modes pin
 *     class colours explicitly, so the SAME asset class was drawn in two
 *     different colours on two surfaces of the same card.
 *   • A balance change that reorders institutions silently recoloured the chart.
 *
 * ── The strategy ──────────────────────────────────────────────────────────────
 * Two regimes, chosen by whether the category means something:
 *
 *   IDENTITY (fixed)  — categories with product meaning get a pinned colour:
 *                       asset class, liquidity horizon, debt. Callers pass
 *                       `item.color`; nothing here overrides it.
 *   DERIVED (stable)  — arbitrary categories (institutions, accounts, spending
 *                       categories) get a colour derived from their stable ID via
 *                       `assignStableColors`. Same ID ⇒ same colour, regardless of
 *                       position, sort order, or which siblings exist.
 *
 * The palette VALUES are unchanged from the previous `DEFAULT_PALETTE`, so the
 * visual language is preserved. What changes is which item receives which colour
 * in the derived regime — that is the point, and it is unavoidable: index
 * coupling cannot be fixed without changing some current assignments.
 *
 * Pure: no React, no DOM, no clock, no randomness. Assignment is deterministic
 * across processes and platforms (integer math only).
 */

/**
 * Eight visually distinct hues (Tailwind-500 equivalents), safe for SVG strokes
 * and inline styles alike. Verbatim the previous `BreakdownWidget.DEFAULT_PALETTE`
 * — this module is now its single home; the copies in CashFlowCategoryBreakdown
 * and elsewhere import from here rather than restating it.
 */
export const CHART_PALETTE: readonly string[] = [
  "#3b82f6", // blue-500
  "#10b981", // emerald-500
  "#f59e0b", // amber-500
  "#8b5cf6", // violet-500
  "#ec4899", // pink-500
  "#06b6d4", // cyan-500
  "#f97316", // orange-500
  "#84cc16", // lime-500
] as const;

/**
 * Asset-class colour identity — the canonical map for the four wealth classes.
 *
 * Values match what the donut ALREADY rendered for a complete four-class set
 * (palette slots 0–3 in declaration order), so a full portfolio is pixel-identical
 * to before. The difference is that these are now pinned to the CLASS rather than
 * to its position, so a portfolio missing a class no longer recolours the rest —
 * and the donut can no longer disagree with the treemap/strip modes.
 *
 * Keyed by the shared class IDs emitted by BOTH producers:
 * `lib/wealth/wealth-time-machine.wealthCompositionItems` and
 * `components/space/widgets/wealth-adapters.assetClassItems`.
 */
export const WEALTH_CLASS_COLOR: Readonly<Record<string, string>> = {
  cash:        "#3b82f6", // blue-500
  investments: "#10b981", // emerald-500
  crypto:      "#f59e0b", // amber-500
  real:        "#8b5cf6", // violet-500
};

/** Fallback when a class ID is not in the identity map. */
export const DEFAULT_CHART_COLOR = CHART_PALETTE[0];

/**
 * FNV-1a (32-bit). Chosen for being tiny, dependency-free, well-distributed over
 * short ASCII keys, and — critically — deterministic everywhere: `Math.imul`
 * gives defined 32-bit wrapping, so the result cannot drift across engines.
 */
function hashKey(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The palette slot a key prefers, before any collision resolution. */
export function preferredSlot(key: string): number {
  return hashKey(key) % CHART_PALETTE.length;
}

/**
 * Assign a colour to each ID such that the result depends ONLY on the set of IDs
 * — never on their order.
 *
 * Method: walk the IDs in canonical (sorted) order; each takes the LEAST-USED
 * palette slot, preferring its own hash slot on ties. Consequences:
 *
 *   • ≤ 8 distinct IDs  ⇒ every one gets a distinct colour (a slot is only reused
 *                          once all are taken), so donut segments stay readable.
 *   • > 8 distinct IDs  ⇒ reuse is spread as evenly as possible rather than
 *                          cycling, which is the honest degradation. A chart with
 *                          that many categories has already lost colour as a
 *                          channel; cardinality is the caller's problem to bound.
 *   • Sorting means input order is irrelevant — the whole point. Adding or
 *     removing an item perturbs only IDs that actually contend for its slot,
 *     instead of shifting everything downstream as index assignment did.
 *
 * Duplicate IDs collapse to one colour (they are the same thing).
 *
 * KNOWN LIMIT — this is stability, not permanence. Two IDs that hash to the same
 * preferred slot contend: one is displaced, and if the winner later leaves, the
 * loser reclaims its preference and changes colour. Removing an item therefore
 * perturbs the IDs that CONTENDED with it, and no others. Index assignment
 * perturbed everything positioned after it, so this is a large reduction rather
 * than an elimination. Truly permanent colour requires a persisted assignment,
 * which is not worth a table for a decorative channel. Categories with product
 * meaning should use the identity regime instead.
 *
 * @param ids Item IDs, in whatever order the caller renders them.
 * @returns   Colours positionally aligned to `ids`.
 */
export function assignStableColors(ids: readonly string[]): string[] {
  const n = CHART_PALETTE.length;
  const counts = new Array<number>(n).fill(0);
  const chosen = new Map<string, number>();

  // Canonical order — assignment must not depend on render order.
  for (const id of [...new Set(ids)].sort()) {
    const pref = preferredSlot(id);
    let best = pref;
    // Strict `<` keeps the hash slot on ties, so the preference is honoured
    // whenever it is free (or as free as anything else).
    for (let p = 1; p < n; p++) {
      const slot = (pref + p) % n;
      if (counts[slot] < counts[best]) best = slot;
    }
    counts[best]++;
    chosen.set(id, best);
  }

  return ids.map((id) => CHART_PALETTE[chosen.get(id) ?? 0]);
}
