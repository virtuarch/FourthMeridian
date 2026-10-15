/**
 * lib/snapshots/real-asset-basis.ts   (RWA-2B — READ BOUNDARY, server side)
 *
 * Which of a Space's stored history dates have a MODELED real-asset basis,
 * answered from the manual assets' valuation ledgers on the CALLER'S client
 * (the tenant for a request, the system client for a job — exactly the
 * authority the snapshot read itself runs under; nothing is resolved here).
 *
 * One bounded read of the Space's ACTIVE manual-asset links, one bulk ledger
 * read (loadHistoriesFor, the RWA-2A reader), then the pure rule
 * (real-asset-basis.core.ts). A Space with no manual asset costs the link
 * query alone and returns an empty map, so every other Space's read is
 * unchanged.
 */

import type { ReadClient } from "@/lib/db/tenant-context";
import { loadHistoriesFor } from "@/lib/assets/valuations";
import type { ValuationBasis } from "@/lib/assets/valuation-series.core";
import { isLegacyManualAsset, type ManualAssetHistoryInput } from "@/lib/snapshots/manual-asset-history.core";
import { realAssetBasisByDate } from "@/lib/snapshots/real-asset-basis.core";

/**
 * date (YYYY-MM-DD) → the least-trusted manual-asset basis on that date, for
 * every date given. Empty when the Space has no manual asset.
 */
export async function loadRealAssetBasisByDate(
  client: ReadClient,
  spaceId: string,
  dates: readonly string[],
  today: string,
): Promise<Map<string, ValuationBasis | null>> {
  if (dates.length === 0) return new Map();
  const links = await client.spaceAccountLink.findMany({
    where: {
      spaceId,
      status: "ACTIVE",
      financialAccount: { deletedAt: null, type: "other", syncStatus: "manual" },
    },
    select: { financialAccount: { select: { id: true, currency: true, balance: true, lastUpdated: true } } },
  });
  if (links.length === 0) return new Map();

  const histories = await loadHistoriesFor(client, links.map((l) => l.financialAccount), today);
  const assets: ManualAssetHistoryInput[] = [...histories.values()].map((h) => ({
    resolved: h.resolved,
    isLegacy: isLegacyManualAsset({ resolved: h.resolved, hasProfile: h.profile !== null }),
  }));
  return realAssetBasisByDate(assets, dates);
}
