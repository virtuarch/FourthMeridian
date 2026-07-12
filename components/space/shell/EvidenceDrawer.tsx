"use client";

/**
 * components/space/shell/EvidenceDrawer.tsx
 *
 * Opens from the shell's Evidence chip when the active perspective has real
 * detail (S4). Lists the records behind the result — for Wealth today, the
 * snapshots (date · net worth · Observed/Reconstructed). The row model is
 * generic ({date, label, tier}) so A7/A8/A10 observations/imports/prices populate
 * it later without rework. Reuses OverlaySurface (focus trap, Escape, restore).
 * No fabricated rows — only what the envelope carried.
 */

import { OverlaySurface } from "@/components/atlas/OverlaySurface";
import type { EnvelopeEvidence } from "@/lib/perspectives/envelope";

const TIER_LABEL: Record<string, string> = {
  observed: "Observed",
  reconstructed: "Reconstructed",
  imported: "Imported",
};

export function EvidenceDrawer({
  open,
  onClose,
  evidence,
}: {
  open: boolean;
  onClose: () => void;
  evidence: EnvelopeEvidence;
}) {
  const rows = evidence.rows ?? [];
  return (
    <OverlaySurface open={open} onClose={onClose} title="Evidence" subtitle={evidence.label}>
      {rows.length === 0 ? (
        <p className="text-sm text-[var(--text-faint)]">Evidence details available soon.</p>
      ) : (
        <div className="max-h-[52vh] overflow-y-auto">
          <ul className="divide-y" style={{ borderColor: "var(--border-hairline)" }}>
            {rows.map((r, i) => (
              <li key={`${r.date}-${i}`} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="text-[var(--text-secondary)]">{r.date}</span>
                <span className="tabular-nums text-[var(--text-primary)] ml-auto mr-3">{r.label}</span>
                <span
                  className="text-[11px] font-medium shrink-0"
                  style={{ color: r.tier === "reconstructed" ? "var(--accent-warning)" : "var(--text-faint)" }}
                >
                  {TIER_LABEL[r.tier] ?? r.tier}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </OverlaySurface>
  );
}
