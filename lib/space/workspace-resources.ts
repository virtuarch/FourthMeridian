/**
 * lib/space/workspace-resources.ts
 *
 * SD-3 — the declarative Workspace resource orchestrator (pure, client-safe).
 *
 * DOCTRINE (SPACE_CONTRACT_DOCTRINE §4, §13, Addendum II §F): a Workspace DECLARES
 * what it needs — `WorkspaceDefinition.dataNeeds`, in the canonical WORKSPACE_REGISTRY
 * — and never decides HOW anything loads. The host (the shell's orchestration layer)
 * RESOLVES those declared needs to activate the EXISTING loaders. This module owns
 * only the Workspace→needs resolution.
 *
 * It is deliberately DOMAIN-AGNOSTIC: it knows nothing about Investments, Wealth,
 * Debt, Jobs, Audit, or any domain. It reads the registry and returns a Set of need
 * tokens. Any Space domain that registers a `WorkspaceDefinition` with `dataNeeds`
 * — Personal Finance today, Platform/Security/Growth/Customer-Success later — is
 * orchestrated by this SAME code, with no change here. That is the SD-3 extensibility
 * contract (Addendum II §F): the vocabulary grows by domain registration, never by a
 * per-domain branch in the orchestrator.
 *
 * `dataNeeds` is ORCHESTRATION METADATA ONLY — not a DTO, not a domain contract, not
 * a fetch. The domain envelopes (InvestmentsSpaceData, ConnectionsSpaceData, future
 * *SpaceData) stay entirely separate and are never merged into this vocabulary.
 *
 * Type-only import of the registry accessor keeps this file free of any server/engine
 * code (the registry is a client-safe config module).
 */

import { getWorkspaceDefinition, type WorkspaceDataNeed } from "@/lib/perspectives";

/** Shared empty result — a stable reference for "this workspace declares no needs"
 *  (self-fetching workspaces, or an unknown id). Never mutated. */
const NO_NEEDS: ReadonlySet<WorkspaceDataNeed> = new Set<WorkspaceDataNeed>();

/**
 * The declared resource requirements of ONE Workspace, resolved from the canonical
 * registry. Empty for an unknown id or a workspace that self-fetches (e.g. Members,
 * whose widget owns its own fetch — `dataNeeds: []`). This is the reusable primitive:
 * any surface (customer host today, a future Platform host) resolves a workspace's
 * needs through this single function.
 */
export function workspaceDataNeeds(
  workspaceId: string | null | undefined,
): ReadonlySet<WorkspaceDataNeed> {
  if (!workspaceId) return NO_NEEDS;
  const needs = getWorkspaceDefinition(workspaceId)?.dataNeeds;
  return needs && needs.length > 0 ? new Set(needs) : NO_NEEDS;
}

/**
 * The dataNeeds of the Perspective Workspace currently occupying the shell slot —
 * i.e. the OPEN perspective, and only while the Perspectives tab is active (else the
 * empty set). This is the SD-3 replacement for the host's former per-perspective
 * fetch booleans (`cashFlowActive` / `debtWorkspaceActive` / `wealthWorkspaceActive`
 * / `liquidityWorkspaceActive` / `goalsWorkspaceActive` / `investmentsActive`): the
 * host no longer hardcodes "debt ⇒ snapshots" or "cash flow ⇒ transactions" — it
 * asks the registry which resources the open workspace declared, then activates the
 * matching existing loader.
 *
 * SCOPE NOTE (honest, per Addendum II §H): the structural tabs (Overview /
 * Transactions / Accounts) keep their own category-aware activation in the host for
 * now — `dataNeeds` is a resource CEILING (what a workspace MAY consume), not a fetch
 * schedule, and Overview's snapshot/transaction prefetch is category-conditional.
 * Promoting those tabs to fully declarative loading is a later slice (SD-4+); this
 * function deliberately covers only the perspective-driven lazy activation it
 * replaces, so the change is behavior-preserving.
 */
export function openPerspectiveDataNeeds(
  activeTab: string,
  activePerspectiveId: string | null,
): ReadonlySet<WorkspaceDataNeed> {
  if (activeTab !== "PERSPECTIVES") return NO_NEEDS;
  return workspaceDataNeeds(activePerspectiveId);
}
