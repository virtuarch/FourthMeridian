/**
 * lib/snapshots/regeneration-candidates.core.ts
 *
 * V26-PRICE-5 — which historical snapshots are actually AFFECTED by newly
 * arrived evidence. Pure: no Prisma, no network, no clock.
 *
 * ── Why "changed" is defined by recomputation, not by timestamps ─────────────
 * SpaceSnapshot carries no createdAt/updatedAt, so "was this row written before
 * that price arrived?" is not answerable. It is also the wrong question: a price
 * can arrive and change nothing (a weekend fill, a duplicate, a component that
 * rounds identically), and a row can be stale for reasons no timestamp records.
 *
 * The honest definition is direct: a snapshot is affected when recomputing it
 * from CURRENT stored evidence produces a different value than the one stored.
 * That needs no metadata, cannot drift, and answers the operational question
 * exactly — would rewriting this row change anything?
 *
 * Unaffected rows are therefore never rewritten. Beyond saving writes this
 * matters for trust: a regeneration that touches thousands of rows to change
 * none is indistinguishable, in an audit trail, from one that changed them all.
 *
 * ── Four dispositions ────────────────────────────────────────────────────────
 *   BLOCKED    the row may not be written — frozen, or its membership changed
 *   SKIPPED    evidence is insufficient or invalid — P0's skip-not-clamp doctrine
 *   UPDATED    a write that would change stored values  ← the only rows to write
 *   UNCHANGED  a write that would change nothing        ← deliberately not written
 *
 * Order is part of the contract: BLOCKED before SKIPPED before the change test.
 * A frozen row is blocked whether or not its evidence changed, and its
 * immutability is never expressed as "unchanged" — that would conflate "must not
 * be rewritten" with "need not be".
 */

import type { DayRegenResult } from "./regenerate-history.core";
import { WEALTH_REGEN_EPSILON } from "./regenerate-history.core";

export const REGENERATION_DISPOSITIONS = ["UNCHANGED", "UPDATED", "SKIPPED", "BLOCKED"] as const;
export type RegenerationDisposition = (typeof REGENERATION_DISPOSITIONS)[number];

/** The stored components a regeneration would overwrite. */
export interface StoredSnapshotComponents {
  stocks:   number;
  crypto:   number;
  cash:     number;
  savings:  number;
  debt:     number;
  netWorth: number;
}

/** One component whose recomputed value differs from what is stored. */
export interface ComponentDelta {
  component: keyof StoredSnapshotComponents;
  before:    number;
  after:     number;
  delta:     number;
}

export interface RegenerationCandidate {
  dateISO:     string;
  disposition: RegenerationDisposition;
  /** The core's own action, preserved so the mapping stays auditable. */
  action:      DayRegenResult["action"];
  /** Coded reason from the core, when it gave one. */
  reason:      string | null;
  /** Populated only for UPDATED; ascending by component name, never Map order. */
  deltas:      ComponentDelta[];
  /** The largest absolute change on this day — 0 unless UPDATED. */
  largestAbsDelta: number;
}

/** Declaration order IS emission order for deltas. */
const COMPONENTS: readonly (keyof StoredSnapshotComponents)[] = [
  "stocks", "crypto", "cash", "savings", "debt", "netWorth",
];

/**
 * Classify one day's regeneration result against what is stored.
 *
 * `existing` is null when no snapshot exists for the date — a write there is
 * always UPDATED, since creating a row is a change by definition.
 *
 * Differences at or below `epsilon` are not changes. The default is the same
 * WEALTH_REGEN_EPSILON the regeneration core uses, so this classifier and the
 * writer cannot disagree about what "different" means — a disagreement would
 * either rewrite rows forever or never rewrite them at all.
 */
export function classifyRegeneration(
  result:   DayRegenResult,
  existing: StoredSnapshotComponents | null,
  epsilon:  number = WEALTH_REGEN_EPSILON,
): RegenerationCandidate {
  const base = { dateISO: result.date, action: result.action, reason: result.reason ?? null };

  // 1. BLOCKED — immutability and identity, before anything about values.
  if (result.action === "skip-frozen" || result.action === "skip-membership-changed") {
    return { ...base, disposition: "BLOCKED", deltas: [], largestAbsDelta: 0 };
  }
  // 2. SKIPPED — P0's invalid-evidence guard and the no-fabrication rule.
  if (result.action === "skip-unsupported" || result.fields === null) {
    return { ...base, disposition: "SKIPPED", deltas: [], largestAbsDelta: 0 };
  }

  // 3. Value comparison.
  const fields = result.fields;
  if (existing === null) {
    return {
      ...base,
      disposition: "UPDATED",
      deltas: COMPONENTS.map((component) => ({
        component, before: 0, after: fields[component], delta: fields[component],
      })).filter((d) => Math.abs(d.delta) > epsilon),
      largestAbsDelta: COMPONENTS.reduce((m, c) => Math.max(m, Math.abs(fields[c])), 0),
    };
  }

  const deltas: ComponentDelta[] = [];
  for (const component of COMPONENTS) {
    const before = existing[component];
    const after  = fields[component];
    const delta  = after - before;
    if (Math.abs(delta) > epsilon) deltas.push({ component, before, after, delta });
  }

  if (deltas.length === 0) {
    return { ...base, disposition: "UNCHANGED", deltas: [], largestAbsDelta: 0 };
  }
  return {
    ...base,
    disposition: "UPDATED",
    deltas,
    largestAbsDelta: deltas.reduce((m, d) => Math.max(m, Math.abs(d.delta)), 0),
  };
}

export interface RegenerationImpact {
  candidates:  RegenerationCandidate[];
  unchanged:   number;
  updated:     number;
  skipped:     number;
  blocked:     number;
  /** Days that would actually be written — UPDATED only. */
  writable:    string[];
  /** Largest absolute component change across every UPDATED day. */
  largestAbsDelta: number;
}

/**
 * Aggregate a window's classifications. Deterministic: candidates are sorted by
 * date and `writable` is derived from them, never from iteration order.
 */
export function summariseRegenerationImpact(
  candidates: readonly RegenerationCandidate[],
): RegenerationImpact {
  const sorted = [...candidates].sort((a, b) => (a.dateISO < b.dateISO ? -1 : a.dateISO > b.dateISO ? 1 : 0));
  const count = (d: RegenerationDisposition): number => sorted.filter((c) => c.disposition === d).length;
  return {
    candidates:      sorted,
    unchanged:       count("UNCHANGED"),
    updated:         count("UPDATED"),
    skipped:         count("SKIPPED"),
    blocked:         count("BLOCKED"),
    writable:        sorted.filter((c) => c.disposition === "UPDATED").map((c) => c.dateISO),
    largestAbsDelta: sorted.reduce((m, c) => Math.max(m, c.largestAbsDelta), 0),
  };
}

/**
 * A newly introduced DISCONTINUITY: two adjacent written days whose net worth
 * jumps by more than `threshold`, where the jump is created by regeneration
 * rather than present in the stored series.
 *
 * Surfaced because "the chart moved" is the user-visible consequence of this
 * slice, and a regeneration that fixes an average while introducing a cliff is
 * not an improvement. Reported, never auto-corrected — smoothing a real
 * discontinuity would be fabrication.
 */
export function detectDiscontinuities(
  candidates: readonly RegenerationCandidate[],
  threshold:  number,
): Array<{ fromISO: string; toISO: string; jump: number }> {
  const updated = [...candidates]
    .filter((c) => c.disposition === "UPDATED")
    .sort((a, b) => (a.dateISO < b.dateISO ? -1 : 1));
  const out: Array<{ fromISO: string; toISO: string; jump: number }> = [];
  for (let i = 1; i < updated.length; i++) {
    const prev = updated[i - 1].deltas.find((d) => d.component === "netWorth");
    const curr = updated[i].deltas.find((d) => d.component === "netWorth");
    if (!prev || !curr) continue;
    // How much the DAY-OVER-DAY step changed as a result of regeneration.
    const jump = Math.abs(curr.delta - prev.delta);
    if (jump > threshold) {
      out.push({ fromISO: updated[i - 1].dateISO, toISO: updated[i].dateISO, jump });
    }
  }
  return out;
}
