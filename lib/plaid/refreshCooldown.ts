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
 * The cooldown window is a local constant for now. Provider-level config
 * (e.g. a ProviderCatalog-driven, per-provider limit) is a later decision —
 * out of scope for this slice.
 */

import { db } from "@/lib/db";

/** 60 minutes. See module header for why this isn't provider-configurable yet. */
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
export function checkManualRefreshCooldown(lastManualRefreshAt: Date | null): CooldownCheck {
  if (!lastManualRefreshAt) return { onCooldown: false };

  const elapsedMs = Date.now() - lastManualRefreshAt.getTime();
  if (elapsedMs >= MANUAL_REFRESH_COOLDOWN_MS) return { onCooldown: false };

  return {
    onCooldown: true,
    retryAfterSeconds: Math.ceil((MANUAL_REFRESH_COOLDOWN_MS - elapsedMs) / 1000),
  };
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
