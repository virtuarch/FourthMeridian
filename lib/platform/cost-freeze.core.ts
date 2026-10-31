/**
 * lib/platform/cost-freeze.core.ts  (BETA LIFECYCLE L2 — the GLOBAL cost freeze, pure)
 *
 * Owner ruling 2026-10-31: a GLOBAL Cost Freeze stops every operation that can
 * incur a provider charge — per-customer work AND platform-wide work (paid
 * market data, historical pricing, FX refreshes, the sync-crypto global price
 * steps, the security-price job). Cached data stays readable. Default to
 * blocking: a free operation may continue only when it is PROVEN free.
 *
 * THE FLAG. One PlatformSetting row, `platform_cost_frozen` (registered in
 * lib/platform-settings.ts; no migration — the existing key/value mechanism),
 * judged with the admission-fact idiom:
 *
 *   "true"            → FROZEN
 *   "false"           → not frozen
 *   no row            → not frozen (ABSENT_MEANS_OFF — the flag ships absent)
 *   any other string  → FROZEN (an unreadable freeze is a freeze)
 *   the read threw    → FROZEN (fail closed: unknown is never "go")
 *
 * TWO CONSUMERS, one judgement:
 *   · the policy-group catalogue loader folds it in (every group reads as
 *     cost-frozen; an unreadable flag marks the lifecycle facts UNAVAILABLE),
 *     so every resolver-driven route and the billable gate see it with the
 *     catalogue's ≤ 25 s propagation;
 *   · platform-wide jobs with no single customer (lib/platform/cost-freeze.ts
 *     `readGlobalCostFreeze`) read it UNCACHED before any vendor call.
 */

import type { BillableDenialReason } from "@/lib/entitlements/billable-gate-core";

export type GlobalCostFreezeState = "ON" | "OFF" | "MISSING" | "INVALID" | "UNAVAILABLE";

export interface GlobalCostFreezeVerdict {
  /** True ⇒ no provider-charging work may start. */
  frozen: boolean;
  state: GlobalCostFreezeState;
  /** The refusal reason when frozen (COST_FREEZE when declared, POLICY_UNAVAILABLE when unreadable); null otherwise. */
  reason: Extract<BillableDenialReason, "COST_FREEZE" | "POLICY_UNAVAILABLE"> | null;
}

/** PURE — the verdict for one read outcome (undefined/null = no row; `unavailable` = the read threw). */
export function judgeGlobalCostFreeze(raw: string | null | undefined, unavailable = false): GlobalCostFreezeVerdict {
  if (unavailable) return { frozen: true, state: "UNAVAILABLE", reason: "POLICY_UNAVAILABLE" };
  if (raw === null || raw === undefined) return { frozen: false, state: "MISSING", reason: null };
  if (raw === "true") return { frozen: true, state: "ON", reason: "COST_FREEZE" };
  if (raw === "false") return { frozen: false, state: "OFF", reason: null };
  return { frozen: true, state: "INVALID", reason: "POLICY_UNAVAILABLE" };
}
