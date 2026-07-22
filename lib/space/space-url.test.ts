/**
 * lib/space/space-url.test.ts
 *
 * SD-0A — pure tests for the canonical Space URL serialization core. The core is
 * the single authority every Space URL writer routes through, so these pin the
 * non-clobbering contract: an update touches only the keys it names and preserves
 * every other param.
 *
 *   npx tsx lib/space/space-url.test.ts
 */

import {
  applySpaceUrlUpdate,
  buildSpaceUrl,
  readSpaceParam,
  legacyTabPerspective,
  SPACE_URL_PARAMS,
} from "./space-url";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const params = (qs: string) => new URLSearchParams(qs);
const has = (qs: string, k: string, v: string) => params(qs).get(k) === v;
const absent = (qs: string, k: string) => !params(qs).has(k);

// ── one update preserves ALL unrelated params ──────────────────────────────────
{
  const start = "tab=perspectives&perspective=investments&asof=2026-07-16&compareto=2026-01-01&preset=ytd";
  const next = applySpaceUrlUpdate(start, { perspective: "wealth" });
  check("changing perspective keeps asof", has(next, "asof", "2026-07-16"));
  check("changing perspective keeps compareto", has(next, "compareto", "2026-01-01"));
  check("changing perspective keeps preset", has(next, "preset", "ytd"));
  check("changing perspective keeps tab", has(next, "tab", "perspectives"));
  check("changing perspective updates perspective", has(next, "perspective", "wealth"));
}

// ── multiple sequential updates compose correctly ──────────────────────────────
{
  let qs = "";
  qs = applySpaceUrlUpdate(qs, { tab: "perspectives" });
  qs = applySpaceUrlUpdate(qs, { perspective: "wealth" });
  qs = applySpaceUrlUpdate(qs, { asof: "2026-07-16", preset: "mtd" });
  qs = applySpaceUrlUpdate(qs, { metric: "totalAssets" });
  check("sequential compose: tab", has(qs, "tab", "perspectives"));
  check("sequential compose: perspective", has(qs, "perspective", "wealth"));
  check("sequential compose: asof", has(qs, "asof", "2026-07-16"));
  check("sequential compose: preset", has(qs, "preset", "mtd"));
  check("sequential compose: metric", has(qs, "metric", "totalAssets"));
}

// ── transaction deep link preserves workspace/time state (the clobber fix) ──────
{
  const start = "tab=perspectives&perspective=investments&asof=2026-07-16&compareto=2026-01-01&preset=ytd&account=acc_1";
  const opened = buildSpaceUrl("/dashboard", `?${start}`, { transaction: "txn_42" });
  check("open drawer sets transaction", has(opened.split("?")[1], "transaction", "txn_42"));
  for (const [k, v] of [
    ["tab", "perspectives"], ["perspective", "investments"], ["asof", "2026-07-16"],
    ["compareto", "2026-01-01"], ["preset", "ytd"], ["account", "acc_1"],
  ] as const) {
    check(`open drawer keeps ${k}`, has(opened.split("?")[1], k, v));
  }
  // closing (transaction: null) strips only the drawer param, keeps the rest
  const closed = buildSpaceUrl("/dashboard", opened.split("/dashboard")[1], { transaction: null });
  check("close drawer removes transaction", absent(closed.split("?")[1] ?? "", "transaction"));
  check("close drawer keeps perspective", has(closed.split("?")[1], "perspective", "investments"));
  check("close drawer keeps preset", has(closed.split("?")[1], "preset", "ytd"));
}

// ── null deletes; missing keys are left untouched ──────────────────────────────
{
  const next = applySpaceUrlUpdate("tab=overview&metric=totalAssets", { metric: null });
  check("null removes the key", absent(next, "metric"));
  check("null-delete keeps siblings", has(next, "tab", "overview"));
  const noop = applySpaceUrlUpdate("tab=overview", { compareto: null });
  check("deleting an absent key is a no-op", noop === "tab=overview");
}

// ── buildSpaceUrl strips the '?' when the query is empty ────────────────────────
{
  check("empty query yields bare pathname", buildSpaceUrl("/dashboard", "?metric=totalAssets", { metric: null }) === "/dashboard");
  check("non-empty query keeps the '?'", buildSpaceUrl("/dashboard", "", { tab: "overview" }) === "/dashboard?tab=overview");
}

// ── leading '?' tolerated on the base search ────────────────────────────────────
{
  check("accepts window.location.search form", has(applySpaceUrlUpdate("?tab=overview", { metric: "netWorth" }), "tab", "overview"));
  check("readSpaceParam reads with '?'", readSpaceParam("?preset=ytd&asof=2026-07-16", "preset") === "ytd");
  check("readSpaceParam reads without '?'", readSpaceParam("preset=ytd", "preset") === "ytd");
  check("readSpaceParam absent → null", readSpaceParam("tab=overview", "preset") === null);
}

// ── the documented Space params are exactly the eight known ones ────────────────
{
  check(
    "SPACE_URL_PARAMS lists the eight Space-scoped params",
    JSON.stringify([...SPACE_URL_PARAMS].sort()) ===
      JSON.stringify(["account", "asof", "compareto", "metric", "perspective", "preset", "tab", "transaction"]),
  );
}

// ── M2 canonical IA — legacy perspective-routing ?tab= → forced lens ────────────
// Old links (?tab=debt / ?tab=credit / ?tab=investments) must canonicalize to a
// perspective engaged through Overview, not a separate destination. The tab→lens
// authority is this pure map; the host reads it in readUrlTabState.
{
  check("legacyTabPerspective(debt) → debt", legacyTabPerspective("debt") === "debt");
  check("legacyTabPerspective(DEBT) is case-insensitive", legacyTabPerspective("DEBT") === "debt");
  check("legacyTabPerspective(credit) → debt (credit is a debt alias)", legacyTabPerspective("credit") === "debt");
  check("legacyTabPerspective(investments) → investments", legacyTabPerspective("investments") === "investments");
  // "perspectives" carries NO forced lens — its own ?perspective= drives it.
  check("legacyTabPerspective(perspectives) → null", legacyTabPerspective("perspectives") === null);
  // Structural tabs and absent values force nothing.
  check("legacyTabPerspective(overview) → null", legacyTabPerspective("overview") === null);
  check("legacyTabPerspective(accounts) → null", legacyTabPerspective("accounts") === null);
  check("legacyTabPerspective(null) → null", legacyTabPerspective(null) === null);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll space-url core checks passed.");
