/**
 * lib/fx/registry.test.ts
 *
 * MC1 Phase 1 Slice 2 — registry tests (pure, no DB, no network). House-style
 * standalone tsx script, auto-discovered by scripts/run-tests.ts. Fake
 * adapters only — no real providers exist until Slice 3.
 */

import { createFxRegistry, defaultFxRegistry } from "./registry";
import type { FxProviderAdapter, RateResult } from "./types";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

function fakeAdapter(source: string): FxProviderAdapter {
  return {
    source,
    historicalDepth: "2000-01-01",
    supportedQuotes: (qs) => [...qs],
    fetchDailyRates: async (): Promise<RateResult[]> => [],
  };
}

// ordered providers: priority order preserved exactly
const a = fakeAdapter("primary");
const b = fakeAdapter("secondary");
const c = fakeAdapter("tertiary");
const reg = createFxRegistry([a, b, c]);
check("ordering: priority order preserved", reg.adapters[0] === a && reg.adapters[1] === b && reg.adapters[2] === c);
check("ordering: length exact", reg.adapters.length === 3);

// dependency injection: the registry is whatever the caller supplies
check("DI: injected fakes are returned as-is", createFxRegistry([b]).adapters[0].source === "secondary");

// immutability: registry list is frozen (fetch walk can never reorder failover)
check("immutability: adapter list frozen", Object.isFrozen(reg.adapters));

// duplicate source = programmer error (provenance stamping requires unique sources)
let threw = false;
try { createFxRegistry([a, fakeAdapter("primary")]); } catch { threw = true; }
check("duplicate source throws", threw);

// Slice 3 state: production registry wires the two approved providers.
// Without OXR_APP_ID → Frankfurter-only (approved safe-disable posture);
// with the key → [openexchangerates, frankfurter] in priority order (plan D1/D2).
{
  const prev = process.env.OXR_APP_ID;

  delete process.env.OXR_APP_ID;
  const withoutKey = defaultFxRegistry();
  check("default registry (no key): frankfurter only",
    withoutKey.adapters.length === 1 && withoutKey.adapters[0].source === "frankfurter");

  process.env.OXR_APP_ID = "test-key";
  const withKey = defaultFxRegistry();
  check("default registry (key set): OXR primary, frankfurter failover",
    withKey.adapters.length === 2 &&
    withKey.adapters[0].source === "openexchangerates" &&
    withKey.adapters[1].source === "frankfurter");

  if (prev === undefined) delete process.env.OXR_APP_ID; else process.env.OXR_APP_ID = prev;
}

if (failures.length > 0) {
  console.error(`\nMC1 P1 fx registry: ${failures.length} FAILURE(S) (${passed} checks passed):`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`MC1 P1 fx registry: all ${passed} checks passed.`);
process.exit(0);
