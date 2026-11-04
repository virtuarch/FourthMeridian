/**
 * lib/crypto/btc-xpub-confirmed-balance.test.ts
 *
 * FM-AUDIT-053 (unconfirmed half) — an xpub balance is CONFIRMED-ONLY.
 *
 * `fetchXpubConfirmedSats` reads each ACTIVE address (multiaddr n_tx > 0)
 * from Esplora `chain_stats`, through the same `fetchConfirmedSats` a
 * single-address wallet uses, with bounded concurrency and a per-run request
 * budget. Anything short of a complete read is PARTIAL with no sum.
 *
 * Fake HTTP only — no network. Addresses are placeholders, not wallets.
 */

import {
  fetchXpubConfirmedSats,
  fetchConfirmedSats,
  XPUB_BALANCE_CONCURRENCY,
  XPUB_BALANCE_HARD_CAP,
  xpubBalanceRequestBudget,
  type AddrStat,
} from "@/lib/crypto/btc-explorer";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}

interface Entry { funded: number; spent: number; mFunded?: number; mSpent?: number }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** Fake Esplora: routes `/api/address/{a}` to a fixture, records calls + peak concurrency. */
function esplora(byAddr: Record<string, Entry>, opts: { delayMs?: number; failFor?: Set<string> } = {}) {
  const calls: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const f = (async (input: string) => {
    const a = decodeURIComponent(new URL(input).pathname.split("/").pop() ?? "");
    calls.push(a);
    inFlight++; peak = Math.max(peak, inFlight);
    try {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.failFor?.has(a)) return json({ error: "down" }, 500);
      const e = byAddr[a];
      if (!e) return json({ error: "unknown" }, 404);
      return json({
        chain_stats: { funded_txo_sum: e.funded, spent_txo_sum: e.spent, tx_count: 1 },
        mempool_stats: { funded_txo_sum: e.mFunded ?? 0, spent_txo_sum: e.mSpent ?? 0, tx_count: 0 },
      });
    } finally { inFlight--; }
  }) as unknown as typeof fetch;
  return { f, calls, peak: () => peak };
}
const statsOf = (m: Record<string, number>) => new Map<string, AddrStat>(Object.entries(m).map(([a, n]) => [a, { txCount: n }]));

async function main() {
  const savedRetries = process.env.BTC_RATE_LIMIT_RETRIES;
  process.env.BTC_RATE_LIMIT_RETRIES = "0";
  const savedBase = process.env.BTC_BALANCE_API_URL;
  process.env.BTC_BALANCE_API_URL = "https://esplora.test";

  check("constants: concurrency 3, per-wallet per-run hard cap 600",
    XPUB_BALANCE_CONCURRENCY === 3 && XPUB_BALANCE_HARD_CAP === 600);
  check("budget = min(ceil(used × 1.25) + 10, HARD_CAP)",
    xpubBalanceRequestBudget(0) === 10 && xpubBalanceRequestBudget(1) === 12 && xpubBalanceRequestBudget(200) === 260
      && xpubBalanceRequestBudget(472) === 600 && xpubBalanceRequestBudget(473) === 600 && xpubBalanceRequestBudget(10_000) === 600,
    [0, 1, 200, 472, 473, 10_000].map((n) => xpubBalanceRequestBudget(n)).join(","));

  // 1. A mempool-only receive is NOT counted.
  {
    const net = esplora({ a1: { funded: 0, spent: 0, mFunded: 70_000 }, a2: { funded: 50_000, spent: 0 } });
    const r = await fetchXpubConfirmedSats(["a1", "a2"], statsOf({ a1: 1, a2: 2 }), net.f);
    check("mempool-only receive is not counted (sum = confirmed only)",
      r.status === "OBSERVED" && r.sats === 50_000 && r.activeAddresses === 2, JSON.stringify(r));
  }

  // 2. A pending outgoing spend does not reduce the confirmed balance.
  {
    const net = esplora({ a1: { funded: 100_000, spent: 0, mSpent: 100_000 } });
    const r = await fetchXpubConfirmedSats(["a1"], statsOf({ a1: 2 }), net.f);
    check("pending outgoing spend does not reduce the confirmed balance", r.status === "OBSERVED" && r.sats === 100_000, JSON.stringify(r));
  }

  // 3. Parity with the single-address read on the same address.
  {
    const net = esplora({ a1: { funded: 123_456, spent: 23_456, mFunded: 9_999, mSpent: 1 } });
    const single = await fetchConfirmedSats("a1", net.f);
    const x = await fetchXpubConfirmedSats(["a1", "u1"], statsOf({ a1: 3, u1: 0 }), net.f);
    check("xpub and single-address agree on the same address", x.status === "OBSERVED" && x.sats === single && single === 100_000,
      `xpub=${JSON.stringify(x)} single=${single}`);
  }

  // 4. n_tx 0 addresses cost no request; an address with NO usage entry is read, not assumed 0.
  {
    const net = esplora({ a1: { funded: 10, spent: 0 }, a3: { funded: 5, spent: 0 } });
    const r = await fetchXpubConfirmedSats(["a1", "u1", "a3"], statsOf({ a1: 1, u1: 0 }), net.f);
    check("n_tx 0 ⇒ not requested; missing usage ⇒ read (never a structural 0)",
      r.status === "OBSERVED" && r.sats === 15 && !net.calls.includes("u1") && net.calls.includes("a3"), JSON.stringify({ r, calls: net.calls }));
  }

  // 5. Budget exhausted ⇒ PARTIAL, never a sum.
  {
    const fx: Record<string, Entry> = {};
    const st: Record<string, number> = {};
    for (let i = 0; i < 6; i++) { fx[`a${i}`] = { funded: 1_000, spent: 0 }; st[`a${i}`] = 1; }
    const net = esplora(fx);
    const r = await fetchXpubConfirmedSats(Object.keys(fx), statsOf(st), net.f, { requestBudget: 4, concurrency: 2 });
    check("budget exhausted ⇒ PARTIAL BUDGET_EXHAUSTED with no `sats`",
      r.status === "PARTIAL" && r.cause === "BUDGET_EXHAUSTED" && !("sats" in r) && r.addressesUnread > 0 && r.requests <= 4, JSON.stringify(r));
    check("budget: never more requests than the budget", net.calls.length <= 4, `calls=${net.calls.length}`);
    const zero = await fetchXpubConfirmedSats(["a0"], statsOf({ a0: 1 }), esplora(fx).f, { requestBudget: 0 });
    check("budget 0 with an active address ⇒ PARTIAL, not 0", zero.status === "PARTIAL" && !("sats" in zero), JSON.stringify(zero));
    const none = await fetchXpubConfirmedSats(["u1"], statsOf({ u1: 0 }), esplora({}).f, { requestBudget: 0 });
    check("no active addresses ⇒ an exact, OBSERVED 0 (proven unused, no request)", none.status === "OBSERVED" && none.sats === 0 && none.requests === 0, JSON.stringify(none));
  }

  // 6. An Esplora failure on one address ⇒ PARTIAL, not 0 and not the others' sum.
  {
    const net = esplora({ a1: { funded: 10_000, spent: 0 }, a2: { funded: 20_000, spent: 0 }, a3: { funded: 30_000, spent: 0 } }, { failFor: new Set(["a2"]) });
    const r = await fetchXpubConfirmedSats(["a1", "a2", "a3"], statsOf({ a1: 1, a2: 1, a3: 1 }), net.f, { concurrency: 1 });
    check("one address read failure ⇒ PARTIAL READ_FAILED, no sum, host-only reason",
      r.status === "PARTIAL" && r.cause === "READ_FAILED" && !("sats" in r) && r.reason === "HTTP 500 from esplora.test"
        && r.kind === "HTTP" && r.addressesUnread >= 1, JSON.stringify(r));
    check("after a failure no further addresses are scheduled (sequential: a3 never asked)", !net.calls.includes("a3"), net.calls.join(","));
    const garbled = await fetchXpubConfirmedSats(["a1"], statsOf({ a1: 1 }), (async () => json({})) as unknown as typeof fetch);
    check("a garbled Esplora response ⇒ PARTIAL, not 0", garbled.status === "PARTIAL" && garbled.cause === "READ_FAILED", JSON.stringify(garbled));
    const thrower = await fetchXpubConfirmedSats(["a1"], statsOf({ a1: 1 }), undefined, { readAddress: async () => { throw new Error("boom at a1"); } });
    check("a non-provider error text is reduced to its class (an address can never leak through it)",
      thrower.status === "PARTIAL" && !thrower.reason.includes("a1"), JSON.stringify(thrower));
  }

  // 8. SCALED BUDGET — a large wallet reads in full; over the cap is PARTIAL by name.
  {
    const fx: Record<string, Entry> = {};
    const st: Record<string, number> = {};
    for (let i = 0; i < 200; i++) { fx[`a${i}`] = { funded: 1_000 + i, spent: 0 }; st[`a${i}`] = 1; }
    const net = esplora(fx);
    const r = await fetchXpubConfirmedSats(Object.keys(fx), statsOf(st), net.f);
    const expected = Array.from({ length: 200 }, (_, i) => 1_000 + i).reduce((a, b) => a + b, 0);
    check("200 used addresses ⇒ a FULL confirmed balance (no PARTIAL from a fixed budget)",
      r.status === "OBSERVED" && r.sats === expected && r.activeAddresses === 200 && net.calls.length === 200, JSON.stringify({ ...r, calls: net.calls.length }));

    const big: Record<string, number> = {};
    for (let i = 0; i < XPUB_BALANCE_HARD_CAP + 1; i++) big[`b${i}`] = 1;
    const net2 = esplora({});
    const over = await fetchXpubConfirmedSats(Object.keys(big), statsOf(big), net2.f);
    check("above the hard cap ⇒ PARTIAL OVER_READ_CAP, cause names the COUNT, no request, no sum",
      over.status === "PARTIAL" && over.cause === "OVER_READ_CAP" && !("sats" in over)
        && over.reason === `wallet exceeds the per-run read cap (${XPUB_BALANCE_HARD_CAP + 1} used addresses)`
        && net2.calls.length === 0 && !/b\d/.test(over.reason), JSON.stringify(over));
    const atCap: Record<string, number> = {};
    for (let i = 0; i < XPUB_BALANCE_HARD_CAP; i++) atCap[`c${i}`] = 1;
    const fxCap: Record<string, Entry> = Object.fromEntries(Object.keys(atCap).map((a) => [a, { funded: 1, spent: 0 }]));
    const exact = await fetchXpubConfirmedSats(Object.keys(atCap), statsOf(atCap), esplora(fxCap).f);
    check("exactly at the hard cap with no retries ⇒ still OBSERVED", exact.status === "OBSERVED" && exact.sats === XPUB_BALANCE_HARD_CAP, JSON.stringify({ ...exact }));
  }
  {
    // The budget follows the DISCOVERED (used) count, not the scan size: 4 used
    // of 1,000 known ⇒ budget 15. A reader needing 5 requests per address (429
    // retries) needs 20 — exhausted at 15. Sized by the scan, it would have fit.
    const st: Record<string, number> = {};
    for (let i = 0; i < 1_000; i++) st[`s${i}`] = i < 4 ? 2 : 0;
    let attempts = 0;
    const retrying = async (_a: string, before: () => Promise<void>) => { for (let k = 0; k < 5; k++) { await before(); attempts++; } return 1; };
    const r = await fetchXpubConfirmedSats(Object.keys(st), statsOf(st), undefined, { readAddress: retrying });
    check("budget scales with the used count (4 ⇒ 15), not the 1,000-address scan",
      r.status === "PARTIAL" && r.cause === "BUDGET_EXHAUSTED" && r.activeAddresses === 4 && r.requests === 15 && attempts === 15, JSON.stringify(r));
    const ok = await fetchXpubConfirmedSats(Object.keys(st), statsOf(st), undefined, { readAddress: async (_a, before) => { await before(); await before(); return 1; } });
    check("…and 2 attempts per address (8 ≤ 15) completes", ok.status === "OBSERVED" && ok.sats === 4 && ok.requests === 8, JSON.stringify(ok));
  }

  // 7. Concurrency stays within the bound.
  {
    const fx: Record<string, Entry> = {};
    const st: Record<string, number> = {};
    for (let i = 0; i < 12; i++) { fx[`a${i}`] = { funded: 1, spent: 0 }; st[`a${i}`] = 1; }
    const net = esplora(fx, { delayMs: 5 });
    const r = await fetchXpubConfirmedSats(Object.keys(fx), statsOf(st), net.f);
    check(`concurrency: peak in-flight ≤ ${XPUB_BALANCE_CONCURRENCY} (default), and it IS concurrent`,
      r.status === "OBSERVED" && r.sats === 12 && net.peak() <= XPUB_BALANCE_CONCURRENCY && net.peak() > 1, `peak=${net.peak()}`);
    const net2 = esplora(fx, { delayMs: 5 });
    await fetchXpubConfirmedSats(Object.keys(fx), statsOf(st), net2.f, { concurrency: 2 });
    check("concurrency: an explicit bound of 2 is honoured", net2.peak() <= 2, `peak=${net2.peak()}`);
  }

  if (savedRetries === undefined) delete process.env.BTC_RATE_LIMIT_RETRIES; else process.env.BTC_RATE_LIMIT_RETRIES = savedRetries;
  if (savedBase === undefined) delete process.env.BTC_BALANCE_API_URL; else process.env.BTC_BALANCE_API_URL = savedBase;

  console.log(`btc-xpub-confirmed-balance: ${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
