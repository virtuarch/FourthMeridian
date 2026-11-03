/**
 * lib/platform/ai/spend-anomaly.ts  (quota/cost anomaly — the AI spend windows)
 *
 * Eight consecutive trailing 24 h windows of customer-surface AI spend, each
 * folded by THE fleet fold (spend-health.ts foldSpendGroups) over THE grouped
 * read (readUserSpendGroups). Window 0 is exactly the window `ai-spend-fleet-high`
 * judges ([now − 24 h, now]); windows 1..7 are the baseline, each ending 1 ms
 * before the next one starts, so no invocation is counted twice.
 *
 * Classification per window (lib/alerts/anomaly.ts AnomalyWindow):
 *   no customer invocations                 ⇒ IDLE      (unavailable, never $0)
 *   any invocation the rate card can't price ⇒ UNPRICED  (the fleet status PARTIAL /
 *                                                         UNAVAILABLE: a lower bound)
 *   otherwise                               ⇒ VALUE     (estimated USD)
 *
 * IDENTITY: per-customer figures leave this module keyed by opaqueUserRef /
 * opaqueDedupeToken only. The raw user id is used to join windows and is
 * dropped here.
 */

import "server-only";
import { foldSpendGroups, readUserSpendGroups, type SpendFold, type UserSpendGroup } from "@/lib/platform/ai/spend-health";
import { opaqueDedupeToken, opaqueUserRef } from "@/lib/platform/opaque-user-ref";
import { ANOMALY_DEFINITION, type AnomalyWindow } from "@/lib/alerts/anomaly";
import type { AiSpendAnomalyFacts } from "@/lib/alerts/authorities";

const HOUR_MS = 60 * 60 * 1000;

/** Pure: one window's fleet classification from its fold. */
export function fleetWindowOf(f: SpendFold): AnomalyWindow {
  if (f.invocations === 0) return { kind: "IDLE" };
  if (f.unpricedInvocations > 0 || f.fleetUsd === null) return { kind: "UNPRICED", unpricedInvocations: f.unpricedInvocations };
  return { kind: "VALUE", value: f.fleetUsd };
}

/**
 * Pure: the facts from folds (window 0 first). `refOf` / `dedupeOf` turn a raw
 * id into its opaque reference (injected so a test never needs the secret).
 */
export function buildAiSpendAnomalyFacts(
  folds: readonly SpendFold[],
  now: Date,
  windowHours: number,
  refOf: (userId: string) => string = opaqueUserRef,
  dedupeOf: (userId: string) => string = opaqueDedupeToken,
): AiSpendAnomalyFacts {
  const windows = folds.map(fleetWindowOf);
  const [current, ...baseline] = windows;
  // Per customer: only when the current window is fully priced (an unpriced
  // call may belong to any customer, so every per-customer figure is a lower
  // bound). A baseline window that is not fully priced is UNPRICED for every
  // customer; a fully priced window without them is a measured zero (IDLE).
  const customers: AiSpendAnomalyFacts["customers"] = [];
  if (current?.kind === "VALUE") {
    for (const [userId, usd] of folds[0].perUser) {
      if (!(usd > 0)) continue;
      customers.push({
        ref: refOf(userId),
        dedupe: dedupeOf(userId),
        current: { kind: "VALUE", value: usd },
        baseline: baseline.map((w, i) => {
          if (w.kind === "UNPRICED" || w.kind === "UNREADABLE") return w;
          const v = folds[i + 1].perUser.get(userId);
          return v !== undefined && v > 0 ? { kind: "VALUE", value: v } : { kind: "IDLE" };
        }),
      });
    }
  }
  return {
    checkedAt: now.toISOString(),
    windowHours,
    fleet: { current: current ?? { kind: "UNREADABLE" }, baseline },
    customers,
  };
}

export interface AiSpendAnomalyDeps {
  now?: Date;
  groups?: (since: Date, until: Date) => Promise<UserSpendGroup[]>;
}

/** The authority read: one grouped query per window (8, small, sequential). */
export async function getAiSpendAnomalyFacts(deps: AiSpendAnomalyDeps = {}): Promise<AiSpendAnomalyFacts> {
  const now = deps.now ?? new Date();
  const read = deps.groups ?? readUserSpendGroups;
  const windowHours = 24;
  const folds: SpendFold[] = [];
  for (let k = 0; k <= ANOMALY_DEFINITION.baselineWindows; k++) {
    const end = new Date(now.getTime() - k * windowHours * HOUR_MS - (k > 0 ? 1 : 0));
    const start = new Date(now.getTime() - (k + 1) * windowHours * HOUR_MS);
    folds.push(foldSpendGroups(await read(start, end)));
  }
  return buildAiSpendAnomalyFacts(folds, now, windowHours);
}
