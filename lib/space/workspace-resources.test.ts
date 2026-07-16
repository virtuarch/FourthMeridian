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

import { readFileSync } from "node:fs";
import path from "node:path";
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

// ── openPerspectiveDataNeeds — only the OPEN perspective, only on the Perspectives tab
{
  // Non-Perspectives tabs never activate perspective needs (structural tabs keep
  // their own host activation — SD-3 covers only the perspective-driven lazy fetch).
  for (const tab of ["OVERVIEW", "TRANSACTIONS", "ACCOUNTS", "ACTIVITY", "MEMBERS"]) {
    check(`tab ${tab} ⇒ no perspective needs`, openPerspectiveDataNeeds(tab, "wealth").size === 0);
  }
  // On the Perspectives tab, it is exactly the open perspective's registry needs.
  check("PERSPECTIVES+wealth ⇒ wealth needs",
    [...openPerspectiveDataNeeds("PERSPECTIVES", "wealth")].sort().join("|") === ["accounts", "snapshots"].sort().join("|"));
  check("PERSPECTIVES+null ⇒ empty", openPerspectiveDataNeeds("PERSPECTIVES", null).size === 0);
}

// ── EXACT-EQUIVALENCE — the SD-3 refactor is behavior-preserving ─────────────────
// The host's removed booleans were:
//   debtWorkspaceActive || wealthWorkspaceActive   → gated the snapshots fetch
//   cashFlowActive || liquidityWorkspaceActive     → gated the transactions fetch
//   goalsWorkspaceActive                            → gated the goals fetch
//   investmentsActive                               → gated the investments hook
// each defined as `activeTab === "PERSPECTIVES" && activePerspectiveId === <id>`.
// SD-3 replaces them with openPerspectiveDataNeeds(...).has(<need>). This section
// proves — across the WHOLE registry — that each need membership reduces to EXACTLY
// the same set of perspective ids, so no fetch triggers earlier, later, or differently.
{
  // The canonical id→need reductions the host now relies on.
  const REDUCTIONS: { need: string; ids: string[] }[] = [
    { need: "snapshots",          ids: ["wealth", "debt"] },
    { need: "transactions",       ids: ["cashFlow", "liquidity"] },
    { need: "goals",              ids: ["goals"] },
    { need: "investmentsHistory", ids: ["investments"] },
  ];
  // activePerspectiveId is drawn from perspectiveItems, which EXCLUDES overview
  // (SpaceDashboard.tsx) — so overview (which also declares snapshots+transactions)
  // can never be the open perspective. We therefore verify the reduction over every
  // registry id EXCEPT overview, which is unreachable as an open perspective.
  const openablePerspectiveIds = Object.keys(PERSPECTIVE_LIBRARY).filter((id) => id !== "overview");
  for (const { need, ids } of REDUCTIONS) {
    const derived = openablePerspectiveIds.filter(
      (id) => openPerspectiveDataNeeds("PERSPECTIVES", id).has(need as never),
    );
    check(`need "${need}" activates exactly {${ids.sort().join(",")}}`,
      derived.sort().join("|") === ids.slice().sort().join("|"),
      `got {${derived.sort().join(",")}}`);
  }
}

// ── Source-scan: the host's per-perspective fetch booleans are gone; it uses the orchestrator
{
  const ROOT = process.cwd();
  const src = readFileSync(path.join(ROOT, "components", "dashboard", "SpaceDashboard.tsx"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, ""); // strip comments (they name the removed booleans)
  for (const gone of [
    "debtWorkspaceActive", "wealthWorkspaceActive",
    "liquidityWorkspaceActive", "goalsWorkspaceActive", "investmentsActive",
  ]) {
    check(`host no longer declares/uses ${gone}`, !code.includes(gone));
  }
  check("host consumes openPerspectiveDataNeeds (registry-driven activation)",
    /openPerspectiveDataNeeds\(/.test(code));
  check("host derives activation from declared needs (perspectiveNeeds*)",
    /perspectiveNeedsSnapshots/.test(code) && /perspectiveNeedsTransactions/.test(code) &&
    /perspectiveNeedsGoals/.test(code) && /perspectiveNeedsInvestments/.test(code));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll SD-3 workspace-resources ratchets passed.");
