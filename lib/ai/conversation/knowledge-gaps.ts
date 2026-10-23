/**
 * lib/ai/conversation/knowledge-gaps.ts
 *
 * WHAT THIS ANSWER WANTED AND DID NOT HAVE.
 *
 * ⚠️ IT READS A FIELD, IT DOES NOT READ PROSE. `get_financial_snapshot` already
 * returns `missingDebtFields` — the accounts assembler's own list of debt
 * metadata that is null on accounts the viewer can see in full. This collects
 * that list off the tool results a turn actually produced. Nothing here inspects
 * the assistant's sentences, and nothing here decides what is missing; the
 * assembler decided, the tool carried it, and this makes it presentable.
 *
 * ⚠️ RELEVANCE IS STRUCTURAL, NOT EDITORIAL. A gap surfaces only when the turn
 * read the accounts — because that is when it actually bore on the answer. The
 * assembled context knows about the same gaps on every turn; surfacing them
 * under "what did I spend last month?" would make a standing notice out of
 * something that is supposed to be a remark about this answer.
 *
 * ⚠️ THE PROJECTION IS FIELD BY FIELD, NEVER A SPREAD. This is the seam where a
 * server object becomes a public one. A spread would carry whatever the internal
 * type grows next straight into a browser, and it would do it silently.
 *
 * PURE, and imports nothing but a type — a client may narrow a response with it.
 */

import type { AiKnowledgeGap } from '@/types';

/** The tool that carries them. The only one; asserted by test. */
export const GAP_BEARING_FIELD = 'missingDebtFields' as const;

const FIELDS = new Set(['apr', 'minimumPayment']);

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/**
 * Narrow one unknown value to a public gap, or reject it.
 *
 * ⚠️ USED ON BOTH SIDES OF THE WIRE. The server narrows what a tool produced;
 * a client may narrow what a response contained. One definition of a well-formed
 * gap, so a shape that is unrenderable can never be called valid at one end and
 * invalid at the other.
 */
export function readKnowledgeGap(value: unknown): AiKnowledgeGap | null {
  if (typeof value !== 'object' || value === null) return null;
  const g = value as Record<string, unknown>;
  if (!str(g.accountId) || !str(g.accountName) || !str(g.label)) return null;
  if (typeof g.field !== 'string' || !FIELDS.has(g.field)) return null;
  if (g.debtSubtype !== undefined && g.debtSubtype !== null && !str(g.debtSubtype)) return null;
  return {
    accountId:   g.accountId,
    accountName: g.accountName,
    field:       g.field as AiKnowledgeGap['field'],
    label:       g.label,
    ...(str(g.debtSubtype) ? { debtSubtype: g.debtSubtype } : {}),
  };
}

/**
 * Narrow an unknown list. Anything unrenderable is dropped, never rendered
 * half-formed and never thrown over — a malformed extra must not cost the user
 * the answer it was attached to.
 */
export function readKnowledgeGaps(value: unknown): AiKnowledgeGap[] {
  if (!Array.isArray(value)) return [];
  return value.map(readKnowledgeGap).filter((g): g is AiKnowledgeGap => g !== null);
}

/**
 * The gaps a turn's tool results carried, de-duplicated and stably ordered.
 *
 * Deduplication is by account and field: two reads of the accounts in one turn
 * describe the same missing APR, not two of them. Order is the order they were
 * first seen, so the list a user reads matches the evidence the answer used.
 */
export function collectKnowledgeGaps(
  /**
   * ⚠️ SELECTED BY FIELD, NOT BY TOOL NAME. The name is accepted so a caller can
   * pass a turn record's calls unchanged, and it is deliberately never read: a
   * gap is whatever a tool returned under the one named key, so a second tool
   * that carries the same list needs no change here.
   */
  toolCalls: readonly { name?: string; result?: unknown }[],
): AiKnowledgeGap[] {
  const out: AiKnowledgeGap[] = [];
  const seen = new Set<string>();
  for (const call of toolCalls) {
    const result = call.result;
    if (typeof result !== 'object' || result === null) continue;
    for (const gap of readKnowledgeGaps((result as Record<string, unknown>)[GAP_BEARING_FIELD])) {
      const key = `${gap.accountId}:${gap.field}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(gap);
    }
  }
  return out;
}
