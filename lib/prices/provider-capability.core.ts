/**
 * lib/prices/provider-capability.core.ts
 *
 * V26-CAP-1 — WHAT A PROVIDER SAYS IT CAN SERVE, AND WHETHER THAT CHANGED.
 *
 * Pure: no Prisma, no DB, no clock, no network.
 *
 * ── The one thing this models ────────────────────────────────────────────────
 * DECLARED capability, and nothing else. It is deliberately not:
 *   · requested history      — what we asked for
 *   · demonstrated evidence  — what actually came back
 *   · licensed support       — what ownership/quantity permits
 *   · regenerated support    — what snapshots may assert
 *
 * A capability change only changes what Fourth Meridian is ALLOWED TO ATTEMPT.
 * It proves nothing was returned and authorizes no existing snapshot. That
 * separation is the whole point: acquiring earlier prices must never re-bless a
 * stale row, and only a successful regeneration may move support.
 *
 * ── Why a naive date comparison is WRONG ─────────────────────────────────────
 * A rolling-window provider's floor MOVES FORWARD every day: with a 365-day
 * window, today's floor is one day later than yesterday's. Persisting the
 * derived date and comparing it tomorrow would report NARROWED every single day,
 * forever, and a widening would be lost in that noise.
 *
 * So the comparison is made on the DECLARATION, not on its derived date:
 *
 *   ROLLING — declared as a DEPTH (`historyDays`). More days ⇒ wider.
 *             The derived floor is recorded for audit only.
 *   FIXED   — declared as an absolute earliest date. Earlier ⇒ wider.
 *
 * The two kinds are NOT comparable to each other. A provider that changes kind
 * has not widened or narrowed — it has become a different sort of contract, and
 * saying so honestly is better than inventing an ordering. Cross-kind returns
 * `incomparable`, which schedules no work and overwrites nothing.
 *
 * This module performs no floor arithmetic of its own. The ISO floor of a
 * rolling declaration is produced by the provider's own authority
 * (resolveCoinGeckoFloorISO) at the construction edge and passed in as data, so
 * there is exactly one place that knows how a floor is computed.
 *
 * Nothing here names a vendor, a plan, a tier, an asset, an account or a user.
 */

/** How a provider expresses its historical reach. */
export type CapabilityKind = "ROLLING" | "FIXED";

/** Where a declaration came from. Configuration today; API discovery later. */
export type CapabilitySource = "CONFIG" | "API" | "DEFAULT";

/**
 * One provider's declared historical capability at a moment in time.
 *
 * `earliestSupportedISO` is present for BOTH kinds but means different things:
 * for FIXED it IS the declaration; for ROLLING it is a derived snapshot kept for
 * audit and for feeding the work planner. Only `historyDays` is authoritative
 * for a ROLLING comparison — see the header.
 */
export interface CapabilityDeclaration {
  kind: CapabilityKind;
  /** Authoritative for ROLLING; null for FIXED. */
  historyDays: number | null;
  /** Authoritative for FIXED; a derived snapshot for ROLLING. */
  earliestSupportedISO: string;
  source: CapabilitySource;
}

export type CapabilityComparison =
  | "first-observation"
  | "unchanged"
  | "widened"
  | "narrowed"
  | "incomparable";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Is this declaration well-formed enough to persist and compare?
 *
 * Validation is a REFUSAL, not a repair. An unparseable or self-contradictory
 * declaration must never overwrite a prior valid one — a typo in configuration
 * would otherwise silently narrow (or widen) capability, which is precisely the
 * class of failure this slice exists to make impossible.
 */
export function isValidCapabilityDeclaration(d: unknown): d is CapabilityDeclaration {
  if (typeof d !== "object" || d === null) return false;
  const c = d as Partial<CapabilityDeclaration>;
  if (c.kind !== "ROLLING" && c.kind !== "FIXED") return false;
  if (c.source !== "CONFIG" && c.source !== "API" && c.source !== "DEFAULT") return false;
  if (typeof c.earliestSupportedISO !== "string" || !ISO_DATE.test(c.earliestSupportedISO)) return false;
  // A UTC-real date: rejects 2025-02-30 and friends, which `new Date` would
  // silently roll forward into a different (and wrong) floor.
  const t = Date.parse(`${c.earliestSupportedISO}T00:00:00Z`);
  if (!Number.isFinite(t)) return false;
  if (new Date(t).toISOString().slice(0, 10) !== c.earliestSupportedISO) return false;
  if (c.kind === "ROLLING") {
    if (!Number.isSafeInteger(c.historyDays) || (c.historyDays as number) <= 0) return false;
  } else if (c.historyDays !== null && c.historyDays !== undefined) {
    return false; // a FIXED declaration carrying a depth is self-contradictory
  }
  return true;
}

/**
 * Compare a new declaration against the most recent valid one for the SAME
 * capability identity. Total and deterministic.
 *
 * Callers must not compare across identities — a different provider or a
 * different configuration lineage is a different contract, and letting one
 * widen another is exactly the accident PART 8 asks to prevent. The binding
 * enforces that by scoping its lookup; this function only ever sees one pair.
 */
export function compareCapability(
  previous: CapabilityDeclaration | null,
  next: CapabilityDeclaration,
): CapabilityComparison {
  if (previous === null) return "first-observation";
  if (previous.kind !== next.kind) return "incomparable";

  if (next.kind === "ROLLING") {
    const a = previous.historyDays, b = next.historyDays;
    if (a === null || b === null) return "incomparable";
    if (b === a) return "unchanged";
    return b > a ? "widened" : "narrowed";
  }

  // FIXED — an EARLIER floor reaches further back, so it is wider.
  if (next.earliestSupportedISO === previous.earliestSupportedISO) return "unchanged";
  return next.earliestSupportedISO < previous.earliestSupportedISO ? "widened" : "narrowed";
}

/**
 * The newly available interval a widening opens up, or null when none is.
 *
 * `[newFloor … dayBefore(previousFloor)]` — strictly the dates that were
 * previously out of reach. The already-covered interval is deliberately NOT
 * re-requested: it is complete by construction, and refetching it would burn
 * provider quota to learn nothing.
 *
 * Both floors are taken AS OF THE SAME MOMENT. For a rolling provider the caller
 * must re-derive the previous declaration's floor against today rather than
 * reusing the date stored at observation time; otherwise the interval would be
 * inflated by however many days have elapsed since. `previousFloorISO` is
 * therefore a parameter, not a field read off the stored row.
 */
export function newlyAvailableInterval(
  previousFloorISO: string,
  newFloorISO: string,
): { fromISO: string; toISO: string } | null {
  if (!(newFloorISO < previousFloorISO)) return null; // not a widening
  const dayBefore = new Date(Date.parse(`${previousFloorISO}T00:00:00Z`) - 86_400_000)
    .toISOString().slice(0, 10);
  if (dayBefore < newFloorISO) return null; // adjacent floors open nothing
  return { fromISO: newFloorISO, toISO: dayBefore };
}

/**
 * Does this comparison warrant historical work?
 *
 * ONLY a widening does. `narrowed` is explicitly non-destructive: evidence
 * already acquired under a wider entitlement stays acquired and stays supported,
 * because it was lawfully returned and successfully regenerated. A narrower
 * declaration constrains only FUTURE attempts. `unchanged`, `first-observation`
 * and `incomparable` schedule nothing — a first observation records the baseline
 * without inventing a backfill nobody asked for.
 */
export function widensCapability(comparison: CapabilityComparison): boolean {
  return comparison === "widened";
}
