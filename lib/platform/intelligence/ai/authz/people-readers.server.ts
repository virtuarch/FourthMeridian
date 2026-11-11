/**
 * lib/platform/intelligence/ai/authz/people-readers.server.ts  (Platform AI — the @ people picker + guard's two reads)
 *
 * Kept OUT of tools/packs/customers.server.ts on purpose: the P5 subject lookups there stay EXACT-only (pinned by
 * authz/subject.test.ts). These are the only two Platform AI reads over customer usernames / emails that are not
 * exact-identifier lookups, each owner-requested (2026-11-10) and S2-conditioned (09fc, 09fl):
 *
 *   searchCustomersByPrefix   the picker (P1 / P5): customers whose USERNAME or EMAIL starts with q (normalised:
 *                             3–64 of [a-z0-9_.+-], no `@`, so an email match is a LOCAL-PART prefix). Never a name
 *                             column. S2 09fl C4: the LIKE pattern is built by likePrefixPattern — `%`, `_` and the
 *                             escape character are ESCAPED (ESCAPE '!'), so a wildcard cannot widen the match and fill
 *                             the bounded row window. Step 1 (raw, parameterised): the ids, role USER (the customer
 *                             population — CUSTOMER_WHERE is `{ role: "USER" }` today), newest first, ≤ 2 × take;
 *                             step 2 (Prisma): the allowlisted select (id, username, email) re-filtered through
 *                             CUSTOMER_WHERE itself — if the population is ever narrowed, step 2 still enforces it.
 *                             Both run under a TRANSACTION-LOCAL statement timeout (SET LOCAL — never a session SET
 *                             through the pooler). authz/people.ts re-applies the strict prefix rule in JS.
 *                             INDEX: none serves a case-insensitive prefix (User_username_key / User_email_key are
 *                             plain btrees) ⇒ a bounded seq scan over User, accepted by S2 at beta scale (no migration).
 *   customerUsernameHit       the guard (G3): ONE exact query — does any customer hold one of these usernames?
 *                             Usernames are stored case-folded (register / profile routes lower-case them). S2 09fl C2:
 *                             the list holds each case-folded token AND its as-typed form, so `username IN (…)` stays
 *                             on the unique index and also catches a legacy row stored exactly as typed. NOT covered
 *                             (no migration): a legacy mixed-case row typed in a DIFFERENT case — S1 checks that count
 *                             in E0-LIVE (rows where username <> lower(username)). A boolean only.
 *
 * fm_system (an operator reaching customers acts outside their own tenancy — the CS routes' reasoning). Never logs.
 */

import "server-only";

import { systemDb } from "@/lib/db";
import { CUSTOMER_WHERE } from "@/lib/platform/customer/population";
import { likePrefixPattern } from "./people";

type Client = typeof systemDb;

/** The picker read's statement timeout (ms). */
export const PEOPLE_SEARCH_STATEMENT_TIMEOUT_MS = 1_500;
/** The guard query's list bound: ≤ 128 case-folded tokens + ≤ 128 as-typed forms. */
export const GUARD_QUERY_MAX = 256;

export async function searchCustomersByPrefix(q: string, take: number, client: Client = systemDb): Promise<{ id: string; username: string | null; email: string }[]> {
  const pattern = likePrefixPattern(q);
  const limit = Math.max(1, Math.min(take, 16)) * 2;
  return client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${PEOPLE_SEARCH_STATEMENT_TIMEOUT_MS}ms'`);
    const ids = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "User"
      WHERE "role" = 'USER'
        AND (lower("username") LIKE ${pattern} ESCAPE '!' OR lower("email") LIKE ${pattern} ESCAPE '!')
      ORDER BY "createdAt" DESC
      LIMIT ${limit}`;
    if (ids.length === 0) return [];
    return tx.user.findMany({
      where: { AND: [CUSTOMER_WHERE, { id: { in: ids.map((r) => r.id) } }] },
      select: { id: true, username: true, email: true },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }, { timeout: PEOPLE_SEARCH_STATEMENT_TIMEOUT_MS * 2 });
}

export async function customerUsernameHit(tokens: readonly string[], client: Client = systemDb): Promise<boolean> {
  const list = [...new Set(tokens.flatMap((t) => [t.toLowerCase(), t]))].slice(0, GUARD_QUERY_MAX);
  if (list.length === 0) return false;
  const row = await client.user.findFirst({ where: { AND: [CUSTOMER_WHERE, { username: { in: list } }] }, select: { id: true } });
  return row !== null;
}
