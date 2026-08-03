/**
 * lib/prices/provider-capability.ts
 *
 * V26-CAP-1 — the DB binding for provider-capability observation.
 *
 * Reads the declaration from the ONE authority that already computes it (the
 * registered adapter), compares it against the last valid observation for the
 * same identity, appends the result, and — only on a widening — reports the
 * newly available interval so a caller can plan work.
 *
 * It plans nothing and writes no financial row itself. Acquisition and
 * regeneration stay with their existing owners; this only says "these dates just
 * became attemptable".
 */

import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { defaultPriceRegistry } from "./registry";
import {
  compareCapability, isValidCapabilityDeclaration, newlyAvailableInterval, widensCapability,
  type CapabilityComparison, type CapabilityDeclaration,
} from "./provider-capability.core";

export type { CapabilityComparison, CapabilityDeclaration };

/**
 * The identity boundary a declaration applies to.
 *
 * DEPLOYMENT today, and deliberately so: the only crypto price credential in
 * this system is a single deployment environment variable, so two users cannot
 * hold different plans. Modelling it per-account would invent a distinction the
 * provider contract does not make — and would then need unpicking when it turned
 * out one key served everyone.
 */
export const CAPABILITY_SCOPE_DEPLOYMENT = "DEPLOYMENT";

/**
 * A non-reversible fingerprint of the configuration that determines capability.
 *
 * NEVER the credential itself, and never enough of it to reconstruct: a short
 * digest is sufficient to notice "the key changed", which is all the lineage
 * rule needs. A replaced key yields a different `capabilityKey`, so it starts a
 * fresh lineage and cannot be compared against — let alone accidentally widen —
 * the previous one.
 */
export function capabilityKeyFor(secret: string | undefined, declaration: CapabilityDeclaration): string {
  const material = `${secret ?? ""}::${declaration.kind}::${declaration.source}`;
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

export interface CapabilityObservationResult {
  provider:      string;
  capabilityKey: string;
  comparison:    CapabilityComparison;
  declaration:   CapabilityDeclaration;
  /** The previous VALID declaration for this identity, or null. */
  previous:      CapabilityDeclaration | null;
  /**
   * Present only on a widening: the dates that were previously unreachable and
   * now are. Never a claim that they are supported — only that they may now be
   * attempted.
   */
  newlyAvailable: { fromISO: string; toISO: string } | null;
  /** The appended row's id, or null when nothing was persisted. */
  observationId: string | null;
  /** Set when the declaration was refused; nothing was written. */
  rejectedReason: string | null;
}

/**
 * Observe one provider's declared capability and record it.
 *
 * Idempotent in EFFECT, not in row count: an unchanged re-check appends an
 * `unchanged` row and schedules nothing, which is what makes the check auditable
 * ("we looked, on this date, and it had not moved"). Duplicate runs therefore
 * cannot duplicate WORK, which is the property that matters.
 *
 * Never throws on a malformed declaration — it refuses, records nothing, and
 * leaves the prior valid observation untouched. A configuration typo must not be
 * able to silently narrow or widen capability.
 */
export async function observeProviderCapability(
  providerSource: string,
  opts: { secret?: string; now?: Date } = {},
): Promise<CapabilityObservationResult> {
  const registry = defaultPriceRegistry();
  const adapter = registry.adapters.find((a) => a.source === providerSource);

  const base = {
    provider: providerSource, capabilityKey: "", comparison: "incomparable" as CapabilityComparison,
    declaration: null as unknown as CapabilityDeclaration, previous: null,
    newlyAvailable: null, observationId: null,
  };

  if (!adapter) {
    return { ...base, rejectedReason: `no registered adapter for source "${providerSource}"` };
  }
  const declaration = adapter.capability;
  if (!isValidCapabilityDeclaration(declaration)) {
    // Refusal, not repair — see the core module's validation note.
    return { ...base, rejectedReason: "adapter declared no valid capability" };
  }

  const capabilityKey = capabilityKeyFor(opts.secret, declaration);

  const prevRow = await db.providerCapabilityObservation.findFirst({
    where:   { provider: providerSource, capabilityKey },
    orderBy: { observedAt: "desc" },
  });
  const previous: CapabilityDeclaration | null = prevRow
    ? {
        kind:                 prevRow.kind as CapabilityDeclaration["kind"],
        historyDays:          prevRow.historyDays,
        earliestSupportedISO: prevRow.earliestSupportedISO,
        source:               prevRow.declarationSource as CapabilityDeclaration["source"],
      }
    : null;

  const comparison = compareCapability(previous, declaration);

  // The newly available interval is computed against the previous declaration's
  // floor AS OF NOW, not the date stored at observation time. For a rolling
  // window those differ by however many days have elapsed, and using the stored
  // date would inflate the interval by exactly that drift.
  let newlyAvailable: { fromISO: string; toISO: string } | null = null;
  if (widensCapability(comparison) && previous) {
    const previousFloorNowISO =
      previous.kind === "ROLLING" && previous.historyDays !== null
        ? floorForRollingDays(previous.historyDays, opts.now ?? new Date(), declaration.earliestSupportedISO, declaration.historyDays)
        : previous.earliestSupportedISO;
    newlyAvailable = newlyAvailableInterval(previousFloorNowISO, declaration.earliestSupportedISO);
  }

  const row = await db.providerCapabilityObservation.create({
    data: {
      provider:              providerSource,
      capabilityKey,
      scope:                 CAPABILITY_SCOPE_DEPLOYMENT,
      kind:                  declaration.kind,
      historyDays:           declaration.historyDays,
      earliestSupportedISO:  declaration.earliestSupportedISO,
      declarationSource:     declaration.source,
      comparison,
      previousObservationId: prevRow?.id ?? null,
      widenedFromISO:        newlyAvailable?.fromISO ?? null,
      widenedToISO:          newlyAvailable?.toISO ?? null,
      ...(opts.now ? { observedAt: opts.now } : {}),
    },
    select: { id: true },
  });

  return {
    provider: providerSource, capabilityKey, comparison, declaration, previous,
    newlyAvailable, observationId: row.id, rejectedReason: null,
  };
}

/**
 * The floor a ROLLING declaration of `days` would have TODAY.
 *
 * Derived by anchoring on the CURRENT declaration's own floor+days pair, so the
 * arithmetic still comes from the provider authority that produced it rather
 * than being reimplemented here: today = currentFloor + currentDays, and the
 * previous floor is today − previousDays.
 */
function floorForRollingDays(
  previousDays: number,
  _now: Date,
  currentFloorISO: string,
  currentDays: number | null,
): string {
  if (currentDays === null) return currentFloorISO;
  const todayMs = Date.parse(`${currentFloorISO}T00:00:00Z`) + currentDays * 86_400_000;
  return new Date(todayMs - previousDays * 86_400_000).toISOString().slice(0, 10);
}

/** The provider sources currently registered — the set a reconciliation sweeps. */
export function registeredPriceProviderSources(): string[] {
  return defaultPriceRegistry().adapters.map((a) => a.source).sort();
}
