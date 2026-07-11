/**
 * lib/perspective-engine/engine.test.ts
 *
 * Perspective Engine foundation tests — registry, shaped failures,
 * determinism, structural contract, and import-graph guards.
 *
 * The project has no test runner (no jest/vitest). This is a standalone,
 * dependency-free script runnable with the already-installed `tsx`,
 * mirroring lib/space-nav.test.ts and lib/data/transactions.privacy.test.ts:
 *
 *     npx tsx lib/perspective-engine/engine.test.ts
 *
 * Run from the repo root (the source-scan checks resolve paths from cwd).
 * Exits 0 when all cases pass and 1 on failure, so it can be wired into CI.
 *
 * Layers:
 *   1. Registry behavior — register/lookup/list, duplicate registration
 *      fails loudly.
 *   2. Engine shaping — unregistered ids and throwing/mis-shaped lenses all
 *      come back as fully-formed, render-safe error results; thrown error
 *      text (which could embed account data) never reaches the result JSON.
 *   3. Determinism — identical scope + injected clock → byte-identical
 *      JSON across runs.
 *   4. Source tripwires — nothing under lib/perspective-engine/ imports
 *      Prisma (@/lib/db, @prisma/client), lib/plaid/encryption,
 *      lib/ai/provider, or app/ routes. If a future lens adds a direct DB
 *      or crypto import, this fails loudly (lenses must read through
 *      lib/data/accounts.ts — investigation §2.3).
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

import {
  computePerspective,
  computePerspectives,
  getLens,
  listRegisteredLenses,
  makeEmptyResult,
  makeErrorResult,
  registerLens,
  validateLensResult,
} from "./index";
import type { Completeness, ComputeOptions, LensResult, PerspectiveScope } from "./types";
import {
  COMPLETENESS_TIERS,
  isCompletenessTier,
  propagateCompleteness,
  worstTier,
} from "./completeness";

// ── Tiny harness (house pattern) ─────────────────────────────────────────────

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const SCOPE: PerspectiveScope = { spaceId: "space_test_1", userId: "user_test_1" };
const FIXED_NOW = () => new Date("2026-07-03T12:00:00.000Z");

// A deterministic, contract-conforming fake lens registered under the real
// "liquidity" id. Deliberately a fake even though the real lens now exists
// (lenses/liquidity.ts): importing the real lens module would pull the data
// layer (and Prisma) into this pure engine-mechanics test. The real lenses
// are fixture-tested in liquidity.test.ts / debt.test.ts; each tsx test runs
// in its own process, so the ids never collide.
const fakeLiquidity = async (
  scope: PerspectiveScope,
  options: ComputeOptions,
): Promise<LensResult> => ({
  lensId: "liquidity",
  lensVersion: 1,
  scope,
  computedAt: options.now().toISOString(),
  status: "ok",
  verdict: "About $100 is available as cash now.",
  headline: { id: "cashNow", label: "Available now", value: 100, format: "currency" },
  metrics: [{ id: "cashNow", label: "Available now", value: 100, format: "currency" }],
  assumptions: [],
  provenance: {
    accountIds: ["fa_1", "fa_2"],
    tierCounts: { full: 2, balanceOnly: 0, summaryOnly: 0 },
    dataAsOf: "2026-07-01T00:00:00.000Z",
    redactions: [],
  },
});

async function main(): Promise<void> {
  // ── 1. Registry ─────────────────────────────────────────────────────────
  console.log("1. Registry behavior");

  check("registry starts empty (no lens modules exist yet in commit 1)",
    listRegisteredLenses().length === 0,
    `found: ${listRegisteredLenses().join(", ")}`);

  registerLens("liquidity", fakeLiquidity);
  check("registered lens is retrievable", getLens("liquidity") === fakeLiquidity);
  check("listRegisteredLenses reflects insertion order",
    JSON.stringify(listRegisteredLenses()) === JSON.stringify(["liquidity"]));

  let dupThrew = false;
  try {
    registerLens("liquidity", fakeLiquidity);
  } catch {
    dupThrew = true;
  }
  check("duplicate registration throws", dupThrew);

  // ── 2. Engine shaping ───────────────────────────────────────────────────
  console.log("2. Engine shaping (fail closed, fail shaped)");

  const unreg = await computePerspective("debt", SCOPE, { now: FIXED_NOW });
  check("unregistered lens → status error", unreg.status === "error");
  check("unregistered lens → LENS_NOT_REGISTERED", unreg.error?.code === "LENS_NOT_REGISTERED");
  check("unregistered result is fully shaped (passes validator)",
    validateLensResult(unreg).length === 0,
    validateLensResult(unreg).join("; "));

  // Throwing lens: error text carrying a sentinel must never reach the
  // result. Registered under the "debt" id (fake for the same reason as the
  // "liquidity" fake above — keep this test DB-free).
  const SENTINEL = "LEAKCANARY_CHASE_SAVINGS_9931";
  const throwingId = "debt" as const;
  registerLens(throwingId, async () => {
    throw new Error(`db exploded for account ${SENTINEL}`);
  });
  const thrown = await computePerspective(throwingId, SCOPE, { now: FIXED_NOW });
  check("throwing lens → shaped COMPUTE_FAILED (never propagates)",
    thrown.status === "error" && thrown.error?.code === "COMPUTE_FAILED");
  check("thrown error text never enters result JSON",
    !JSON.stringify(thrown).includes(SENTINEL));

  // Mis-shaped lens result → COMPUTE_FAILED via validator.
  const misshapen: LensResult = {
    ...(await fakeLiquidity(SCOPE, { now: FIXED_NOW })),
    status: "empty", // empty without empty copy + with verdict/headline = 3 violations
  };
  check("validator flags empty-without-copy", validateLensResult(misshapen).length > 0);

  // Builders produce validator-clean results.
  const opts: ComputeOptions = { now: FIXED_NOW };
  check("makeErrorResult passes validator",
    validateLensResult(makeErrorResult("debt", 1, SCOPE, opts, "DATA_UNAVAILABLE")).length === 0);
  check("makeEmptyResult passes validator",
    validateLensResult(
      makeEmptyResult("debt", 1, SCOPE, opts, { headline: "No debt accounts in this Space yet", subline: "Link an account to see this lens." }),
    ).length === 0);

  // ── 3. Determinism ──────────────────────────────────────────────────────
  console.log("3. Determinism");

  const a = await computePerspective("liquidity", SCOPE, { now: FIXED_NOW });
  const b = await computePerspective("liquidity", SCOPE, { now: FIXED_NOW });
  check("identical scope + injected clock → byte-identical JSON",
    JSON.stringify(a) === JSON.stringify(b));
  check("computedAt comes from the injected clock",
    a.computedAt === "2026-07-03T12:00:00.000Z");

  const batch = await computePerspectives(SCOPE, { now: FIXED_NOW });
  check("batch computes every registered lens in registration order",
    batch.length === 2 && batch[0].lensId === "liquidity" && batch[1].lensId === "debt");
  check("batch degrades per-lens (bad lens shaped, good lens intact)",
    batch[0].status === "ok" && batch[1].status === "error");

  // ── 3b. A5-S1 kill switch — asOf is additive and optional ────────────────
  // The load-bearing regression guard: a lens that does not consume asOf yields
  // byte-identical JSON whether or not asOf is supplied, and never emits a
  // completeness field. (No lens consumes asOf in the S1/S2 slices — the fake
  // liquidity lens above ignores it, exactly like every existing lens today.)
  console.log("3b. A5-S1 kill switch (asOf-absent byte-identity)");

  const noAsOf   = await computePerspective("liquidity", SCOPE, { now: FIXED_NOW });
  const withAsOf = await computePerspective("liquidity", SCOPE, { now: FIXED_NOW, asOf: "2026-01-01" });
  check("asOf-absent result carries no completeness field",
    noAsOf.completeness === undefined && !JSON.stringify(noAsOf).includes("completeness"));
  check("asOf is additive/optional — an asOf-ignoring lens is byte-identical",
    JSON.stringify(noAsOf) === JSON.stringify(withAsOf));

  // ── 3c. A5-S1 completeness vocabulary + propagation helpers ──────────────
  console.log("3c. A5-S1 completeness vocabulary");

  check("COMPLETENESS_TIERS is the frozen canonical order",
    JSON.stringify([...COMPLETENESS_TIERS]) ===
      '["observed","derived","estimated","incomplete","unknown"]');
  check("COMPLETENESS_TIERS is frozen", Object.isFrozen(COMPLETENESS_TIERS));

  check("isCompletenessTier accepts every canonical tier",
    COMPLETENESS_TIERS.every((t) => isCompletenessTier(t)));
  check("isCompletenessTier rejects a non-member value", !isCompletenessTier("partial"));
  check("isCompletenessTier rejects non-strings", !isCompletenessTier(undefined) && !isCompletenessTier(3));

  check("worstTier picks the least-trustworthy tier",
    worstTier(["observed", "estimated"]) === "estimated" &&
    worstTier(["derived", "incomplete", "observed"]) === "incomplete");
  check("worstTier of a single tier is that tier", worstTier(["observed"]) === "observed");
  check("worstTier of an empty set fails closed to unknown", worstTier([]) === "unknown");

  check("propagateCompleteness takes worst tier and ORs conflict upward",
    JSON.stringify(propagateCompleteness([{ tier: "observed" }, { tier: "estimated", conflict: true }])) ===
      JSON.stringify({ tier: "estimated", conflict: true }));
  check("propagateCompleteness with no conflicts reports conflict false",
    JSON.stringify(propagateCompleteness([{ tier: "observed" }, { tier: "derived" }])) ===
      JSON.stringify({ tier: "derived", conflict: false }));
  check("propagateCompleteness of an empty set is unknown/false",
    JSON.stringify(propagateCompleteness([])) === JSON.stringify({ tier: "unknown", conflict: false }));

  // Completeness values are plain serialisable objects (contract rule: no Date,
  // no functions), so they round-trip through JSON byte-identically.
  const stamp: Completeness = {
    tier: "derived",
    conflict: false,
    reason: "Reconstructed from transaction history.",
    coverageFrom: "2026-01-01",
    byComponent: { cash: "derived", marketable: "estimated" },
  };
  check("Completeness round-trips through JSON unchanged",
    JSON.stringify(JSON.parse(JSON.stringify(stamp))) === JSON.stringify(stamp));

  // ── 4. Source tripwires ─────────────────────────────────────────────────
  console.log("4. Import-graph guards (lib/perspective-engine/**)");

  const engineDir = join(process.cwd(), "lib", "perspective-engine");
  const sources: string[] = [];
  (function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry) && !entry.includes(".test.")) sources.push(full);
    }
  })(engineDir);

  check("engine has source files to scan", sources.length >= 3);

  const FORBIDDEN: Array<[string, RegExp]> = [
    ["direct Prisma client",        /['"]@prisma\/client['"]/],
    ["db singleton (direct query)", /['"]@\/lib\/db['"]/],
    ["plaid encryption",            /lib\/plaid\/encryption/],
    ["AI provider (LLM)",           /lib\/ai\/provider/],
    ["HTTP route coupling",         /['"]@?\/?app\//],
    ["next server coupling",        /['"]next\//],
  ];

  for (const file of sources) {
    // Scan import/require statements only — the engine's doc comments
    // legitimately NAME the forbidden modules ("must not import X"), so a
    // whole-file scan would trip on its own documentation.
    const importLines = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => /^\s*(import\b|export\s.*\bfrom\b)/.test(l) || /\brequire\s*\(/.test(l))
      .join("\n");
    for (const [label, re] of FORBIDDEN) {
      check(`${file.slice(engineDir.length + 1)} does not import ${label}`, !re.test(importLines));
    }
  }

  // ── Result ──────────────────────────────────────────────────────────────
  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll perspective-engine foundation checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Test harness crashed:", err);
  process.exit(1);
});
