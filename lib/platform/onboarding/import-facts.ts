/**
 * lib/platform/onboarding/import-facts.ts  (PB-7 — the one loader both readers share)
 *
 * PlaidItem import markers (allowlisted select: no token, no cursor) + the
 * refresh projection's import evidence, folded through deriveImportStatus.
 * Customer Success passes the owners it may name; Platform Ops passes a time
 * window and receives NO owner (`ownerId` is selected only when asked for).
 *
 * fm_system: an operator reading across customers is outside any tenancy by
 * definition (the Platform page header records the same reasoning).
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { getImportEvidence } from "@/lib/platform/refresh/projections";
import { IMPORT_WINDOW_MS, deriveImportStatus, type ImportItemFacts, type ImportedItem } from "./import-status-core";

/** The PlaidItem columns the rule reads. Explicit allowlist: never encryptedToken / cursor / syncOriginCursor. */
const ITEM_SELECT = {
  id: true, createdAt: true, status: true, errorCode: true, institutionName: true,
  syncIncompleteAt: true, historyBuildStartedAt: true, completedSyncCount: true, syncImportedCount: true,
} as const;

/** Bound on items per read (the windows are days; the population is new connections). */
export const IMPORT_ITEMS_MAX = 1_000;

export type { ImportedItem };

/** The population both readers count: active role-USER customers (the CS overview's own population). */
const CUSTOMER_OWNER = { role: "USER" as const, deactivatedAt: null };

async function fold(rows: Array<ImportItemFacts & { institutionName: string; userId?: string }>, now: Date): Promise<{ items: ImportedItem[]; floor: boolean }> {
  const { evidence, floor } = await getImportEvidence(rows.map((r) => ({ id: r.id, createdAt: r.createdAt })), IMPORT_WINDOW_MS);
  return {
    items: rows.map((r) => ({ ...r, verdict: deriveImportStatus(r, evidence.get(r.id) ?? null, now) })),
    floor,
  };
}

/** Customer Success — every Plaid Item these customers own, with its verdict (owner included). */
export async function loadImportsForOwners(userIds: readonly string[], now: Date, client = systemDb): Promise<{ items: ImportedItem[]; floor: boolean }> {
  if (userIds.length === 0) return { items: [], floor: false };
  const rows = await client.plaidItem.findMany({
    where: { userId: { in: [...userIds] } },
    select: { ...ITEM_SELECT, userId: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: IMPORT_ITEMS_MAX,
  });
  const out = await fold(rows.map((r) => ({ ...r, status: String(r.status) })), now);
  return { items: out.items, floor: out.floor || rows.length >= IMPORT_ITEMS_MAX };
}

/** Platform Ops — Plaid Items linked since `since` by active customers. NO owner is selected. */
export async function loadImportsLinkedSince(since: Date, now: Date, client = systemDb): Promise<{ items: ImportedItem[]; floor: boolean }> {
  const rows = await client.plaidItem.findMany({
    where: { createdAt: { gte: since }, user: CUSTOMER_OWNER },
    select: ITEM_SELECT,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: IMPORT_ITEMS_MAX,
  });
  const out = await fold(rows.map((r) => ({ ...r, status: String(r.status) })), now);
  return { items: out.items, floor: out.floor || rows.length >= IMPORT_ITEMS_MAX };
}
