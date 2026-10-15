/**
 * lib/snapshots/real-asset-amendment-offer.core.test.ts   (RWA-2B — CONSENT FLOW)
 *
 * The offer logic for "Update past net worth?":
 *   - a PERSONAL Space with an anchor before today is offered; a SHARED or
 *     unknown Space never; nothing when no history precedes today;
 *   - the requested range is [first anchor, yesterday];
 *   - the preview is clipped to days that already have a net-worth row and
 *     summarised as before → after on the most recent changed day.
 *
 *   npx tsx lib/snapshots/real-asset-amendment-offer.core.test.ts
 */
import {
  clipAmendmentPreview, realAssetAmendmentOffer, yesterdayOf, type PreviewDay,
} from "./real-asset-amendment-offer.core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const TODAY = "2026-10-15";

console.log("1. when to ask");
{
  const offer = realAssetAmendmentOffer({ spaceType: "PERSONAL", firstAnchorDate: "2026-01-01", today: TODAY });
  check("PERSONAL + an anchor before today → offered over [first anchor, yesterday]",
    JSON.stringify(offer) === JSON.stringify({ fromDate: "2026-01-01", toDate: "2026-10-14" }));
  check("SHARED → never", realAssetAmendmentOffer({ spaceType: "SHARED", firstAnchorDate: "2026-01-01", today: TODAY }) === null);
  check("unknown Space type → never (fail closed)",
    realAssetAmendmentOffer({ spaceType: undefined, firstAnchorDate: "2026-01-01", today: TODAY }) === null
    && realAssetAmendmentOffer({ spaceType: null, firstAnchorDate: "2026-01-01", today: TODAY }) === null);
  check("first anchor today → nothing before today to rebuild",
    realAssetAmendmentOffer({ spaceType: "PERSONAL", firstAnchorDate: TODAY, today: TODAY }) === null);
  check("no anchor → never", realAssetAmendmentOffer({ spaceType: "PERSONAL", firstAnchorDate: null, today: TODAY }) === null);
  check("yesterday across a month boundary", yesterdayOf("2026-03-01") === "2026-02-28" && yesterdayOf("2024-03-01") === "2024-02-29");
}

console.log("2. clipping the preview to the Space's existing history");
{
  const day = (date: string, action: string, before: number | null, after: number | null): PreviewDay => ({ date, action, netWorthBefore: before, netWorthAfter: after });
  const days: PreviewDay[] = [
    day("2026-01-01", "write", null, 100_000),      // before the Space had any row — never created
    day("2026-01-02", "write", null, 100_050),
    day("2026-01-03", "write", 5_000, 105_100),     // the Space's first row
    day("2026-01-04", "write", 5_000, 105_150),
    day("2026-01-05", "skip-unsupported", 5_100, null),
    day("2026-01-06", "write-partial", 5_200, 105_300),
    day("2026-01-07", "write", 5_300, 5_300),       // recomputes identically — engine still reports it
  ];
  const clipped = clipAmendmentPreview(days, { fromDate: "2026-01-01", toDate: "2026-01-07" });
  check("fromDate clips to the first day that already has a row", clipped?.fromDate === "2026-01-03" && clipped?.toDate === "2026-01-07");
  check("days before the Space's history are counted, never applied", clipped?.skippedBeforeHistory === 2);
  check("changed days = write + write-partial from the clipped start", clipped?.changedDays === 4, String(clipped?.changedDays));
  check("first/last changed dates", clipped?.firstChanged === "2026-01-03" && clipped?.lastChanged === "2026-01-07");
  check("the representative figure is net worth on the LAST changed day, before → after",
    clipped?.netWorthBefore === 5_300 && clipped?.netWorthAfter === 5_300);
  check("a Space with no row anywhere in the range → null (nothing to update)",
    clipAmendmentPreview(days.slice(0, 2), { fromDate: "2026-01-01", toDate: "2026-01-02" }) === null);
  check("days outside the requested range are ignored",
    clipAmendmentPreview(days, { fromDate: "2026-01-04", toDate: "2026-01-04" })?.changedDays === 1);
  const none = clipAmendmentPreview([day("2026-01-03", "skip-frozen", 5_000, null)], { fromDate: "2026-01-01", toDate: "2026-01-03" });
  check("rows exist but nothing changes → zero changed days, no figure", none?.changedDays === 0 && none?.netWorthAfter === null);
}

if (failures > 0) { console.error(`\nreal-asset-amendment-offer: ${failures} failure(s).`); process.exit(1); }
console.log("\nreal-asset-amendment-offer: all passed.");
