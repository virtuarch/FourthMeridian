/**
 * lib/prices/providers/tiingo.test.ts
 *
 * A8-3B — Tiingo adapter contract. Standalone tsx script (no real network — the
 * HTTP call is injected via the fetchImpl option):
 *
 *     npx tsx lib/prices/providers/tiingo.test.ts
 *
 * Proves the adapter honors the PriceProviderAdapter contract a real vendor
 * must honor (RAW_CLOSE only, window clamp, close→price mapping, USD currency),
 * degrades a 429 / non-2xx / network error to a normal adapter failure (throws
 * so fetchInstrumentWindow fails over rather than crashing the run), never lets
 * one malformed row poison a batch, and flows cleanly through the real
 * fetch orchestration + registry.
 */

import { PriceBasis } from "@prisma/client";
import { createTiingoPriceProvider, type TiingoFetch, type TiingoHttpResponse } from "./tiingo";
import { fetchInstrumentWindow } from "../fetch";
import { createPriceRegistry } from "../registry";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** Build a fake fetch that returns a canned JSON body with the given status. */
function fakeFetch(body: unknown, opts: { ok?: boolean; status?: number } = {}): { fn: TiingoFetch; calls: string[] } {
  const calls: string[] = [];
  const fn: TiingoFetch = async (url) => {
    calls.push(url);
    const res: TiingoHttpResponse = {
      ok:     opts.ok ?? true,
      status: opts.status ?? 200,
      json:   async () => body,
    };
    return res;
  };
  return { fn, calls };
}

const req = {
  instrumentId:   "instr_nvda",
  providerSymbol: "NVDA",
  basis:          PriceBasis.RAW_CLOSE,
  fromISO:        "2026-06-05",
  toISO:          "2026-06-09",
};

async function main(): Promise<void> {
  console.log("1. Metadata");
  {
    const { fn } = fakeFetch([]);
    const p = createTiingoPriceProvider("k", { fetchImpl: fn });
    check("source is 'tiingo'", p.source === "tiingo");
    check("serves RAW_CLOSE only",
      p.supportedBases().length === 1 && p.supportedBases()[0] === PriceBasis.RAW_CLOSE);
  }

  console.log("2. Maps Tiingo rows → PriceResult (close→price, date slice, USD, window clamp)");
  {
    const body = [
      { date: "2026-06-05T00:00:00.000Z", close: 200.5, adjClose: 199 },
      { date: "2026-06-08T00:00:00.000Z", close: 210,   adjClose: 208 },
      { date: "2026-06-09T00:00:00.000Z", close: 205,   adjClose: 204 },
      { date: "2026-06-12T00:00:00.000Z", close: 999,   adjClose: 999 }, // outside window → clamped
    ];
    const { fn, calls } = fakeFetch(body);
    const rows = await createTiingoPriceProvider("secret-key", { fetchImpl: fn }).fetchDailyCloses(req);
    check("row count = in-window rows (3, the off-window row clamped)", rows.length === 3, `got ${rows.length}`);
    check("close mapped to price", rows[0].price === 200.5);
    check("date sliced to YYYY-MM-DD", rows[0].dateISO === "2026-06-05");
    check("basis is RAW_CLOSE", rows.every((r) => r.basis === PriceBasis.RAW_CLOSE));
    check("currency USD", rows.every((r) => r.currency === "USD"));
    check("instrumentId echoed from the request", rows.every((r) => r.instrumentId === "instr_nvda"));
    check("symbol went into the path, key NOT in the URL",
      calls[0].includes("/tiingo/daily/NVDA/prices") && !calls[0].includes("secret-key"));
    check("window bounds in the query", calls[0].includes("startDate=2026-06-05") && calls[0].includes("endDate=2026-06-09"));
  }

  console.log("3. Malformed / non-positive rows are dropped, not thrown");
  {
    const body = [
      { date: "2026-06-05T00:00:00.000Z", close: 200 },
      { date: "2026-06-06T00:00:00.000Z", close: 0 },     // non-positive → dropped
      { date: "2026-06-07T00:00:00.000Z", close: -5 },    // negative → dropped
      { date: "bad-date", close: 5 },                     // no valid date slice within window → dropped
      { date: "2026-06-08T00:00:00.000Z" },               // missing close → dropped
      { date: "2026-06-09T00:00:00.000Z", close: 205 },
    ];
    const { fn } = fakeFetch(body);
    const rows = await createTiingoPriceProvider("k", { fetchImpl: fn }).fetchDailyCloses(req);
    check("only the two valid closes survive", rows.length === 2, `got ${rows.length}`);
    check("survivors are positive-finite", rows.every((r) => Number.isFinite(r.price) && r.price > 0));
  }

  console.log("4. Empty/absent symbol → [] (no fetch), non-RAW_CLOSE → []");
  {
    const { fn, calls } = fakeFetch([{ date: "2026-06-05T00:00:00.000Z", close: 1 }]);
    const p = createTiingoPriceProvider("k", { fetchImpl: fn });
    const empty = await p.fetchDailyCloses({ ...req, providerSymbol: "   " });
    check("blank symbol returns [] without calling the API", empty.length === 0 && calls.length === 0);
    const wrongBasis = await p.fetchDailyCloses({ ...req, basis: PriceBasis.NAV });
    check("non-RAW_CLOSE basis returns []", wrongBasis.length === 0);
  }

  console.log("5. 429 / non-2xx / network error → thrown (normal adapter failure)");
  {
    const { fn: rl } = fakeFetch({ detail: "limit" }, { ok: false, status: 429 });
    let threw = false;
    try { await createTiingoPriceProvider("k", { fetchImpl: rl }).fetchDailyCloses(req); }
    catch { threw = true; }
    check("429 throws", threw);

    const { fn: err500 } = fakeFetch("oops", { ok: false, status: 500 });
    threw = false;
    try { await createTiingoPriceProvider("k", { fetchImpl: err500 }).fetchDailyCloses(req); }
    catch { threw = true; }
    check("HTTP 500 throws", threw);

    const netFail: TiingoFetch = async () => { throw new Error("ECONNRESET"); };
    threw = false;
    try { await createTiingoPriceProvider("k", { fetchImpl: netFail }).fetchDailyCloses(req); }
    catch { threw = true; }
    check("network error throws", threw);
  }

  console.log("6. Flows cleanly through fetchInstrumentWindow + registry (validateBatch passes)");
  {
    const body = [
      { date: "2026-06-05T00:00:00.000Z", close: 200 },
      { date: "2026-06-09T00:00:00.000Z", close: 205 },
    ];
    const { fn } = fakeFetch(body);
    const registry = createPriceRegistry([createTiingoPriceProvider("k", { fetchImpl: fn })]);
    const res = await fetchInstrumentWindow(req, registry);
    check("winning source is tiingo", res.source === "tiingo");
    check("validated rows returned", res.rows.length === 2);
  }

  console.log("7. A vendor 429 fails over instead of crashing the run (source null, no throw)");
  {
    const { fn } = fakeFetch("nope", { ok: false, status: 429 });
    const registry = createPriceRegistry([createTiingoPriceProvider("k", { fetchImpl: fn })]);
    const res = await fetchInstrumentWindow(req, registry); // must NOT throw
    check("source is null (adapter failed over)", res.source === null);
    check("failure recorded in notes", res.notes.some((n) => n.includes("tiingo") && n.includes("FAILED")));
  }

  console.log(failures === 0 ? "\nAll tiingo adapter checks passed" : `\n${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
