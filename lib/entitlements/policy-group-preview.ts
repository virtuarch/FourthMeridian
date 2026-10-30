/**
 * lib/entitlements/policy-group-preview.ts  (POLICY EDITOR — pure)
 *
 * WHAT A GROUP'S VALUES WOULD MEAN FOR ITS CUSTOMERS — computed by THE
 * resolver, never a restatement of it, so the editor's live preview, the change
 * summary and enforcement cannot disagree:
 *
 *   previewEffective(values, overlay)   the effective values of a customer on a
 *       group with these values (optionally with the Founder overlay), through
 *       resolveEffectiveEntitlements on a one-group catalogue: overlay ∘ group,
 *       then the ceiling clamps last.
 *
 *   estimateAllowanceCeiling(buckets, groupUsd, platformUsd)
 *       COST EXPOSURE: Σ over the group's customers of the daily AI allowance
 *       each would have (the ONE precedence function: per-customer override >
 *       overlay > platform setting > this group's value, ceiling last). It is a
 *       CEILING on estimated spend per UTC day, not a forecast — the label says
 *       so. Buckets are COUNTS by (overlay, override); no customer identity.
 *
 * Pure: no I/O, client-safe (the editor imports it).
 */

import { DIMENSION_KEYS, ENTITLEMENT_DIMENSIONS, OVERLAYS, type EntitlementDimensionKey, type EntitlementValue, type EntitlementValues } from "./catalogue";
import { resolveAiDailyAllowance } from "./ai-allowance";
import { resolveEffectiveEntitlements, type EntitlementSource } from "./resolve";
import type { PolicyGroupCatalogue } from "./policy-groups";

const PREVIEW_KEY = "__PREVIEW__";

export interface PreviewDimension { key: EntitlementDimensionKey; value: EntitlementValue; source: EntitlementSource; clamped: boolean }

/** The effective values for a customer on a group with `values` (+ an overlay key, or null). */
export function previewEffective(values: EntitlementValues, overlay: string | null = null): Record<EntitlementDimensionKey, PreviewDimension> {
  const catalogue: PolicyGroupCatalogue = {
    source: "CODE", defaultKey: PREVIEW_KEY, loadedAt: null,
    groups: {
      [PREVIEW_KEY]: {
        key: PREVIEW_KEY, label: "", description: "", values, valid: true, invalidReasons: [], archived: false, archivedAt: null,
        isDefault: true, builtIn: false, version: null, source: "CODE", effectiveFrom: "",
      },
    },
  };
  const e = resolveEffectiveEntitlements({ policyGroup: PREVIEW_KEY, overlay, assignedAt: new Date(0), assignedById: null }, undefined, { catalogue });
  const out = {} as Record<EntitlementDimensionKey, PreviewDimension>;
  for (const k of DIMENSION_KEYS) {
    const d = e.dimensions[k];
    out[k] = { key: k, value: d.value, source: d.source, clamped: d.clamped };
  }
  return out;
}

/** Customers of one group, counted by what changes their allowance. */
export interface AllowanceBucket {
  overlay: string | null;
  /** The per-customer AI allowance override (whole USD) or null. */
  overrideUsd: number | null;
  count: number;
}

export interface AllowanceExposure {
  /** Σ allowance per UTC day across the customers (estimated ceiling, whole USD). */
  ceilingUsdPerDay: number;
  customers: number;
  /** Customers whose allowance does NOT follow this group's value (override, overlay or platform setting wins). */
  notFollowingGroup: number;
}

/** PURE — the estimated daily AI spend ceiling for these customers if the group's allowance were `groupUsd`. */
export function estimateAllowanceCeiling(buckets: readonly AllowanceBucket[], groupUsd: number, platformUsd: number | null): AllowanceExposure {
  let ceilingUsdPerDay = 0;
  let customers = 0;
  let notFollowingGroup = 0;
  for (const b of buckets) {
    const count = Math.max(0, Math.floor(b.count));
    if (count === 0) continue;
    const overlayUsd = b.overlay && b.overlay in OVERLAYS ? (OVERLAYS[b.overlay].values.aiDailyUsdAllowance ?? null) : null;
    const r = resolveAiDailyAllowance({
      policyUsd: groupUsd, overlayUsd: overlayUsd ?? null, platformUsd, userOverrideUsd: b.overrideUsd,
      ceilingUsd: ENTITLEMENT_DIMENSIONS.aiDailyUsdAllowance.ceiling,
    });
    ceilingUsdPerDay += r.usd * count;
    customers += count;
    if (r.askedSource !== "POLICY") notFollowingGroup += count;
  }
  return { ceilingUsdPerDay, customers, notFollowingGroup };
}
