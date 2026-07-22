/**
 * lib/prices/providers/coingecko.test.ts
 *
 * CoinGecko BTC daily-close fetch — standalone tsx, mocked HTTP (no network).
 */

import { fetchBtcDailyClosesUsd, type CoinGeckoFetch, type CoinGeckoHttpResponse } from "./coingecko";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function ms(dateISO: string, hour = 0): number { return Date.parse(`${dateISO}T${String(hour).padStart(2, "0")}:00:00Z`); }
function fake(body: unknown, opts: { ok?: boolean; status?: number } = {}): { fn: CoinGeckoFetch; calls: string[] } {
  const calls: string[] = [];
  const fn: CoinGeckoFetch = async (url) => {
    calls.push(url);
    const res: CoinGeckoHttpResponse = { ok: opts.ok ?? true, status: opts.status ?? 200, json: async () => body };
    return res;
  };
  return { fn, calls };
}

async function main(): Promise<void> {
  const KEY = "demo-key";

  console.log("1. No key → dark no-op ([])");
  {
    const { fn, calls } = fake({ prices: [[ms("2026-06-01"), 60000]] });
    const out = await fetchBtcDailyClosesUsd("2026-06-01", "2026-06-03", { fetchImpl: fn }); // no apiKey
    check("returns [] and never calls the API", out.length === 0 && calls.length === 0);
  }

  console.log("2. Buckets hourly points to one close per UTC day (last point wins)");
  {
    const body = { prices: [
      [ms("2026-06-01", 1), 60000], [ms("2026-06-01", 23), 60500], // 06-01 close = 60500
      [ms("2026-06-02", 6), 61000], [ms("2026-06-02", 20), 61200], // 06-02 close = 61200
      [ms("2026-06-03", 0), 62000],                                 // 06-03 close = 62000
      [ms("2026-06-04", 0), 99999],                                 // outside window → dropped
    ] };
    const { fn, calls } = fake(body);
    const out = await fetchBtcDailyClosesUsd("2026-06-01", "2026-06-03", { apiKey: KEY, fetchImpl: fn });
    check("one row per day, in order", out.length === 3 && out[0].dateISO === "2026-06-01" && out[2].dateISO === "2026-06-03");
    check("last point of the day is the close", out[0].price === 60500 && out[1].price === 61200);
    check("out-of-window point dropped", !out.some((r) => r.dateISO === "2026-06-04"));
    check("demo key header, bitcoin coin id, usd", calls[0].includes("/coins/bitcoin/market_chart/range") && calls[0].includes("vs_currency=usd"));
  }

  console.log("3. Failures → [] (never throws)");
  {
    const { fn: rl } = fake({}, { ok: false, status: 429 });
    check("429 → []", (await fetchBtcDailyClosesUsd("2026-06-01", "2026-06-03", { apiKey: KEY, fetchImpl: rl })).length === 0);
    const net: CoinGeckoFetch = async () => { throw new Error("boom"); };
    check("network error → []", (await fetchBtcDailyClosesUsd("2026-06-01", "2026-06-03", { apiKey: KEY, fetchImpl: net })).length === 0);
    const { fn: bad } = fake({ nope: true });
    check("missing prices array → []", (await fetchBtcDailyClosesUsd("2026-06-01", "2026-06-03", { apiKey: KEY, fetchImpl: bad })).length === 0);
  }

  console.log("4. Drops non-positive / malformed points");
  {
    const body = { prices: [[ms("2026-06-01", 5), 0], [ms("2026-06-01", 23), 60000], [ms("2026-06-02", 5), -1]] };
    const { fn } = fake(body);
    const out = await fetchBtcDailyClosesUsd("2026-06-01", "2026-06-02", { apiKey: KEY, fetchImpl: fn });
    check("only the positive close survives", out.length === 1 && out[0].price === 60000);
  }

  console.log(failures === 0 ? "\nAll coingecko checks passed" : `\n${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
