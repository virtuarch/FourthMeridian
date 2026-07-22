/**
 * lib/fx/providers/providers.test.ts
 *
 * MC1 Phase 1 Slice 3 — provider parser tests with recorded-shape fixtures
 * (pure, no network — plan §4). Only the exported pure parsers are exercised;
 * the fetching wrappers are one-line URL+timeout shells validated live by the
 * backfill's --verify (plan §4 "archive spot-check").
 */

import { parseOxrHistorical } from "./openExchangeRates";
import { FRANKFURTER_QUOTES, parseFrankfurterDay } from "./frankfurter";
import { SUPPORTED_QUOTES } from "../config";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

const D = "2026-07-02";

// ── Open Exchange Rates ───────────────────────────────────────────────────────

const oxrFixture = {
  base: "USD",
  rates: { EUR: 0.851234, GBP: 0.731111, SAR: 3.7505, AED: 3.6725 },
};

{
  const rows = parseOxrHistorical(oxrFixture, D, ["EUR", "GBP", "SAR", "AED"]);
  check("oxr: canonical RateResult shape",
    rows.length === 4 && rows.every((r) => r.base === "USD" && r.dateISO === D && r.rate > 0));
  check("oxr: SAR/AED served (primary-provider driver)",
    rows.some((r) => r.quote === "SAR" && r.rate === 3.7505) && rows.some((r) => r.quote === "AED"));
  check("oxr: only requested quotes returned",
    parseOxrHistorical(oxrFixture, D, ["EUR"]).length === 1);

  let missingThrew = false;
  try { parseOxrHistorical(oxrFixture, D, ["EUR", "JPY"]); } catch { missingThrew = true; }
  check("oxr: missing quote throws (complete-or-throw → failover)", missingThrew);

  let baseThrew = false;
  try { parseOxrHistorical({ base: "EUR", rates: { GBP: 0.8 } }, D, ["GBP"]); } catch { baseThrew = true; }
  check("oxr: non-USD base throws", baseThrew);

  let badRateThrew = false;
  try { parseOxrHistorical({ base: "USD", rates: { EUR: -1 } }, D, ["EUR"]); } catch { badRateThrew = true; }
  check("oxr: non-positive rate throws", badRateThrew);
}

// ── Frankfurter ───────────────────────────────────────────────────────────────

const frankfurterFixture = {
  base: "USD",
  date: D,
  rates: { EUR: 0.8523, GBP: 0.7305 },
};

{
  const rows = parseFrankfurterDay(frankfurterFixture, D, ["EUR", "GBP"]);
  check("frankfurter: canonical RateResult shape",
    rows.length === 2 && rows.every((r) => r.base === "USD" && r.dateISO === D && r.rate > 0));

  // The graceful-limitation contract: a weekend/holiday request is answered
  // with the PREVIOUS banking day's date → parser returns [] (no data), never
  // rows forged under the requested date.
  const sunday = "2026-07-05";
  const answeredWithFriday = { base: "USD", date: "2026-07-03", rates: { EUR: 0.85 } };
  check("frankfurter: non-banking day → [] (no forged close)",
    parseFrankfurterDay(answeredWithFriday, sunday, ["EUR"]).length === 0);

  let missingThrew = false;
  try { parseFrankfurterDay(frankfurterFixture, D, ["EUR", "JPY"]); } catch { missingThrew = true; }
  check("frankfurter: missing quote throws", missingThrew);

  let baseThrew = false;
  try { parseFrankfurterDay({ base: "EUR", date: D, rates: { GBP: 0.8 } }, D, ["GBP"]); } catch { baseThrew = true; }
  check("frankfurter: non-USD base throws", baseThrew);

  // ECB subset: exactly the approved list minus SAR/AED
  check("frankfurter: quote subset = approved minus SAR/AED",
    FRANKFURTER_QUOTES.length === SUPPORTED_QUOTES.length - 2 &&
    !FRANKFURTER_QUOTES.includes("SAR") && !FRANKFURTER_QUOTES.includes("AED"));
}

if (failures.length > 0) {
  console.error(`\nMC1 P1 fx providers: ${failures.length} FAILURE(S) (${passed} checks passed):`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`MC1 P1 fx providers: all ${passed} checks passed.`);
process.exit(0);
