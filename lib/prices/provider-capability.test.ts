/**
 * lib/prices/provider-capability.test.ts
 *
 * V26-CAP-1 — capability comparison, widening intervals, and the static
 * guarantees that orchestration never invents its own depth arithmetic.
 * Standalone tsx, pure (no DB).
 */

import {
  compareCapability, isValidCapabilityDeclaration, newlyAvailableInterval, widensCapability,
  type CapabilityDeclaration,
} from "./provider-capability.core";
import { readFileSync } from "node:fs";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const rolling = (days: number, floor = "2025-08-03"): CapabilityDeclaration =>
  ({ kind: "ROLLING", historyDays: days, earliestSupportedISO: floor, source: "CONFIG" });
const fixed = (floor: string): CapabilityDeclaration =>
  ({ kind: "FIXED", historyDays: null, earliestSupportedISO: floor, source: "CONFIG" });

function main(): void {
  console.log("V26-CAP-1 — provider capability\n");

  // ── A–H: comparison semantics ─────────────────────────────────────────────
  console.log("comparison");
  check("A. no previous observation → first-observation",
    compareCapability(null, rolling(365)) === "first-observation");
  check("B. same depth → unchanged", compareCapability(rolling(365), rolling(365)) === "unchanged");
  check("C. deeper rolling window → widened", compareCapability(rolling(365), rolling(730)) === "widened");
  check("D. shallower rolling window → narrowed", compareCapability(rolling(730), rolling(365)) === "narrowed");
  check("D. FIXED: earlier floor is WIDER", compareCapability(fixed("1995-01-01"), fixed("1990-01-01")) === "widened");
  check("D. FIXED: later floor is NARROWER", compareCapability(fixed("1990-01-01"), fixed("1995-01-01")) === "narrowed");
  check("G. ROLLING vs FIXED is incomparable, never an invented ordering",
    compareCapability(rolling(365), fixed("1990-01-01")) === "incomparable" &&
    compareCapability(fixed("1990-01-01"), rolling(365)) === "incomparable");

  // THE ROLLING TRAP — a rolling floor advances one day every day. Comparing the
  // DERIVED DATE would report "narrowed" daily and bury real widenings.
  check("rolling: same depth, floor moved forward a day → still UNCHANGED",
    compareCapability(rolling(365, "2025-08-03"), rolling(365, "2025-08-04")) === "unchanged");
  check("rolling: a year of drift at the same depth is still UNCHANGED",
    compareCapability(rolling(365, "2025-08-03"), rolling(365, "2026-08-03")) === "unchanged");

  // ── E: validation is a refusal, never a repair ────────────────────────────
  console.log("\nvalidation");
  check("E. rejects a non-integer depth", !isValidCapabilityDeclaration({ ...rolling(365), historyDays: 1.5 }));
  check("E. rejects a zero/negative depth",
    !isValidCapabilityDeclaration({ ...rolling(365), historyDays: 0 }) &&
    !isValidCapabilityDeclaration({ ...rolling(365), historyDays: -1 }));
  check("E. rejects a malformed floor", !isValidCapabilityDeclaration({ ...rolling(365), earliestSupportedISO: "2025-8-3" }));
  check("E. rejects an unknown kind", !isValidCapabilityDeclaration({ ...rolling(365), kind: "SLIDING" }));
  check("E. rejects a FIXED declaration carrying a depth",
    !isValidCapabilityDeclaration({ ...fixed("1990-01-01"), historyDays: 365 }));
  check("E. rejects null/undefined/primitives",
    !isValidCapabilityDeclaration(null) && !isValidCapabilityDeclaration(undefined) && !isValidCapabilityDeclaration("2025-08-03"));
  check("E. accepts well-formed ROLLING and FIXED",
    isValidCapabilityDeclaration(rolling(365)) && isValidCapabilityDeclaration(fixed("1990-01-01")));

  // ── F: UTC / date-boundary correctness ────────────────────────────────────
  console.log("\nUTC boundaries");
  check("F. rejects a non-real calendar date (2025-02-30)",
    !isValidCapabilityDeclaration({ ...rolling(365), earliestSupportedISO: "2025-02-30" }));
  check("F. accepts a real leap day", isValidCapabilityDeclaration({ ...rolling(365), earliestSupportedISO: "2024-02-29" }));
  check("F. rejects a non-leap Feb 29", !isValidCapabilityDeclaration({ ...rolling(365), earliestSupportedISO: "2025-02-29" }));

  // ── Newly available interval ──────────────────────────────────────────────
  console.log("\nnewly available interval");
  {
    const i = newlyAvailableInterval("2025-08-03", "2024-08-03");
    check("widening 1y → interval is exactly the previously unreachable dates",
      i?.fromISO === "2024-08-03" && i?.toISO === "2025-08-02", JSON.stringify(i));
    check("…and it does NOT include the already-covered floor", i!.toISO < "2025-08-03");
  }
  check("no widening → null", newlyAvailableInterval("2025-08-03", "2025-08-03") === null);
  check("narrowing → null", newlyAvailableInterval("2025-08-03", "2026-01-01") === null);
  check("adjacent floors open nothing", newlyAvailableInterval("2025-08-03", "2025-08-02")?.fromISO === "2025-08-02");
  check("month/leap boundaries are UTC-exact",
    newlyAvailableInterval("2024-03-01", "2024-01-01")?.toISO === "2024-02-29");

  // ── Only a widening schedules work ────────────────────────────────────────
  console.log("\nwork scheduling");
  check("ONLY widened schedules work",
    widensCapability("widened") &&
    !widensCapability("narrowed") && !widensCapability("unchanged") &&
    !widensCapability("first-observation") && !widensCapability("incomparable"));

  // ── H / static guards ─────────────────────────────────────────────────────
  console.log("\nstatic guards");
  {
    const stripComments = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const core   = stripComments(readFileSync("lib/prices/provider-capability.core.ts", "utf8"));
    const bind   = stripComments(readFileSync("lib/prices/provider-capability.ts", "utf8"));
    const recon  = stripComments(readFileSync("lib/prices/capability-reconciliation.ts", "utf8"));
    const cron   = stripComments(readFileSync("jobs/sync-crypto.ts", "utf8"));
    const gecko  = readFileSync("lib/prices/providers/coingecko.ts", "utf8");

    // 1. exactly one CoinGecko floor authority
    const floorDefs = (gecko.match(/export function resolveCoinGeckoFloorISO/g) ?? []).length;
    check("1. exactly one CoinGecko capability-floor authority", floorDefs === 1);
    check("1. …and orchestration never recomputes a floor",
      !/resolveCoinGeckoFloorISO|minusDaysISO/.test(core + bind + recon));

    // 2/3. no parallel depth arithmetic, no hardcoded plan or day count
    check("2. capability core names no vendor, plan, asset or tier",
      !/coingecko|bitcoin|BTC|tiingo|public|paid|demo|pro\b/i.test(core));
    check("3. the trigger hardcodes no day count or plan name",
      !/\b365\b|\b730\b|demo|public tier|paid/i.test(recon));
    check("3. …and takes the provider source as data, not a literal",
      /BTC_PRICE_SOURCE/.test(cron) && !/"coingecko"/.test(cron));

    // 4. capability widening never writes snapshot support
    check("4. reconciliation writes no SpaceSnapshot and no price",
      !/spaceSnapshot|priceObservation\.(create|update)|cryptoValuationStatus/.test(recon));
    check("4. …it only PLANS — no regeneration call",
      !/regenerateWealthHistory|backfillPrices|backfillHeldInstrument/.test(recon));

    // 5. narrowing never deletes evidence
    check("5. nothing in this slice deletes a PriceObservation",
      !/priceObservation\.delete|deleteMany/.test(core + bind + recon));

    // 7. no read path performs reconciliation
    const walletRoute = stripComments(readFileSync("app/api/accounts/wallet/route.ts", "utf8"));
    const syncRoute   = stripComments(readFileSync("app/api/accounts/[id]/sync/route.ts", "utf8"));
    check("7. no API route performs capability reconciliation",
      !/reconcileProviderCapability|observeProviderCapability/.test(walletRoute + syncRoute));
    check("7. the scheduled sweep is the trigger", /reconcileProviderCapability/.test(cron));

    // 8. identity is deployment-scoped and the credential is never persisted
    check("8. the credential is fingerprinted, never stored",
      /createHash/.test(bind) && !/data:\s*\{[^}]*secret/.test(bind));
    check("8. scope is deployment-level and stated", /CAPABILITY_SCOPE_DEPLOYMENT/.test(bind));
  }

  console.log(failures === 0 ? "\nAll provider-capability guards passed." : `\n${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
