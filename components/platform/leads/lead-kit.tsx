"use client";

/**
 * components/platform/leads/lead-kit.tsx  (Platform Operations 2.0 — R2)
 *
 * Two small layout helpers the view leads share, built on the Atlas Surface:
 *
 *   LeadSection     one titled summary surface with ONE quiet doorway in its
 *                   header (no per-section explanatory paragraph)
 *   LazyDisclosure  a ≥ 44 px disclosure that MOUNTS its content only while open,
 *                   so a hosted widget (and its fetch) never runs on the default
 *                   screen — the summary stays a summary
 *
 * Domain-free: every word and figure arrives from the lead.
 */

import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Surface } from "@/components/atlas/Surface";

const DOORWAY =
  "inline-flex min-h-11 items-center gap-1 rounded-[var(--radius-xs)] text-xs text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] sm:min-h-8";

export function LeadSection({
  title,
  action,
  children,
  className = "",
}: {
  title: string;
  /** The section's ONE doorway (a drawer opener or a view link). */
  action?: { label: string; onSelect: () => void; opensDialog?: boolean };
  children: ReactNode;
  className?: string;
}) {
  return (
    <section aria-label={title} className={`min-w-0 ${className}`}>
      <Surface className="flex min-w-0 flex-col gap-3 p-4 sm:p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">{title}</h2>
          {action && (
            <button type="button" onClick={action.onSelect} aria-haspopup={action.opensDialog ? "dialog" : undefined} className={DOORWAY}>
              {action.label} <ChevronRight size={12} aria-hidden />
            </button>
          )}
        </div>
        {children}
      </Surface>
    </section>
  );
}

export function LazyDisclosure({ title, hint, children, defaultOpen = false }: {
  title: string;
  /** One quiet line beside the title (what is inside). */
  hint?: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="flex min-w-0 flex-col border-t border-[var(--border-hairline)]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-11 w-full items-center gap-2 py-2 text-left text-sm text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--meridian-400)]"
      >
        {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        <span className="font-medium">{title}</span>
        {hint && <span className="min-w-0 truncate text-[11px] text-[var(--text-muted)]">{hint}</span>}
      </button>
      {open && <div className="min-w-0 pb-4">{children}</div>}
    </div>
  );
}
