/**
 * lib/crypto/wallet-reconstruction.ts
 *
 * W6c — the pieces of a wallet reconstruction that are not about any one chain.
 *
 * Solana's reconstruction was written first, so the generic parts lived in its
 * file. Bitcoin needs the same parts, and copying them would create two
 * implementations of "which dates did the replay actually establish" that could
 * drift. They live here instead; `sol-history-sync` re-exports what it exported
 * before, so nothing that imported it has to move.
 */

import type { QuantityTimeline } from "@/lib/investments/quantity-replay.core";

/**
 * The dated rows a timeline licenses.
 *
 * ONLY `ABSOLUTE` segments state a quantity. RELATIVE and UNRESOLVED segments
 * say a quantity could NOT be established, and they write nothing — which is
 * what keeps uncovered time absent from the spine rather than present as zero.
 */
export function derivedRowsFromTimeline(
  timeline: QuantityTimeline,
): Array<{ dateISO: string; quantity: number; basis: string }> {
  const out: Array<{ dateISO: string; quantity: number; basis: string }> = [];
  const seen = new Set<string>();
  for (const seg of timeline.segments) {
    if (seg.kind !== "ABSOLUTE") continue;
    let d = seg.fromISO;
    // Bounded walk; both ends are ISO dates from the same engine.
    for (let guard = 0; d <= seg.toISO && guard < 4000; guard++) {
      if (!seen.has(d)) { seen.add(d); out.push({ dateISO: d, quantity: seg.quantity, basis: seg.basis }); }
      d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    }
  }
  return out.sort((a, b) => a.dateISO.localeCompare(b.dateISO));
}
