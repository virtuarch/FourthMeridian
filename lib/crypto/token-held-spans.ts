/**
 * lib/crypto/token-held-spans.ts
 *
 * PR #122 re-review F2/F4 — WHEN a token was actually HELD (quantity > 0) on an
 * account, from its stored rows (OBSERVED or reconstructed DERIVED): the first
 * day with a positive balance, and the last — or null `toISO` when it is still
 * held (its latest row is positive). A token whose rows never show a positive
 * balance (zero-value spam transfers) has NO span: it was never held, so it is
 * never probed, never priced and never counted as unvalued.
 *
 * Rows are end-of-day balances that persist until the next row, so an exit is
 * the day of the first zero row after the last positive one: held through the
 * day before it. Takes `client` explicitly. Dates only.
 */

import type { Prisma, PrismaClient } from "@prisma/client";

type Client = PrismaClient | Prisma.TransactionClient;

export interface TokenHeldSpan { fromISO: string; /** null = still held */ toISO: string | null }

const isoOf = (d: Date) => d.toISOString().slice(0, 10);
const dayBefore = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** PURE — the held span from the positive rows' first/last day and the last zero row's day. */
export function heldSpanFrom(firstPositiveISO: string | null, lastPositiveISO: string | null, lastZeroISO: string | null): TokenHeldSpan | null {
  if (!firstPositiveISO || !lastPositiveISO) return null;
  if (lastZeroISO && lastZeroISO > lastPositiveISO) return { fromISO: firstPositiveISO, toISO: dayBefore(lastZeroISO) };
  return { fromISO: firstPositiveISO, toISO: null };
}

/** Keyed `${accountId}|${instrumentId}`. Absent ⇒ never held. */
export async function loadTokenHeldSpans(client: Client, accountIds: readonly string[], instrumentIds: readonly string[]): Promise<Map<string, TokenHeldSpan>> {
  const out = new Map<string, TokenHeldSpan>();
  if (accountIds.length === 0 || instrumentIds.length === 0) return out;
  const scope = { financialAccountId: { in: [...accountIds] }, instrumentId: { in: [...instrumentIds] }, deletedAt: null, supersededById: null };
  const [pos, zero] = await Promise.all([
    client.positionObservation.groupBy({ by: ["financialAccountId", "instrumentId"], where: { ...scope, quantity: { gt: 0 } }, _min: { date: true }, _max: { date: true } }),
    client.positionObservation.groupBy({ by: ["financialAccountId", "instrumentId"], where: { ...scope, quantity: 0 }, _max: { date: true } }),
  ]);
  const lastZero = new Map(zero.map((z) => [`${z.financialAccountId}|${z.instrumentId}`, z._max?.date ? isoOf(z._max.date) : null]));
  for (const p of pos) {
    const k = `${p.financialAccountId}|${p.instrumentId}`;
    const span = heldSpanFrom(p._min?.date ? isoOf(p._min.date) : null, p._max?.date ? isoOf(p._max.date) : null, lastZero.get(k) ?? null);
    if (span) out.set(k, span);
  }
  return out;
}
