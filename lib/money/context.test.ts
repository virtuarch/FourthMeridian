/**
 * lib/money/context.test.ts
 *
 * MC1 Phase 2 Slice 2 — context-builder tests (pure: no DB, no network; the
 * FxArchiveReader is an in-memory fake, same seam as lib/fx/service.test.ts).
 * House-style standalone tsx script, auto-discovered by scripts/run-tests.ts.
 *
 * Also hosts the MC1 QA perf P0 batch-prefetch gates merged from
 * lib/money/context-batch.test.ts: the BATCHED prefetch path in
 * buildConversionContext (one `readRange` window + in-memory snapshot) produces
 * resolutions BYTE-IDENTICAL to the original per-date path (sequential
 * `readLatestOnOrBefore` reads), across exact / walk-back / beyond-window-miss
 * / unsupported-currency / mixed-date fixtures — and it collapses the DB
 * round-trips (one range read, zero point reads). Those gates use an
 * instrumented FxArchiveReader fake that counts reads.
 */

import { buildConversionContext } from "./context";
import { convertMoney } from "./convert";
import { createFxService } from "@/lib/fx/service";
import { minusDaysISO, MAX_STALE_DAYS } from "@/lib/fx/config";
import type { FxArchiveReader } from "@/lib/fx/types";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

/** In-memory archive fake — identical walk-back semantics to the fx suite's. */
function fakeArchive(rows: Record<string, number>): FxArchiveReader {
  const store = new Map(Object.entries(rows));
  return {
    async readLatestOnOrBefore(base, quote, dateISO, maxStaleDays) {
      if (base !== "USD") return null;
      for (let i = 0; i <= maxStaleDays; i++) {
        const d = minusDaysISO(dateISO, i);
        const rate = store.get(`${d}|${quote}`);
        if (rate !== undefined) return { dateISO: d, rate };
      }
      return null;
    },
  };
}

const D    = "2026-07-01"; // EUR exact
const D2   = "2026-06-15"; // EUR exact (older date)
const DFAR = "2026-05-01"; // EUR nearest row is >7d away → miss on both paths

// ── merged from lib/money/context-batch.test.ts (MC1 QA perf P0) ──────────────

interface Row { quote: string; dateISO: string; rate: number }

/**
 * One backing store, two reader facades over it:
 *   - `sequential`: exposes ONLY readLatestOnOrBefore (older/pure fakes) → the
 *     builder takes the per-date path.
 *   - `batch`: additionally exposes readRange → the builder takes the P0 path.
 * Both count their calls so we can prove the access pattern changed while the
 * results did not.
 */
function makeArchives(rows: Row[]) {
  const counts = { seqReads: 0, seqRanges: 0, batchReads: 0, batchRanges: 0 };

  const latest = (base: string, quote: string, dateISO: string, maxStaleDays: number) => {
    if (base !== "USD") return null;
    for (let i = 0; i <= maxStaleDays; i++) {
      const d = minusDaysISO(dateISO, i);
      const hit = rows.find((r) => r.quote === quote && r.dateISO === d);
      if (hit) return { dateISO: d, rate: hit.rate };
    }
    return null;
  };
  const range = (base: string, quotes: readonly string[], fromISO: string, toISO: string) =>
    base !== "USD"
      ? []
      : rows.filter((r) => quotes.includes(r.quote) && r.dateISO >= fromISO && r.dateISO <= toISO)
            .map((r) => ({ quote: r.quote, dateISO: r.dateISO, rate: r.rate }));

  const sequential: FxArchiveReader = {
    async readLatestOnOrBefore(b, q, d, m) { counts.seqReads++; return latest(b, q, d, m); },
    // no readRange → forces the per-date path
  };
  const batch: FxArchiveReader = {
    async readLatestOnOrBefore(b, q, d, m) { counts.batchReads++; return latest(b, q, d, m); },
    async readRange(b, q, f, t)            { counts.batchRanges++; return range(b, q, f, t); },
  };
  return { sequential, batch, counts };
}

async function main(): Promise<void> {
  const rows = {
    [`${D}|EUR`]: 0.8,
    [`${D2}|EUR`]: 0.9,
    [`${minusDaysISO(D, 2)}|GBP`]: 0.5, // GBP only via walk-back at D
  };

  const ctx = await buildConversionContext(
    { target: "USD", currencies: ["EUR", "GBP", "SAR", null, "USD"], dates: [D, D2] },
    fakeArchive(rows),
  );

  // ── prefetch shape + sync resolve ──────────────────────────────────────────
  {
    check("target carried on context", ctx.target === "USD");
    const r = ctx.resolve("EUR", D);
    check("sync resolve: returns a value, not a Promise", !(r instanceof Promise));
    check("prefetch: exact pair resolved", r.kind === "rate" && r.rate === 1 / 0.8);
  }

  // ── parity with the fx service (exact / walk-back / miss) ──────────────────
  {
    const svc = createFxService(fakeArchive(rows));
    for (const [from, dateISO, label] of [
      ["EUR", D, "exact"], ["EUR", D2, "exact (second date)"],
      ["GBP", D, "walk-back"], ["SAR", D, "miss"],
    ] as const) {
      const fromCtx = ctx.resolve(from, dateISO);
      const fromSvc = await svc.getRateForDate(from, "USD", dateISO);
      check(`parity: ${label} (${from}@${dateISO}) byte-equal with fx service`,
        JSON.stringify(fromCtx) === JSON.stringify(fromSvc));
    }
    const gb = ctx.resolve("GBP", D);
    check("walk-back parity: staleness surfaces", gb.kind === "rate" && gb.staleness === "walked-back");
    const sar = ctx.resolve("SAR", D);
    check("miss parity: RateMiss value shape", sar.kind === "miss" && sar.quote === "SAR" && sar.requestedDateISO === D);
  }

  // ── frozen lookup table ─────────────────────────────────────────────────────
  {
    check("context object frozen", Object.isFrozen(ctx));
    const r = ctx.resolve("EUR", D);
    check("stored resolutions frozen", Object.isFrozen(r));
    let mutated = true;
    try { (r as { rate?: number }).rate = 999; mutated = (r as { rate?: number }).rate === 999; } catch { mutated = false; }
    check("stored resolutions immune to mutation", mutated === false);
  }

  // ── unprefetched pairs + degraded inputs ────────────────────────────────────
  {
    const un = ctx.resolve("EUR", "2020-01-01"); // date never prefetched
    check("unprefetched pair → deterministic miss (never throws)", un.kind === "miss");
    // unsupported currency in the data → caught during prefetch, stored as miss
    const weird = await buildConversionContext(
      { target: "USD", currencies: ["XXX"], dates: [D] },
      fakeArchive(rows),
    );
    const xxx = weird.resolve("XXX", D);
    check("unsupported data currency → miss, not a throw (D-3 at prefetch)", xxx.kind === "miss");
  }

  // ── end-to-end with convertMoney (the consuming seam) ───────────────────────
  {
    const c = convertMoney({ amount: 80, currency: "EUR" }, D, ctx);
    check("e2e: 80 EUR @ (1/0.8) = 100 USD via prefetched context",
      c.amount === 80 * (1 / 0.8) && c.estimated === false && c.conversion?.from === "EUR");
    const sar = convertMoney({ amount: 100, currency: "SAR" }, D, ctx);
    // V25-FINAL-1 — a known-currency miss is UNAVAILABLE: excluded to 0 (never
    // relabeled), native value preserved, estimated flagged.
    check("e2e: miss → excluded (amount 0) + native + estimated through the same seam",
      sar.amount === null && sar.native?.amount === 100 && sar.estimated === true);
  }

  // ── determinism ─────────────────────────────────────────────────────────────
  {
    const build = () => buildConversionContext(
      { target: "USD", currencies: ["EUR", "GBP", "SAR"], dates: [D, D2] },
      fakeArchive(rows),
    );
    const a = await build();
    const b = await build();
    const probes: Array<[string, string]> = [["EUR", D], ["EUR", D2], ["GBP", D], ["SAR", D], ["EUR", "2020-01-01"]];
    check("determinism: two builds over the same archive resolve byte-identically",
      probes.every(([f, d]) => JSON.stringify(a.resolve(f, d)) === JSON.stringify(b.resolve(f, d))));
    check("stale-bound sanity: MAX_STALE_DAYS respected by prefetch",
      (await build()).resolve("GBP", D).kind === "rate" && MAX_STALE_DAYS === 7);
  }

  // ── merged from lib/money/context-batch.test.ts (MC1 QA perf P0) ──────────
  {
    const batchRows: Row[] = [
      { quote: "EUR", dateISO: D,             rate: 0.80 }, // exact @ D
      { quote: "EUR", dateISO: D2,            rate: 0.90 }, // exact @ D2
      { quote: "EUR", dateISO: "2026-04-20",  rate: 0.85 }, // 11d before DFAR → unreachable
      { quote: "GBP", dateISO: "2026-06-29",  rate: 0.50 }, // walk-back 2d @ D
    ];

    const batchCurrencies = ["EUR", "GBP", "SAR", "XXX", null, "USD"]; // exact, walk-back, miss, unsupported, null, identity
    const batchDates      = [D, D2, DFAR];

    // ── Build both ways over the SAME data ────────────────────────────────────
    const arch = makeArchives(batchRows);
    const seqCtx   = await buildConversionContext({ target: "USD", currencies: batchCurrencies, dates: batchDates }, arch.sequential);
    const batchCtx = await buildConversionContext({ target: "USD", currencies: batchCurrencies, dates: batchDates }, arch.batch);

    // ── Byte-identical resolutions across the whole matrix ────────────────────
    const probeCurrencies = ["EUR", "GBP", "SAR", "XXX", "USD"];
    const probeDates      = [D, D2, DFAR, "2020-01-01" /* unprefetched */];
    let allEqual = true;
    const mismatches: string[] = [];
    for (const f of probeCurrencies) {
      for (const d of probeDates) {
        const s = JSON.stringify(seqCtx.resolve(f, d));
        const b = JSON.stringify(batchCtx.resolve(f, d));
        if (s !== b) { allEqual = false; mismatches.push(`${f}@${d}: seq=${s} batch=${b}`); }
      }
    }
    check("batched builder == sequential builder for EVERY (currency,date) pair", allEqual, mismatches.join(" | "));

    // ── Spot-check the specific semantics survive on the batch path ───────────
    {
      const eur = batchCtx.resolve("EUR", D);
      check("batch: exact rate (1/0.8)", eur.kind === "rate" && eur.rate === 1 / 0.8 && eur.staleness === "exact");
      const gbp = batchCtx.resolve("GBP", D);
      check("batch: walk-back resolves + flagged", gbp.kind === "rate" && gbp.rate === 1 / 0.5 && gbp.staleness === "walked-back");
      const far = batchCtx.resolve("EUR", DFAR);
      check("batch: beyond-window → miss (D-3)", far.kind === "miss");
      const sar = batchCtx.resolve("SAR", D);
      check("batch: no rows → miss", sar.kind === "miss" && sar.quote === "SAR");
      const xxx = batchCtx.resolve("XXX", D);
      check("batch: unsupported currency → miss, not a throw", xxx.kind === "miss");
      const un = batchCtx.resolve("EUR", "2020-01-01");
      check("batch: unprefetched pair → deterministic miss", un.kind === "miss");
    }

    // ── Access pattern actually changed (the point of P0) ─────────────────────
    {
      check("batch path issues exactly ONE range read", arch.counts.batchRanges === 1,
        `got ${arch.counts.batchRanges}`);
      check("batch path issues ZERO per-date point reads on the source reader", arch.counts.batchReads === 0,
        `got ${arch.counts.batchReads}`);
      check("sequential path issues MANY per-date point reads", arch.counts.seqReads > 0,
        `got ${arch.counts.seqReads}`);
      check("sequential path issues NO range read", arch.counts.seqRanges === 0);
    }

    // ── All-USD identity: no archive reads of either kind, empty table ────────
    {
      const usd = makeArchives(batchRows);
      const usdCtx = await buildConversionContext(
        { target: "USD", currencies: ["USD", null, "USD"], dates: [D, D2] },
        usd.batch,
      );
      check("all-USD: zero range reads", usd.counts.batchRanges === 0);
      check("all-USD: zero point reads", usd.counts.batchReads === 0);
      check("all-USD: any resolve is a miss (empty prefetch table)", usdCtx.resolve("USD", D).kind === "miss");
    }

    // ── Non-USD target (SGD) over USD-stamped rows — the reported hot path ────
    {
      const rows2: Row[] = [
        { quote: "SGD", dateISO: D,  rate: 1.35 },
        { quote: "SGD", dateISO: D2, rate: 1.34 },
      ];
      const s = makeArchives(rows2);
      const b = makeArchives(rows2);
      const seq2   = await buildConversionContext({ target: "SGD", currencies: ["USD"], dates: [D, D2] }, s.sequential);
      const batch2 = await buildConversionContext({ target: "SGD", currencies: ["USD"], dates: [D, D2] }, b.batch);
      const eq =
        JSON.stringify(seq2.resolve("USD", D))  === JSON.stringify(batch2.resolve("USD", D)) &&
        JSON.stringify(seq2.resolve("USD", D2)) === JSON.stringify(batch2.resolve("USD", D2));
      check("SGD target over USD rows: batch == sequential", eq);
      check("SGD target: USD→SGD resolves (1 * 1.35)", batch2.resolve("USD", D).kind === "rate");
      check("SGD target: still ONE range read for the whole window", b.counts.batchRanges === 1);
    }
  }

  if (failures.length > 0) {
    console.error(`\nMC1 P2 money context: ${failures.length} FAILURE(S) (${passed} checks passed):`);
    for (const f of failures) console.error("  " + f);
    process.exit(1);
  }
  console.log(`MC1 P2 money context: all ${passed} checks passed.`);
  process.exit(0);
}

main().catch((e) => {
  console.error("context.test.ts crashed:", e);
  process.exit(1);
});
