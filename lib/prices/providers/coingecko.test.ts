/**
 * lib/prices/providers/coingecko.test.ts
 *
 * CoinGecko BTC daily-close fetch — standalone tsx, mocked HTTP (no network).
 */

import { fetchCoinDailyClosesUsd, effectiveRequestFromISO, type CoinGeckoFetch, type CoinGeckoHttpResponse } from "./coingecko";
import {
  createCoinGeckoPriceProvider,
  resolveCoinGeckoFloorISO,
  resolveCoinGeckoHistoryDays,
  COINGECKO_DATASET_START,
  COINGECKO_DEFAULT_HISTORY_DAYS,
} from "./coingecko";
import { PriceBasis } from "@prisma/client";
import { ProviderFetchError, RETRYABLE_OUTCOMES } from "../provider-errors";

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
  /** True when `fn` throws a ProviderFetchError carrying `code`. */
async function throwsWithCode(fn: () => Promise<unknown>, code: string): Promise<boolean> {
  try { await fn(); return false; }
  catch (e) { return e instanceof ProviderFetchError && e.code === code; }
}

const KEY = "demo-key";

  console.log("1. No key → dark no-op ([])");
  {
    const { fn, calls } = fake({ prices: [[ms("2026-06-01"), 60000]] });
    const out = await fetchCoinDailyClosesUsd("bitcoin", "2026-06-01", "2026-06-03", { fetchImpl: fn }); // no apiKey
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
    const out = await fetchCoinDailyClosesUsd("bitcoin", "2026-06-01", "2026-06-03", { apiKey: KEY, fetchImpl: fn });
    check("one row per day, in order", out.length === 3 && out[0].dateISO === "2026-06-01" && out[2].dateISO === "2026-06-03");
    check("last point of the day is the close", out[0].price === 60500 && out[1].price === 61200);
    check("out-of-window point dropped", !out.some((r) => r.dateISO === "2026-06-04"));
    check("demo key header, bitcoin coin id, usd", calls[0].includes("/coins/bitcoin/market_chart/range") && calls[0].includes("vs_currency=usd"));
  }

  console.log("3. Failures → [] (never throws)");
  {
    const { fn: rl } = fake({}, { ok: false, status: 429 });
    check("429 → THROTTLED (never a silent [], which looked like completeness)",
      await throwsWithCode(() => fetchCoinDailyClosesUsd("bitcoin", "2026-06-01", "2026-06-03", { apiKey: KEY, fetchImpl: rl }), "THROTTLED"));
    const net: CoinGeckoFetch = async () => { throw new Error("boom"); };
    check("network error → PROVIDER_ERROR",
      await throwsWithCode(() => fetchCoinDailyClosesUsd("bitcoin", "2026-06-01", "2026-06-03", { apiKey: KEY, fetchImpl: net }), "PROVIDER_ERROR"));
    const { fn: bad } = fake({ nope: true });
    check("missing prices array → [] (a shaped response with nothing in it)",
      (await fetchCoinDailyClosesUsd("bitcoin", "2026-06-01", "2026-06-03", { apiKey: KEY, fetchImpl: bad })).length === 0);
  }

  console.log("4. Drops non-positive / malformed points");
  {
    const body = { prices: [[ms("2026-06-01", 5), 0], [ms("2026-06-01", 23), 60000], [ms("2026-06-02", 5), -1]] };
    const { fn } = fake(body);
    const out = await fetchCoinDailyClosesUsd("bitcoin", "2026-06-01", "2026-06-02", { apiKey: KEY, fetchImpl: fn });
    check("only the positive close survives", out.length === 1 && out[0].price === 60000);
  }

  // ── 5. Deployment capability floor (V26-PRICE-4C) ─────────────────────────
  console.log("5. deployment capability floor");
  {
    // INCLUSIVE SEMANTICS, pinned on both sides. With a 365-day window and a UTC
    // today of 2026-07-31 the floor is 2025-07-31, and that date IS servable —
    // 2025-07-31 + 365 days = 2026-07-31 exactly.
    const floor = resolveCoinGeckoFloorISO("2026-07-31", 365);
    check("floor is exactly historyDays before today", floor === "2025-07-31", floor);
    check("the floor date itself is servable (no off-by-one below)",
      resolveCoinGeckoFloorISO("2026-07-31", 365) <= "2025-07-31");
    check("the day before the floor is NOT servable", "2025-07-30" < floor);
    check("a 364-day window moves the floor one day later",
      resolveCoinGeckoFloorISO("2026-07-31", 364) === "2025-08-01");
    check("a 366-day window moves it one day earlier",
      resolveCoinGeckoFloorISO("2026-07-31", 366) === "2025-07-30");
    check("leap-year arithmetic is UTC date math, not 365×86400s",
      resolveCoinGeckoFloorISO("2025-03-01", 366) === "2024-02-29");

    // Clamped at the dataset start — a huge window cannot claim data that never existed.
    check("a very large window clamps to the dataset start",
      resolveCoinGeckoFloorISO("2026-07-31", 100_000) === COINGECKO_DATASET_START);
    check("…and the clamp is exactly the dataset start", COINGECKO_DATASET_START === "2013-04-28");
  }

  // ── 6. Configuration ──────────────────────────────────────────────────────
  console.log("6. COINGECKO_HISTORY_DAYS validation");
  {
    check("absent → the Demo default", resolveCoinGeckoHistoryDays(undefined) === 365);
    check("blank → the Demo default", resolveCoinGeckoHistoryDays("  ") === 365);
    check("the default is the MOST RESTRICTIVE tier, never inferred from a key",
      COINGECKO_DEFAULT_HISTORY_DAYS === 365);
    check("a valid value is honoured", resolveCoinGeckoHistoryDays("1825") === 1825);
    for (const bad of ["0", "-1", "1.5", "abc", "365x", "1e3"]) {
      let threw = false;
      try { resolveCoinGeckoHistoryDays(bad); } catch { threw = true; }
      check(`"${bad}" is rejected, never silently defaulted`, threw);
    }
  }

  // ── 7. Failure taxonomy (V26-PRICE-4C) ────────────────────────────────────
  console.log("7. 401 taxonomy — capability limit vs credential fault");
  {
    const unauthorised: CoinGeckoFetch = async () => ({ ok: false, status: 401, async json() { return {}; } });
    const adapter = createCoinGeckoPriceProvider("k", {
      fetchImpl: unauthorised, now: new Date("2026-07-31T00:00:00Z"),
    });
    check("the adapter advertises the deployment floor, not the dataset start",
      adapter.historicalDepth === "2025-07-31", adapter.historicalDepth);

    const req = (fromISO: string, toISO: string) => ({
      instrumentId: "inst_btc", assetClass: "CRYPTO", providerSymbol: "BTC",
      basis: PriceBasis.RAW_CLOSE, fromISO, toISO,
    });

    // BELOW the floor → capability limit, permanent until the tier changes.
    let code: string | null = null;
    try { await adapter.fetchDailyCloses(req("2024-01-01", "2024-06-01")); }
    catch (e) { code = e instanceof ProviderFetchError ? e.code : "other"; }
    check("a 401 below the floor is PROVIDER_LIMIT", code === "PROVIDER_LIMIT", String(code));
    check("…and PROVIDER_LIMIT is NOT retryable", !RETRYABLE_OUTCOMES.has("PROVIDER_LIMIT"));

    // WITHIN the floor → credential fault, retryable.
    code = null;
    try { await adapter.fetchDailyCloses(req("2026-06-01", "2026-07-01")); }
    catch (e) { code = e instanceof ProviderFetchError ? e.code : "other"; }
    check("a 401 within the floor is PROVIDER_ERROR (credentials, not capability)",
      code === "PROVIDER_ERROR", String(code));
    check("…and PROVIDER_ERROR remains retryable", RETRYABLE_OUTCOMES.has("PROVIDER_ERROR"));

    // A 429 stays throttling regardless of position.
    const throttled = createCoinGeckoPriceProvider("k", {
      fetchImpl: async () => ({ ok: false, status: 429, async json() { return {}; } }),
      now: new Date("2026-07-31T00:00:00Z"),
    });
    code = null;
    try { await throttled.fetchDailyCloses(req("2024-01-01", "2024-06-01")); }
    catch (e) { code = e instanceof ProviderFetchError ? e.code : "other"; }
    check("a 429 below the floor is still THROTTLED, not PROVIDER_LIMIT", code === "THROTTLED");
  }

  // ── 8. Determinism under an injected clock ────────────────────────────────
  console.log("8. determinism");
  {
    const mk = () => createCoinGeckoPriceProvider("k", {
      fetchImpl: async () => ({ ok: true, status: 200, async json() { return { prices: [] }; } }),
      now: new Date("2026-07-31T00:00:00Z"), historyDays: 365,
    });
    check("identical clock + window → identical capability",
      mk().historicalDepth === mk().historicalDepth && mk().historicalDepth === "2025-07-31");
    const tomorrow = createCoinGeckoPriceProvider("k", {
      fetchImpl: async () => ({ ok: true, status: 200, async json() { return { prices: [] }; } }),
      now: new Date("2026-08-01T00:00:00Z"), historyDays: 365,
    });
    check("the floor MOVES with the calendar (a rolling window, by design)",
      tomorrow.historicalDepth === "2025-08-01");
    check("an explicit historicalDepth override still wins (test/back-compat seam)",
      createCoinGeckoPriceProvider("k", { historicalDepth: "2020-01-01" }).historicalDepth === "2020-01-01");
  }

  // ── V26-PRICE-4D — the lower request bound never crosses the capability floor ──
  //
  // The padding exists so the first requested day is covered; it must not buy that
  // coverage by asking for a day the tier refuses, because CoinGecko rejects the
  // WHOLE window (401 / error_code 10012) rather than trimming it.
  {
    console.log("\nV26-PRICE-4D — lower-bound clamp");
    const FLOOR = "2025-08-03";

    // A — planned start EQUALS the floor: padding must not cross below it.
    check("A. planned == floor → request starts AT the floor, not a day earlier",
      effectiveRequestFromISO(FLOOR, FLOOR) === FLOOR,
      effectiveRequestFromISO(FLOOR, FLOOR));

    // B — planned start is ONE day after the floor: the pad may land exactly on it.
    check("B. planned == floor + 1 → padded start may equal the floor",
      effectiveRequestFromISO("2025-08-04", FLOOR) === "2025-08-03",
      effectiveRequestFromISO("2025-08-04", FLOOR));

    // C — well after the floor: the existing one-day padding is untouched.
    check("C. planned well after floor → one-day padding preserved",
      effectiveRequestFromISO("2026-01-01", FLOOR) === "2025-12-31",
      effectiveRequestFromISO("2026-01-01", FLOOR));

    // D — no declared floor is an ALLOWED adapter state (deploymentFloorISO is
    // optional by contract), so behaviour there is deliberately unchanged.
    check("D. absent floor → existing unclamped padding preserved",
      effectiveRequestFromISO("2025-08-03", undefined) === "2025-08-02",
      effectiveRequestFromISO("2025-08-03", undefined));

    // A planned start BELOW the floor should not be reachable (the planner clamps),
    // but if it ever were, the adapter must still not request below capability.
    check("planned below floor → still clamped to the floor",
      effectiveRequestFromISO("2025-06-01", FLOOR) === FLOOR);

    // E — UTC date-boundary safety: month, year and leap-day rollovers.
    check("E. month rollover is UTC-exact", effectiveRequestFromISO("2026-03-01", "2020-01-01") === "2026-02-28");
    check("E. leap-day rollover is UTC-exact", effectiveRequestFromISO("2024-03-01", "2020-01-01") === "2024-02-29");
    check("E. year rollover is UTC-exact", effectiveRequestFromISO("2026-01-01", "2020-01-01") === "2025-12-31");

    // F — THE EXACT INCIDENT. Floor 2025-08-03, planned 2025-08-03..2026-03-22.
    // The URL must carry the floor's midnight UTC epoch, never the day before.
    {
      const { fn, calls } = fake({ prices: [[ms("2026-01-01", 23), 70000]] });
      await fetchCoinDailyClosesUsd("bitcoin", FLOOR, "2026-03-22", {
        apiKey: "k", fetchImpl: fn, deploymentFloorISO: FLOOR,
      });
      const from = Number(new URL(calls[0]).searchParams.get("from"));
      check("F. incident window requests from 2025-08-03T00:00:00Z",
        from === Date.parse("2025-08-03T00:00:00Z") / 1000, String(from));
      check("F. incident window never requests 2025-08-02",
        from !== Date.parse("2025-08-02T00:00:00Z") / 1000);
    }

    // The upper bound was checked for the same defect and has none: it is not
    // padded at all, so it cannot overshoot capability. Pinned so it stays that way.
    {
      const { fn, calls } = fake({ prices: [] });
      await fetchCoinDailyClosesUsd("bitcoin", "2026-01-01", "2026-03-22", {
        apiKey: "k", fetchImpl: fn, deploymentFloorISO: FLOOR,
      });
      const to = Number(new URL(calls[0]).searchParams.get("to"));
      check("upper bound is unpadded (no equivalent defect)",
        to === Date.parse("2026-03-22T23:59:59Z") / 1000, String(to));
    }

    // G — response parsing is unchanged: points are still filtered against the
    // PLANNED from, so a clamped-or-padded request never leaks an extra day.
    {
      const { fn } = fake({ prices: [
        [ms("2025-12-31", 23), 111], // inside the PAD, outside the planned window
        [ms("2026-01-01", 23), 222],
        [ms("2026-01-02", 23), 333],
      ] });
      const out = await fetchCoinDailyClosesUsd("bitcoin", "2026-01-01", "2026-01-02", {
        apiKey: "k", fetchImpl: fn, deploymentFloorISO: FLOOR,
      });
      check("G. padded day is still excluded from results",
        out.length === 2 && out[0].dateISO === "2026-01-01" && out[1].dateISO === "2026-01-02",
        JSON.stringify(out.map((r) => r.dateISO)));
      check("G. close selection unchanged", out[0].price === 222 && out[1].price === 333);
    }
  }

  console.log(failures === 0 ? "\nAll coingecko checks passed" : `\n${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
