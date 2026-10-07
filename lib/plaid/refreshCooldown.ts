/**
 * lib/plaid/refreshCooldown.ts
 *
 * D2 Step 7B — manual refresh/sync cooldown, scoped to PlaidItem (not user,
 * not AccountConnection). Imported only by the two manual-trigger routes
 * (app/api/plaid/refresh/route.ts, app/api/plaid/sync/route.ts) — never by
 * lib/plaid/refresh.ts's internals, lib/plaid/syncTransactions.ts, or
 * jobs/sync-banks.ts. That keeps the scheduled job outside this cooldown by
 * construction, not by a conditional check that could later rot.
 *
 * P1 HUMAN OPERABILITY — the window is now the customer's EFFECTIVE ENTITLEMENT
 * (lib/entitlements: `manualBankRefreshCooldownMinutes`, policy 60, founder
 * overlay 15, platform floor 15). `MANUAL_REFRESH_COOLDOWN_MS` remains the
 * catalogue default for callers that have not loaded entitlements; the check
 * takes the window as a parameter so one rule serves banks AND wallets.
 */

import { db } from "@/lib/db";

/** 60 minutes — the catalogue default (BETA_FULL_ACCESS_V1.manualBankRefreshCooldownMinutes); callers with entitlements pass their own. */
export const MANUAL_REFRESH_COOLDOWN_MS = 60 * 60 * 1000;

export interface CooldownCheck {
  onCooldown: boolean;
  /** Only set when onCooldown is true. */
  retryAfterSeconds?: number;
}

/**
 * Pure check against an already-fetched PlaidItem.lastManualRefreshAt — no
 * DB call. `null` (never manually refreshed) is always off cooldown.
 */
export function checkManualRefreshCooldown(
  lastManualRefreshAt: Date | null,
  cooldownMs: number = MANUAL_REFRESH_COOLDOWN_MS,
  nowMs: number = Date.now(),
): CooldownCheck {
  if (!lastManualRefreshAt) return { onCooldown: false };

  const elapsedMs = nowMs - lastManualRefreshAt.getTime();
  if (elapsedMs >= cooldownMs) return { onCooldown: false };

  return {
    onCooldown: true,
    retryAfterSeconds: Math.ceil((cooldownMs - elapsedMs) / 1000),
  };
}

/** The entitlement dimension is in minutes; the check is in milliseconds. */
export function cooldownMsFromMinutes(minutes: number): number {
  return Math.max(0, Math.floor(minutes)) * 60 * 1000;
}

/**
 * Marks a single PlaidItem as manually attempted just now — called on every
 * manual attempt (success or failure), since a failed call still reached
 * Plaid and still cost an API call.
 */
export async function markManualRefreshed(plaidItemId: string): Promise<void> {
  await db.plaidItem.update({
    where: { id: plaidItemId },
    data:  { lastManualRefreshAt: new Date() },
  });
}

/** Bulk variant for the "refresh/sync all active items" path — one query instead of N. */
export async function markManyManualRefreshed(plaidItemIds: string[]): Promise<void> {
  if (plaidItemIds.length === 0) return;
  await db.plaidItem.updateMany({
    where: { id: { in: plaidItemIds } },
    data:  { lastManualRefreshAt: new Date() },
  });
}
