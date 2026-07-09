/**
 * lib/money/fx-freshness.test.ts
 *
 * Pure guards for the opportunistic FX stale-while-revalidate gate. Standalone
 * tsx script (house pattern): npx tsx lib/money/fx-freshness.test.ts — exits 0/1.
 * Auto-discovered by scripts/run-tests.ts.
 *
 * NO LIVE DATABASE / NO NETWORK / NO TIMERS: revalidateFxIfStale takes an
 * injected gate (two archive probes + a trigger), and shouldTrigger is a pure
 * clock function, so nothing here touches Prisma or wall-clock time. Covers:
 * fresh short-circuit · stale-with-cache triggers exactly one refresh · cold
 * archive never triggers (bootstrap owns it) · clock injection selects the
 * newest closed day · probe order (fresh checked before cache) · the in-process
 * throttle (suppress within window, fire after, timestamp advance).
 */

import {
  revalidateFxIfStale,
  shouldTrigger,
  type FxFreshnessGate,
} from "@/lib/money/fx-freshness";
import { yesterdayUTCISO } from "@/lib/fx/config";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Build a gate over fixed probe answers, recording calls. */
function makeGate(opts: {
  freshDays?: Set<string>; // ISO dates the archive has rows for
  hasCache?: boolean;
  now?: Date;
}) {
  const calls = { hasFreshDay: [] as string[], hasAnyCached: 0, triggers: 0 };
  const gate: FxFreshnessGate = {
    now: opts.now,
    async hasFreshDay(freshISO) {
      calls.hasFreshDay.push(freshISO);
      return (opts.freshDays ?? new Set()).has(freshISO);
    },
    async hasAnyCached() {
      calls.hasAnyCached++;
      return opts.hasCache ?? false;
    },
    triggerRefresh() {
      calls.triggers++;
    },
  };
  return { gate, calls };
}

async function main(): Promise<void> {
  console.log("fx-freshness (SWR gate)");
  const NOW = new Date("2026-07-10T09:00:00Z");
  const FRESH = yesterdayUTCISO(NOW); // 2026-07-09

  // ── 1. Fresh newest closed day → short-circuit, no cache probe, no trigger ─
  {
    const { gate, calls } = makeGate({ freshDays: new Set([FRESH]), hasCache: true, now: NOW });
    const outcome = await revalidateFxIfStale(gate);
    check("fresh archive returns \"fresh\"", outcome === "fresh");
    check("fresh path never triggers a refresh", calls.triggers === 0);
    check("fresh path short-circuits before the cache probe", calls.hasAnyCached === 0);
    check("freshness probe asks for the newest closed day (yesterday UTC)",
      calls.hasFreshDay.length === 1 && calls.hasFreshDay[0] === FRESH, calls.hasFreshDay.join());
  }

  // ── 2. Stale but cached → serve stale, trigger exactly one refresh ────────
  {
    const { gate, calls } = makeGate({ freshDays: new Set(), hasCache: true, now: NOW });
    const outcome = await revalidateFxIfStale(gate);
    check("stale-with-cache returns \"revalidating\"", outcome === "revalidating");
    check("stale-with-cache triggers exactly one background refresh", calls.triggers === 1);
    check("stale path probes fresh THEN cache (serve-stale order)",
      calls.hasFreshDay.length === 1 && calls.hasAnyCached === 1);
  }

  // ── 3. Cold archive (no rows at all) → no trigger; bootstrap owns it ──────
  {
    const { gate, calls } = makeGate({ freshDays: new Set(), hasCache: false, now: NOW });
    const outcome = await revalidateFxIfStale(gate);
    check("cold archive returns \"cold\"", outcome === "cold");
    check("cold archive NEVER triggers a refresh (no stale data to serve)", calls.triggers === 0);
    check("cold archive still ran both probes", calls.hasFreshDay.length === 1 && calls.hasAnyCached === 1);
  }

  // ── 4. Clock injection selects the correct newest closed day ──────────────
  {
    const otherNow = new Date("2026-01-01T00:30:00Z");
    const { gate, calls } = makeGate({ freshDays: new Set(), hasCache: true, now: otherNow });
    await revalidateFxIfStale(gate);
    check("injected clock drives the fresh-day probe (2025-12-31)",
      calls.hasFreshDay[0] === yesterdayUTCISO(otherNow) && calls.hasFreshDay[0] === "2025-12-31",
      calls.hasFreshDay[0]);
  }

  // ── 5. Pure throttle: suppress within window, fire after, advance stamp ───
  {
    const WINDOW = 30 * 60 * 1000;
    const T0 = 2_000_000; // ≥ WINDOW past the epoch stamp (0), so the first call fires
    const first = shouldTrigger(0, T0, WINDOW);
    check("first call fires and remembers now", first.fire === true && first.lastAtMs === T0);

    const within = shouldTrigger(first.lastAtMs, first.lastAtMs + WINDOW - 1, WINDOW);
    check("a call inside the window is suppressed", within.fire === false && within.lastAtMs === first.lastAtMs);

    const after = shouldTrigger(first.lastAtMs, first.lastAtMs + WINDOW, WINDOW);
    check("a call at/after the window fires and advances the stamp",
      after.fire === true && after.lastAtMs === first.lastAtMs + WINDOW);
  }

  if (failures > 0) {
    console.error(`\nfx-freshness tests: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("\nfx-freshness tests: all passed");
  process.exit(0);
}

main().catch((err) => {
  console.error("  ✗ test harness error:", err);
  process.exit(1);
});
