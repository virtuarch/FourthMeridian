/**
 * lib/calendar/crypto-calendar.test.ts
 *
 * V26-PRICE-2 — 24/7 crypto calendar fixtures. Standalone tsx script:
 *
 *     npx tsx lib/calendar/crypto-calendar.test.ts
 *
 * These assertions exist less to test the logic — there is almost none — than to
 * pin the claim that the TradingCalendar abstraction is not equity-shaped: no
 * weekend rule, no holiday table, no horizon. Section 4 states the consequence
 * that matters downstream: a missing Saturday is a real gap for BTC and no gap
 * at all for an equity, decided entirely by which calendar was selected.
 */

import { cryptoCalendar, CRYPTO_CALENDAR_ID } from "./crypto-calendar";
import { usEquityCalendar } from "./us-equity-calendar";
import { calendarCoversWindow, enumerateDatesISO } from "./trading-calendar";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function main(): void {
  const expected = (f: string, t: string): string[] => [...cryptoCalendar.expectedDates(f, t)];

  // ── 1. Every calendar date ────────────────────────────────────────────────
  console.log("1. every calendar date is expected");
  {
    check("a full week yields all seven days",
      eq(expected("2026-01-05", "2026-01-11"),
         ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08",
          "2026-01-09", "2026-01-10", "2026-01-11"]));
    check("a weekend-only window yields both days",
      eq(expected("2026-01-10", "2026-01-11"), ["2026-01-10", "2026-01-11"]));
    check("a single day yields itself", eq(expected("2026-01-10", "2026-01-10"), ["2026-01-10"]));
    check("an inverted window yields nothing", eq(expected("2026-01-11", "2026-01-10"), []));
  }

  // ── 2. No holiday exclusions ──────────────────────────────────────────────
  console.log("2. no holiday exclusions");
  {
    const wk = expected("2025-12-24", "2026-01-02");
    check("Christmas Day is an expected crypto date", wk.includes("2025-12-25"));
    check("New Year's Day is an expected crypto date", wk.includes("2026-01-01"));
    check("Good Friday is an expected crypto date",
      expected("2026-04-03", "2026-04-03").includes("2026-04-03"));
    check("the 2025-01-09 exceptional US closure is irrelevant here",
      expected("2025-01-09", "2025-01-09").includes("2025-01-09"));
  }

  // ── 3. Unbounded horizon ──────────────────────────────────────────────────
  console.log("3. unbounded horizon");
  {
    check("supportedFromISO is null", cryptoCalendar.supportedFromISO === null);
    check("supportedThroughISO is null", cryptoCalendar.supportedThroughISO === null);
    check("covers a window far before the US table starts",
      calendarCoversWindow(cryptoCalendar, "2013-01-01", "2013-12-31"));
    check("covers a window far past the US horizon",
      calendarCoversWindow(cryptoCalendar, "2030-01-01", "2035-12-31"));
    check("HORIZON_EXCEEDED can never apply — expectedDates does not throw",
      expected("2013-01-01", "2013-01-03").length === 3);
    check("leap day 2028-02-29 is expected", expected("2028-02-28", "2028-03-01").length === 3);
  }

  // ── 4. The abstraction is not equity-shaped ───────────────────────────────
  console.log("4. the abstraction is not equity-shaped");
  {
    // Same window, same interface, opposite answers — decided only by calendar.
    const window: [string, string] = ["2026-01-09", "2026-01-12"]; // Fri → Mon
    const crypto = expected(...window);
    const equity = [...usEquityCalendar.expectedDates(...window)];
    check("crypto expects the weekend, equity does not",
      crypto.length === 4 && equity.length === 2);
    check("a missing Saturday is a GAP for crypto", crypto.includes("2026-01-10"));
    check("a missing Saturday is NOT a gap for equity", !equity.includes("2026-01-10"));
    check("both satisfy the same TradingCalendar contract",
      typeof cryptoCalendar.expectedDates === "function" &&
      typeof usEquityCalendar.expectedDates === "function" &&
      typeof cryptoCalendar.id === "string");
  }

  // ── 5. Identity and determinism ───────────────────────────────────────────
  console.log("5. identity and determinism");
  {
    check("calendar id is revision-stamped with no horizon segment",
      CRYPTO_CALENDAR_ID === "crypto-247@r1");
    const a = expected("2025-01-01", "2025-12-31");
    const b = expected("2025-01-01", "2025-12-31");
    check("repeated calls are byte-identical", JSON.stringify(a) === JSON.stringify(b));
    check("a non-leap year yields 365 expected dates", a.length === 365, `got ${a.length}`);
    check("a leap year yields 366 expected dates",
      expected("2024-01-01", "2024-12-31").length === 366);
    check("matches a plain date enumeration exactly",
      eq(a, enumerateDatesISO("2025-01-01", "2025-12-31")));
  }

  console.log(failures === 0 ? "\nAll crypto calendar checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
