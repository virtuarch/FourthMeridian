/**
 * lib/connections/real-assets.ts  (Connections 2.0 — real assets in Connections)
 *
 * The user's OWN manual assets, as the Connections page lists them. Read inside
 * the page's tenant phase (the caller's client, never the global `db`), with the
 * same ownership predicate the rest of the Connections loader writes:
 *
 *   FinancialAccount.ownerUserId = me, syncStatus "manual", type "other",
 *   not deleted
 *
 * — exactly the rows the manual-asset write routes (PATCH/DELETE
 * /api/accounts/manual/[id]) accept from this user. An asset someone else owns
 * and shares into a Space is THEIRS to manage and stays out of this user's
 * Connections, the way their bank connections do.
 *
 * Three small reads, all bounded by the asset ids just read:
 *   · the asset rows (+ acquisition facts, + the Spaces it is ACTIVE in)
 *   · the latest valuation DATE per asset (AssetValuation, append-only ledger)
 *   · the user's own audit events for these assets (AuditLog SELECT policy is
 *     `userId = me`), kinds + dates only — see groupAssetActivity
 *
 * The value is FinancialAccount.balance, which the valuation route keeps equal
 * to the latest-dated valuation. Nothing is summed here.
 */

import { AccountType, ShareStatus } from "@prisma/client";
import type { ReadClient } from "@/lib/db/tenant-context";
import { accountDisplayName, ACCOUNT_NAME_SELECT } from "@/lib/accounts/display-identity";
import { displaySpaceName } from "@/lib/format";
import {
  groupAssetActivity, MANUAL_ASSET_ACTIVITY_ACTIONS, type ManualAssetLite,
} from "@/lib/connections/real-assets.core";

/** Activity is a convenience list; a user with thousands of revaluations sees the newest. */
const ACTIVITY_ROW_CAP = 1000;

const isoDay = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

export async function loadConnectionsManualAssets(client: ReadClient, userId: string): Promise<ManualAssetLite[]> {
  const rows = await client.financialAccount.findMany({
    where: {
      ownerUserId: userId, // ownership gate — the user's own assets only
      syncStatus:  "manual",
      type:        AccountType.other,
      deletedAt:   null,
    },
    select: {
      id: true, ...ACCOUNT_NAME_SELECT, balance: true, currency: true, lastUpdated: true,
      manualAssetProfile: { select: { acquisitionDate: true, purchasePrice: true, purchaseCurrency: true } },
      spaceAccountLinks:  { where: { status: ShareStatus.ACTIVE }, select: { space: { select: { id: true, name: true } } } },
    },
    orderBy: { createdAt: "asc" },
  });
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const [latest, audit] = await Promise.all([
    client.assetValuation.groupBy({
      by:    ["financialAccountId"],
      where: { financialAccountId: { in: ids } },
      _max:  { effectiveDate: true },
    }),
    client.auditLog.findMany({
      where:   { userId, action: { in: [...MANUAL_ASSET_ACTIVITY_ACTIONS] } },
      select:  { action: true, createdAt: true, metadata: true },
      orderBy: { createdAt: "desc" },
      take:    ACTIVITY_ROW_CAP,
    }),
  ]);
  const valuedAsOf = new Map(latest.map((l) => [l.financialAccountId, isoDay(l._max.effectiveDate)]));
  const activity = groupAssetActivity(audit, new Set(ids));

  return rows.map((r) => ({
    id:       r.id,
    name:     accountDisplayName(r),
    value:    r.balance,
    currency: r.currency,
    // A pre-ledger asset has no valuation row; its balance was dated by lastUpdated.
    valuedAsOfISO:      valuedAsOf.get(r.id) ?? isoDay(r.lastUpdated),
    acquisitionDateISO: isoDay(r.manualAssetProfile?.acquisitionDate),
    purchasePrice:      r.manualAssetProfile?.purchasePrice ?? null,
    purchaseCurrency:   r.manualAssetProfile?.purchaseCurrency ?? null,
    spaces:   r.spaceAccountLinks.map((l) => ({ id: l.space.id, name: displaySpaceName(l.space.name) })),
    activity: activity[r.id] ?? [],
  }));
}
