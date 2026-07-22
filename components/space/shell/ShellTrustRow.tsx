"use client";

/**
 * components/space/shell/ShellTrustRow.tsx
 *
 * The shell's TRUST surfaces — Completeness, Evidence, and the orthogonal
 * warning chips (FX today) — extracted verbatim from ShellContextRow as the
 * first slice of the TimelineLens v4 migration.
 *
 * Why the split: ShellContextRow fused two unrelated concerns behind one name.
 * The time controls (As of · ⇄ · Compare to) are capability-gated per lens and
 * are moving into the Atlas TimelineLens primitive; the trust chips are NOT
 * gated (they render for every Perspective regardless of temporal capability)
 * and stay exactly where they are. Keeping them inside a component named after
 * "context" would have made the lens swap look like it was deleting trust
 * surfaces.
 *
 * Presentation only — reads the active perspective's envelope and owns nothing
 * but its own popover/drawer disclosure state. No behavior change from the
 * pre-split ShellContextRow: same markup, same classes, same conditions.
 */

import { useState } from "react";
import { ShieldCheck, FileSearch, AlertTriangle } from "lucide-react";
import type { PerspectiveEnvelope } from "@/lib/perspectives/envelope";
import { CompletenessPopover } from "./CompletenessPopover";
import { EvidenceDrawer } from "./EvidenceDrawer";

/** A shell chip; a button when `onClick` is provided, otherwise a static chip. */
function ShellChip({
  icon,
  label,
  value,
  tone = "neutral",
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value?: string;
  tone?: "neutral" | "positive" | "warning";
  onClick?: () => void;
}) {
  const toneColor =
    value === undefined
      ? "var(--text-faint)"
      : tone === "positive"
        ? "var(--accent-positive)"
        : tone === "warning"
          ? "var(--accent-warning)"
          : "var(--text-secondary)";
  const inner = (
    <>
      <span className="text-[var(--text-faint)]" aria-hidden>{icon}</span>
      <span className="text-[11px] font-medium text-[var(--text-muted)]">{label}</span>
      <span className="text-[11px] font-semibold tabular-nums" style={{ color: toneColor }}>
        {value ?? "—"}
      </span>
    </>
  );
  const base = "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 bg-[var(--surface-inset)] border border-[var(--border-hairline)]";
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={`${label}: ${value ?? "—"}`}
        className={`${base} hover:border-[var(--border-hairline-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] transition-colors cursor-pointer`}
      >
        {inner}
      </button>
    );
  }
  return (
    <div className={base} title={value === undefined ? `${label} — not yet available` : `${label}: ${value}`}>
      {inner}
    </div>
  );
}

interface Props {
  /** The active perspective's trust envelope (empty ⇒ inert "—" chips). */
  envelope: PerspectiveEnvelope;
  /** Positioning is the caller's business; defaults to the pre-split `sm:ml-auto`. */
  className?: string;
}

export function ShellTrustRow({ envelope, className = "sm:ml-auto" }: Props) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const completeness = envelope.completeness;
  const evidence = envelope.evidence;
  const warnings = envelope.warnings ?? [];
  const canPopover = !!completeness?.detail;
  const canDrawer = !!(evidence?.rows && evidence.rows.length > 0);

  return (
    <>
      <div className={["flex flex-wrap items-center gap-2", className].join(" ")}>
        <ShellChip
          icon={<ShieldCheck size={13} />}
          label="Completeness"
          value={completeness?.label}
          tone={completeness?.tone}
          onClick={canPopover ? () => setPopoverOpen(true) : undefined}
        />
        <ShellChip
          icon={<FileSearch size={13} />}
          label="Evidence"
          value={evidence?.label}
          onClick={canDrawer ? () => setDrawerOpen(true) : undefined}
        />
        {/* Orthogonal trust caveats (FX today) — a SEPARATE axis from completeness, so
            "Observed + missing FX" reads honestly at the shell instead of collapsing
            the whole chip to "Estimated" (the pre-convergence behavior). */}
        {warnings.map((w, i) => (
          <div
            key={`${w.kind}-${i}`}
            title={w.detail ?? w.label}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 bg-[var(--surface-inset)] border border-[var(--border-hairline)]"
          >
            <span className="text-[var(--accent-warning)]" aria-hidden><AlertTriangle size={13} /></span>
            <span className="text-[11px] font-semibold text-[var(--accent-warning)]">{w.label}</span>
          </div>
        ))}
      </div>

      {completeness && (
        <CompletenessPopover open={popoverOpen} onClose={() => setPopoverOpen(false)} completeness={completeness} />
      )}
      {evidence && (
        <EvidenceDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} evidence={evidence} />
      )}
    </>
  );
}
