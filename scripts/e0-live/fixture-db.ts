/**
 * scripts/e0-live/fixture-db.ts — discovery by tag, drift hashing and the
 * tag ∩ manifest teardown, over a CALLER-OWNED Prisma transaction client.
 *
 * No Prisma client is constructed here and nothing is imported at runtime from
 * the repo (the `Prisma` import is type-only and erased). seed.ts / teardown.ts
 * pass their transaction in AFTER the guard. Counts only; never an id, a name,
 * an address or a payload is printed.
 *
 * Deliberately NOT touched (disclosed): AuditLog (append-only — R-6; userId → NULL
 * when the fixture user goes), AiInvocation (cost ledger), and any SyncIssueEvent a
 * run's operator action wrote on a fixture incident (scripts/ may not write or
 * delete that table — the incident-boundary census; counted as left in place).
 */

import type { Prisma } from "@prisma/client";
import {
  DRIFT_SELECT, MANIFEST_TABLES, emptyIds, matchTagToManifest, rowHash, tagWhere,
  type DriftTable, type E0LiveManifest, type ManifestTable, type TagManifestMatch,
} from "./fixture-common";

type Tx = Prisma.TransactionClient;

/** Every fixture row found BY TAG (or by a tagged owner), per manifest table. */
export async function discoverByTag(tx: Tx, tag: string): Promise<Record<ManifestTable, string[]>> {
  const w = tagWhere(tag);
  const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();
  const out = emptyIds();
  out.user = ids(await tx.user.findMany({ where: w.user, select: { id: true } }));
  const owners = { in: out.user };
  out.plaidItem = ids(await tx.plaidItem.findMany({ where: { OR: [w.plaidItem, { userId: owners }] }, select: { id: true } }));
  out.connection = ids(await tx.connection.findMany({ where: { OR: [w.connection, { userId: owners }] }, select: { id: true } }));
  out.userSession = ids(await tx.userSession.findMany({ where: { OR: [w.userSession, { userId: owners }] }, select: { id: true } }));
  out.betaAccessRequest = ids(await tx.betaAccessRequest.findMany({ where: w.betaAccessRequest, select: { id: true } }));
  out.customerPolicyAssignment = ids(await tx.customerPolicyAssignment.findMany({ where: { userId: owners }, select: { id: true } }));
  out.financialAccount = ids(await tx.financialAccount.findMany({ where: { OR: [{ ownerUserId: owners }, { createdByUserId: owners }] }, select: { id: true } }));
  out.accountConnection = ids(await tx.accountConnection.findMany({
    where: { OR: [{ financialAccountId: { in: out.financialAccount } }, { connectedByUserId: owners }] }, select: { id: true },
  }));
  out.syncIssue = ids(await tx.syncIssue.findMany({
    where: { OR: [w.syncIssue, { subjectUserId: owners }, { plaidItemId: { in: out.plaidItem } }] }, select: { id: true },
  }));
  return out;
}

/** The total of tagged rows (the teardown post-check requires 0). */
export async function tagRowCount(tx: Tx, tag: string): Promise<number> {
  const found = await discoverByTag(tx, tag);
  return MANIFEST_TABLES.reduce((n, t) => n + found[t].length, 0);
}

/** sha256 of each row's DRIFT_SELECT columns, by table then id (hashes only). */
export async function readDriftHashes(tx: Tx, ids: Record<ManifestTable, readonly string[]>): Promise<Partial<Record<DriftTable, Record<string, string>>>> {
  const hash = (rows: Array<Record<string, unknown> & { id: string }>) => Object.fromEntries(rows.map((r) => [r.id, rowHash(r)]));
  const inIds = (t: ManifestTable) => ({ id: { in: [...ids[t]] } });
  return {
    user: hash(await tx.user.findMany({ where: inIds("user"), select: DRIFT_SELECT.user })),
    plaidItem: hash(await tx.plaidItem.findMany({ where: inIds("plaidItem"), select: DRIFT_SELECT.plaidItem })),
    connection: hash(await tx.connection.findMany({ where: inIds("connection"), select: DRIFT_SELECT.connection })),
    financialAccount: hash(await tx.financialAccount.findMany({ where: inIds("financialAccount"), select: DRIFT_SELECT.financialAccount })),
    syncIssue: hash(await tx.syncIssue.findMany({ where: inIds("syncIssue"), select: DRIFT_SELECT.syncIssue })),
  };
}

/** Rows deliberately left in place (disclosed in the teardown output). Counts only. */
export async function leftInPlace(tx: Tx, manifest: E0LiveManifest): Promise<Record<string, number>> {
  return {
    "AuditLog (append-only; userId → NULL)": await tx.auditLog.count({ where: { userId: { in: manifest.ids.user } } }),
    "AiInvocation (cost ledger)": await tx.aiInvocation.count({ where: { userId: { in: manifest.ids.user } } }),
    "SyncIssueEvent on fixture incidents (scripts/ may not delete)": await tx.syncIssueEvent.count({ where: { incidentId: { in: manifest.ids.syncIssue } } }),
  };
}

export interface TeardownPreview { match: TagManifestMatch; counts: Record<ManifestTable, number> }

export async function previewTeardown(tx: Tx, manifest: E0LiveManifest): Promise<TeardownPreview> {
  const found = await discoverByTag(tx, manifest.tag);
  const match = matchTagToManifest(found, manifest);
  const counts = Object.fromEntries(MANIFEST_TABLES.map((t) => [t, manifest.ids[t].length])) as Record<ManifestTable, number>;
  return { match, counts };
}

/**
 * Deletes EXACTLY tag ∩ manifest, children first, in the caller's transaction;
 * refuses (throws ⇒ rollback) on any tag/manifest mismatch, on a delete count that
 * differs from the manifest, or when any tagged row remains afterwards.
 */
export async function teardownInTx(tx: Tx, manifest: E0LiveManifest): Promise<Record<ManifestTable, number>> {
  const { match } = await previewTeardown(tx, manifest);
  if (!match.ok) throw new Error("teardown refused: the rows found by tag differ from the manifest (extras or missing)");
  const id = (t: ManifestTable) => ({ id: { in: [...manifest.ids[t]] } });
  const del = {} as Record<ManifestTable, number>;
  // SyncIssueOccurrence rows cascade with their SyncIssue.
  del.syncIssue = (await tx.syncIssue.deleteMany({ where: id("syncIssue") })).count;
  del.accountConnection = (await tx.accountConnection.deleteMany({ where: id("accountConnection") })).count;
  del.financialAccount = (await tx.financialAccount.deleteMany({ where: id("financialAccount") })).count;
  del.plaidItem = (await tx.plaidItem.deleteMany({ where: id("plaidItem") })).count;
  del.connection = (await tx.connection.deleteMany({ where: id("connection") })).count;
  del.userSession = (await tx.userSession.deleteMany({ where: id("userSession") })).count;
  del.betaAccessRequest = (await tx.betaAccessRequest.deleteMany({ where: id("betaAccessRequest") })).count;
  del.customerPolicyAssignment = (await tx.customerPolicyAssignment.deleteMany({ where: id("customerPolicyAssignment") })).count;
  del.user = (await tx.user.deleteMany({ where: id("user") })).count;
  for (const t of MANIFEST_TABLES) {
    if (del[t] !== manifest.ids[t].length) throw new Error(`teardown post-check failed: ${t} deleted count differs from the manifest (rolled back)`);
  }
  if ((await tagRowCount(tx, manifest.tag)) !== 0) throw new Error("teardown post-check failed: tagged rows remain (rolled back)");
  return del;
}
