"use client";

/**
 * components/space/trust/TransactionCoverageNote.tsx  (TX-2A)
 *
 * The ONE presentational surface for transaction-coverage honesty. It reads the
 * workspace-safe coverage meta ({ truncated, limit }) and the pure copy resolver
 * (lib/transactions/coverage-note) — nothing else. It renders a muted caveat LINE
 * only when the transaction population is intentionally bounded, and renders
 * NOTHING when coverage is complete (truncated=false), so a Space under the cap is
 * visually identical to before TX-2A. It performs NO calculation and does not
 * inspect transactions — the charts/totals beside it fold over the same rows they
 * always did.
 *
 * Placement is the workspace's call (Transactions tab header, Cash Flow / Liquidity
 * historical block); meaning is fixed by the variant.
 */

import { Layers } from "lucide-react";
import { coverageMessage, type CoverageVariant, type TransactionsCoverage } from "@/lib/transactions/coverage-note";

interface Props {
  coverage: TransactionsCoverage | null | undefined;
  /** `browse` — the Transactions tab ("showing the most recent N"); `history` —
   *  the muted completeness caveat for a derived/historical view. */
  variant?: CoverageVariant;
  className?: string;
}

export function TransactionCoverageNote({ coverage, variant = "browse", className = "" }: Props) {
  const message = coverageMessage(coverage, variant);
  if (!message) return null; // complete ⇒ no indicator (identical to pre-TX-2A)
  return (
    <p
      role="note"
      className={[
        "inline-flex items-start gap-1.5 text-[11px] leading-snug text-[var(--text-muted)]",
        className,
      ].join(" ")}
    >
      <Layers size={12} aria-hidden className="mt-px shrink-0 opacity-70" />
      <span>{message}</span>
    </p>
  );
}
