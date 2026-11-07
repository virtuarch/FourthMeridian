/**
 * lib/platform/incidents/related-navigation.ts  (PB-1 — from an incident, navigate to its related records)
 *
 * The "Go to" links of the Platform Ops incident drawer (titled apart from "Related and recurring"). PURE + client-safe:
 * it builds NO href. Every href comes from the caller's `resolve`, which the
 * guarded route binds to `resolveNavigationTarget("<LITERAL SURFACE>", token, …)`
 * (lib/platform/intelligence/navigation/access.ts) with the token it minted
 * from its OWN guard result. A target the resolver refuses (null — invisible to
 * the token on that surface, unknown, or a param its owner's parser would not
 * keep) is simply NOT in the output: no disabled link, no ghost row, no count
 * of what was hidden (no existence oracle).
 *
 * LINKS (target id · params — every param is one its owning parser already reads):
 *   provider-health    PLATFORM_OPS:platform-providers:health · none. The
 *                      Providers lead keeps its drawer in component state; no
 *                      URL param filters it to a provider, so the link is the
 *                      unfiltered view and says so.
 *   connection-health  PLATFORM_OPS:platform-overview:pipeline · none. The
 *                      connection-health widget (ops_connection_health, hosted
 *                      by the Pipeline view) keeps its filter and selection in
 *                      component state; no URL param exists, so the link is the
 *                      unfiltered view and says so. Only when the incident has a
 *                      connection subject.
 *   previous-episode   PLATFORM_OPS:platform-incidents:history · iid (incidents-url.ts,
 *                      the workspace's own drawer param). Only when the verdict
 *                      carries a previousIncidentId.
 *   same-subject-open  PLATFORM_OPS:platform-incidents:open · iid. The OTHER open
 *                      episodes of this incident's key (same provider + subject
 *                      scope + failure), from the investigation's own recurrence
 *                      read — no new query. Capped.
 *   customer-success   CUSTOMER_SUCCESS:platform-incidents:open · iid — the CS
 *                      incidents view opened on THIS incident (an incident id,
 *                      never a customer id). Offered only when the incident has
 *                      one connection subject; rendered only when the resolver
 *                      returns it. The registry hides every CUSTOMER_SUCCESS-tier
 *                      target on any other surface, so on the Ops surface it never
 *                      resolves today — by design (no customer-detail target exists).
 *
 * No user id, connection id or other subject id is ever passed as a param.
 */

import type { IncidentVerdict } from "./intelligence/types";
import type { IncidentDetailDTO } from "./investigation-dto";

export type IncidentNavigationKind = "provider-health" | "connection-health" | "previous-episode" | "same-subject-open" | "customer-success";

export interface IncidentNavigationLinkDTO {
  kind: IncidentNavigationKind;
  label: string;
  /** What the link does NOT do (e.g. no per-provider filter exists), or null. */
  note: string | null;
  /** A resolver href, verbatim. */
  href: string;
  /** For an in-workspace incident link (same surface): the incident it opens, so a plain click can open it in place. */
  incidentId: string | null;
  /**
   * The incidents VIEW that link opens (the target's view id), or null. A plain
   * click opens in place ONLY when this is the drawer's current view — then the
   * in-place state (that view, no filters, iid) IS the href's URL. Any other
   * view: the click follows the href, so the URL always matches the link.
   */
  viewId: string | null;
}

/** The resolver the route binds (string-literal surface + its own token). Null = not rendered. */
export type IncidentNavigationResolver = (targetId: string, params?: Readonly<Record<string, string>>) => { href: string } | null;

/** Registry target ids (pinned against NAVIGATION_TARGETS in the test). */
export const INCIDENT_NAVIGATION_TARGETS = {
  providerHealth: "PLATFORM_OPS:platform-providers:health",
  connectionHealth: "PLATFORM_OPS:platform-overview:pipeline",
  opsIncidentsOpen: "PLATFORM_OPS:platform-incidents:open",
  opsIncidentsHistory: "PLATFORM_OPS:platform-incidents:history",
  csIncidentsOpen: "CUSTOMER_SUCCESS:platform-incidents:open",
} as const;

/** How many same-subject open episodes are linked at most. */
export const SAME_SUBJECT_LINK_CAP = 5;

const OPEN_STATES: ReadonlySet<IncidentVerdict["state"]> = new Set(["active", "acknowledged", "recovering", "stale-unverified"]);

type VerdictFacts = Pick<IncidentVerdict, "id" | "provider" | "state"> & { recurrence: Pick<IncidentVerdict["recurrence"], "previousIncidentId"> };

export interface IncidentNavigationInput {
  verdict: VerdictFacts;
  /** The connection subjects of the incident (IncidentAffected.itemCount). */
  itemCount: number;
  /** Other episodes of the same incident key (IncidentInvestigation.recurrences). */
  recurrences: readonly (Pick<IncidentVerdict, "id" | "state"> & { recurrence: Pick<IncidentVerdict["recurrence"], "generation"> })[];
}

export function incidentNavigationLinks(input: IncidentNavigationInput, resolve: IncidentNavigationResolver): IncidentNavigationLinkDTO[] {
  const v = input.verdict;
  const out: IncidentNavigationLinkDTO[] = [];
  const push = (kind: IncidentNavigationKind, label: string, note: string | null, target: string, incidentId: string | null) => {
    const r = resolve(target, incidentId ? { iid: incidentId } : undefined);
    // The view id is the target id's last segment ("<AREA>:<workspace>:<view>"; pinned against the registry).
    if (r) out.push({ kind, label, note, href: r.href, incidentId, viewId: incidentId ? target.slice(target.lastIndexOf(":") + 1) : null });
  };

  push("provider-health", `${v.provider} provider health`, "Opens the Providers view (it has no per-provider filter).", INCIDENT_NAVIGATION_TARGETS.providerHealth, null);
  if (input.itemCount > 0) {
    push("connection-health", "Connection health", "Opens the fleet connection-health view (it has no per-connection filter).", INCIDENT_NAVIGATION_TARGETS.connectionHealth, null);
  }
  const prev = v.recurrence.previousIncidentId;
  if (prev && prev !== v.id) push("previous-episode", "Previous episode", null, INCIDENT_NAVIGATION_TARGETS.opsIncidentsHistory, prev);

  const seen = new Set<string>([v.id]);
  let n = 0;
  for (const r of input.recurrences) {
    if (n >= SAME_SUBJECT_LINK_CAP) break;
    if (seen.has(r.id) || !OPEN_STATES.has(r.state)) continue;
    seen.add(r.id);
    n++;
    push("same-subject-open", `Episode ${r.recurrence.generation} · open, same subject`, null, INCIDENT_NAVIGATION_TARGETS.opsIncidentsOpen, r.id);
  }

  if (input.itemCount === 1) {
    const r = resolve(INCIDENT_NAVIGATION_TARGETS.csIncidentsOpen, { iid: v.id });
    if (r) out.push({ kind: "customer-success", label: "1 affected customer — open in Customer Success", note: null, href: r.href, incidentId: null, viewId: null });
  }
  return out;
}

// ── The Customer Success drawer ─────────────────────────────────────────────

/**
 * CS-tier targets ONLY (the CS route resolves on the literal surface
 * "CUSTOMER_SUCCESS"; pinned: every id here is a CUSTOMER_SUCCESS-tier target).
 * No Providers / connection-health link: those are Platform Ops destinations,
 * invisible to a CS token. No "open in Customer Success" link: on the CS
 * surface it would be a link to the drawer the operator is already in.
 */
export const CS_INCIDENT_NAVIGATION_TARGETS = {
  incidentsOpen: "CUSTOMER_SUCCESS:platform-incidents:open",
  incidentsHistory: "CUSTOMER_SUCCESS:platform-incidents:history",
} as const;
const CS_TARGET_IDS: ReadonlySet<string> = new Set(Object.values(CS_INCIDENT_NAVIGATION_TARGETS));

/**
 * The CS drawer's "Go to" links, built from the CS-tier DTO ITSELF — so a link
 * can reference only an id that DTO already exposes to this reader:
 *   previous-episode   the DTO's `related` entry of kind PREVIOUS_EPISODE (the
 *                      previousIncidentId chain neighbour) → CS History · iid;
 *   same-subject-open  the DTO's `recurrences` rows that are open → CS Broken now · iid.
 * Never the incident itself, never a customer / connection id, never a
 * non-CS target (refused here before the resolver is asked).
 */
export function csIncidentNavigationLinks(
  d: Pick<IncidentDetailDTO, "incident" | "related" | "recurrences">,
  resolve: IncidentNavigationResolver,
): IncidentNavigationLinkDTO[] {
  const self = d.incident.id;
  const out: IncidentNavigationLinkDTO[] = [];
  const push = (kind: IncidentNavigationKind, label: string, target: string, incidentId: string) => {
    if (!CS_TARGET_IDS.has(target) || incidentId === self) return;
    const r = resolve(target, { iid: incidentId });
    if (r) out.push({ kind, label, note: null, href: r.href, incidentId, viewId: target.slice(target.lastIndexOf(":") + 1) });
  };
  const prev = d.related.find((l) => l.kind === "PREVIOUS_EPISODE");
  if (prev) push("previous-episode", "Previous episode", CS_INCIDENT_NAVIGATION_TARGETS.incidentsHistory, prev.id);
  const seen = new Set<string>([self]);
  let n = 0;
  for (const r of d.recurrences) {
    if (n >= SAME_SUBJECT_LINK_CAP) break;
    if (seen.has(r.id) || !OPEN_STATES.has(r.state)) continue;
    seen.add(r.id);
    n++;
    push("same-subject-open", `Episode ${r.generation} · open, same subject`, CS_INCIDENT_NAVIGATION_TARGETS.incidentsOpen, r.id);
  }
  return out;
}

/**
 * The route's guard against a navigation failure: a registry / builder bug
 * must never hide the incident itself, so any throw yields no links (logged
 * without detail — no ids, no message text).
 */
export function navigationOrEmpty(build: () => IncidentNavigationLinkDTO[]): IncidentNavigationLinkDTO[] {
  try {
    return build();
  } catch {
    console.error("[incidents] related navigation failed; serving the incident without links");
    return [];
  }
}
