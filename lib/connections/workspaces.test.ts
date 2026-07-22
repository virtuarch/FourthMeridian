/**
 * lib/connections/workspaces.test.ts  (UI Convergence Wave 1 — W1-0)
 *
 * Guards for the Connections utility-workspace identity. Standalone tsx (house
 * pattern): npx tsx lib/connections/workspaces.test.ts — exits 0/1. Auto-discovered
 * by scripts/run-tests.ts.
 *
 * Pins: every Connections destination resolves in the UNIVERSAL registry; ids are
 * namespaced + disjoint; domain:"connections"; NO finance vocabulary pollutes a
 * Connections definition; navigation reuses the shared SpaceShell (global-peer, no
 * Space-mode takeover).
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import {
  CONNECTIONS_WORKSPACES,
  CONNECTIONS_WORKSPACE_ORDER,
  getConnectionsWorkspace,
  isConnectionsWorkspaceId,
} from "@/lib/connections/workspaces";
import { WORKSPACE_REGISTRY, getWorkspaceDefinition, STANDARD_WORKSPACES } from "@/lib/perspectives";
import { PLATFORM_WORKSPACES } from "@/lib/platform/workspaces";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
/** Strip comments so documentation prose (which may name an avoided call) never
 *  trips a code ratchet — the house pattern (see space-shell.test.ts). */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

console.log("universal registry identity");
{
  for (const [id, def] of Object.entries(CONNECTIONS_WORKSPACES)) {
    check(`"${id}" is registered in the universal WORKSPACE_REGISTRY`, WORKSPACE_REGISTRY[id] === def);
    check(`"${id}" resolves via the universal getWorkspaceDefinition`, getWorkspaceDefinition(id) === def);
    check(`"${id}" resolves via getConnectionsWorkspace + isConnectionsWorkspaceId`, getConnectionsWorkspace(id) === def && isConnectionsWorkspaceId(id));
    check(`"${id}" is "connections-*"-namespaced (disjoint from finance/platform ids)`, id.startsWith("connections-"));
    check(`"${id}" registry key === def.id`, def.id === id);
    check(`"${id}" declares domain:"connections"`, def.domain === "connections");
    check(`"${id}" is a standard Workspace`, def.kind === "standard");
  }
  // Disjoint from the other domains' id sets.
  check("no id collision with finance STANDARD_WORKSPACES", Object.keys(CONNECTIONS_WORKSPACES).every((id) => !(id in STANDARD_WORKSPACES)));
  check("no id collision with PLATFORM_WORKSPACES", Object.keys(CONNECTIONS_WORKSPACES).every((id) => !(id in PLATFORM_WORKSPACES)));
  // NOT the bare "connections" (which a finance tab lookup could resolve to).
  check("no bare \"connections\" id (finance getWorkspaceForTab stays undefined)", getWorkspaceDefinition("connections") === undefined);
}

console.log("no finance-vocabulary pollution");
{
  for (const [id, def] of Object.entries(CONNECTIONS_WORKSPACES)) {
    const d = def as unknown as Record<string, unknown>;
    check(`"${id}" declares no finance dataNeeds`, d.dataNeeds === undefined);
    check(`"${id}" declares no finance envelope`, d.envelope === undefined);
    check(`"${id}" declares no finance routing`, d.routing === undefined);
    check(`"${id}" declares no temporalCapability`, d.temporalCapability === undefined);
  }
}

console.log("composition + render reuse");
{
  check("CONNECTIONS_WORKSPACE_ORDER is non-empty", CONNECTIONS_WORKSPACE_ORDER.length >= 1);
  for (const id of CONNECTIONS_WORKSPACE_ORDER) check(`order id "${id}" resolves to a registered workspace`, getConnectionsWorkspace(id) != null);

  // Render-surface scans activate once W1-A lands its SpaceShell host (self-
  // contained W1-0 commit stays green before then).
  const dashRel = "components/connections/ConnectionsSpaceDashboard.tsx";
  if (existsSync(path.join(process.cwd(), dashRel))) {
    const dash = stripComments(read(dashRel));
    check("navigation reuses the shared SpaceShell (not a parallel frame)", /@\/components\/space\/shell\/SpaceShell/.test(dash) && /railOptions/.test(dash));
    // D2 — global-nav peer: MUST NOT take over the ContextualNavbar (no publishSpace).
    check("does NOT enter customer Space mode (no publishSpace / useSpaceChromePublisher)", !/publishSpace|useSpaceChromePublisher/.test(dash));
    // Ownership boundary — Connections is credential/sync only, never a money consumer.
    check("reads no portfolio/valuation authority", !/getAccounts|debtProfile|minimumPayment/.test(dash));
  } else {
    console.log("  … ConnectionsSpaceDashboard.tsx not present yet (W1-A) — render scans deferred");
  }
}

if (failures > 0) {
  console.error(`\nconnections/workspaces.test: ${failures} failure(s).`);
  process.exit(1);
}
console.log("\nconnections/workspaces.test: all passed.");
