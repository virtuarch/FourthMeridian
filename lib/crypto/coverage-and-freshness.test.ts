/**
 * lib/crypto/coverage-and-freshness.test.ts
 *
 * W6b — the two temporal boundaries, each with its own authority.
 *
 *     npx tsx lib/crypto/coverage-and-freshness.test.ts
 *
 * HISTORICAL. W6 bounded the forward carry at the first and last spine row. That
 * was better than an unbounded carry and still the wrong authority: it read the
 * SHAPE of the evidence as the licence to project it. It only looked right
 * because this replay writes one row per licensed day — an implementation
 * detail. The licence is `ChainCoverage`, and it is now persisted.
 *
 * CURRENT. `isEstimated=false` was being read as freshness. It is not: it says a
 * row was recorded rather than reconstructed, and says nothing about when the
 * provider last answered. A wallet whose sync has been failing for a week was
 * being published as today's confirmed wealth.
 *
 * The rule both halves share: EXISTENCE OF A ROW IS NOT AUTHORITY.
 */

import { readFileSync } from "fs";
import { join } from "path";
import {
  resolveLicensedQuantityAsOf, licensedInterval, hasBlockingCaveat,
  isCoverageKind, BLOCKING_CAVEATS,
} from "./position-coverage";
import type { ChainCoverage } from "./chain-movement";
import {
  bandForAge, ageInDays, isStaleBand, STALE_AFTER_DAYS, LIVE_WITHIN_DAYS,
} from "@/lib/freshness/observation";
import {
  resolveCryptoValuationState, isCryptoAssertable, isCryptoLastKnown,
  isAssetSideContaminated, cryptoUnavailableReason,
} from "@/lib/snapshots/crypto-valuation-status.core";

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const read = (...s: string[]) => readFileSync(join(process.cwd(), ...s), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

const SRC = "solana-rpc";
const complete = (from: string, to: string): ChainCoverage =>
  ({ kind: "COMPLETE", fromISO: from, toISO: to, source: `${SRC}+balance-reconciliation` });
const partial = (from: string | null, to: string | null, caveats: ChainCoverage extends { caveats: infer C } ? C : never = [] as never): ChainCoverage =>
  ({ kind: "PARTIAL", coveredFromISO: from, coveredToISO: to, caveats, source: SRC });
const unknown = (...caveats: string[]): ChainCoverage =>
  ({ kind: "UNKNOWN", caveats: caveats as never, source: SRC });

// The real wallet's shape, deliberately SPARSE: two rows describing a four-year
// interval. The dense daily representation is an implementation detail.
const SPARSE = [
  { dateISO: "2026-02-26", quantity: 100.776600602 },
  { dateISO: "2026-02-27", quantity: 0.7516006019999789 },
];

// ══ COVERAGE IS THE LICENCE; ROWS ARE THE EVIDENCE ════════════════════════════
{
  const c = complete("2022-03-26", "2026-08-26");

  check("inside a licensed interval a SPARSE representation still carries",
    resolveLicensedQuantityAsOf(SPARSE, c, "2026-06-15").quantity === 0.7516006019999789,
    "the licence says nothing happened in between; row spacing is not the authority");
  check("…naming the evidence it actually used",
    resolveLicensedQuantityAsOf(SPARSE, c, "2026-06-15").evidenceDateISO === "2026-02-27");
  check("the Feb-27 disposition survives the licence",
    resolveLicensedQuantityAsOf(SPARSE, c, "2026-02-26").quantity === 100.776600602
      && resolveLicensedQuantityAsOf(SPARSE, c, "2026-02-27").quantity === 0.7516006019999789);

  // ROW PRESENCE IS NOT AUTHORITY — the headline regression.
  const rowsBeyond = [...SPARSE, { dateISO: "2026-12-25", quantity: 42.5 }];
  const beyond = resolveLicensedQuantityAsOf(rowsBeyond, c, "2026-12-25");
  check("a row BEYOND the licensed edge does not make its date assertable",
    beyond.quantity === null && beyond.refusal === "BEYOND_LICENSED_COVERAGE",
    "existing is not the same as being licensed to represent a date");
  check("…and it does not leak backward into licensed dates either",
    resolveLicensedQuantityAsOf(rowsBeyond, c, "2026-08-26").quantity === 0.7516006019999789);

  check("before the licensed interval is BEFORE_FIRST_DEFENSIBLE_ANCHOR, never zero",
    resolveLicensedQuantityAsOf(SPARSE, c, "2021-06-01").refusal === "BEFORE_FIRST_DEFENSIBLE_ANCHOR"
      && resolveLicensedQuantityAsOf(SPARSE, c, "2021-06-01").quantity === null);
  check("licensed, but with no evidence yet reaching the date, is also not zero",
    resolveLicensedQuantityAsOf(SPARSE, c, "2022-06-01").quantity === null);
}

// ══ THE COVERAGE CASES ════════════════════════════════════════════════════════
{
  check("COMPLETE licenses exactly its stated bounds",
    JSON.stringify(licensedInterval(complete("2024-01-01", "2024-06-30")))
      === JSON.stringify({ fromISO: "2024-01-01", toISO: "2024-06-30" }));

  const p = partial("2024-01-01", "2024-03-31", ["ADDRESS_INDEX_INCOMPLETE"] as never);
  check("PARTIAL licenses only what it proved",
    JSON.stringify(licensedInterval(p)) === JSON.stringify({ fromISO: "2024-01-01", toISO: "2024-03-31" }));
  check("…and stops EXACTLY at the bound",
    resolveLicensedQuantityAsOf(SPARSE, p, "2024-03-31").refusal === null
      || resolveLicensedQuantityAsOf(SPARSE, p, "2024-03-31").refusal === "BEFORE_FIRST_DEFENSIBLE_ANCHOR");
  check("…refusing the very next day",
    resolveLicensedQuantityAsOf(SPARSE, p, "2024-04-01").refusal === "BEYOND_LICENSED_COVERAGE");

  check("an OPEN edge is unproven, not unbounded",
    licensedInterval(partial("2024-01-01", null)) === null
      && licensedInterval(partial(null, "2024-06-30")) === null,
    "a coverage that cannot say where it ended must not carry through the gap");

  check("UNKNOWN coverage licenses nothing",
    licensedInterval(unknown("ADDRESS_INDEX_INCOMPLETE")) === null
      && resolveLicensedQuantityAsOf(SPARSE, unknown(), "2026-02-27").refusal === "COVERAGE_UNLICENSED");

  check("NO coverage record licenses nothing — row presence may not stand in",
    resolveLicensedQuantityAsOf(SPARSE, null, "2026-02-27").refusal === "NO_COVERAGE_RECORD");
}

// ══ A BLOCKING CAVEAT PREVENTS CARRY EVEN WITH ROWS PRESENT ═══════════════════
{
  for (const caveat of BLOCKING_CAVEATS) {
    const blocked = partial("2022-01-01", "2026-12-31", [caveat] as never);
    check(`${caveat} blocks the licence outright`,
      hasBlockingCaveat(blocked) && licensedInterval(blocked) === null);
    check(`…so a date with a row present still refuses under ${caveat}`,
      resolveLicensedQuantityAsOf(SPARSE, blocked, "2026-02-27").refusal === "COVERAGE_UNLICENSED",
      "a run that knows it stopped early cannot have its silence read as absence");
  }
  // ADDRESS_INDEX_INCOMPLETE is deliberately NOT blocking: it is a hazard the
  // reconciliation can close over, which is the whole basis of the SOL licence.
  check("ADDRESS_INDEX_INCOMPLETE alone does NOT block a proven interval",
    !hasBlockingCaveat(partial("2022-01-01", "2026-08-26", ["ADDRESS_INDEX_INCOMPLETE"] as never)));

  // One list, shared with the acquisition-time upgrade.
  check("the acquisition-time upgrade reads the SAME blocking list",
    /BLOCKING_CAVEATS\.includes/.test(code(read("lib", "crypto", "chain-movement.ts"))),
    "two copies of this list would eventually disagree");
}

// ══ RECONCILIATION-LICENSED, NOT MOVEMENT-ABSENCE-LICENSED ════════════════════
{
  // The real wallet's licence: COMPLETE, sourced from the arithmetic closing —
  // not from "no movement row happened to exist in the interval".
  const real = complete("2022-03-26", "2026-08-26");
  check("the SOL licence is sourced from balance reconciliation",
    real.source.includes("balance-reconciliation"));
  const chain = code(read("lib", "crypto", "chain-movement.ts"));
  check("the upgrade requires the residual to actually close",
    /if \(!recon\.reconciles\) return coverage;/.test(chain));
  check("…and refuses to upgrade an open-ended PARTIAL",
    /coveredFromISO === null \|\| coverage\.coveredToISO === null\) return coverage;/.test(chain));
  check("…extending only to the OBSERVATION the arithmetic closed against",
    /observedAtISO && observedAtISO > coverage\.coveredToISO/.test(chain));
}

// ══ THE LICENCE IS PERSISTED WITH THE EVIDENCE IT LICENSES ════════════════════
{
  const sync = code(read("lib", "crypto", "sol-history-sync.ts"));
  check("acquisition persists the coverage it computed",
    /persistPositionCoverage\(tx, accountId, instrumentId, licensed\)/.test(sync));
  {
    // Both writes must sit inside the ONE `db.$transaction` block: rows and
    // their licence must never be able to disagree after a partial write.
    const tx = sync.slice(sync.indexOf("db.$transaction"));
    const body = tx.slice(0, tx.indexOf("\n    });"));
    check("…inside the SAME transaction as the rows",
      body.includes("positionObservation.createMany") && body.includes("persistPositionCoverage("),
      "rows and their licence must never be able to disagree after a partial write");
  }
  check("the stored vocabulary is guarded, never a parallel one",
    isCoverageKind("COMPLETE") && isCoverageKind("PARTIAL") && isCoverageKind("UNKNOWN")
      && !isCoverageKind("complete") && !isCoverageKind("ok"));

  const binding = code(read("lib", "snapshots", "regenerate-history.ts"));
  check("the historical binding asks the licence, not the row bounds",
    /resolveLicensedQuantityAsOf\(/.test(binding) && !/bounds\.lastISO/.test(binding));
  check("origin precedence still decides WHICH row wins",
    /resolvePositionAsOf\(rows, dISO\)\.quantity/.test(binding),
    "the licence decides whether any row may speak; it does not rank them");
  check("the historical path still reads no CURRENT wallet authority",
    !/loadWalletCurrentValues/.test(binding));
}

// ══ CURRENT: FRESHNESS IS NOT isEstimated ═════════════════════════════════════
{
  const wcv = read("lib", "crypto", "wallet-current-value.ts");
  check("freshness comes from the canonical band authority, not a local TTL",
    /bandForAge\(ageInDays\(observedAt, now\)\)/.test(wcv));
  check("no invented threshold appears in the wallet authority",
    !/24 \* 60 \* 60|86400|hours?\s*[<>]=?\s*\d/.test(code(wcv)));
  check("the clock used is the SUCCESSFUL-read clock",
    /lastUpdated/.test(wcv) && /successful provider read/i.test(wcv));

  // The bands themselves, so a change to them is a deliberate act.
  check("LIVE is under a day, STALE begins at a week",
    LIVE_WITHIN_DAYS === 1 && STALE_AFTER_DAYS === 7);
  check("bandForAge draws the line where the authority says",
    bandForAge(0.5) === "LIVE" && bandForAge(3) === "RECENT"
      && bandForAge(8) === "STALE" && bandForAge(40) === "VERY_STALE");
  check("a missing timestamp is UNKNOWN and never laundered into a band",
    bandForAge(null) === "UNKNOWN" && !isStaleBand("UNKNOWN"));

  const now = new Date("2026-08-27T12:00:00.000Z");
  check("age is measured from the observation to now",
    Math.abs(ageInDays(new Date("2026-08-26T12:00:00.000Z"), now) - 1) < 1e-9);
}

// ══ FRESH vs STALE vs NONE — THREE DIFFERENT ANSWERS ══════════════════════════
{
  const wcv = read("lib", "crypto", "wallet-current-value.ts");
  check("STALE is a declared state, not an absence",
    /"VALUED" \| "STALE" \| "NO_PRICE" \| "NO_OBSERVATION"/.test(wcv));
  check("a stale wallet KEEPS its number — hasKnownValue admits STALE",
    /state === "VALUED" \|\| v\.state === "STALE"/.test(code(wcv)),
    "falling back for staleness swaps a dated figure for a column that reads zero");
  check("only VALUED may back a CURRENT claim",
    /export function isFreshCurrentValue[\s\S]{0,200}v\.state === "VALUED"/.test(code(wcv)));
  check("freshness is decided BEFORE the quantity is looked at, so ZERO is covered",
    /freshness decides between a CURRENT claim and a LAST-KNOWN one, and\s*\n\s*\/\/ it is asked BEFORE the quantity is looked at/.test(wcv),
    "a stale confirmed zero must not read as a fresh confirmation of an empty wallet");
  check("no observation stays UNKNOWN, never zero",
    /state:     "NO_OBSERVATION"/.test(wcv) && /quantity:  null,\n      value:     null,/.test(wcv));
}

// ══ THE SNAPSHOT SAYS "LAST KNOWN" RATHER THAN "OBSERVED" ═════════════════════
{
  const stale = resolveCryptoValuationState({
    crypto: 18944.04, isEstimated: false, cryptoValuationStatus: "stale" });
  check("an explicit `stale` stamp is honoured even on an isEstimated=false row",
    stale === "stale",
    "today's live row IS written isEstimated=false; without this a week-old "
    + "reading is laundered into observed-and-trusted");
  check("…and is NOT assertable as current wealth", !isCryptoAssertable(stale));
  check("…but IS reported as a last-known reading, distinct from unavailable",
    isCryptoLastKnown(stale) && !isCryptoLastKnown("unavailable"));
  check("…with its own machine-readable reason",
    cryptoUnavailableReason(stale) === "CRYPTO_OBSERVATION_STALE");
  check("…and it contaminates the aggregates composed from it",
    isAssetSideContaminated(stale));

  // The frozen-row protection is intact: it is an EXPLICIT stamp, not a clock.
  check("a frozen historical row with no stamp is still trusted unconditionally",
    resolveCryptoValuationState({ crypto: 25201.23, isEstimated: false, cryptoValuationStatus: null })
      === "observed");
  const core = code(read("lib", "snapshots", "crypto-valuation-status.core.ts"));
  check("the stale branch consults no clock",
    !/Date\.now|new Date\(/.test(core),
    "a date-based rule here could invalidate another user's genuine observed history");

  const writer = code(read("lib", "snapshots", "regenerate.ts"));
  check("the today-writer stamps stale from the evidence, not from a guess",
    /cryptoStale === true\) \? "stale"/.test(writer));
  check("…and still writes the number rather than discarding it",
    !/crypto: 0/.test(writer));
}

// ══ THE FAILED-SYNC DAY ═══════════════════════════════════════════════════════
//
// Day 1 succeeds; day 2 the provider refuses. Yesterday's reading must not
// become today's confirmation, and it must not vanish into a zero either.
{
  const observedAt = new Date("2026-08-20T10:00:00.000Z");
  const dayOne = new Date("2026-08-20T18:00:00.000Z");
  const dayEight = new Date("2026-08-28T10:00:00.000Z");

  check("day 1: the reading is LIVE and backs a current claim",
    bandForAge(ageInDays(observedAt, dayOne)) === "LIVE");
  check("after a week of refused syncs the SAME row is STALE",
    bandForAge(ageInDays(observedAt, dayEight)) === "STALE",
    "the clock advances because a refused sync never moves lastUpdated");
  check("…which is stale by the authority's own predicate",
    isStaleBand(bandForAge(ageInDays(observedAt, dayEight))));

  const adapters = [read("lib", "crypto", "sol-sync.ts"), read("lib", "crypto", "evm-native.ts")];
  for (const a of adapters) {
    const body = code(a);
    check("a wallet adapter advances lastUpdated ONLY after a successful read",
      /syncStatus: "synced", lastUpdated: new Date\(\)/.test(body)
        && body.indexOf("lastUpdated: new Date()") > body.indexOf("captureWalletPosition("),
      "a failure path that bumped the clock would manufacture freshness");
  }
}

// ══ CURRENT-ONLY CHAINS GAIN NOTHING HISTORICAL ═══════════════════════════════
{
  // A fresh current observation must not extend historical coverage: the two
  // authorities are separate records and one cannot write the other.
  const wcv = code(read("lib", "crypto", "wallet-current-value.ts"));
  check("the current authority writes no coverage",
    !/persistPositionCoverage|positionCoverage/.test(wcv));
  check("…and reads none either — freshness is not a licence",
    !/loadPositionCoverage/.test(wcv));

  // And with no coverage record, no historical date resolves however fresh the
  // current row is.
  const todayRow = [{ dateISO: "2026-08-27", quantity: 12.5 }];
  check("a fresh ETH/BNB/AVAX observation licenses NO historical date",
    resolveLicensedQuantityAsOf(todayRow, null, "2026-02-27").refusal === "NO_COVERAGE_RECORD");
  check("…not even the day before it",
    resolveLicensedQuantityAsOf(todayRow, null, "2026-08-26").quantity === null);

  // Conversely, historical coverage proves nothing about now.
  const historical = complete("2022-03-26", "2026-08-26");
  check("historical coverage does not make a current reading fresh",
    licensedInterval(historical) !== null && bandForAge(null) === "UNKNOWN",
    "coverage is about dates in the past; freshness is about the provider's last answer");
}

// ══ DOCTRINE ══════════════════════════════════════════════════════════════════
{
  const doc = read("docs", "systems", "crypto-networks.md");
  check("doctrine: observation existence and coverage authority are independent",
    /independent facts/i.test(doc) && /coverage/i.test(doc));
  check("doctrine: forward carry requires an explicit temporal licence",
    /Forward carry requires an explicit temporal licence/i.test(doc));
  check("doctrine: a current observation has a freshness horizon",
    /freshness horizon/i.test(doc));
  check("doctrine: zero needs the same authority as any other quantity",
    /Zero requires the same/i.test(doc));
  check("doctrine: current evidence does not extend historical coverage",
    /does not extend historical coverage/i.test(doc));
}

console.log(`\ncoverage-and-freshness: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
