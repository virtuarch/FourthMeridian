"use client";

/**
 * components/space/compact/CompactInsights.tsx  (v2.7 R4 — owner D-3)
 *
 * Compact (<1024px) insight treatment: up to three concise, number-first
 * one-liners, then a "Details" disclosure revealing the FULL existing text
 * verbatim. The caller supplies both — the lines are re-statements of figures
 * the card already shows, never a new derivation. Every element here is
 * compact-only (`lg:hidden` in its own className), so the desktop card renders
 * exactly as before; the caller hides its desktop paragraph below lg only.
 */

import { useId, useState, type ReactNode } from "react";
import { CompactDisclosureButton } from "./CompactDisclosure";

export const COMPACT_INSIGHT_MAX = 3;

export function CompactInsights({ lines, details }: { lines: ReactNode[]; details: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = `compact-details-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const shown = lines.slice(0, COMPACT_INSIGHT_MAX);
  return (
    <div className="lg:hidden min-w-0" data-compact-insights>
      {shown.length > 0 && (
        <ul className="lg:hidden space-y-1.5">
          {shown.map((line, i) => (
            <li key={i} className="text-[13px] leading-snug text-[var(--text-secondary)] [overflow-wrap:anywhere]" data-compact-insight>
              {line}
            </li>
          ))}
        </ul>
      )}
      <div className="lg:hidden mt-1 -ml-2">
        <CompactDisclosureButton open={open} onToggle={() => setOpen((v) => !v)} controls={id} label="Details" openLabel="Hide details" />
      </div>
      <div id={id} className={open ? "lg:hidden" : "lg:hidden hidden"} data-compact-details>
        <p className="text-sm leading-relaxed text-[var(--text-secondary)]">{details}</p>
      </div>
    </div>
  );
}
