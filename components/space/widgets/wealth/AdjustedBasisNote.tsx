/**
 * components/space/widgets/wealth/AdjustedBasisNote.tsx   (v2.7-P0)
 *
 * The forward-only basis disclosure under the Net Worth / Assets / Cash trend:
 * snapshot rows before the per-environment cutover (v2.7-P5:
 * NEXT_PUBLIC_ADJUSTED_CASH_BASIS_CUTOVER, else the code default) stay on the
 * provider-reported ledger basis (never rewritten), so a plotted window that
 * spans it says so, in UTC days. Renders nothing otherwise. Wording and cutover
 * semantics owned by lib/balances/adjusted-basis.
 */

import { adjustedCashBasisNote } from "@/lib/balances/adjusted-basis";

export function AdjustedBasisNote({ from, to }: { from: string | null; to: string | null }) {
  const note = adjustedCashBasisNote(from, to);
  if (!note) return null;
  return <p className="mt-2 text-[11px] text-[var(--text-faint)]" data-adjusted-basis-note>{note}</p>;
}
