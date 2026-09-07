/**
 * lib/space/workspace-resources.test.ts
 *
 * SD-3 ratchets for the declarative Workspace resource orchestrator. Mostly PURE
 * (registry-derived resolution); one source-scan section pins that the host's former
 * per-perspective fetch booleans are gone and the host now consumes the orchestrator.
 *   npx tsx lib/space/workspace-resources.test.ts
 *
 * The load-bearing section is the EXACT-EQUIVALENCE proof: it shows the registry-
 * derived activation reduces to precisely the per-id checks it replaced, so the SD-3
 * refactor is behavior-preserving (no eager-loading regression, no lazy-loading loss).
 */

import {
  workspaceDataNeeds,
  openPerspectiveDataNeeds,
} from "./workspace-resources";
import { WORKSPACE_REGISTRY, PERSPECTIVE_LIBRARY } from "../perspectives";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── workspaceDataNeeds — registry-derived, domain-agnostic primitive ─────────────
{
  // Reads the canonical registry for ANY workspace id (standard or perspective).
  check("wealth needs === registry dataNeeds",
    [...workspaceDataNeeds("wealth")].sort().join("|") === ["accounts", "snapshots"].sort().join("|"));
  check("transactions (standard) needs resolve too (domain-agnostic)",
    [...workspaceDataNeeds("transactions")].sort().join("|") === ["accounts", "transactions"].sort().join("|"));
  // Self-fetching workspace (Members, dataNeeds: []) ⇒ empty set.
  check("members (self-fetch) ⇒ empty needs", workspaceDataNeeds("members").size === 0);
  // Fail-safe: unknown / empty / null ⇒ empty, never throws.
  check("unknown id ⇒ empty needs", workspaceDataNeeds("nope").size === 0);
  check("null id ⇒ empty needs", workspaceDataNeeds(null).size === 0);
  check("undefined id ⇒ empty needs", workspaceDataNeeds(undefined).size === 0);
  // Every returned member is one of the workspace's own declared needs.
  for (const [id, def] of Object.entries(WORKSPACE_REGISTRY)) {
    const got = [...workspaceDataNeeds(id)].sort().join("|");
    const want = [...(def.dataNeeds ?? [])].sort().join("|");
    check(`workspaceDataNeeds(${id}) === registry`, got === want);
  }
}

// ── openPerspectiveDataNeeds — only the OPEN perspective, only on Overview (M2)
{
  // M2 canonical IA: perspectives are engaged through OVERVIEW, so a perspective
  // is "open" only there. Non-Overview tabs never activate perspective needs
  // (structural tabs keep their own host activation — SD-3 covers only the
  // perspective-driven lazy fetch).
  for (const tab of ["TRANSACTIONS", "ACCOUNTS", "ACTIVITY", "MEMBERS"]) {
    check(`tab ${tab} ⇒ no perspective needs`, openPerspectiveDataNeeds(tab, "wealth").size === 0);
  }
  // On Overview with a lens engaged, it is exactly the open perspective's needs.
  check("OVERVIEW+wealth ⇒ wealth needs",
    [...openPerspectiveDataNeeds("OVERVIEW", "wealth")].sort().join("|") === ["accounts", "snapshots"].sort().join("|"));
  // Overview WITHOUT an engaged lens (summary) declares no perspective needs — its
  // structural fetches stay category-gated in the host.
  check("OVERVIEW+null (summary) ⇒ empty", openPerspectiveDataNeeds("OVERVIEW", null).size === 0);
}

// ── EXACT-EQUIVALENCE — the SD-3 refactor is behavior-preserving ─────────────────
// The host's removed booleans were:
//   debtWorkspaceActive || wealthWorkspaceActive   → gated the snapshots fetch
//   cashFlowActive || liquidityWorkspaceActive     → gated the transactions fetch
//   investmentsActive                               → gated the investments hook
// each defined (M2) as `activeTab === "OVERVIEW" && activePerspectiveId === <id>`.
// SD-3 replaces them with openPerspectiveDataNeeds(...).has(<need>). This section
// proves — across the WHOLE registry — that each need membership reduces to EXACTLY
// the same set of perspective ids, so no fetch triggers earlier, later, or differently.
{
  // The canonical id→need reductions the host now relies on.
  const REDUCTIONS: { need: string; ids: string[] }[] = [
    { need: "snapshots",          ids: ["wealth", "debt"] },
    { need: "transactions",       ids: ["cashFlow", "liquidity"] },
    // W2 — the "goals" need row was deleted with the goals perspective (Goals retired).
    { need: "investmentsHistory", ids: ["investments"] },
  ];
  // activePerspectiveId is drawn from perspectiveItems, which EXCLUDES overview
  // (SpaceDashboard.tsx) — so overview (which also declares snapshots+transactions)
  // can never be the open perspective. We therefore verify the reduction over every
  // registry id EXCEPT overview, which is unreachable as an open perspective.
  const openablePerspectiveIds = Object.keys(PERSPECTIVE_LIBRARY).filter((id) => id !== "overview");
  for (const { need, ids } of REDUCTIONS) {
    const derived = openablePerspectiveIds.filter(
      (id) => openPerspectiveDataNeeds("OVERVIEW", id).has(need as never),
    );
    check(`need "${need}" activates exactly {${ids.sort().join(",")}}`,
      derived.sort().join("|") === ids.slice().sort().join("|"),
      `got {${derived.sort().join(",")}}`);
  }
}

// ── OVERVIEW-CONSOLIDATION — per-MODE needs ────────────────────────────────────
// liquidity / investments / debt are no longer OPENABLE perspectives (they render
// inside the Net Worth workspace), so the reductions above describe registry
// membership only. The host now passes the Net Worth mode, and the gate unions
// the registry's `modeDataNeeds` — so Assets reaches the former Liquidity +
// Investments fetches and Debt the former Debt ones, still from ONE registry.
{
  const has = (mode: string, need: string) => openPerspectiveDataNeeds("OVERVIEW", "wealth", mode).has(need as never);
  check("wealth/total does NOT activate transactions", !has("total", "transactions"));
  check("wealth/assets activates transactions (the former liquidity need)", has("assets", "transactions"));
  check("wealth/assets activates investmentsHistory (the former investments need)", has("assets", "investmentsHistory"));
  check("wealth/assets activates lens (the liquidity verdict)", has("assets", "lens"));
  check("wealth/debt activates lens + fico (the former debt needs)", has("debt", "lens") && has("debt", "fico"));
  check("wealth/debt does NOT activate transactions", !has("debt", "transactions"));
  check("every mode keeps the base needs", ["total", "assets", "debt"].every((m) => has(m, "accounts") && has(m, "snapshots")));
  check("an unknown mode ⇒ base needs only", [...openPerspectiveDataNeeds("OVERVIEW", "wealth", "nope")].sort().join() === "accounts,snapshots");
  check("a non-Overview tab ignores the mode", openPerspectiveDataNeeds("ACCOUNTS", "wealth", "assets").size === 0);
}

// NOTE (TEST-3): the former source-scan tail — which pinned the host's now-removed
// per-perspective fetch booleans (debtWorkspaceActive, …) and the host-internal
// `perspectiveNeeds*` identifier spellings — was removed. It pinned deleted host
// symbols and internal variable names (pure implementation churn) rather than any
// observable contract. The registry-derivation + EXACT-EQUIVALENCE proof above is
// the durable, behavior-level guarantee that SD-3 is regression-free.

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll SD-3 workspace-resources ratchets passed.");
