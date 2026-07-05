/**
 * lib/money/context.test.ts
 *
 * MC1 Phase 2 Slice 2 — context-builder tests (pure: no DB, no network; the
 * FxArchiveReader is an in-memory fake, same seam as lib/fx/service.test.ts).
 * House-style standalone tsx script, auto-discovered by scripts/run-tests.ts.
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

const D  = "2026-07-01";
const D2 = "2026-06-15";

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
    check("e2e: miss → native + estimated through the same seam", sar.amount === 100 && sar.estimated === true);
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
