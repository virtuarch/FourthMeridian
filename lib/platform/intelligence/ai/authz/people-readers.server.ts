/**
 * lib/platform/intelligence/ai/authz/people-readers.server.ts  (Platform AI — the @ people picker + guard's two reads)
 *
 * Kept OUT of tools/packs/customers.server.ts on purpose: the P5 subject lookups there stay EXACT-only (pinned by
 * authz/subject.test.ts). These are the only two Platform AI reads over customer usernames / emails that are not
 * exact-identifier lookups, each owner-requested (2026-11-10) and S2-conditioned (09fc):
 *
 *   searchCustomersByPrefix   the picker (P1 / P5): customers (CUSTOMER_WHERE — never an operator or a System
 *                             Admin) whose USERNAME or EMAIL starts with q (normalised: 3–64 of [a-z0-9._+-], no
 *                             `@`, so an email match is a LOCAL-PART prefix). Never a name column. Allowlisted
 *                             select (id, username, email); at most 2 × take rows (authz/people.ts re-applies the
 *                             strict prefix rule — Prisma's LIKE treats `_` as a wildcard); under a TRANSACTION-
 *                             LOCAL statement timeout (SET LOCAL — never a session SET through the pooler).
 *                             INDEX: none serves a case-insensitive prefix (User_username_key / User_email_key are
 *                             plain btrees) ⇒ a bounded seq scan over User, accepted by S2 at beta scale (no migration).
 *   customerUsernameHit       the guard (G3): ONE exact query — does any customer hold one of these usernames?
 *                             Usernames are stored case-folded (register / profile routes lower-case them), so the
 *                             case-folded tokens are `username IN (…)` on the unique index. A boolean only.
 *
 * fm_system (an operator reaching customers acts outside their own tenancy — the CS routes' reasoning). Never logs.
 */

import "server-only";

import { systemDb } from "@/lib/db";
import { CUSTOMER_WHERE } from "@/lib/platform/customer/population";

type Client = typeof systemDb;

/** The picker read's statement timeout (ms). */
export const PEOPLE_SEARCH_STATEMENT_TIMEOUT_MS = 1_500;

export async function searchCustomersByPrefix(q: string, take: number, client: Client = systemDb): Promise<{ id: string; username: string | null; email: string }[]> {
  return client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${PEOPLE_SEARCH_STATEMENT_TIMEOUT_MS}ms'`);
    return tx.user.findMany({
      where: { AND: [CUSTOMER_WHERE, { OR: [{ username: { startsWith: q, mode: "insensitive" } }, { email: { startsWith: q, mode: "insensitive" } }] }] },
      select: { id: true, username: true, email: true },
      orderBy: { createdAt: "desc" },
      take: Math.max(1, Math.min(take, 16)) * 2,
    });
  }, { timeout: PEOPLE_SEARCH_STATEMENT_TIMEOUT_MS * 2 });
}

export async function customerUsernameHit(tokens: readonly string[], client: Client = systemDb): Promise<boolean> {
  const list = [...new Set(tokens.map((t) => t.toLowerCase()))].slice(0, 128);
  if (list.length === 0) return false;
  const row = await client.user.findFirst({ where: { AND: [CUSTOMER_WHERE, { username: { in: list } }] }, select: { id: true } });
  return row !== null;
}
