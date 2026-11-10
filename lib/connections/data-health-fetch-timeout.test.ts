/**
 * lib/connections/data-health-fetch-timeout.test.ts   (B13)
 *
 *     npx tsx --require ./scripts/lib/server-only-preload.cjs lib/connections/data-health-fetch-timeout.test.ts
 *
 * The client's data-health read (`loadPayload`) is what the Net Worth / Debt
 * charts HOLD on (balanceChartPending) until the balance coverage resolves. It
 * had no client timeout, so a stalled request held the chart forever. It now
 * carries AbortSignal.timeout(DATA_HEALTH_FETCH_TIMEOUT_MS); a timed-out read
 * falls to the existing FAILED path (FAILED_DATA_HEALTH ⇒ coverage
 * UNAVAILABLE), so the hold ends and the chart renders UNCLIPPED, exactly as
 * for any failed read. Synthetic fixtures only; `fetch` is stubbed.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DATA_HEALTH_FETCH_TIMEOUT_MS, FAILED_DATA_HEALTH, balanceCoverageState, loadPayload,
} from "@/components/space/PerspectiveEmptyState";
import {
  BALANCE_COVERAGE_LOADING, BALANCE_COVERAGE_UNAVAILABLE, balanceChartPending, balanceCoverageSidesFor, clipToBalanceCoverage,
  type BalanceCoverage,
} from "./balance-coverage.core";

const checks: string[] = [];
const ok = (label: string) => checks.push(label);

// The 30 s memo-eviction timer in loadPayload must not keep this process alive.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
  const t = realSetTimeout(fn, ms, ...rest);
  (t as unknown as { unref?: () => void }).unref?.();
  return t;
}) as typeof setTimeout;

// console.warn is the counts-only failure line; capture instead of printing.
const warns: string[] = [];
const realWarn = console.warn;
console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };

const realFetch = globalThis.fetch;
let seenSignal: AbortSignal | undefined;
/** A request that never answers — it only ends when its signal aborts (as a real fetch does). */
const stalledFetch = ((_url: string, init?: RequestInit) => {
  seenSignal = init?.signal ?? undefined;
  return new Promise<Response>((_resolve, reject) => {
    const s = init?.signal;
    if (!s) return; // no signal ⇒ stalls forever (the pre-B13 behaviour)
    s.addEventListener("abort", () => reject(s.reason), { once: true });
  });
}) as typeof fetch;

const SIDES = balanceCoverageSidesFor("netWorth");
// A day-one-shaped series: the floor is the last day, so a KNOWN coverage would clip to one point.
const POINTS = [{ date: "2026-10-04", v: 1 }, { date: "2026-10-20", v: 2 }, { date: "2026-11-03", v: 3 }];
const COV: BalanceCoverage = { liabilityFloors: ["2026-11-03"], assetFloors: ["2026-11-03"], estimatedLiabilityFloors: [] };

async function main() {
  // ── §1 the constant + wiring ─────────────────────────────────────────────────
  {
    assert.equal(DATA_HEALTH_FETCH_TIMEOUT_MS, 15_000, "15 s, consistent with the repo's other per-request read timeouts");
    const pes = readFileSync(new URL("../../components/space/PerspectiveEmptyState.tsx", import.meta.url), "utf8");
    assert.ok(/typeof AbortSignal !== "undefined" && typeof AbortSignal\.timeout === "function"/.test(pes), "AbortSignal.timeout is feature-detected");
    assert.ok(/const t = dataHealthTimeout\(timeoutMs\);/.test(pes) && /\.\.\.\(t\.signal \? \{ signal: t\.signal \} : \{\}\)/.test(pes), "the read carries the timeout signal");
    assert.ok(/p = Promise\.resolve\(\)\s*\.then\(\(\) => \{\s*const t = dataHealthTimeout/.test(pes), "signal + fetch are built INSIDE the chain (no synchronous throw)");
    assert.ok(/\.finally\(\(\) => clear\(\)\)/.test(pes), "the fallback timer is cleared when the read settles");
    assert.ok(/timeoutMs: number = DATA_HEALTH_FETCH_TIMEOUT_MS/.test(pes), "the default is the constant");
    assert.ok(/void loadPayload\(spaceId\)\.then/.test(pes), "the hook uses the default timeout");
    ok("§1 loadPayload carries AbortSignal.timeout(DATA_HEALTH_FETCH_TIMEOUT_MS = 15 s)");
  }

  // ── §2 a stalled read times out ⇒ FAILED ⇒ the hold ends, unclipped ───────────
  {
    globalThis.fetch = stalledFetch;
    const started = Date.now();
    // Node's AbortSignal.timeout timer is unref'd: keep the loop alive while it runs.
    const keepAlive = realSetTimeout(() => {}, 10_000);
    const payload = await loadPayload("space-timeout-a", 25);
    clearTimeout(keepAlive);
    assert.ok(seenSignal instanceof AbortSignal, "the fetch received an AbortSignal");
    assert.equal(seenSignal!.aborted, true, "…which fired");
    assert.ok(Date.now() - started < 5_000, "the read settled on the timeout, not never");
    assert.equal(payload, FAILED_DATA_HEALTH, "an aborted fetch resolves to FAILED_DATA_HEALTH");
    assert.ok(warns.some((w) => /client-data-health/.test(w)), "the counts-only failure line is logged");

    const cov = balanceCoverageState("space-timeout-a", payload);
    assert.equal(cov, BALANCE_COVERAGE_UNAVAILABLE, "coverage is UNAVAILABLE (failed), never null / loading");
    assert.equal(balanceChartPending(BALANCE_COVERAGE_LOADING, SIDES, false), true, "before it settles, the chart holds…");
    assert.equal(balanceChartPending(cov, SIDES, false), false, "…after the timeout, the hold ends");
    assert.deepEqual(clipToBalanceCoverage(POINTS, cov, SIDES, false), POINTS, "the chart renders unclipped, as for failure");
    assert.equal(clipToBalanceCoverage(POINTS, COV, SIDES, false).length, 1, "(a resolved coverage would have clipped it)");
    ok("§2 stalled read ⇒ timeout ⇒ FAILED_DATA_HEALTH ⇒ UNAVAILABLE ⇒ hold ends, chart unclipped");
  }

  // ── §3 a healthy read inside the timeout is unchanged ─────────────────────────
  {
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seenSignal = init?.signal ?? undefined;
      return new Response(JSON.stringify({ sources: [], valuationCoverage: null, balanceCoverage: COV }), { status: 200 });
    }) as typeof fetch;
    const payload = await loadPayload("space-timeout-b", 1_000);
    assert.ok(seenSignal instanceof AbortSignal && !seenSignal.aborted, "the signal is present but never fires on a healthy read");
    assert.deepEqual(payload, { sources: [], valuationCoverage: null, balanceCoverage: COV }, "the payload is untouched");
    ok("§3 healthy read: payload unchanged; the timeout never fires");
  }

  // ── §4 R1 — no AbortSignal.timeout (Safari < 16 / older iOS WebViews) ─────────
  {
    const realTimeout = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
    Object.defineProperty(AbortSignal, "timeout", { value: undefined, configurable: true, writable: true });
    try {
      assert.equal(typeof AbortSignal.timeout, "undefined", "stubbed: AbortSignal.timeout is missing");

      // a) healthy read ⇒ OK, via the AbortController fallback (signal present, never fired)
      globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        seenSignal = init?.signal ?? undefined;
        return new Response(JSON.stringify({ sources: [], valuationCoverage: null, balanceCoverage: COV }), { status: 200 });
      }) as typeof fetch;
      const healthy = await loadPayload("space-fallback-ok", 1_000);
      assert.deepEqual(healthy, { sources: [], valuationCoverage: null, balanceCoverage: COV }, "healthy read ⇒ OK without AbortSignal.timeout");
      assert.ok(seenSignal instanceof AbortSignal && !seenSignal.aborted, "the fallback controller's signal rides the fetch, unfired");

      // b) stalled read ⇒ FAILED, via the fallback timer
      globalThis.fetch = stalledFetch;
      const keepAlive = realSetTimeout(() => {}, 10_000);
      const started = Date.now();
      const stalled = await loadPayload("space-fallback-stall", 25);
      clearTimeout(keepAlive);
      assert.ok(seenSignal instanceof AbortSignal && seenSignal.aborted, "the fallback timer aborted the controller");
      assert.ok(Date.now() - started < 5_000, "settled on the fallback timer");
      assert.equal(stalled, FAILED_DATA_HEALTH, "stalled read ⇒ FAILED_DATA_HEALTH via the fallback");
      assert.equal(balanceChartPending(balanceCoverageState("space-fallback-stall", stalled), SIDES, false), false, "the hold ends");

      // c) a synchronous throw while building the request ⇒ FAILED, never a synchronous throw
      const realAC = globalThis.AbortController;
      globalThis.AbortController = function Broken() { throw new TypeError("AbortController is not a constructor"); } as unknown as typeof AbortController;
      globalThis.fetch = (() => { throw new TypeError("fetch threw synchronously"); }) as unknown as typeof fetch;
      let p: Promise<unknown> | undefined;
      try {
        assert.doesNotThrow(() => { p = loadPayload("space-fallback-throw", 25); }, "loadPayload never throws synchronously");
        assert.equal(await p, FAILED_DATA_HEALTH, "a synchronous throw during construction ⇒ FAILED_DATA_HEALTH");
      } finally {
        globalThis.AbortController = realAC;
      }
      // …and a fetch that throws synchronously with no AbortController at all (no signal path).
      const noAC = globalThis.AbortController;
      // @ts-expect-error — simulate an environment without AbortController
      delete globalThis.AbortController;
      try {
        let q: Promise<unknown> | undefined;
        assert.doesNotThrow(() => { q = loadPayload("space-fallback-nosignal", 25); });
        assert.equal(await q, FAILED_DATA_HEALTH, "no AbortController ⇒ no signal; a throwing fetch still ⇒ FAILED");
      } finally {
        globalThis.AbortController = noAC;
      }
    } finally {
      if (realTimeout) Object.defineProperty(AbortSignal, "timeout", realTimeout);
    }
    assert.equal(typeof AbortSignal.timeout, "function", "restored");
    ok("§4 without AbortSignal.timeout: healthy ⇒ OK, stalled ⇒ FAILED via fallback timer, synchronous throw ⇒ FAILED (never thrown)");
  }
}

main()
  .then(() => {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
    for (const c of checks) console.log(`  ✓ ${c}`);
    console.log(`data-health-fetch-timeout: ${checks.length} checks passed`);
  })
  .catch((e) => { console.warn = realWarn; console.error(e); process.exitCode = 1; });
