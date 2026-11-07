/**
 * lib/plaid/token-scrub-state.ts  (PB-5 — S2)
 *
 * WHICH ITEMS' REMOVAL PLAID ALREADY CONFIRMED, AS A FACT ABOUT THE TOKEN —
 * WITHOUT THE TOKEN EVER LEAVING THIS MODULE.
 *
 * lib/plaid/disconnect.ts scrubs PlaidItem's access-token column to
 * REVOKED_TOKEN_SENTINEL only after Plaid CONFIRMED the Item gone (PRIV-004).
 * The provider-cleanup fold needs that one bit to recognise a PHANTOM
 * obligation (see provider-cleanup.core.ts cleanupVerdicts): an UNCONFIRMED
 * marker written by a late second call after a confirmed, scrubbed removal.
 *
 * The Platform Ops readers are pinned never to touch a token or secret
 * (provider-cleanup.test.ts §6, removed-connections.test.ts). So the question
 * is asked HERE, in the token's own module, as a FILTER: the query selects ids
 * only, and the column's value is never read into memory or returned.
 */

import { systemDb } from "@/lib/db";
import { REVOKED_TOKEN_SENTINEL } from "@/lib/plaid/disconnect";

/** The subset of `itemIds` whose access token is the post-confirmation scrub sentinel. Ids only. */
export async function readScrubbedItemIds(
  itemIds: readonly string[],
  client: Pick<typeof systemDb, "plaidItem"> = systemDb,
): Promise<Set<string>> {
  if (itemIds.length === 0) return new Set();
  const rows = await client.plaidItem.findMany({
    where:  { id: { in: [...itemIds] }, encryptedToken: REVOKED_TOKEN_SENTINEL },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}
