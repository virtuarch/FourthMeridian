/**
 * lib/platform/customer/connection-owners.ts  (UX-P1 — owner decision D4)
 *
 * WHO OWNS A CONNECTION, answered by the one Platform area the owner ruled may
 * resolve customer identity: CUSTOMER_SUCCESS. The Platform Operations
 * connection-health projection (lib/connections/health.ts) carries no userId
 * and no email by design; a surface that holds BOTH grants asks THIS reader,
 * through its own CUSTOMER_SUCCESS-gated route, for the owner labels of the
 * rows it already has. The two readers never merge: a PLATFORM_OPS-only
 * operator gets a 403 here and the surface renders no owner column at all —
 * not blank, not an id.
 *
 * THE LABEL IS THE P1 IDENTITY RULING (identity-label.ts): username → name →
 * an opaque `user …<last6>`. Never the email, which stays in the Customer
 * Success detail. The select below names id / username / name and nothing
 * else — the privacy source-scan (lib/platform/observability-privacy.test.ts)
 * pins that no `email: true` ever appears in this file.
 *
 * The join path is the FK the schema already indexes: PlaidItem.userId and
 * Connection.userId → User. Not AccountConnection / SpaceAccountLink, which
 * answer "which Space", not "which customer".
 *
 * fm_system: an operator reaching a customer is acting outside their own
 * tenancy by definition (same reasoning as customers.ts).
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { operatorDisplayName, type OperatorIdentityLike } from "./identity-label";

/** The connection-health row's own `source` vocabulary. PLAID rows live in PlaidItem; the rest in Connection. */
export const CONNECTION_OWNER_SOURCES = ["PLAID", "WALLET", "EXCHANGE", "BROKERAGE"] as const;
export type ConnectionOwnerSource = (typeof CONNECTION_OWNER_SOURCES)[number];

/** Upper bound on one request — the health list is capped at 20; 50 leaves room without inviting a fleet scan. */
export const CONNECTION_OWNERS_MAX = 50;

/** Ids are cuids / provider ids: a bounded, URL-safe token. Anything else is a malformed request. */
const ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

export interface ConnectionRef { source: ConnectionOwnerSource; id: string }

export interface ConnectionOwner {
  source: ConnectionOwnerSource;
  id: string;
  /** The display label only — never an email, never a user id. */
  owner: { label: string };
}

export interface ConnectionOwnersResult {
  owners: ConnectionOwner[];
  checkedAt: string;
}

export function isConnectionOwnerSource(s: string): s is ConnectionOwnerSource {
  return (CONNECTION_OWNER_SOURCES as readonly string[]).includes(s);
}

/**
 * Parse the request's `source:id` pairs. Returns the refs, or the reason the
 * request is malformed (the route answers 400 with it). Duplicates collapse.
 */
export function parseConnectionRefs(pairs: readonly string[]): { refs: ConnectionRef[] } | { error: string } {
  if (pairs.length === 0) return { error: "ids required" };
  if (pairs.length > CONNECTION_OWNERS_MAX) return { error: `at most ${CONNECTION_OWNERS_MAX} ids per request` };
  const seen = new Set<string>();
  const refs: ConnectionRef[] = [];
  for (const raw of pairs) {
    const at = raw.indexOf(":");
    if (at <= 0) return { error: `malformed id "${raw}" (expected source:id)` };
    const source = raw.slice(0, at);
    const id = raw.slice(at + 1);
    if (!isConnectionOwnerSource(source)) return { error: `unknown source "${source}"` };
    if (!ID_SHAPE.test(id)) return { error: "malformed id" };
    const key = `${source}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ source, id });
  }
  return { refs };
}

/** What the reader fetches per table: the connection id and its owner's identity triple. */
export interface OwnedRow { id: string; user: OperatorIdentityLike }

/**
 * The pure projection: every requested ref that was found gets exactly
 * `{ source, id, owner: { label } }`. A ref with no row (unknown id, or a row
 * the other table holds) is OMITTED — the surface then shows "owner not
 * resolved" for that row rather than a guess. Extra fields on the input user
 * (an email a careless caller passed through) never reach the output: the
 * label is the only thing read.
 */
export function projectConnectionOwners(
  refs: readonly ConnectionRef[],
  plaidRows: readonly OwnedRow[],
  connectionRows: readonly OwnedRow[],
): ConnectionOwner[] {
  const plaidBy = new Map(plaidRows.map((r) => [r.id, r.user] as const));
  const connBy = new Map(connectionRows.map((r) => [r.id, r.user] as const));
  const out: ConnectionOwner[] = [];
  for (const ref of refs) {
    const user = ref.source === "PLAID" ? plaidBy.get(ref.id) : connBy.get(ref.id);
    if (!user) continue;
    out.push({ source: ref.source, id: ref.id, owner: { label: operatorDisplayName({ id: user.id, username: user.username, name: user.name }) } });
  }
  return out;
}

/** The reader. Bounded by the parsed refs (≤ CONNECTION_OWNERS_MAX); selects id / username / name only. */
export async function getConnectionOwners(
  refs: readonly ConnectionRef[],
  client = systemDb,
  now: Date = new Date(),
): Promise<ConnectionOwnersResult> {
  const plaidIds = refs.filter((r) => r.source === "PLAID").map((r) => r.id);
  const connIds = refs.filter((r) => r.source !== "PLAID").map((r) => r.id);
  const [plaidRows, connectionRows] = await Promise.all([
    plaidIds.length === 0 ? Promise.resolve([] as OwnedRow[]) : client.plaidItem.findMany({
      where: { id: { in: plaidIds } },
      select: { id: true, user: { select: { id: true, username: true, name: true } } },
    }),
    connIds.length === 0 ? Promise.resolve([] as OwnedRow[]) : client.connection.findMany({
      where: { id: { in: connIds } },
      select: { id: true, user: { select: { id: true, username: true, name: true } } },
    }),
  ]);
  return { owners: projectConnectionOwners(refs, plaidRows, connectionRows), checkedAt: now.toISOString() };
}
