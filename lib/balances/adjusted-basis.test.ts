/**
 * lib/balances/adjusted-basis.test.ts   (v2.7-P5 — adjusted-cash cutover semantics)
 *
 *   1. parsing: date / instant / zone / invalid / pre-release ⇒ safe fallback
 *   2. window boundaries: before / after / spanning / single-day / changeover-edge
 *   3. deploy late in the UTC day (23:50Z) and exactly at midnight
 *   4. wording: UTC-stated, identical under any process TZ (Kuwait UTC+3, LA)
 *   5. env override present / absent / invalid through the default argument
 *   6. the REAL snapshot writer over an in-memory store: frozen history, the
 *      changeover-day rewrite, and the first post-release row on the adjusted basis
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/balances/adjusted-basis.test.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  ADJUSTED_CASH_BASIS_CUTOVER_DEFAULT, ADJUSTED_CASH_BASIS_SINCE,
  adjustedCashBasisNote, parseAdjustedCashBasisCutover, resolveAdjustedCashBasisCutover, spansAdjustedCashBasis,
} from "@/lib/balances/adjusted-basis";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

async function main() {
  console.log("1. parsing");
  {
    const d = parseAdjustedCashBasisCutover("2026-10-27")!;
    check("default is the Preview changeover day 2026-10-27", ADJUSTED_CASH_BASIS_CUTOVER_DEFAULT === "2026-10-27");
    check("date-only ⇒ mixed changeover day; first adjusted = next day",
      d.changeoverDay === "2026-10-27" && d.mixed && d.lastReportedDay === "2026-10-27" && d.firstAdjustedDay === "2026-10-28" && d.at === null);
    check("deprecated ADJUSTED_CASH_BASIS_SINCE = first guaranteed-adjusted day under the default", ADJUSTED_CASH_BASIS_SINCE === "2026-10-28");
    const i = parseAdjustedCashBasisCutover("2026-10-27T02:00:00Z")!;
    check("instant ⇒ UTC day, mixed, exact `at`", i.changeoverDay === "2026-10-27" && i.mixed && i.at === "2026-10-27T02:00:00.000Z");
    const k = parseAdjustedCashBasisCutover("2026-11-05T01:30+03:00")!;
    check("offset instant is converted to its UTC day (Kuwait 01:30 = previous UTC day 22:30)",
      k.changeoverDay === "2026-11-04" && k.at === "2026-11-04T22:30:00.000Z");
    for (const bad of ["", "   ", "2026-10-27T02:00:00", "2026-02-30", "2026-13-01", "27/10/2026", "2026-10-27T25:00Z",
      "2026-10-26", "2025-12-01T00:00:00Z", "2026-10-27T00:30+03:00", "tomorrow", "2026-10-27 02:00Z"]) {
      check(`refused: ${JSON.stringify(bad)}`, parseAdjustedCashBasisCutover(bad) === null);
    }
    check("refused: null / undefined", parseAdjustedCashBasisCutover(null) === null && parseAdjustedCashBasisCutover(undefined) === null);
    check("whitespace around a valid value is tolerated", parseAdjustedCashBasisCutover(" 2026-11-05 ")?.changeoverDay === "2026-11-05");
  }

  console.log("\n2. window boundaries (mixed changeover 2026-11-05)");
  {
    const c = parseAdjustedCashBasisCutover("2026-11-05")!;
    const s = (f: string, t: string) => spansAdjustedCashBasis(f, t, c);
    check("entirely before", !s("2026-10-01", "2026-11-04"));
    check("entirely after", !s("2026-11-06", "2026-12-06"));
    check("spanning", s("2026-10-01", "2026-12-01"));
    check("ending ON the changeover day (its row may be adjusted)", s("2026-10-05", "2026-11-05"));
    check("starting ON the changeover day (its row may be reported)", s("2026-11-05", "2026-12-05"));
    check("single changeover day: one point, no discontinuity", !s("2026-11-05", "2026-11-05"));
    check("null ends never disclose", !spansAdjustedCashBasis(null, "2026-12-01", c) && !spansAdjustedCashBasis("2026-10-01", undefined, c));
    check("ISO timestamps are read by their date part", s("2026-10-01T00:00:00.000Z", "2026-12-01T00:00:00.000Z"));
    check("a future planned changeover never discloses on today's window", !s("2026-10-01", "2026-10-27"));
  }

  console.log("\n3. deploy late in the UTC day / exactly at midnight");
  {
    const late = parseAdjustedCashBasisCutover("2026-11-05T23:50:00Z")!;
    check("23:50Z: D is still the (mixed) changeover day, D+1 the first adjusted day",
      late.changeoverDay === "2026-11-05" && late.mixed && late.firstAdjustedDay === "2026-11-06");
    check("23:50Z: a window ending on D discloses (D may already be rewritten)", spansAdjustedCashBasis("2026-10-06", "2026-11-05", late));
    const mid = parseAdjustedCashBasisCutover("2026-11-05T00:00:00Z")!;
    check("00:00:00Z: no mixed day — D is adjusted, D−1 the last reported",
      !mid.mixed && mid.firstAdjustedDay === "2026-11-05" && mid.lastReportedDay === "2026-11-04");
    check("00:00:00Z: window starting ON D is entirely adjusted", !spansAdjustedCashBasis("2026-11-05", "2026-12-05", mid));
    check("00:00:00Z: window ending ON D discloses", spansAdjustedCashBasis("2026-10-05", "2026-11-05", mid));
    check("00:00:01Z is mixed", parseAdjustedCashBasisCutover("2026-11-05T00:00:01Z")!.mixed);
  }

  console.log("\n4. wording (UTC, time-zone independent)");
  {
    const mixed = parseAdjustedCashBasisCutover("2026-10-27")!;
    const clean = parseAdjustedCashBasisCutover("2026-11-05T00:00:00Z")!;
    const nm = adjustedCashBasisNote("2026-10-01", "2026-11-01", mixed)!;
    const nc = adjustedCashBasisNote("2026-10-01", "2026-12-01", clean)!;
    check("mixed note names first adjusted day + UTC + changeover day + both bases",
      nm.startsWith("From Oct 28, 2026 (UTC), cash is net of pending bank activity")
      && /points before Oct 27 use bank-reported balances, and Oct 27, the changeover day, may use either\.$/.test(nm), nm);
    check("clean note: no changeover clause", nc === "From Nov 5, 2026 (UTC), cash is net of pending bank activity not yet deducted from the bank's balance; earlier points use bank-reported balances.", nc);
    const ny = adjustedCashBasisNote("2026-12-01", "2027-01-15", parseAdjustedCashBasisCutover("2026-12-31")!)!;
    check("year boundary: both days carry their year", /From Jan 1, 2027 \(UTC\)/.test(ny) && /before Dec 31, 2026 use/.test(ny), ny);
    const saved = process.env.TZ;
    const under = (tz: string) => { process.env.TZ = tz; return adjustedCashBasisNote("2026-10-01", "2026-11-01", mixed); };
    const kw = under("Asia/Kuwait"), la = under("America/Los_Angeles"), ki = under("Pacific/Kiritimati"), utc = under("UTC");
    if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
    check("identical under Kuwait (UTC+3), Los Angeles, Kiritimati (UTC+14) and UTC", kw === utc && la === utc && ki === utc && utc === nm);
    check("no note outside a spanning window", adjustedCashBasisNote("2026-10-28", "2026-11-28", mixed) === null);
  }

  console.log("\n5. env override present / absent / invalid");
  {
    const key = "NEXT_PUBLIC_ADJUSTED_CASH_BASIS_CUTOVER";
    const saved = process.env[key];
    try {
      delete process.env[key];
      const absent = resolveAdjustedCashBasisCutover();
      check("absent ⇒ default, not flagged", absent.source === "default" && !absent.invalidEnv && absent.changeoverDay === "2026-10-27");
      process.env[key] = "2026-11-12T15:04:00Z";
      const present = resolveAdjustedCashBasisCutover();
      check("present ⇒ env value", present.source === "env" && present.changeoverDay === "2026-11-12" && present.firstAdjustedDay === "2026-11-13");
      check("the note's default argument reads the env (Production window spanning 11-12)",
        /From Nov 13, 2026 \(UTC\)/.test(adjustedCashBasisNote("2026-10-15", "2026-11-20") ?? ""));
      check("…and a Production window over Preview's 10-27 changeover alone stays silent",
        adjustedCashBasisNote("2026-10-01", "2026-11-10") === null);
      process.env[key] = "not-a-date";
      const invalid = resolveAdjustedCashBasisCutover();
      check("invalid ⇒ default, flagged invalidEnv", invalid.source === "default" && invalid.invalidEnv && invalid.changeoverDay === "2026-10-27");
      process.env[key] = "";
      check("empty ⇒ default, not flagged", !resolveAdjustedCashBasisCutover().invalidEnv);
      check("explicit raw argument wins over env", resolveAdjustedCashBasisCutover("2026-12-01").changeoverDay === "2026-12-01");
    } finally {
      if (saved === undefined) delete process.env[key]; else process.env[key] = saved;
    }
  }

  console.log("\n6. the real snapshot writer over an in-memory store");
  {
    // One checking account: reported C = 1,000, available A = 900, one pending −100
    // ⇒ PENDING_EXCLUDED, adjusted 900. Old (pre-release) code stored C.
    const NOW = new Date("2026-11-05T23:50:00Z");
    const account = {
      id: "a1", type: "checking", institution: "Inst", balance: 1000, availableBalance: 900, currency: "USD",
      name: "A1", plaidName: null, officialName: null, nickname: null, customName: null, displayName: null, mask: null,
      lastUpdated: NOW, balanceLastUpdatedAt: NOW, creditLimit: null, debtSubtype: null, providerSubtype: null,
      syncStatus: "active", interestRate: null, minimumPayment: null, walletAddress: null, walletChain: null,
      debtProfile: null, connections: [],
    };
    const pendingRows = [{ id: "t1", financialAccountId: "a1", amount: -100, plaidTransactionId: null, settlementState: "PENDING", pending: true, deletedAt: null }];
    const store = new Map<string, any>();
    const k = (d: Date) => d.toISOString().slice(0, 10);
    const oldRow = (day: string, createdAt: string) => ({ date: day, cash: 1000, savings: 0, totalAssets: 1000, netWorth: 1000, createdAt: new Date(createdAt) });
    store.set("2026-11-04", oldRow("2026-11-04", "2026-11-04T08:00:00Z"));
    store.set("2026-11-05", oldRow("2026-11-05", "2026-11-05T09:00:00Z")); // created by OLD code before the 23:50Z deploy
    const DEPLOY = new Date("2026-11-05T23:50:00Z");
    const client: any = {
      spaceAccountLink: {
        async findMany() {
          return [{ id: "l-a1", visibilityLevel: "FULL", addedByUserId: "u1", addedByUser: { firstName: "O", name: "O" }, financialAccount: account }];
        },
      },
      transaction: { async findMany(a: any) { return a?.where?.pending === true ? pendingRows : []; }, async groupBy() { return []; } },
      financialAccount: { async findMany() { return []; } },
      space: { async findUnique() { return { reportingCurrency: "USD" }; } },
      spaceSnapshot: {
        async upsert(a: any) {
          const day = k(a.where.spaceId_date.date);
          const prev = store.get(day);
          store.set(day, prev ? { ...prev, ...a.update } : { date: day, ...a.create, createdAt: new Date(clock) });
          return {};
        },
      },
      positionObservation: { async findMany() { return []; } },
      manualAssetValuation: { async findMany() { return []; } },
    };
    let clock = "2026-11-05T23:55:00Z";
    const { regenerateSpaceSnapshot } = await import("@/lib/snapshots/regenerate");

    // A refresh 5 minutes after the 23:50Z deploy rewrites the changeover day…
    await regenerateSpaceSnapshot("space-1", new Date(Date.UTC(2026, 10, 5)), client);
    const d = store.get("2026-11-05");
    check("changeover day rewritten after deploy ⇒ adjusted (900) while createdAt stays pre-deploy",
      d.cash === 900 && d.createdAt < DEPLOY, JSON.stringify(d));
    check("…so createdAt < deploy does NOT prove the reported basis (changeover day = may be either)", d.createdAt < DEPLOY && d.cash !== 1000);
    // …and the first post-release UTC day is created by adjusted code only.
    clock = "2026-11-06T06:00:00Z";
    await regenerateSpaceSnapshot("space-1", new Date(Date.UTC(2026, 10, 6)), client);
    const first = store.get("2026-11-06");
    check("first post-release snapshot (D+1) carries the adjusted cash 900 and createdAt ≥ deploy",
      first && first.cash === 900 && first.totalAssets === 900 && first.createdAt >= DEPLOY, JSON.stringify(first));
    check("history before the changeover is untouched (frozen, reported 1,000)",
      store.get("2026-11-04").cash === 1000 && store.get("2026-11-04").createdAt.toISOString() === "2026-11-04T08:00:00.000Z");
    const cut = parseAdjustedCashBasisCutover(DEPLOY.toISOString())!;
    check("the cutover marker for this deploy discloses exactly the window that shows the jump",
      spansAdjustedCashBasis("2026-11-04", "2026-11-06", cut) && !spansAdjustedCashBasis("2026-11-06", "2026-11-06", cut)
      && cut.lastReportedDay === "2026-11-05" && cut.firstAdjustedDay === "2026-11-06");
  }

  if (failures > 0) { console.error(`\n${failures} adjusted-basis check(s) failed`); process.exit(1); }
  console.log("\nAll adjusted-basis checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
