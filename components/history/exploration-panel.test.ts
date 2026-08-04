/**
 * components/history/exploration-panel.test.ts
 *
 * The shared exploration panel: URL model + the invariants the view must not
 * break. Pure — the URL layer is real logic and is exercised directly; the
 * component is asserted by INTENT against its source, which is how this repo
 * guards "React performs no financial arithmetic".
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  readExplorationUrl, explorationOpenUpdate, explorationCloseUpdate,
  encodeNodeRef, decodeNodeRef, EXPLORATION_URL_PARAMS,
} from "@/lib/history/exploration-url";

const checks: string[] = [];
const ok = (l: string) => checks.push(l);

/**
 * Comments are PROSE, not behaviour. A guard that scans them fails on a file
 * that merely explains why it does not do the thing — which is exactly the trap
 * this repo hit before ("strip comments before detecting directives").
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const SHEET_RAW = readFileSync(new URL("./HistoryExplorationSheet.tsx", import.meta.url), "utf8");
const SHEET = stripComments(SHEET_RAW);
const HOOK = stripComments(readFileSync(new URL("./useHistoryExploration.ts", import.meta.url), "utf8"));
const RESOLVER = stripComments(readFileSync(new URL("../../lib/history/exploration.ts", import.meta.url), "utf8"));
const ROUTE = stripComments(readFileSync(new URL("../../app/api/spaces/[id]/history/node/route.ts", import.meta.url), "utf8"));

// ── G/I · a URL restores the exact node, date and window ────────────────────
{
  const q = "?tab=overview&asof=2025-11-03&preset=1Y&perspective=wealth" +
            "&hnode=holding:acc1:inst1&hfrom=2024-07-21&hto=2025-11-03";
  const s = readExplorationUrl(q);
  assert.deepEqual(s, {
    root: "net-worth", nodeType: "holding", nodeId: "holding:acc1:inst1",
    fromISO: "2024-07-21", toISO: "2025-11-03",
  });
  ok("G/I · a deep link restores node type, id and the inherited window");
}

// A window is REQUIRED — without it a refresh would re-derive a different range.
{
  assert.equal(readExplorationUrl("?hnode=bucket:cash"), null);
  assert.equal(readExplorationUrl("?hnode=bucket:cash&hfrom=2025-01-01"), null);
  assert.equal(readExplorationUrl("?hnode=bucket:cash&hfrom=2025-02-01&hto=2025-01-01"), null,
    "a reversed window is not a window");
  ok("an incomplete or reversed window opens nothing rather than guessing a range");
}

// A malformed ref opens NOTHING — never the wrong node.
{
  for (const bad of ["", "nonsense", "bucket", "bucket:", "lens:x", "account"]) {
    assert.equal(decodeNodeRef(bad), null, `"${bad}" must not decode`);
  }
  assert.deepEqual(decodeNodeRef("lens"), { nodeType: "lens", nodeId: null });
  assert.equal(encodeNodeRef("lens", null), "lens");
  assert.equal(encodeNodeRef("bucket", "bucket:crypto"), "bucket:crypto");
  ok("a malformed node reference opens nothing, never a different node");
}

// ── D/E/F · window inheritance is carried, never recomputed ─────────────────
{
  const parent = readExplorationUrl("?hnode=lens&hfrom=2024-07-21&hto=2026-08-04")!;
  const child = explorationOpenUpdate({
    root: parent.root, nodeType: "bucket", nodeId: "bucket:investments",
    fromISO: parent.fromISO, toISO: parent.toISO,
  });
  assert.equal(child.hfrom, "2024-07-21");
  assert.equal(child.hto, "2026-08-04");
  // The hook must pass the CURRENT state's window down, not derive a new one.
  assert.ok(/fromISO:\s*state\.fromISO,\s*toISO:\s*state\.toISO/.test(HOOK),
    "navigate() inherits the window from URL state");
  assert.ok(!/preset|30|clamp|subMonths|addDays/i.test(HOOK),
    "the hook never re-derives a range from a preset or a default");
  ok("D/E/F · every child inherits the parent window verbatim — no reset, no clamp");
}

// ── Closing removes ONLY exploration state ─────────────────────────────────
{
  const close = explorationCloseUpdate();
  assert.deepEqual(Object.keys(close).sort(), [...EXPLORATION_URL_PARAMS].sort());
  assert.ok(Object.values(close).every((v) => v === null));
  // asof / preset / perspective are NOT in the update, so buildSpaceUrl leaves
  // them exactly as they were — closing must not move the chart behind the sheet.
  for (const preserved of ["asof", "preset", "perspective", "tab", "metric"]) {
    assert.ok(!(preserved in close), `${preserved} must survive a close`);
  }
  ok("closing clears only hnode/hfrom/hto and preserves every lens param");
}

// ── X · React performs NO financial arithmetic ─────────────────────────────
{
  // No summing of children, no remainder, no reconciliation classification.
  assert.ok(!/\.reduce\s*\(/.test(SHEET), "the sheet never reduces a list of values");
  assert.ok(!/displayedValue\s*[-+]\s*\w*[Ee]xplained/.test(SHEET), "never computes a remainder");
  assert.ok(!/quantity\s*\*\s*|unitPrice\s*\*/.test(SHEET), "never multiplies quantity by price");
  assert.ok(!/classifyReconciliation|authoriseAggregates|amountOwed|round2/.test(SHEET),
    "no canonical financial helper is imported into the view");
  // The ONE permitted computation is a display percentage, and it is fenced.
  const pct = /explainedValue\s*\/\s*node\.displayedValue/.test(SHEET);
  assert.ok(pct, "the display percentage is the only arithmetic");
  assert.ok(/DISPLAY ONLY/.test(SHEET_RAW), "and it is documented as display-only");
  ok("X · the view sums nothing, computes no remainder, and prices nothing");
}

// ── No React import of a valuation / ownership / reconciliation core ───────
{
  for (const forbidden of [
    "lib/investments/valuation", "lib/investments/holding-ownership",
    "lib/perspective-engine/reconciliation.core", "lib/snapshots/backfill-core",
    "lib/crypto/historical-crypto-valuation.core", "lib/data/snapshots",
  ]) {
    assert.ok(!SHEET.includes(forbidden), `the view must not import ${forbidden}`);
    assert.ok(!HOOK.includes(forbidden), `the hook must not import ${forbidden}`);
  }
  // …and no direct SpaceSnapshot read from the client at all.
  assert.ok(!/spaceSnapshot|prisma|@\/lib\/db/.test(SHEET + HOOK), "no DB access from the client");
  ok("no client module imports a valuation, ownership or snapshot authority");
}

// ── J/K/L/M · the four states are honoured by the view ─────────────────────
{
  // A composition may render for EXACT and PARTIALLY_ATTRIBUTED only.
  assert.ok(
    /mayShowChildren\s*=\s*\n?\s*node\.reconciliation === "EXACT" \|\| node\.reconciliation === "PARTIALLY_ATTRIBUTED"/.test(SHEET),
    "children are gated on the canonical state");
  assert.ok(/\{mayShowChildren && node\.components\.length > 0/.test(SHEET),
    "the component list is rendered only behind that gate");
  // The contradictory sentence is the exact required wording.
  assert.ok(/Historical composition is unavailable because the stored\s+observations conflict\./.test(SHEET),
    "the CONTRADICTORY sentence is verbatim");
  // The remainder is never given a financial identity.
  for (const forbidden of ["remainder is cash", "unallocated cash", "gain", "market movement", "missing holding"]) {
    assert.ok(!new RegExp(forbidden, "i").test(SHEET), `the remainder must not be labelled "${forbidden}"`);
  }
  assert.ok(/does\s+not\s+allocate/.test(SHEET), "the remainder is described neutrally");
  ok("J/K/L/M · children render only for EXACT and PARTIALLY_ATTRIBUTED; refusals use canonical wording");
}

// ── Breadcrumb identity comes from the resolver, not the UI ────────────────
{
  assert.ok(/path\.map\(/.test(SHEET), "the breadcrumb renders the resolver's path");
  assert.ok(!/Net worth ›|buildBreadcrumb|crumbsFor/.test(SHEET), "no UI-owned path assembly");
  assert.ok(/path: \[root, bucket, account, holding\]/.test(RESOLVER),
    "the resolver returns the full ancestor path under an aggregate root");
  assert.ok(/path: \[root, account, holding\]/.test(RESOLVER),
    "and a SHORTER path under a bucket root — Debt › Card, not Net worth › Debt › Card");
  ok("breadcrumb labels and identity come from canonical node data");
}

// ── Charts: gaps stay gaps ────────────────────────────────────────────────
{
  assert.ok(/Only join ADJACENT valued days/.test(SHEET_RAW), "gap policy is stated");
  assert.ok(/x - prevX !== 1\) return null/.test(SHEET), "a gap is never bridged");
  ok("provider-floor and evidence gaps are not bridged in the panel chart");
}

// ── Accessibility ─────────────────────────────────────────────────────────
{
  assert.ok(/aria-label="Exploration path"/.test(SHEET), "the breadcrumb is a labelled nav");
  assert.ok(/aria-current="page"/.test(SHEET), "the current crumb is marked");
  assert.ok(/role="img"[\s\S]{0,120}aria-label=\{summary\}/.test(SHEET), "the chart has a textual summary");
  assert.ok(/className="sr-only"/.test(SHEET), "the summary is also available as text");
  assert.ok(/aria-live="polite"/.test(SHEET), "loading is announced");
  assert.ok(/headingRef\.current\?\.focus\(\)/.test(SHEET), "focus moves into the sheet on open");
  assert.ok(/min-h-11/.test(SHEET), "touch targets meet the minimum height");
  ok("labelled breadcrumb, announced states, textual chart summary, focus-in, touch targets");
}

// ── API discipline ────────────────────────────────────────────────────────
{
  assert.ok(/requireSpaceRole\(spaceId, SpaceMemberRole\.VIEWER\)/.test(ROUTE), "membership is enforced");
  assert.ok(/MAX_WINDOW_DAYS/.test(ROUTE), "the response is bounded by a maximum window");
  assert.ok(/BAD_DATE|BAD_WINDOW|WINDOW_TOO_WIDE|MISSING_NODE_ID|BAD_NODE_TYPE/.test(ROUTE),
    "errors are stable, enumerable codes");
  assert.ok(!/e\.message|err\.message|String\(e\)/.test(ROUTE), "no internal message leaks into a response");
  // The route resolves nothing itself.
  assert.ok(!/classifyReconciliation|authoriseAggregates|computeSnapshotFields/.test(ROUTE),
    "the route makes no financial decision");
  assert.ok(/resolveExplorationNode/.test(ROUTE), "it calls the canonical resolver");
  ok("API: membership gated, bounded, stable error codes, no financial decision, no leakage");
}

// ── The resolver composes; it does not decide ─────────────────────────────
{
  for (const authority of [
    "buildLensRootNode", "buildNetWorthNode", "expandBucketNode", "expandAccountNode",
  ]) {
    assert.ok(RESOLVER.includes(authority), `${authority} is consumed`);
  }
  assert.ok(!/classifyReconciliation|amountOwed|computeSnapshotFields\(/.test(RESOLVER),
    "the resolver performs no arithmetic of its own");
  assert.ok(!/\.(create|update|upsert|delete|createMany|updateMany)\s*\(/.test(RESOLVER),
    "the resolver writes nothing");
  // No persistence of any series.
  assert.ok(!/prisma\.\w*[Ss]eries|accountSeries\.create/.test(RESOLVER), "no series is persisted");
  ok("the resolver composes canonical authorities, writes nothing, persists nothing");
}

// ── Y · flow lenses untouched ─────────────────────────────────────────────
{
  const renderers = readFileSync(
    new URL("../space/workspaces/workspaceRenderers.tsx", import.meta.url), "utf8");
  for (const flow of ["CashFlowWorkspace", "IncomeWorkspace", "SpendingWorkspace"]) {
    if (!renderers.includes(flow)) continue;
    const idx = renderers.indexOf(flow);
    const block = renderers.slice(idx, idx + 600);
    assert.ok(!/HistoryExplorationSheet|useHistoryExploration/.test(block),
      `${flow} must not gain historical exploration`);
  }
  ok("Y · flow lenses are untouched by this slice");
}

for (const c of checks) console.log("  ✓ " + c);
console.log(`exploration-panel: ${checks.length} checks passed`);
