/**
 * lib/crypto/erc20-history-inventory.ts
 *
 * ERC-20 HISTORY — the one READ the wallet-level completeness rule needs
 * (wallet-instrument-history.ts TOKEN_INVENTORY_READERS, the same shape as
 * spl-history-inventory.ts): has every contract this ETH wallet ever touched
 * been found and decided? The answer is the token-history section on the
 * wallet's history link (erc20-history.core `erc20HistoryComplete`): scan
 * closed, nothing past the tracking cap, nothing pending, nothing refused.
 * Absent, foreign or unreadable ⇒ false — never "complete" by default.
 * Takes `client` explicitly.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { btcHistoryLink as historyLink, readHistoryCheckpoint } from "./btc-history-checkpoint";
import { readErc20Section, summarizeSection, erc20HistoryComplete } from "./erc20-history.core";

type Client = PrismaClient | Prisma.TransactionClient;

/** Pure: a history checkpoint → the ERC-20 inventory answer for this account. */
export function erc20InventoryCompleteFromCursor(raw: string | null | undefined, accountId: string): boolean {
  try {
    const r = readErc20Section(raw ?? null, accountId);
    if (r.host === "FOREIGN") return false;
    return erc20HistoryComplete(summarizeSection(r.section));
  } catch { return false; }
}

export async function loadErc20InventoryComplete(client: Client, accountIds: readonly string[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  for (const accountId of accountIds) {
    try {
      const link = await historyLink(client as PrismaClient, accountId);
      const raw = link ? await readHistoryCheckpoint(client as PrismaClient, link.connectionId) : null;
      out.set(accountId, erc20InventoryCompleteFromCursor(raw, accountId));
    } catch { out.set(accountId, false); }
  }
  return out;
}
