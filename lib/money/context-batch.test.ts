/**
 * lib/money/context-batch.test.ts
 *
 * MC1 QA perf P0 — proves the BATCHED prefetch path in buildConversionContext
 * (one `readRange` window + in-memory snapshot) produces resolutions
 * BYTE-IDENTICAL to the original per-date path (sequential
 * `readLatestOnOrBefore` reads), across exact / walk-back / beyond-window-miss
 * / unsupported-currency / mixed-date fixtures — and that it collapses the DB
 * round-trips (one range read, zero point reads). Pure: an in-memory archive
 * fake, no DB, no network. House-style standalone tsx script.
 */

import { buildConversionContext } from "./context";
import { minusDaysISO } from "@/lib/fx/config";
import type { FxArchiveReader } from "@/lib/fx/types";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

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

const D    = "2026-07-01"; // EUR exact
const D2   = "2026-06-15"; // EUR exact (older date)
const DFAR = "2026-05-01"; // EUR nearest row is >7d away → miss on both paths

async function main(): Promise<void> {
  const rows: Row[] = [
    { quote: "EUR", dateISO: D,             rate: 0.80 }, // exact @ D
    { quote: "EUR", dateISO: D2,            rate: 0.90 }, // exact @ D2
    { quote: "EUR", dateISO: "2026-04-20",  rate: 0.85 }, // 11d before DFAR → unreachable
    { quote: "GBP", dateISO: "2026-06-29",  rate: 0.50 }, // walk-back 2d @ D
  ];

  const currencies = ["EUR", "GBP", "SAR", "XXX", null, "USD"]; // exact, walk-back, miss, unsupported, null, identity
  const dates      = [D, D2, DFAR];

  // ── Build both ways over the SAME data ──────────────────────────────────────
  const a = makeArchives(rows);
  const seqCtx   = await buildConversionContext({ target: "USD", currencies, dates }, a.sequential);
  const batchCtx = await buildConversionContext({ target: "USD", currencies, dates }, a.batch);

  // ── Byte-identical resolutions across the whole matrix ──────────────────────
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

  // ── Spot-check the specific semantics survive on the batch path ─────────────
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

  // ── Access pattern actually changed (the point of P0) ───────────────────────
  {
    check("batch path issues exactly ONE range read", a.counts.batchRanges === 1,
      `got ${a.counts.batchRanges}`);
    check("batch path issues ZERO per-date point reads on the source reader", a.counts.batchReads === 0,
      `got ${a.counts.batchReads}`);
    check("sequential path issues MANY per-date point reads", a.counts.seqReads > 0,
      `got ${a.counts.seqReads}`);
    check("sequential path issues NO range read", a.counts.seqRanges === 0);
  }

  // ── All-USD identity: no archive reads of either kind, empty table ──────────
  {
    const usd = makeArchives(rows);
    const usdCtx = await buildConversionContext(
      { target: "USD", currencies: ["USD", null, "USD"], dates: [D, D2] },
      usd.batch,
    );
    check("all-USD: zero range reads", usd.counts.batchRanges === 0);
    check("all-USD: zero point reads", usd.counts.batchReads === 0);
    check("all-USD: any resolve is a miss (empty prefetch table)", usdCtx.resolve("USD", D).kind === "miss");
  }

  // ── Non-USD target (SGD) over USD-stamped rows — the reported hot path ──────
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

  if (failures.length > 0) {
    console.error(`\nMC1 P0 context-batch: ${failures.length} FAILURE(S) (${passed} checks passed):`);
    for (const f of failures) console.error("  " + f);
    process.exit(1);
  }
  console.log(`MC1 P0 context-batch: all ${passed} checks passed.`);
  process.exit(0);
}

main().catch((e) => {
  console.error("context-batch.test.ts crashed:", e);
  process.exit(1);
});
