/**
 * lib/assets/manual-asset.test.ts   (RWA-1)
 *
 * The manual-asset vocabulary: the currency list IS the server allowlist, the
 * typed amount parses exactly the set the route accepts, and the age wording
 * never invents an age.
 *
 *   npx tsx lib/assets/manual-asset.test.ts
 */
import { FX_BASE, SUPPORTED_QUOTES, isSupportedCurrency } from "@/lib/fx/config";
import {
  ESTIMATE_DISCLOSURE, MANUAL_ASSET_CURRENCIES, describeEstimateAge, estimateCaption,
  estimateValueLabel, parseEstimateInput,
} from "./manual-asset";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("currencies — exactly the server allowlist");
check("every offered currency is accepted by the route's isSupportedCurrency",
  MANUAL_ASSET_CURRENCIES.every(isSupportedCurrency));
check("every accepted currency is offered (base + all quotes, 25)",
  MANUAL_ASSET_CURRENCIES.length === 1 + SUPPORTED_QUOTES.length &&
  MANUAL_ASSET_CURRENCIES[0] === FX_BASE, String(MANUAL_ASSET_CURRENCIES.length));
check("no duplicates", new Set(MANUAL_ASSET_CURRENCIES).size === MANUAL_ASSET_CURRENCIES.length);

console.log("labels — an estimate, in the currency actually chosen");
check("value label names the currency", estimateValueLabel("EUR") === "Your estimate of its value (EUR)");
check("value label never hard-codes $", !estimateValueLabel("GBP").includes("$"));
check("disclosure says estimate, not market price",
  /estimate/i.test(ESTIMATE_DISCLOSURE) && /not a verified market price/i.test(ESTIMATE_DISCLOSURE));

console.log("parseEstimateInput — the route's accept set");
check("plain number", parseEstimateInput("450000") === 450000);
check("commas tolerated", parseEstimateInput("1,250,000.50") === 1250000.5);
check("zero is a value", parseEstimateInput("0") === 0);
check("negative refused (route: balance < 0 → 400)", parseEstimateInput("-5") === null);
check("empty refused", parseEstimateInput("  ") === null);
check("text refused", parseEstimateInput("about 5k") === null);
check("Infinity refused", parseEstimateInput("Infinity") === null);

console.log("describeEstimateAge — coarse, never invented");
const now = new Date("2026-10-15T12:00:00Z");
const ago = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
check("today", describeEstimateAge(ago(0.2), now) === "updated today");
check("yesterday", describeEstimateAge(ago(1.1), now) === "updated yesterday");
check("days", describeEstimateAge(ago(12), now) === "updated 12 days ago");
check("one month", describeEstimateAge(ago(40), now) === "updated 1 month ago");
check("months", describeEstimateAge(ago(100), now) === "updated 3 months ago");
check("over a year", describeEstimateAge(ago(400), now) === "updated over a year ago");
check("future instant clamps to today, never negative", describeEstimateAge(ago(-3), now) === "updated today");
check("null → null (no invented age)", describeEstimateAge(null, now) === null);
check("garbage → null", describeEstimateAge("not a date", now) === null);
check("caption with age", estimateCaption(ago(12), now) === "Your estimate · updated 12 days ago");
check("caption without age is still labelled an estimate", estimateCaption(null, now) === "Your estimate");

if (failures > 0) {
  console.error(`\nmanual-asset: ${failures} failure(s).`);
  process.exit(1);
}
console.log("\nmanual-asset: all passed.");
