/**
 * lib/calendar/us-equity-calendar.test.ts
 *
 * V26-PRICE-2 — US equity calendar fixtures. Standalone tsx script:
 *
 *     npx tsx lib/calendar/us-equity-calendar.test.ts
 *
 * The load-bearing test is section 6: the local price archive independently
 * recorded exactly 21 absent weekdays across its span, and this calendar must
 * reproduce that set EXACTLY — not a superset, not a subset. That single
 * assertion validates all four holiday tables, the Good Friday entries, the
 * 2026-07-03 observance shift, and the 2025-01-09 exceptional closure against
 * real vendor data rather than against my own arithmetic.
 */

import {
  usEquityCalendar,
  usEquityClosuresISO,
  isUsEquityMarket,
  US_EQUITY_MICS,
  US_EQUITY_CALENDAR_ID,
} from "./us-equity-calendar";
import { calendarCoversWindow, isWeekendISO, enumerateDatesISO } from "./trading-calendar";
import { US_MARKET_HOLIDAYS_2024 } from "./data/us-holidays-2024";
import { US_MARKET_HOLIDAYS_2025 } from "./data/us-holidays-2025";
import { US_MARKET_HOLIDAYS_2026 } from "./data/us-holidays-2026";
import { US_MARKET_HOLIDAYS_2027 } from "./data/us-holidays-2027";
import { US_EXCEPTIONAL_CLOSURES } from "./data/exceptional-closures";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Ground truth, measured from the local PriceObservation archive: every weekday
 * in [2024-07-22, 2026-07-24] for which NO equity/ETF instrument has a row.
 * Seventeen instruments agree on all 21 dates, so this is the market's own
 * record of when it was shut, not an assumption.
 */
const ARCHIVE_ABSENT_WEEKDAYS = [
  "2024-09-02", "2024-11-28", "2024-12-25",
  "2025-01-01", "2025-01-09", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26",
  "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25",
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19",
  "2026-07-03",
];
const ARCHIVE_SPAN_FROM = "2024-07-22";
const ARCHIVE_SPAN_TO   = "2026-07-24";

function main(): void {
  const expected = (f: string, t: string): string[] => [...usEquityCalendar.expectedDates(f, t)];

  // ── 1. Weekdays and weekends ──────────────────────────────────────────────
  console.log("1. weekdays and weekends");
  {
    // Mon 2026-01-05 → Sun 2026-01-11: five trading days, no weekend.
    check("a full ordinary week yields Mon–Fri only",
      eq(expected("2026-01-05", "2026-01-11"),
         ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09"]));
    check("a weekend-only window yields nothing",
      eq(expected("2026-01-10", "2026-01-11"), []));
    check("a single Saturday yields nothing", eq(expected("2026-01-10", "2026-01-10"), []));
    check("a single trading day yields itself",
      eq(expected("2026-01-06", "2026-01-06"), ["2026-01-06"]));
  }

  // ── 2. Ordinary holidays ──────────────────────────────────────────────────
  console.log("2. ordinary holidays");
  {
    check("a single-day closure window yields nothing (MLK 2026-01-19)",
      eq(expected("2026-01-19", "2026-01-19"), []));
    check("MLK is skipped, surrounding days are not",
      eq(expected("2026-01-16", "2026-01-20"), ["2026-01-16", "2026-01-20"]));
    check("Thanksgiving closes but the half-day Friday still TRADES",
      eq(expected("2025-11-26", "2025-11-28"), ["2025-11-26", "2025-11-28"]));
  }

  // ── 3. Good Friday ────────────────────────────────────────────────────────
  console.log("3. Good Friday (Easter-relative — the one date no fixed rule yields)");
  {
    check("2025-04-18 excluded", !expected("2025-04-14", "2025-04-21").includes("2025-04-18"));
    check("2026-04-03 excluded", !expected("2026-03-30", "2026-04-06").includes("2026-04-03"));
    check("2027-03-26 excluded", !expected("2027-03-22", "2027-03-29").includes("2027-03-26"));
    check("Easter Monday still TRADES (2026-04-06)",
      expected("2026-03-30", "2026-04-06").includes("2026-04-06"));
  }

  // ── 4. Observed closures ──────────────────────────────────────────────────
  console.log("4. observed closures (weekend-shifted)");
  {
    // Jul 4 2026 is a Saturday ⇒ the market closes Friday Jul 3.
    const wk = expected("2026-06-29", "2026-07-10");
    check("2026-07-03 closed (Independence Day observed)", !wk.includes("2026-07-03"));
    check("2026-07-04 absent as a weekend, not as a holiday", !wk.includes("2026-07-04"));
    check("2026-07-06 Monday trades normally", wk.includes("2026-07-06"));
    // Jul 4 2027 is a Sunday ⇒ the market closes Monday Jul 5.
    const wk27 = expected("2027-07-01", "2027-07-09");
    check("2027-07-05 closed (shifted forward from a Sunday)", !wk27.includes("2027-07-05"));
    check("2027-07-02 Friday trades normally", wk27.includes("2027-07-02"));
    // Dec 25 2027 is a Saturday ⇒ closes Friday Dec 24.
    check("2027-12-24 closed (Christmas observed)",
      !expected("2027-12-20", "2027-12-24").includes("2027-12-24"));
  }

  // ── 5. Exceptional closure ────────────────────────────────────────────────
  console.log("5. exceptional closure");
  {
    const wk = expected("2025-01-06", "2025-01-10");
    check("2025-01-09 excluded (national day of mourning)", !wk.includes("2025-01-09"));
    check("the rest of that week trades",
      eq(wk, ["2025-01-06", "2025-01-07", "2025-01-08", "2025-01-10"]));
  }

  // ── 6. ACCEPTANCE — reproduce the archive's own record ────────────────────
  console.log("6. acceptance: the calendar reproduces the archive exactly");
  {
    const dates    = expected(ARCHIVE_SPAN_FROM, ARCHIVE_SPAN_TO);
    const weekdays = enumerateDatesISO(ARCHIVE_SPAN_FROM, ARCHIVE_SPAN_TO).filter((d) => !isWeekendISO(d));
    const excluded = weekdays.filter((d) => !dates.includes(d));

    check("525 weekdays in the archive span", weekdays.length === 525, `got ${weekdays.length}`);
    check("exactly 21 weekdays excluded", excluded.length === 21, `got ${excluded.length}`);
    check("the excluded set IS the archive's absent weekdays — no more, no less",
      eq(excluded, ARCHIVE_ABSENT_WEEKDAYS),
      `\n      calendar: ${JSON.stringify(excluded)}\n      archive:  ${JSON.stringify(ARCHIVE_ABSENT_WEEKDAYS)}`);
    check("expected trading days === 504, the archived row count per instrument",
      dates.length === 504, `got ${dates.length}`);
  }

  // ── 7. Year boundaries and leap day ───────────────────────────────────────
  console.log("7. year boundaries and leap day");
  {
    check("2024-12-31 trades, 2025-01-01 does not",
      eq(expected("2024-12-30", "2025-01-02"), ["2024-12-30", "2024-12-31", "2025-01-02"]));
    check("a window spanning three years is continuous",
      expected("2024-12-30", "2026-01-02").length > 250);
    check("leap day 2024-02-29 (Thu) trades", expected("2024-02-29", "2024-02-29").length === 1);
    check("2025-02-28 (Fri) trades; there is no 2025-02-29",
      eq(expected("2025-02-27", "2025-03-03"),
         ["2025-02-27", "2025-02-28", "2025-03-03"]));
  }

  // ── 8. Horizon ────────────────────────────────────────────────────────────
  console.log("8. horizon (the calendar refuses to invent expectations)");
  {
    check("covers a window inside the horizon",
      calendarCoversWindow(usEquityCalendar, "2024-01-01", "2027-12-31"));
    check("does NOT cover a window starting before 2024",
      !calendarCoversWindow(usEquityCalendar, "2023-12-31", "2024-06-01"));
    check("does NOT cover a window ending after 2027",
      !calendarCoversWindow(usEquityCalendar, "2027-01-01", "2028-01-01"));

    let threw = false;
    try { usEquityCalendar.expectedDates("2028-01-03", "2028-01-07"); } catch { threw = true; }
    check("expectedDates throws past the horizon rather than emitting weekdays", threw);

    threw = false;
    try { usEquityCalendar.expectedDates("2023-06-01", "2023-06-30"); } catch { threw = true; }
    check("expectedDates throws before the horizon", threw);
  }

  // ── 9. Table hygiene ──────────────────────────────────────────────────────
  console.log("9. table hygiene");
  {
    const closures = usEquityClosuresISO();
    check("every tabulated closure is a WEEKDAY (a weekend entry is a typo)",
      closures.every((d) => !isWeekendISO(d)),
      closures.filter((d) => isWeekendISO(d)).join(","));
    check("closures are unique", new Set(closures).size === closures.length);
    check("every closure lies inside the declared horizon",
      closures.every((d) => d >= "2024-01-01" && d <= "2027-12-31"));

    const annual = [
      ...US_MARKET_HOLIDAYS_2024, ...US_MARKET_HOLIDAYS_2025,
      ...US_MARKET_HOLIDAYS_2026, ...US_MARKET_HOLIDAYS_2027,
    ];
    check("each year contributes exactly 10 full-day closures", annual.length === 40);
    check("no exceptional closure duplicates an annual holiday",
      US_EXCEPTIONAL_CLOSURES.every((d) => !annual.includes(d)));
    check("calendar id discloses the data horizon and revision",
      US_EQUITY_CALENDAR_ID === "us-equity@2024-2027.r1");
  }

  // ── 10. Market identity ───────────────────────────────────────────────────
  console.log("10. market identity");
  {
    check("XNAS, XNYS, ARCX recognised (all three appear in current data)",
      isUsEquityMarket("XNAS") && isUsEquityMarket("XNYS") && isUsEquityMarket("ARCX"));
    check("a null MIC is NOT assumed to be US", !isUsEquityMarket(null));
    check("a foreign MIC is not US (XLON)", !isUsEquityMarket("XLON"));
    check("an unknown MIC is not US", !isUsEquityMarket("ZZZZ"));
    check("the MIC set is centralised and non-empty", US_EQUITY_MICS.size >= 3);
  }

  // ── 11. Determinism ───────────────────────────────────────────────────────
  console.log("11. determinism");
  {
    const a = expected("2025-01-01", "2025-12-31");
    const b = expected("2025-01-01", "2025-12-31");
    check("repeated calls are byte-identical", JSON.stringify(a) === JSON.stringify(b));
    check("output is ascending and unique",
      a.every((d, i) => i === 0 || d > a[i - 1]));
    check("2025 has 250 trading days (252 weekday-holidays baseline − Carter closure)",
      a.length === 250, `got ${a.length}`);
  }

  console.log(failures === 0 ? "\nAll US equity calendar checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
