/**
 * components/platform/incidents/incidents-url.ts  (PB-1 2B — the incidents workspace deep link)
 *
 * The incidents workspace's state lives in the Space URL, so a filtered list
 * and an open incident survive a refresh and are linkable — the PB-9 /
 * AI-budget drilldown idiom (ai-budget-calls-url.ts):
 *
 *   ?workspace=platform-incidents[&view=verify|history]   the status preset (the VIEW)
 *   &isev / iprov / iop / icode / ifrom / ito             the filters
 *   &ipage=2                                              the page
 *   &iid=<incident id>                                    the open detail drawer
 *
 * Written through the ONE URL seam (useSpaceUrl) with REPLACE intent — a
 * filter, a page or an open drawer refines the current entry, never a
 * Back/Forward step. All are workspace-scoped (cleared by a user workspace
 * switch). Values are read with the SAME parser the route validates with
 * (search-core.ts parseIncidentSearch), so the URL can never name a search the
 * server refuses — an unknown value is dropped.
 */

import {
  DEFAULT_SEARCH,
  incidentSearchParams,
  parseIncidentSearch,
} from "@/lib/platform/incidents/intelligence/search-core";
import type { IncidentSearchQuery, IncidentStatusFilter } from "@/lib/platform/incidents/intelligence/types";
import type { IncidentTier } from "@/lib/platform/incidents/investigation-dto";

export const INCIDENTS_WORKSPACE_ID = "platform-incidents";
export const INCIDENTS_URL_PARAMS = ["isev", "iprov", "iop", "icode", "ifrom", "ito", "ipage", "iid"] as const;

/** Each view of the workspace IS one status preset (lib/platform/workspaces.ts). Unknown / summary ⇒ broken-now. */
export const VIEW_STATUS: Readonly<Record<string, IncidentStatusFilter>> = {
  open: "broken-now",
  verify: "needs-verification",
  history: "history",
};
export function statusOfView(viewId: string | null | undefined): IncidentStatusFilter {
  return (viewId && VIEW_STATUS[viewId]) || "broken-now";
}

/** URL key ↔ route param. */
const KEYS: readonly (readonly [(typeof INCIDENTS_URL_PARAMS)[number], string])[] = [
  ["isev", "severity"], ["iprov", "provider"], ["iop", "operation"], ["icode", "code"], ["ifrom", "from"], ["ito", "to"], ["ipage", "page"],
];

export interface IncidentsUrlState {
  query: IncidentSearchQuery;
  /** The open incident, or null. */
  selectedId: string | null;
  /** The URL's `ifrom` was older than the archive retention and was clamped. */
  fromClamped: boolean;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Read the state from a search string for the open view. `nowMs` bounds `ifrom` exactly as the route does. */
export function readIncidentsUrl(search: string, viewId: string | null | undefined, nowMs: number): IncidentsUrlState {
  const p = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const probe = new URLSearchParams();
  probe.set("status", statusOfView(viewId));
  for (const [k, r] of KEYS) { const v = p.get(k); if (v) probe.set(r, v); }
  const { fromClamped, ...query } = parseIncidentSearch(probe, nowMs);
  const id = p.get("iid");
  return { query, selectedId: id && ID.test(id) ? id : null, fromClamped };
}

/** The URL update for a state: defaults delete their keys (a clean URL). The status rides on `view`, never here. */
export function incidentsUrlUpdate(s: IncidentsUrlState): Record<string, string | null> {
  const q = s.query;
  return {
    isev: q.severity, iprov: q.provider, iop: q.operation, icode: q.code, ifrom: q.from, ito: q.to,
    ipage: q.page > 1 ? String(q.page) : null,
    iid: s.selectedId,
  };
}

export function incidentsApiBase(tier: IncidentTier): string {
  return tier === "ops" ? "/api/platform/platform-ops/incidents" : "/api/platform/customer-success/incidents";
}

/** The list route path for a search — the KPI and the list both build theirs here. */
export function incidentsApiPath(tier: IncidentTier, q: IncidentSearchQuery): string {
  return `${incidentsApiBase(tier)}?${incidentSearchParams(q).toString()}`;
}

export function incidentDetailApiPath(tier: IncidentTier, id: string): string {
  return `${incidentsApiBase(tier)}/${encodeURIComponent(id)}`;
}

/**
 * The Operations "broken now" KPI: the default view with no filters. Its
 * figure is this path's `total`; its doorway opens INCIDENTS_WORKSPACE_ID on
 * the default view, whose list reads `incidentsApiPath("ops", readIncidentsUrl("", "open", now).query)`
 * — the same path, so list total = KPI by construction (pinned in incidents-url.test.ts).
 */
export const OPS_BROKEN_NOW_KPI_PATH = incidentsApiPath("ops", DEFAULT_SEARCH);
