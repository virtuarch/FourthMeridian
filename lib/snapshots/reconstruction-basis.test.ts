/**
 * lib/snapshots/reconstruction-basis.test.ts
 *
 * Assets historical-boundary fix — the POSTED-ONLY same-basis invariant for cash
 * reconstruction, plus the reconstructed→observed boundary-continuity contract.
 *
 * Standalone tsx (pure core + source-text guards; no DB, no prisma generate):
 *     npx tsx lib/snapshots/reconstruction-basis.test.ts
 *
 * Root cause frozen here (see the investigation): the cash walk-back anchors on
 * `FinancialAccount.balance` — the ONLY balance the snapshot system treats as
 * truth (regenerate.ts classifies it as-is; nothing folds pending into it) — but
 * historically summed PENDING-INCLUSIVE deltas, mixing settlement bases and
 * injecting a phantom for every day before a pending row. The card walk already
 * excluded pending "to match posted balance"; cash now matches.
 */

import { readFileSync } from "fs";
import { join } from "path";
import {
  reconstructDailyCashBalances,
  reconstructDailyLiabilityBalances,
  boundaryContinuityResidual,
  isBoundaryContinuous,
  isoDate,
  addDaysUTC,
  fromISO,
} from "./backfill-core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const approx = (a: number, b: number) => Math.abs(a - b) < 0.005;

// ─────────────────────────────────────────────────────────────────────────────
// 1. Source guards — the posted-only basis is enforced in EVERY balance-walk
//    writer, structurally (no pending-inclusive variant exists to call). These
//    fail under the OLD cash behavior, AND fail if any future writer reintroduces
//    a pending-inclusive `excludePending` footgun. THREE writers reconstruct
//    balances from the posted `FinancialAccount.balance` anchor:
//      • lib/snapshots/backfill.ts            (M2 new-Space backfill)
//      • lib/snapshots/regenerate-history.ts  (M3 ongoing regen + amendments)
//      • lib/data/accounts-asof.ts            (as-of account-balance resolver)
// ─────────────────────────────────────────────────────────────────────────────
console.log("1. Posted-only basis is enforced in ALL balance-walk writers (source guards)");
{
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  const backfill = strip(readFileSync(join(process.cwd(), "lib/snapshots/backfill.ts"), "utf8"));
  const regen    = strip(readFileSync(join(process.cwd(), "lib/snapshots/regenerate-history.ts"), "utf8"));
  const asof     = strip(readFileSync(join(process.cwd(), "lib/data/accounts-asof.ts"), "utf8"));

  // backfill.ts inlines two groupBy queries (cash + card); BOTH carry pending:false.
  check("backfill.ts: cash AND card delta queries are posted-only (≥2 `pending: false`)",
    (backfill.match(/pending:\s*false/g) ?? []).length >= 2);

  // regenerate-history.ts + accounts-asof.ts route through a buildDeltas helper.
  // The helper is now UNCONDITIONALLY posted-only — no excludePending parameter
  // exists to pass, so a pending-inclusive walk cannot be requested by any caller.
  for (const [name, code] of [["regenerate-history.ts", regen], ["accounts-asof.ts", asof]] as const) {
    check(`${name}: buildDeltas has NO excludePending parameter (footgun removed)`,
      !/excludePending/.test(code), "the pending-basis parameter is back — a caller can reintroduce the phantom");
    check(`${name}: no pending-inclusive delta call — none pass a boolean basis flag`,
      !/buildDeltas\([^)]*,\s*(true|false)\s*\)/.test(code),
      "a buildDeltas(..., true/false) basis argument remains");
    check(`${name}: buildDeltas hard-codes posted-only (`+ "`pending: false`)",
      /pending:\s*false/.test(code));
  }

  // Cross-writer: NO reconstruction file may omit the pending filter on a balance
  // delta query. (Every groupBy that feeds reconstructDaily{Cash,Liability}Balances
  // must be posted-only.)
  check("no balance-walk writer contains a bare non-deleted-only delta query (missing pending:false)",
    !/deletedAt:\s*null,\s*date:\s*\{\s*gt:/.test(backfill + regen + asof),
    "a delta groupBy filters only deletedAt (pending-inclusive) — reconstruct it posted-only");
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Pending has ZERO effect on reconstructed cash (posted-only basis).
//    The fixed query yields a POSTED-only delta map; the pure walk sees only it.
// ─────────────────────────────────────────────────────────────────────────────
console.log("2. Pending activity does not move any reconstructed cash day");
{
  const today = fromISO("2026-07-04");
  const start = addDaysUTC(today, -4);
  // Posted set only: a real −80 debit dated today-1.
  const postedOnly = new Map<string, Map<string, number>>([
    ["a", new Map([[isoDate(addDaysUTC(today, -1)), -80]])],
  ]);
  // What the OLD (buggy) query would have produced: the same posted −80 PLUS a
  // pending +5000 deposit dated today-1 folded into the same day's sum.
  const withPending = new Map<string, Map<string, number>>([
    ["a", new Map([[isoDate(addDaysUTC(today, -1)), -80 + 5000]])],
  ]);

  const anchor = [{ id: "a", balance: 1000 }];
  const clean = reconstructDailyCashBalances(anchor, postedOnly, today, start);
  const buggy = reconstructDailyCashBalances(anchor, withPending, today, start);

  // Days AT/AFTER the pending date are identical; days BEFORE it diverge by exactly
  // the pending amount — i.e. a pending row is precisely the phantom this fix kills.
  check("day of the txn: eod(today-1) unaffected by the txn's own day (=1000)",
    clean.get(isoDate(addDaysUTC(today, -1)))?.get("a") === 1000);
  check("clean: eod(today-2) = 1080 (only the posted −80 reversed)",
    clean.get(isoDate(addDaysUTC(today, -2)))?.get("a") === 1080);
  check("buggy: eod(today-2) = 1080 − 5000 = −3920 (pending phantom injected)",
    buggy.get(isoDate(addDaysUTC(today, -2)))?.get("a") === -3920);
  check("the ONLY difference is the pending amount ($5000) on every pre-txn day",
    (clean.get(isoDate(addDaysUTC(today, -2)))!.get("a")! -
     buggy.get(isoDate(addDaysUTC(today, -2)))!.get("a")!) === 5000);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Parity — cash and card walks both reverse a posted anchor with posted deltas.
// ─────────────────────────────────────────────────────────────────────────────
console.log("3. Cash + liability walks share the posted-only basis");
{
  const today = fromISO("2026-07-04");
  const start = addDaysUTC(today, -2);
  const day1 = isoDate(addDaysUTC(today, -1));
  // A pending row must be absent from BOTH delta maps (the query excludes it for
  // both). Feed posted-only maps and confirm both walks hold flat over a pending-
  // only day (nothing to reverse).
  const cash = reconstructDailyCashBalances([{ id: "c", balance: 400 }], new Map([["c", new Map()]]), today, start);
  const card = reconstructDailyLiabilityBalances([{ id: "d", balance: 700 }], new Map([["d", new Map()]]), today, start);
  check("cash: a pending-only day leaves the balance flat (400)", cash.get(day1)?.get("c") === 400);
  check("card: a pending-only day leaves owed flat (700)", card.get(day1)?.get("d") === 700);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Regression fixture — the reported CHASE COLLEGE shape (Part 7).
//    Anchor = today posted balance; a $5,318.61 posted card-payment outflow near
//    the boundary; a +$5,286.63 PENDING payroll credit near the boundary; the
//    first observed balance. (Real numbers used as a fixture, never as logic.)
// ─────────────────────────────────────────────────────────────────────────────
console.log("4. CHASE COLLEGE regression fixture — posted-only continuity");
{
  const today = fromISO("2026-07-18");              // anchor day
  const start = fromISO("2026-07-13");
  const ANCHOR = 868.23;                             // today's posted checking balance
  const OBSERVED_07_15 = 6186.84;                    // first observed value (frozen live row)

  // POSTED-only deltas (what the FIXED query yields): only the 07-16 card payments.
  const posted = new Map<string, Map<string, number>>([
    ["chk", new Map([["2026-07-16", -5318.61]])],
  ]);
  // OLD query would ALSO fold the 07-17 PENDING payroll (+5286.63) into 07-17.
  const buggy = new Map<string, Map<string, number>>([
    ["chk", new Map([["2026-07-16", -5318.61], ["2026-07-17", 5286.63]])],
  ]);

  const fixed  = reconstructDailyCashBalances([{ id: "chk", balance: ANCHOR }], posted, today, start);
  const broken = reconstructDailyCashBalances([{ id: "chk", balance: ANCHOR }], buggy, today, start);

  const recon0714Fixed  = fixed.get("2026-07-14")!.get("chk")!;
  const recon0714Broken = broken.get("2026-07-14")!.get("chk")!;

  check("FIXED posted-only reconstruction of 07-14 = 6186.84 (matches observed 07-15)",
    approx(recon0714Fixed, OBSERVED_07_15), `got ${recon0714Fixed}`);
  check("posted-only 07-15 seam is continuous (residual ≈ 0, no boundary activity)",
    isBoundaryContinuous(recon0714Fixed, OBSERVED_07_15, /*postedBoundaryActivity 07-15*/ 0),
    `residual ${boundaryContinuityResidual(recon0714Fixed, OBSERVED_07_15, 0)}`);

  // The pending-inclusive walk introduces an unexplained residual = the pending amount.
  check("BUGGY pending-inclusive 07-14 is NOT continuous (phantom = the pending payroll)",
    !isBoundaryContinuous(recon0714Broken, OBSERVED_07_15, 0));
  check("the unexplained residual equals the pending amount ($5,286.63)",
    approx(boundaryContinuityResidual(recon0714Broken, OBSERVED_07_15, 0), 5286.63),
    `residual ${boundaryContinuityResidual(recon0714Broken, OBSERVED_07_15, 0)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Continuity contract — legitimate posted boundary activity is ALLOWED.
//    Continuity is not blind equality: a real posted deposit on the observed day
//    explains a difference between the two adjacent values.
// ─────────────────────────────────────────────────────────────────────────────
console.log("5. Boundary continuity permits real posted activity");
{
  // reconstructed(N-1)=1000; a real +250 posted deposit dated N; observed(N)=1250.
  check("real posted activity on the observed day is explained (continuous)",
    isBoundaryContinuous(1000, 1250, 250));
  // Same reconstructed/observed but NO posted activity → an unexplained +250 phantom.
  check("same gap with no posted activity is an unexplained phantom (discontinuous)",
    !isBoundaryContinuous(1000, 1250, 0));
  check("residual is signed (observed − reconstructed − activity)",
    boundaryContinuityResidual(1000, 1250, 0) === 250 &&
    boundaryContinuityResidual(1250, 1000, 0) === -250);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Rebuild idempotency — the walk-back is a pure function of (anchor, posted
//    deltas): identical inputs ⇒ identical output, so regenerate→read→regenerate
//    →read is stable (empirically confirmed on live data; frozen here at the core).
// ─────────────────────────────────────────────────────────────────────────────
console.log("6. Reconstruction is deterministic / idempotent");
{
  const today = fromISO("2026-07-04");
  const start = addDaysUTC(today, -5);
  const deltas = new Map<string, Map<string, number>>([
    ["a", new Map([[isoDate(addDaysUTC(today, -1)), -80], [isoDate(addDaysUTC(today, -3)), 200]])],
  ]);
  const run1 = reconstructDailyCashBalances([{ id: "a", balance: 1000 }], deltas, today, start);
  const run2 = reconstructDailyCashBalances([{ id: "a", balance: 1000 }], deltas, today, start);
  const ser = (m: Map<string, Map<string, number>>) =>
    [...m.entries()].map(([d, inner]) => `${d}:${[...inner.entries()].join(",")}`).join("|");
  check("two runs over identical inputs are byte-identical (idempotent rebuild)", ser(run1) === ser(run2));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll reconstruction-basis checks passed");
