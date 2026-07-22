/**
 * lib/fx/service.test.ts
 *
 * MC1 Phase 1 Slice 2 — resolution engine tests (pure, no DB, no network).
 *
 * Standalone, dependency-free script in the house style (see
 * lib/transactions/flow-classifier.test.ts), runnable with `tsx`:
 *
 *     npx tsx lib/fx/service.test.ts
 *
 * Auto-discovered by scripts/run-tests.ts (D-TEST). Imports ONLY the pure fx
 * modules (service/config/types) — NOT lib/fx/archive.ts — so this suite runs
 * without `prisma generate` (plan §4): the archive seam is an in-memory fake.
 */

import { createFxService } from "./service";
import {
  FX_BASE,
  MAX_STALE_DAYS,
  SUPPORTED_QUOTES,
  assertClosedDateISO,
  isSupportedCurrency,
  minusDaysISO,
  yesterdayUTCISO,
} from "./config";
import type { FxArchiveReader, Resolution } from "./types";

// ── Tiny assert harness ───────────────────────────────────────────────────────

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

// ── In-memory archive fake (the FxArchiveReader seam) ────────────────────────

/** rows: "date|quote" → rate. Mirrors readLatestOnOrBefore's window semantics. */
function fakeArchive(rows: Record<string, number>): FxArchiveReader & { calls: number } {
  const store = new Map(Object.entries(rows));
  const fake = {
    calls: 0,
    async readLatestOnOrBefore(base: string, quote: string, dateISO: string, maxStaleDays: number) {
      fake.calls++;
      if (base !== FX_BASE) return null;
      for (let i = 0; i <= maxStaleDays; i++) {
        const d = minusDaysISO(dateISO, i);
        const rate = store.get(`${d}|${quote}`);
        if (rate !== undefined) return { dateISO: d, rate };
      }
      return null;
    },
  };
  return fake;
}

const D = "2026-07-01"; // a Wednesday — fixture anchor date

async function main(): Promise<void> {
  // ── identity fast path ──────────────────────────────────────────────────────
  {
    const a = fakeArchive({});
    const svc = createFxService(a);
    const r = await svc.getRateForDate("EUR", "EUR", D);
    check("identity: rate 1", r.kind === "rate" && r.rate === 1);
    check("identity: exact staleness", r.kind === "rate" && r.staleness === "exact");
    check("identity: zero archive lookups", a.calls === 0);
    const usd = await svc.getRateForDate("USD", "USD", D);
    check("identity: USD→USD rate 1, still zero lookups", usd.kind === "rate" && usd.rate === 1 && a.calls === 0);
  }

  // ── exact-date lookup + cross-rate arithmetic ───────────────────────────────
  {
    const a = fakeArchive({ [`${D}|EUR`]: 0.8, [`${D}|GBP`]: 0.5 });
    const svc = createFxService(a);

    const usdEur = await svc.getRateForDate("USD", "EUR", D);
    check("exact: USD→EUR uses stored rate", usdEur.kind === "rate" && usdEur.rate === 0.8);
    check("exact: staleness exact", usdEur.kind === "rate" && usdEur.staleness === "exact");
    check(
      "exact: effectiveDates both = requested",
      usdEur.kind === "rate" && usdEur.effectiveDates.from === D && usdEur.effectiveDates.to === D,
    );

    const eurUsd = await svc.getRateForDate("EUR", "USD", D);
    check("inverse: EUR→USD = 1/0.8", eurUsd.kind === "rate" && eurUsd.rate === 1 / 0.8);

    const eurGbp = await svc.getRateForDate("EUR", "GBP", D);
    check("cross-rate: EUR→GBP = usd(GBP)/usd(EUR) = 0.5/0.8", eurGbp.kind === "rate" && eurGbp.rate === 0.5 / 0.8);

    const gbpEur = await svc.getRateForDate("GBP", "EUR", D);
    check(
      "cross-rate: GBP→EUR is the reciprocal of EUR→GBP",
      gbpEur.kind === "rate" && eurGbp.kind === "rate" && Math.abs(gbpEur.rate * eurGbp.rate - 1) < 1e-12,
    );
  }

  // ── walk-back (weekend/holiday) ─────────────────────────────────────────────
  {
    const friday = "2026-06-26";
    const sunday = "2026-06-28"; // 2 days after fixture rate
    const a = fakeArchive({ [`${friday}|EUR`]: 0.9 });
    const svc = createFxService(a);
    const r = await svc.getRateForDate("USD", "EUR", sunday);
    check("walk-back: resolves from prior close", r.kind === "rate" && r.rate === 0.9);
    check("walk-back: staleness walked-back", r.kind === "rate" && r.staleness === "walked-back");
    check("walk-back: effective 'to' date = Friday", r.kind === "rate" && r.effectiveDates.to === friday);
    check("walk-back: requestedDate preserved", r.kind === "rate" && r.requestedDateISO === sunday);

    // boundary: exactly MAX_STALE_DAYS old is still served
    const atLimit = await createFxService(fakeArchive({ [`${minusDaysISO(D, MAX_STALE_DAYS)}|EUR`]: 0.7 }))
      .getRateForDate("USD", "EUR", D);
    check("walk-back: exactly MAX_STALE_DAYS old is served", atLimit.kind === "rate" && atLimit.rate === 0.7);
  }

  // ── stale failure → RateMiss (never a throw) ───────────────────────────────
  {
    const tooOld = minusDaysISO(D, MAX_STALE_DAYS + 1);
    const svc = createFxService(fakeArchive({ [`${tooOld}|EUR`]: 0.7 }));
    const r = await svc.getRateForDate("USD", "EUR", D);
    check("stale: gap > MAX_STALE_DAYS is a miss", r.kind === "miss");
    check("stale: miss names the quote + requested date", r.kind === "miss" && r.quote === "EUR" && r.requestedDateISO === D);
  }
  {
    // one resolvable leg + one missing leg → miss names the missing quote;
    // both missing → miss names the FROM leg (deterministic attribution).
    const svc = createFxService(fakeArchive({ [`${D}|EUR`]: 0.8 }));
    const oneMissing = await svc.getRateForDate("EUR", "GBP", D);
    check("miss: missing 'to' leg named", oneMissing.kind === "miss" && oneMissing.quote === "GBP");
    const bothMissing = await createFxService(fakeArchive({})).getRateForDate("SAR", "AED", D);
    check("miss: both legs missing → 'from' leg named first", bothMissing.kind === "miss" && bothMissing.quote === "SAR");
  }

  // ── programmer errors throw ────────────────────────────────────────────────
  {
    const svc = createFxService(fakeArchive({}));
    let threwCurrency = false;
    try { await svc.getRateForDate("XXX", "EUR", D); } catch { threwCurrency = true; }
    check("throws: unsupported currency", threwCurrency);
    let threwDate = false;
    try { await svc.getRateForDate("EUR", "USD", "07/01/2026"); } catch { threwDate = true; }
    check("throws: malformed date", threwDate);
  }

  // ── memoization + determinism ──────────────────────────────────────────────
  {
    const a = fakeArchive({ [`${D}|EUR`]: 0.8, [`${D}|GBP`]: 0.5 });
    const svc = createFxService(a);
    const r1 = await svc.getRateForDate("EUR", "GBP", D);
    const callsAfterFirst = a.calls;
    const r2 = await svc.getRateForDate("EUR", "GBP", D);
    check("memo: repeat query adds zero archive calls", a.calls === callsAfterFirst);
    check("memo/determinism: byte-equal results", JSON.stringify(r1) === JSON.stringify(r2));

    const miss1 = await svc.getRateForDate("USD", "SAR", D);
    const callsAfterMiss = a.calls;
    const miss2 = await svc.getRateForDate("USD", "SAR", D);
    check("memo: misses memoized too", a.calls === callsAfterMiss && JSON.stringify(miss1) === JSON.stringify(miss2));

    // determinism across independent instances over the same archive
    const r3: Resolution = await createFxService(fakeArchive({ [`${D}|EUR`]: 0.8, [`${D}|GBP`]: 0.5 }))
      .getRateForDate("EUR", "GBP", D);
    check("determinism: fresh service, same archive, same answer", JSON.stringify(r3) === JSON.stringify(r1));
  }

  // ── config invariants (approved constants) ─────────────────────────────────
  {
    check("config: 24 approved quotes", SUPPORTED_QUOTES.length === 24);
    check("config: SAR and AED present (plan D6 driver)", isSupportedCurrency("SAR") && isSupportedCurrency("AED"));
    check("config: USD is base, supported, never a quote",
      isSupportedCurrency("USD") && !(SUPPORTED_QUOTES as readonly string[]).includes("USD"));
    check("config: MAX_STALE_DAYS = 7 (plan D5)", MAX_STALE_DAYS === 7);

    // append-only guard: yesterday accepted, today rejected
    let acceptedYesterday = true;
    try { assertClosedDateISO(yesterdayUTCISO()); } catch { acceptedYesterday = false; }
    check("closed-date guard: yesterday UTC accepted", acceptedYesterday);
    let rejectedToday = false;
    try { assertClosedDateISO(minusDaysISO(yesterdayUTCISO(), -1)); } catch { rejectedToday = true; }
    check("closed-date guard: today rejected", rejectedToday);
  }

  // ── Report ──────────────────────────────────────────────────────────────────
  if (failures.length > 0) {
    console.error(`\nMC1 P1 fx service: ${failures.length} FAILURE(S) (${passed} checks passed):`);
    for (const f of failures) console.error("  " + f);
    process.exit(1);
  }
  console.log(`MC1 P1 fx service: all ${passed} checks passed.`);
  process.exit(0);
}

main().catch((e) => {
  console.error("service.test.ts crashed:", e);
  process.exit(1);
});
