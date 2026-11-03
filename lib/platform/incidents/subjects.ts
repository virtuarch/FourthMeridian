/**
 * lib/platform/incidents/subjects.ts  (PB-1 S3 — removed-subject facts, batched)
 *
 * The batched lookups the removal rule (subjects-core.ts) reads: subject state
 * (deletedAt / REVOKED / missing), the authoritative OWNER of a subject, and
 * the account subjects named on an episode's occurrences.
 *
 * Write-side only in this slice — consumed by lifecycle.ts. The read-time
 * backstop for the incident readers is Phase 2 (one shared intelligence
 * module), deliberately not here.
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { occurrenceAccountId, type SubjectFacts } from "./subjects-core";

export type SubjectReader = {
  financialAccount: Pick<typeof systemDb.financialAccount, "findMany">;
  plaidItem: Pick<typeof systemDb.plaidItem, "findMany">;
};

/** Batched facts for the subjects these rows (and extra account ids) name. */
export async function loadSubjectFacts(
  rows: readonly { plaidItemId: string | null; financialAccountId: string | null }[],
  client: SubjectReader,
  extraAccountIds: readonly string[] = [],
): Promise<SubjectFacts & { owners: Map<string, string | null> }> {
  const accountIds = [...new Set([...rows.map((r) => r.financialAccountId), ...extraAccountIds].filter((x): x is string => !!x))];
  const itemIds = [...new Set(rows.map((r) => r.plaidItemId).filter((x): x is string => !!x))];
  const [accounts, items] = await Promise.all([
    accountIds.length
      ? client.financialAccount.findMany({ where: { id: { in: accountIds } }, select: { id: true, deletedAt: true, ownerUserId: true, createdByUserId: true } })
      : [],
    itemIds.length ? client.plaidItem.findMany({ where: { id: { in: itemIds } }, select: { id: true, status: true, userId: true } }) : [],
  ]);
  // Owner keyed `item:<id>` / `account:<id>` — the authoritative columns, never `detail`.
  const owners = new Map<string, string | null>();
  for (const a of accounts) owners.set(`account:${a.id}`, a.ownerUserId ?? a.createdByUserId ?? null);
  for (const i of items) owners.set(`item:${i.id}`, i.userId);
  return {
    accountDeletedAt: new Map(accounts.map((a) => [a.id, a.deletedAt] as const)),
    itemStatus: new Map(items.map((i) => [i.id, String(i.status)] as const)),
    owners,
  };
}

/** The authoritative owner of an incident's subject: the item's user, else the account's owner. */
export function ownerOf(
  row: { plaidItemId: string | null; financialAccountId: string | null },
  owners: ReadonlyMap<string, string | null>,
): string | null {
  return (row.plaidItemId ? owners.get(`item:${row.plaidItemId}`) : null)
    ?? (row.financialAccountId ? owners.get(`account:${row.financialAccountId}`) : null)
    ?? null;
}

/**
 * Account subjects named on each episode's occurrences: the structured
 * `subjectAccountId` column (Phase 1), falling back to `detail.financialAccountId`
 * for occurrences written before it existed. `detail` never leaves this function.
 */
export async function loadOccurrenceAccounts(
  incidentIds: readonly string[],
  client: { syncIssueOccurrence: Pick<typeof systemDb.syncIssueOccurrence, "findMany"> },
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (incidentIds.length === 0) return out;
  const occ = await client.syncIssueOccurrence.findMany({
    where: { syncIssueId: { in: [...incidentIds] } },
    select: { syncIssueId: true, subjectAccountId: true, detail: true },
  });
  for (const o of occ) {
    const id = o.subjectAccountId ?? occurrenceAccountId(o.detail);
    if (!id) continue;
    const list = out.get(o.syncIssueId) ?? [];
    if (!list.includes(id)) list.push(id);
    out.set(o.syncIssueId, list);
  }
  return out;
}
