/**
 * components/platform/widgets/removed-connections-view.ts  (PB-5)
 *
 * The pure half of the Removed connections list and the operator Remove
 * connection dialog: urls, labels and the confirm copy, provable without a DOM
 * (removed-connections.test.ts). The components only lay these out.
 *
 * Client-safe: imports the pure fold's vocabulary and the reason list only —
 * never a reader, never the database client.
 */

import {
  REMOVED_OUTCOME_LABEL,
  type RemovedBy,
  type RemovedConnectionRow,
  type RemovedOutcome,
  type RemovedProvider,
} from "@/lib/platform/connections/removed-connections.core";
import { REMOVAL_REASON_LABEL, type RemovalReason } from "@/lib/platform/connections/removal-reasons";

export const REMOVED_CONNECTIONS_ROUTE = "/api/platform/platform-ops/removed-connections";
/** The existing retry path for an owed Plaid cleanup — reused, never a second one. */
export const PROVIDER_CLEANUP_RETRY_ROUTE = "/api/platform/platform-ops/provider-cleanup";
export const removeConnectionRoute = (id: string) => `/api/platform/platform-ops/connections/${encodeURIComponent(id)}/remove`;

export interface RemovedFilters {
  provider: RemovedProvider | "";
  outcome: RemovedOutcome | "";
  /** The six characters of an owner reference, or "". */
  owner: string;
  page: number;
}

export const EMPTY_FILTERS: RemovedFilters = { provider: "", outcome: "", owner: "", page: 1 };
export const REMOVED_LIST_PAGE_SIZE = 25;

/** The list url. `nonce` forces a re-read after an action (the keyed fetch reloads on a new url). */
export function removedConnectionsUrl(f: RemovedFilters, nonce = 0): string {
  const p = new URLSearchParams();
  if (f.provider) p.set("provider", f.provider);
  if (f.outcome) p.set("outcome", f.outcome);
  if (f.owner) p.set("owner", f.owner);
  p.set("page", String(f.page));
  p.set("pageSize", String(REMOVED_LIST_PAGE_SIZE));
  if (nonce > 0) p.set("n", String(nonce));
  return `${REMOVED_CONNECTIONS_ROUTE}?${p.toString()}`;
}

/** "user …abc123" → "abc123" (the owner filter's token); null for anything else. */
export function ownerTokenOf(ownerRef: string): string | null {
  const m = /^user …([A-Za-z0-9_-]{6})$/.exec(ownerRef);
  return m ? m[1] : null;
}

export function outcomeLabel(o: RemovedOutcome): string {
  return REMOVED_OUTCOME_LABEL[o];
}

export function removedByLabel(by: RemovedBy): string {
  switch (by.kind) {
    case "OPERATOR": return `Removed by operator ${by.operator}`;
    case "CUSTOMER": return by.attribution === "RECORDED" ? "Removed by the customer" : "Removed by the customer (inferred)";
    case "PROVIDER": return "Revoked at the institution";
    case "SYSTEM":   return "Removed by the system";
    case "UNKNOWN":  return "Not recorded";
  }
}

/** The reason an operator removal carried, in words (null when none / not an operator removal). */
export function removalReasonLabel(by: RemovedBy): string | null {
  if (by.kind !== "OPERATOR" || !by.reason) return null;
  return REMOVAL_REASON_LABEL[by.reason as RemovalReason] ?? by.reason;
}

/** Tone for the outcome chip: owed is the one that needs someone. */
export function outcomeTone(o: RemovedOutcome): "danger" | "ok" | "muted" {
  if (o === "CLEANUP_OWED") return "danger";
  if (o === "CONFIRMED_REMOVED" || o === "ALREADY_GONE") return "ok";
  return "muted";
}

/** Rows the CS owner-label route can resolve (it keys on `source:id`). */
export function ownerLookupRows(rows: readonly RemovedConnectionRow[]): { source: RemovedProvider; id: string }[] {
  return rows.filter((r) => !r.itemGone).map((r) => ({ source: r.provider, id: r.id }));
}

/**
 * S2 flag 1 — the one-line consequence statement, shown above the typed
 * confirmation. Plaid's wording is the reviewer's, verbatim.
 */
export function removeConsequenceLine(provider: RemovedProvider): string {
  return provider === "PLAID"
    ? "Removes the bank link at Plaid; the customer must reconnect; history is kept."
    : "Stops tracking this wallet; the customer must add it again; history is kept.";
}

/**
 * S2 flag 1 — Confirm enables only when the operator has TYPED the institution
 * name (trimmed, case-insensitive, whitespace-collapsed) AND picked a reason.
 * The server does not trust this: it keeps the SYSTEM_ADMIN + live re-check
 * gate and refuses a missing reason itself.
 */
export function canConfirmRemoval(input: { typed: string; source: string; reason: string }): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  return input.reason !== "" && norm(input.source) !== "" && norm(input.typed) === norm(input.source);
}

/**
 * The confirm dialog's message — the customer and the institution by name, so
 * an operator cannot remove the wrong one by misreading a row. `owner` is the
 * Customer Success label when resolved, else the opaque reference.
 */
export function removeConfirmMessage(input: { owner: string; source: string; provider: RemovedProvider }): string {
  const what = input.provider === "WALLET" ? `the wallet ${input.source}` : input.source;
  return `Remove ${what} from ${input.owner}'s account? Their accounts on it stop syncing and leave every Space` +
    (input.provider === "PLAID" ? ", and Plaid is asked to delete the connection. That cannot be undone" : "") +
    ". History is kept. The customer is told by email and in-app that support removed it.";
}
