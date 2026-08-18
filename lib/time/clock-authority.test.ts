/**
 * lib/time/clock-authority.test.ts   (REVIEW-3 B-6 — the chronology guard)
 *
 * House convention: standalone tsx script, no framework, no DB.
 *     npx tsx lib/time/clock-authority.test.ts
 * Run from the repo root (source scans resolve paths from cwd).
 *
 * Two layers:
 *
 *   1. BEHAVIOUR — the clock seam itself: UTC day semantics, the injectable
 *      `now`, yesterday's closed-day arithmetic across month/year boundaries,
 *      and the today/history switch (classifyAsOfDay) at its boundary.
 *
 *   2. SOURCE SCAN — no source file outside lib/time re-implements the clock.
 *      Before B-6 the repo had THREE "now" implementations (`todayIso` ×2,
 *      `yesterdayUTCISO` ×2 byte-identical clones, `isoDate(truncDateUTC(new
 *      Date()))` ×3); all now delegate to lib/time/clock.ts. This scan is what
 *      keeps that a fact instead of a moment: any new current-day derivation
 *      (`new Date().toISOString().slice(0, 10)` and its spellings, or a fresh
 *      `todayIso`/`yesterdayUTCISO` definition) fails the suite.
 *
 *      ⚠️ Scope: lib/, components/, app/, jobs/, minus *.test.ts and minus
 *      lib/ai/** — the AI assembler layer is owned by a concurrent
 *      convergence slice (REVIEW-3 F2); its two remaining inline day
 *      derivations (prompts/system-prompt.ts, assemblers/transactions.ts) are
 *      RECORDED here as the exception rather than silently excluded, and the
 *      exclusion should be deleted when that slice lands.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";

import {
  systemClock,
  toISODateUTC,
  todayUTCISO,
  yesterdayUTCISO,
} from "./clock";
import { classifyAsOfDay, isHistoricalDay } from "./basis";

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`        ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Behaviour — the seam itself
// ---------------------------------------------------------------------------

console.log("1. The clock seam");
{
  const t = new Date("2026-08-17T23:59:59.999Z");
  check("todayUTCISO is the UTC calendar day of the injected instant",
    todayUTCISO(t) === "2026-08-17");
  check("...including one millisecond later, across the day boundary",
    todayUTCISO(new Date("2026-08-18T00:00:00.000Z")) === "2026-08-18");
  check("yesterdayUTCISO is exactly one UTC day back",
    yesterdayUTCISO(t) === "2026-08-16");
  check("yesterday crosses a month boundary correctly",
    yesterdayUTCISO(new Date("2026-08-01T00:00:00Z")) === "2026-07-31");
  check("yesterday crosses a year boundary correctly",
    yesterdayUTCISO(new Date("2026-01-01T12:00:00Z")) === "2025-12-31");
  check("yesterday handles a leap day",
    yesterdayUTCISO(new Date("2028-03-01T00:00:00Z")) === "2028-02-29");
  check("toISODateUTC formats an instant's UTC day",
    toISODateUTC(new Date("2026-02-03T04:05:06Z")) === "2026-02-03");
  check("the system clock returns a live Date (injectable default)",
    Math.abs(systemClock().getTime() - Date.now()) < 5_000);
  check("todayUTCISO() with no argument uses the system clock",
    todayUTCISO() === toISODateUTC(new Date()));
}

console.log("2. The today/history switch");
{
  const today = "2026-08-17";
  check("the day before today is HISTORICAL",
    classifyAsOfDay("2026-08-16", today) === "historical");
  check("today itself is PRESENT — the boundary belongs to the present",
    classifyAsOfDay("2026-08-17", today) === "present");
  check("a future day is PRESENT (never reconstructed)",
    classifyAsOfDay("2026-08-18", today) === "present");
  check("isHistoricalDay agrees with classifyAsOfDay at the boundary",
    !isHistoricalDay("2026-08-17", today) && isHistoricalDay("2026-08-16", today));
}

// ---------------------------------------------------------------------------
// 2. Source scan — one clock, everywhere
// ---------------------------------------------------------------------------

const ROOT = process.cwd();
const SCAN_DIRS = ["lib", "components", "app", "jobs"];

/** lib/time is the seam itself. REVIEW-3 C: the lib/ai exclusion is DELETED —
 *  the AI slice migrated its inline day derivations onto the seam
 *  (prompts/system-prompt.ts and assemblers/transactions.ts now call
 *  todayUTCISO), so lib/ai is scanned like everything else. */
const EXCLUDED_PREFIXES = [
  join("lib", "time") + sep,
];

const CLOCK_REIMPLEMENTATION_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "inline current-day: new Date().toISOString().slice(0, 10)",
    re: /new Date\(\)\s*\.toISOString\(\)\s*\.slice\(\s*0\s*,\s*10\s*\)/ },
  { name: 'inline current-day: new Date().toISOString().split("T")[0]',
    re: /new Date\(\)\s*\.toISOString\(\)\s*\.split\(\s*['"]T['"]\s*\)\s*\[0\]/ },
  { name: "inline current-day: isoDate(truncDateUTC(new Date()))",
    re: /isoDate\(\s*truncDateUTC\(\s*new Date\(\)\s*\)\s*\)/ },
  { name: "a private todayIso()/todayISO() clock definition",
    re: /function\s+today(?:Iso|ISO)\s*\(\s*\)/ },
  { name: "a second yesterdayUTCISO implementation",
    re: /function\s+yesterdayUTCISO\s*\(/ },
];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) yield full;
  }
}

const offenders: string[] = [];
for (const dir of SCAN_DIRS) {
  let files: string[] = [];
  try { files = [...walk(join(ROOT, dir))]; } catch { continue; }
  for (const file of files) {
    const rel = relative(ROOT, file);
    if (EXCLUDED_PREFIXES.some((p) => rel.startsWith(p))) continue;
    const src = readFileSync(file, "utf8");
    for (const { name, re } of CLOCK_REIMPLEMENTATION_PATTERNS) {
      if (re.test(src)) offenders.push(`${rel} — ${name}`);
    }
  }
}

console.log("3. Source scan — no clock outside lib/time");
check(
  "no source file outside lib/time re-implements the current-day / closed-day clock",
  offenders.length === 0,
  offenders.join("\n        "),
);

// (REVIEW-3 C: the recorded lib/ai exception was deleted together with its
// exclusion above — the AI layer now delegates to the seam and is scanned by
// the main invariant like every other directory.)
{
  const aiSystemPrompt = readFileSync(join(ROOT, "lib", "ai", "prompts", "system-prompt.ts"), "utf8");
  check(
    "lib/ai delegates to the seam (system-prompt imports todayUTCISO from lib/time)",
    aiSystemPrompt.includes("@/lib/time/clock") &&
      !/new Date\(\)\.toISOString\(\)\.split\('T'\)\[0\]/.test(aiSystemPrompt),
  );
}

// The delegations themselves: fx and prices re-export the seam instead of
// defining their own (the byte-identical-clone defect this slice removed).
{
  const fx = readFileSync(join(ROOT, "lib", "fx", "config.ts"), "utf8");
  const prices = readFileSync(join(ROOT, "lib", "prices", "config.ts"), "utf8");
  check("lib/fx/config.ts imports yesterdayUTCISO from the seam",
    fx.includes('from "@/lib/time/clock"') && !/function\s+yesterdayUTCISO/.test(fx));
  check("lib/prices/config.ts imports yesterdayUTCISO from the seam",
    prices.includes('from "@/lib/time/clock"') && !/function\s+yesterdayUTCISO/.test(prices));
  check("fx and prices still do not import each other (the no-coupling doctrine)",
    !fx.includes("@/lib/prices") && !prices.includes("@/lib/fx"));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
