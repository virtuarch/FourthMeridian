/**
 * lib/perspectives/sync-incomplete-warning.test.ts
 *
 * PRE-BETA-OPS-CLOSE Phase 2B — the partial-convergence trust warning
 * (house pattern: standalone tsx, DB-free):
 *
 *   npx tsx lib/perspectives/sync-incomplete-warning.test.ts
 *
 * When the cursor-safety invariant holds an item's page, that item's CURRENT
 * balance can be newer than its transactions and its last converged snapshot.
 * That is honest provider behaviour, not corruption — but a user must not read
 * a fresh balance beside stale history as "fully converged".
 *
 * The warning rides the EXISTING orthogonal `warnings[]` channel (the one FX
 * already uses), not a second trust framework: `completeness` still answers
 * "how was this value obtained", and this answers "has the provider's picture
 * fully arrived".
 */

import { resolvePerspectiveEnvelope } from "./envelope";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const PERSPECTIVES = ["wealth", "cashFlow", "debt", "liquidity", "investments"];

console.log("1. Every perspective carries the caveat when an item is sync-incomplete");
for (const id of PERSPECTIVES) {
  const env = resolvePerspectiveEnvelope({ perspectiveId: id, syncIncomplete: true });
  const w = (env.warnings ?? []).find((x) => x.kind === "sync-incomplete");
  check(`${id}: warning present`, w !== undefined);
  check(`${id}: tone warning`, w?.tone === "warning");
}

console.log("2. Absent by default — no warning is invented");
for (const id of PERSPECTIVES) {
  const env = resolvePerspectiveEnvelope({ perspectiveId: id });
  check(`${id}: no sync warning when converged`,
    !(env.warnings ?? []).some((x) => x.kind === "sync-incomplete"));
}

console.log("3. Orthogonal to FX — both can be present at once");
{
  // cashFlow has a static envelope fallback, so fxUnconverted applies without a
  // lens result — the cleanest place to prove the two channels coexist.
  const env = resolvePerspectiveEnvelope({ perspectiveId: "cashFlow", fxUnconverted: true, syncIncomplete: true });
  const kinds = (env.warnings ?? []).map((w) => w.kind);
  check("carries BOTH fx and sync-incomplete", kinds.includes("fx") && kinds.includes("sync-incomplete"), kinds.join(","));
  check("neither replaces the other", (env.warnings ?? []).length >= 2);
}

console.log("4. It does not touch the completeness axis");
{
  const converged = resolvePerspectiveEnvelope({ perspectiveId: "cashFlow" });
  const stalled   = resolvePerspectiveEnvelope({ perspectiveId: "cashFlow", syncIncomplete: true });
  check("completeness tier is unchanged",
    JSON.stringify(converged.completeness) === JSON.stringify(stalled.completeness));
  check("only warnings differ",
    (stalled.warnings ?? []).length > (converged.warnings ?? []).length);
}

console.log("5. The copy is honest about WHAT is stale");
{
  const env = resolvePerspectiveEnvelope({ perspectiveId: "cashFlow", syncIncomplete: true });
  const w = (env.warnings ?? []).find((x) => x.kind === "sync-incomplete")!;
  check("says balances MAY BE CURRENT (does not disown them)", /balances may be current/i.test(w.detail ?? ""));
  check("names transactions AND history as the lagging parts",
    /transactions/i.test(w.detail ?? "") && /history/i.test(w.detail ?? ""));
  check("frames it as in-progress, not broken", /still syncing|catching up/i.test(w.detail ?? ""));
  check("compact label is the approved copy", w.label === "Sync incomplete", w.label);
  check("does NOT claim the data is wrong",
    !/wrong|incorrect|error|inaccurate/i.test(`${w.label} ${w.detail ?? ""}`), w.detail);
}

console.log(failures === 0
  ? "\n✅ sync-incomplete warning: all checks passed"
  : `\n❌ sync-incomplete warning: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
