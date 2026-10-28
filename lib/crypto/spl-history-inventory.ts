/**
 * lib/crypto/spl-history-inventory.ts
 *
 * SPL TOKEN HISTORY — the one READ the wallet-level completeness rule needs:
 * has every token this SOL wallet ever held been found and decided? The answer
 * is `inventoryComplete` in the token state inside the SOL checkpoint
 * (Connection.cursor, the same link the history store uses). Absent, foreign or
 * unreadable ⇒ false — never "complete" by default. Takes `client` explicitly.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { isSolBackfillCursor } from "./sol-history-backfill.core";
import { parseSplState } from "./spl-history.core";

type Client = PrismaClient | Prisma.TransactionClient;

/** Pure: a SOL cursor → its token inventory answer. */
export function splInventoryCompleteFromCursor(raw: string | null | undefined): boolean {
  if (!isSolBackfillCursor(raw)) return false;
  try {
    const cp = JSON.parse(raw as string) as { tokens?: unknown };
    return parseSplState(cp.tokens)?.inventoryComplete === true;
  } catch { return false; }
}

export async function loadSplInventoryComplete(client: Client, accountIds: readonly string[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  if (accountIds.length === 0) return out;
  const links = await client.accountConnection.findMany({
    where: { financialAccountId: { in: [...accountIds] }, deletedAt: null, connectionId: { not: null } },
    // The SAME link prismaSolBackfillStore uses: canonical first, then oldest.
    orderBy: [{ isCanonical: "desc" }, { createdAt: "asc" }],
    select: { financialAccountId: true, connection: { select: { cursor: true } } },
  });
  for (const l of links) {
    if (out.has(l.financialAccountId)) continue;
    out.set(l.financialAccountId, splInventoryCompleteFromCursor(l.connection?.cursor ?? null));
  }
  return out;
}
