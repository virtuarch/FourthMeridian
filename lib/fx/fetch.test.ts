/**
 * lib/fx/fetch.test.ts
 *
 * MC1 Phase 1 Slice 3 — fetch orchestration tests (pure, no DB, no network).
 * House-style standalone tsx script, auto-discovered by scripts/run-tests.ts.
 * Fake adapters exercise failover, first-success-wins, batch atomicity,
 * validation rejection, and determinism (plan §4).
 */

import { fetchDay } from "./fetch";
import { createFxRegistry } from "./registry";
import { yesterdayUTCISO } from "./config";
import type { FxProviderAdapter, RateResult } from "./types";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

const D = yesterdayUTCISO(); // fetchDay only accepts closed dates

function row(quote: string, rate: number, dateISO = D): RateResult {
  return { dateISO, base: "USD", quote, rate };
}

/** Fake adapter with scriptable behavior + call counter. */
function fake(
  source: string,
  behavior: (dateISO: string, quotes: readonly string[]) => RateResult[] | Error,
  serves?: (quotes: readonly string[]) => string[],
): FxProviderAdapter & { calls: number } {
  const a = {
    source,
    historicalDepth: "2000-01-01",
    calls: 0,
    supportedQuotes: serves ?? ((qs: readonly string[]) => [...qs]),
    async fetchDailyRates(dateISO: string, quotes: readonly string[]) {
      a.calls++;
      const out = behavior(dateISO, quotes);
      if (out instanceof Error) throw out;
      return out;
    },
  };
  return a;
}

async function main(): Promise<void> {
  const QUOTES = ["EUR", "GBP", "SAR"] as const;

  // ── first successful provider wins; later providers never called ───────────
  {
    const p1 = fake("primary", (_d, qs) => qs.map((q) => row(q, 0.5)));
    const p2 = fake("secondary", () => [row("EUR", 0.9)]);
    const r = await fetchDay(D, createFxRegistry([p1, p2]), QUOTES);
    check("first success wins: source = primary", r.source === "primary");
    check("first success wins: all quotes served", r.rates.length === QUOTES.length);
    check("first success wins: secondary never called", p2.calls === 0);
  }

  // ── failover on provider failure; batch discarded whole ────────────────────
  {
    const p1 = fake("primary", () => new Error("HTTP 500"));
    const p2 = fake("secondary", (_d, qs) => qs.map((q) => row(q, 0.8)));
    const r = await fetchDay(D, createFxRegistry([p1, p2]), QUOTES);
    check("failover: secondary wins after primary failure", r.source === "secondary");
    check("failover: failure noted for progress output", r.notes.some((n) => n.includes("primary: FAILED")));
    check("failover: no primary rows leak into the batch", r.rates.every((x) => x.rate === 0.8));
  }

  // ── invalid batches are treated as failures (validation → failover) ────────
  {
    const offDate = fake("primary", (_d, qs) => qs.map((q) => row(q, 0.5, "2020-01-01")));
    const good = fake("secondary", (_d, qs) => qs.map((q) => row(q, 0.8)));
    const r1 = await fetchDay(D, createFxRegistry([offDate, good]), QUOTES);
    check("validation: off-date batch discarded, failover engaged", r1.source === "secondary");

    const badRate = fake("p", (_d, qs) => qs.map((q) => row(q, q === "GBP" ? -1 : 0.5)));
    const r2 = await fetchDay(D, createFxRegistry([badRate, fake("s", (_d, qs) => qs.map((q) => row(q, 0.8)))]), QUOTES);
    check("validation: non-positive rate discarded", r2.source === "s");
  }

  // ── empty result = "no data", not failure; continue down the chain ─────────
  {
    const noData = fake("primary", () => []);
    const p2 = fake("secondary", (_d, qs) => qs.map((q) => row(q, 0.8)));
    const r = await fetchDay(D, createFxRegistry([noData, p2]), QUOTES);
    check("empty: continues past no-data source", r.source === "secondary");
    check("empty: note recorded, not FAILED", r.notes.some((n) => n.includes("non-banking day")));
  }

  // ── partial coverage: adapter only fetches what it serves ──────────────────
  {
    const subsetOnly = fake(
      "ecb-like",
      (_d, qs) => qs.map((q) => row(q, 0.7)),
      (qs) => qs.filter((q) => q !== "SAR"),
    );
    const r = await fetchDay(D, createFxRegistry([subsetOnly]), QUOTES);
    check("subset: served quotes only (no SAR fabrication)",
      r.source === "ecb-like" && r.rates.length === 2 && !r.rates.some((x) => x.quote === "SAR"));
  }

  // ── all adapters exhausted → null source, notes explain ────────────────────
  {
    const r = await fetchDay(D, createFxRegistry([fake("a", () => new Error("down")), fake("b", () => [])]), QUOTES);
    check("exhausted: source null, no rates", r.source === null && r.rates.length === 0);
    check("exhausted: both adapters noted", r.notes.length === 2);
  }

  // ── closed-date doctrine: today rejected (programmer error) ────────────────
  {
    let threw = false;
    const today = new Date().toISOString().slice(0, 10);
    try { await fetchDay(today, createFxRegistry([fake("a", () => [])])); } catch { threw = true; }
    check("closed dates only: today throws", threw);
  }

  // ── determinism: same registry + same responses → identical result ─────────
  {
    const mk = () => createFxRegistry([
      fake("primary", () => new Error("down")),
      fake("secondary", (_d, qs) => qs.map((q) => row(q, 0.8))),
    ]);
    const r1 = await fetchDay(D, mk(), QUOTES);
    const r2 = await fetchDay(D, mk(), QUOTES);
    check("determinism: byte-equal FetchDayResult", JSON.stringify(r1) === JSON.stringify(r2));
  }

  if (failures.length > 0) {
    console.error(`\nMC1 P1 fx fetch: ${failures.length} FAILURE(S) (${passed} checks passed):`);
    for (const f of failures) console.error("  " + f);
    process.exit(1);
  }
  console.log(`MC1 P1 fx fetch: all ${passed} checks passed.`);
  process.exit(0);
}

main().catch((e) => {
  console.error("fetch.test.ts crashed:", e);
  process.exit(1);
});
