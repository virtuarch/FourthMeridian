/**
 * lib/platform/customer/attention-core.ts  (PB-4 — Customer Success "who needs help", pure)
 *
 * THE ONE DEFINITION of why an active customer needs help. Both readers fold
 * the same facts through `foldAttention`:
 *
 *   • the overview (lib/platform/customer/overview-core.ts) — COUNTS per reason
 *     and the distinct-customer headline; no identity leaves it;
 *   • the audited Customers list (lib/platform/customer/customers.ts) — the
 *     reasons ON each row (`attention`) and the `attention=<key|any>` filter.
 *
 * So the panel's "3 need reconnecting" and the list filtered to that reason are
 * the same set by construction — there is no second definition to drift.
 *
 * Who is in scope: ACTIVE role-USER customers only (`activeCustomerIds`). An
 * owner fact about anyone else (a deactivated account, an operator) is dropped
 * here, once, for both readers.
 *
 * ONBOARDING REASONS (2026-11-09) — `no_connection_24h`, `link_exited`,
 * `import_failed` and `import_stuck` read only existing facts: the funnel's
 * connection facts, the CONNECTION_LINK_EXITED product events (closed codes
 * only) and the import-status rule's verdicts. Each reason carries a TEXT-ONLY
 * suggested next step (ATTENTION_ACTIONS); none of them contacts a customer.
 * Reserved-domain accounts are LABELLED test, never excluded (OD-4 undecided).
 *
 * Pure: no I/O, no clock of its own (`now` is handed in).
 */

import type { CsIncidentVerdict } from "@/lib/platform/incidents/intelligence/types";
import { ABANDONMENT_HORIZON_DAYS, FUNNEL_STAGE_ORDER, firstConnections } from "@/lib/platform/growth/product-analytics-core";
import { funnelThrough, type CohortFunnelFacts } from "@/lib/platform/growth/acquisition-core";
import { IMPORT_REASON_SHORT, type ImportReasonCategory, type ImportVerdict } from "@/lib/platform/onboarding/import-status-core";
import type { AttentionFilter, AttentionKey } from "./overview-types";
import { ATTENTION_KEYS } from "./attention-keys";

// The keys and the one filter parser live in the import-free attention-keys.ts (the client uses them too).
export { ATTENTION_KEYS, parseAttentionFilter } from "./attention-keys";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** `no_connection_24h` fires this long after registering (until `stalled` takes over at ABANDONMENT_HORIZON_DAYS). */
export const NO_CONNECTION_AFTER_HOURS = 24;
/** `link_exited` looks back this far for a Plaid Link exit. */
export const LINK_EXIT_WINDOW_DAYS = 7;
/** `import_failed` / `import_stuck` read bank connections linked this recently (the onboarding import window). */
export const IMPORT_ATTENTION_DAYS = 14;

export const ATTENTION_LABELS: Readonly<Record<AttentionKey, string>> = {
  reconnect: "A connection needs reconnecting",
  incident: "An active sync incident",
  // PB-4 (owner, 2026-11-02) — a customer with NO assignment resolves to the
  // catalogue default and works; that is not "missing". Only an assignment that
  // names a group which is unknown, has an invalid stored definition, or is
  // retired (archived — no longer offered) is a reason to help.
  policy: "Assigned policy group is unknown, invalid or retired",
  // S2 ruling (2026-11-02) — an UNASSIGNED customer needs help only while the
  // fail-closed switch is ENFORCED: then they are restricted right now. A
  // separate key (not `policy`) because it is a different fix (assign a group
  // vs. correct a broken one), it has its own label, and it mirrors the Platform
  // Ops alert's own UNASSIGNED / UNKNOWN_POLICY_GROUP split.
  unassigned: "No policy group assigned (fail-closed: access restricted)",
  stalled: `Stalled before first connection, ${ABANDONMENT_HORIZON_DAYS}+ days after registering`,
  import_failed: `A new bank connection's first import failed (linked in the last ${IMPORT_ATTENTION_DAYS} days)`,
  import_stuck: "A new bank connection's first import was interrupted (a resume is pending)",
  link_exited: `Left bank linking without connecting (last ${LINK_EXIT_WINDOW_DAYS} days), no connection since`,
  no_connection_24h: `No connection or account yet, ${NO_CONNECTION_AFTER_HOURS} h – ${ABANDONMENT_HORIZON_DAYS} days after registering`,
};

/** The chip word on a Customers-list row. */
export const ATTENTION_SHORT: Readonly<Record<AttentionKey, string>> = {
  reconnect: "Reconnect",
  incident: "Sync incident",
  policy: "Policy group",
  unassigned: "No policy group",
  stalled: "Stalled",
  import_failed: "Import failed",
  import_stuck: "Import interrupted",
  link_exited: "Left linking",
  no_connection_24h: "No connection yet",
};

/** Said by every action that might lead to a customer conversation: the operator does not reach out on their own. */
export const CONTACT_REQUIRES_APPROVAL = "Customer contact requires owner approval.";

/**
 * The suggested next step per reason — TEXT ONLY, for the operator. Nothing in
 * Customer Success sends anything to a customer, and no action here tells the
 * operator to contact one without approval (S2 condition d).
 */
export const ATTENTION_ACTIONS: Readonly<Record<AttentionKey, string>> = {
  reconnect: `Review the connection's status in the customer's profile; only the customer can reconnect it from Connections. ${CONTACT_REQUIRES_APPROVAL}`,
  incident: `Open the incident in Incidents and follow its diagnosis; it may clear on its own once the provider recovers. ${CONTACT_REQUIRES_APPROVAL}`,
  import_failed: `Review the failure reason in the customer's Onboarding timeline and check provider status first. ${CONTACT_REQUIRES_APPROVAL}`,
  import_stuck: `Check the import's latest run in the Onboarding timeline; a resume is pending, so re-check before escalating. ${CONTACT_REQUIRES_APPROVAL}`,
  link_exited: `Review the exit code: an institution or provider code points at the bank's side, a credentials or MFA code at the sign-in step. ${CONTACT_REQUIRES_APPROVAL}`,
  policy: "Assign a current policy group in Policies (the assigned one is unknown, invalid or retired).",
  unassigned: "Assign a policy group in Policies; access stays restricted until then.",
  no_connection_24h: `Review the invitation and registration in the customer's profile and note them for onboarding follow-up. ${CONTACT_REQUIRES_APPROVAL}`,
  stalled: `Review the registration and the furthest onboarding stage reached; flag for owner-approved follow-up. ${CONTACT_REQUIRES_APPROVAL}`,
};

/** One recorded Plaid Link exit (CONNECTION_LINK_EXITED): closed-vocabulary codes only, never a message or an institution. */
export interface LinkExitFact {
  userId: string;
  at: Date;
  /** LINK_EXIT_STAGES value (lib/analytics/product-events.ts), or null when the row carries none. */
  stage: string | null;
  /** LINK_EXIT_ERROR_CODES value ("NONE" = a clean cancel), or null when the row carries none. */
  errorCode: string | null;
}

/** One recent bank connection's import verdict, with its owner (import-facts.ts). */
export interface ImportAttentionFact {
  userId: string;
  verdict: Pick<ImportVerdict, "status" | "interrupted" | "reason">;
}

export interface AttentionFacts {
  /** Active (not deactivated) role-USER accounts — the only population that can need help. */
  activeCustomerIds: ReadonlySet<string>;
  funnel: CohortFunnelFacts;
  /** Owners of a NEEDS_REAUTH / ERROR Plaid Item or live-provider Connection. */
  reconnectOwners: readonly string[];
  /** Owners of a broken-now sync incident — the module's attribution (incidentOwnersOf, PB-1 R6b). */
  incidentOwners: readonly string[];
  /** Customers whose assignment names an unknown, invalid or retired policy group (never the unassigned default). */
  policyIssueOwners: readonly string[];
  /**
   * Customers with NO assignment, and whether the fail-closed switch is ENFORCED
   * (the resolver's own mode, entitlementLoadOptions().failClosed). They are a
   * reason only when enforced. Optional so a caller without them flags nobody.
   */
  unassignedOwners?: readonly string[];
  policyFailClosed?: boolean;
  /**
   * Import verdicts of bank connections linked in the last IMPORT_ATTENTION_DAYS
   * (import-status-core — the one rule). Optional: a caller without them flags nobody.
   */
  recentImports?: readonly ImportAttentionFact[];
  /** CONNECTION_LINK_EXITED rows of the last LINK_EXIT_WINDOW_DAYS (codes only). Optional, as above. */
  linkExits?: readonly LinkExitFact[];
  /** Active customers with a reserved test e-mail domain — a LABEL (OD-4 undecided), never an exclusion. */
  testAccountIds?: readonly string[];
  /** True when a fleet read hit its row cap: every set is then a floor. */
  floor?: boolean;
}

export interface AttentionFold {
  /** Per reason, the active customers it applies to. */
  sets: Readonly<Record<AttentionKey, ReadonlySet<string>>>;
  /** Active customers with at least one reason. */
  union: ReadonlySet<string>;
  /** The reasons that apply in this mode, in display order (`unassigned` only while fail-closed is enforced). */
  keys: readonly AttentionKey[];
  /** Every count is a floor ("≥N") — a fleet read hit its cap. */
  floor: boolean;
  /** The funnel restricted to active customers, and its strict fold (the overview's stage distribution reuses both). */
  activeFunnel: CohortFunnelFacts;
  through: ReadonlyMap<string, number>;
  /**
   * Per customer, a short closed-vocabulary detail for a reason (an exit code,
   * an import reason category in words). Never an institution, a message or a figure.
   */
  details: ReadonlyMap<string, Partial<Record<AttentionKey, string>>>;
  /** Every active customer labelled test (reserved e-mail domain) — still counted (OD-4). */
  testAccounts: ReadonlySet<string>;
  /** Of `union`, the customers labelled test. */
  testInUnion: ReadonlySet<string>;
}

const CODE = /^[A-Z_]{1,64}$/;

/** A Link-exit AuditLog row → its codes: the writer's allowlisted `stage` / `errorCode` strings only — nothing else is read out of metadata. */
export function linkExitFactOf(row: { userId: string | null; createdAt: Date; metadata: unknown }): LinkExitFact | null {
  if (!row.userId) return null;
  const m = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? (row.metadata as Record<string, unknown>) : {};
  const str = (v: unknown) => (typeof v === "string" && v.length <= 64 ? v : null);
  return { userId: row.userId, at: row.createdAt, stage: str(m.stage), errorCode: str(m.errorCode) };
}

/** The exit detail in words, from the closed vocabularies only (anything else reads "OTHER"). */
export function linkExitDetail(e: Pick<LinkExitFact, "stage" | "errorCode">): string {
  const code = e.errorCode && CODE.test(e.errorCode) ? e.errorCode : "OTHER";
  const stage = e.stage && CODE.test(e.stage) ? e.stage : "NONE";
  const what = code === "NONE" ? "closed without an error" : `exit code ${code}`;
  return stage === "NONE" ? what : `${what} at ${stage}`;
}

const importDetail = (reason: ImportReasonCategory | null): string | undefined => (reason ? IMPORT_REASON_SHORT[reason] : undefined);

/**
 * PB-1 R6b — the `incident` reason's owners, from the incident-intelligence
 * module's CUSTOMER_SUCCESS-tier verdicts ONLY: a verdict counts when the module
 * says it is broken now (D1/D2/D2b/D10 decided there), and its owner is the
 * module's ONE attribution (`subjectUserId`, D4 — recorded at observation, else
 * item owner, else account owner ?? creator). No item / account lookup and no
 * owner rule here; an unattributable incident names no one.
 */
export function incidentOwnersOf(verdicts: readonly Pick<CsIncidentVerdict, "brokenNow" | "subjectUserId">[]): string[] {
  return verdicts.flatMap((v) => (v.brokenNow && v.subjectUserId ? [v.subjectUserId] : []));
}

export function foldAttention(facts: AttentionFacts, now: Date): AttentionFold {
  const active = facts.activeCustomerIds;
  const activeFunnel: CohortFunnelFacts = { ...facts.funnel, users: facts.funnel.users.filter((u) => active.has(u.id)) };
  const through = funnelThrough(activeFunnel);

  const connIdx = FUNNEL_STAGE_ORDER.indexOf("firstConnection");
  const horizon = now.getTime() - ABANDONMENT_HORIZON_DAYS * DAY_MS;
  const stalled = activeFunnel.users.filter((u) => (through.get(u.id) ?? 0) < connIdx && u.createdAt.getTime() <= horizon).map((u) => u.id);

  // no_connection_24h — LITERALLY no connection or account yet (any Plaid Item, wallet or manual
  // asset, revoked included — firstConnections, the funnel's own rule), registered in
  // (now − 7 d, now − 24 h]. From 7 days on `stalled` takes over, so the two never name one customer.
  const firstConn = firstConnections(activeFunnel);
  const after24h = now.getTime() - NO_CONNECTION_AFTER_HOURS * HOUR_MS;
  const noConnection = activeFunnel.users
    .filter((u) => !firstConn.has(u.id) && u.createdAt.getTime() <= after24h && u.createdAt.getTime() > horizon)
    .map((u) => u.id);

  const details = new Map<string, Partial<Record<AttentionKey, string>>>();
  const detail = (id: string, k: AttentionKey, text: string | undefined) => {
    if (text && !details.get(id)?.[k]) details.set(id, { ...(details.get(id) ?? {}), [k]: text });
  };

  // link_exited — the customer's LATEST Link exit in the window, with no connection made at or after it.
  const lastConn = new Map<string, number>();
  const connected = (id: string | null | undefined, at: Date | string) => {
    if (!id) return;
    const t = (typeof at === "string" ? new Date(at) : at).getTime();
    if (t > (lastConn.get(id) ?? -Infinity)) lastConn.set(id, t);
  };
  for (const p of activeFunnel.plaidItems) connected(p.userId, p.createdAt);
  for (const w of activeFunnel.walletConnections) connected(w.userId, w.createdAt);
  for (const m of activeFunnel.manualAssets) connected(m.userId, m.createdAt);
  const exitFrom = now.getTime() - LINK_EXIT_WINDOW_DAYS * DAY_MS;
  const latestExit = new Map<string, LinkExitFact>();
  for (const e of facts.linkExits ?? []) {
    const t = e.at.getTime();
    if (t < exitFrom || t > now.getTime() || !active.has(e.userId)) continue;
    const cur = latestExit.get(e.userId);
    if (!cur || t > cur.at.getTime()) latestExit.set(e.userId, e);
  }
  const linkExited: string[] = [];
  for (const [id, e] of latestExit) {
    if ((lastConn.get(id) ?? -Infinity) >= e.at.getTime()) continue;
    linkExited.push(id);
    detail(id, "link_exited", linkExitDetail(e));
  }

  // import_failed / import_stuck — the import-status rule's own verdicts: failed, or in progress
  // with its newest run failed (interrupted). Removed / complete / recovered are not a reason.
  const importFailed: string[] = [];
  const importStuck: string[] = [];
  for (const i of facts.recentImports ?? []) {
    if (!active.has(i.userId)) continue;
    if (i.verdict.status === "failed") {
      importFailed.push(i.userId);
      detail(i.userId, "import_failed", importDetail(i.verdict.reason));
    } else if (i.verdict.status === "in_progress" && i.verdict.interrupted) {
      importStuck.push(i.userId);
      detail(i.userId, "import_stuck", importDetail(i.verdict.reason));
    }
  }

  const only = (ids: readonly string[]) => new Set(ids.filter((id) => active.has(id)));
  const sets: Record<AttentionKey, Set<string>> = {
    reconnect: only(facts.reconnectOwners),
    incident: only(facts.incidentOwners),
    import_failed: only(importFailed),
    import_stuck: only(importStuck),
    link_exited: only(linkExited),
    policy: only(facts.policyIssueOwners),
    unassigned: facts.policyFailClosed === true ? only(facts.unassignedOwners ?? []) : new Set<string>(),
    no_connection_24h: only(noConnection),
    stalled: only(stalled),
  };
  const keys = ATTENTION_KEYS.filter((k) => k !== "unassigned" || facts.policyFailClosed === true);
  const union = new Set<string>();
  for (const k of keys) for (const id of sets[k]) union.add(id);
  const testAccounts = only(facts.testAccountIds ?? []);
  const testInUnion = new Set([...union].filter((id) => testAccounts.has(id)));
  return { sets, union, keys, floor: facts.floor === true, activeFunnel, through, details, testAccounts, testInUnion };
}

/** One customer's per-reason details (closed vocabulary; {} when none). */
export function attentionDetailOf(fold: AttentionFold, userId: string): Partial<Record<AttentionKey, string>> {
  return { ...(fold.details.get(userId) ?? {}) };
}

/** One customer's reasons, in display order ([] = needs no help, or not an active customer). */
export function attentionOf(fold: AttentionFold, userId: string): AttentionKey[] {
  return fold.keys.filter((k) => fold.sets[k].has(userId));
}

/** The customers a filter selects: one reason's set, or the union for "any". */
export function idsForAttention(fold: AttentionFold, filter: AttentionFilter): ReadonlySet<string> {
  return filter === "any" ? fold.union : fold.sets[filter];
}
