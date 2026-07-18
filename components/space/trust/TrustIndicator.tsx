"use client";

/**
 * components/space/trust/TrustIndicator.tsx
 *
 * The ONE shared, domain-neutral trust presentation primitive. It consumes the
 * canonical `PerspectiveEnvelope` (completeness + orthogonal warnings + evidence)
 * and nothing else — it does NOT calculate trust, determine completeness, inspect
 * workspace data, or know Wealth/Debt/Investment semantics. Every workspace's
 * inline "confidence chip" / "reconstructed" / "estimated" marker converges here,
 * so the local indicator can never disagree with the shell's Completeness chip:
 * both read the same envelope.
 *
 * Trust is TWO orthogonal axes: `completeness` (how the value was obtained — the
 * five canonical tiers) and `warnings[]` (orthogonal caveats such as walked-back
 * FX). This primitive renders both without collapsing them.
 *
 * Variants:
 *   compact   — a tone-colored tier pill (+ a warning glyph); clickable → the
 *               shell Completeness popover when the envelope carries a reason.
 *   inline    — a muted caveat LINE, rendered ONLY when something is noteworthy
 *               (tier is not the positive/observed tier, or a warning is present).
 *               The honest replacement for a workspace's "≈ …" / reason note.
 *   expanded  — pill + reason + warnings list + optional Evidence affordance.
 *
 * Placement is the workspace's call; meaning is not — it comes entirely from the
 * envelope. No financial-domain imports (only the trust contract + the shell's
 * tier-agnostic detail surfaces).
 */

import { useState } from "react";
import { ShieldCheck, AlertTriangle, FileSearch } from "lucide-react";
import type { PerspectiveEnvelope, EnvelopeTone } from "@/lib/perspectives/envelope";
import { CompletenessPopover } from "@/components/space/shell/CompletenessPopover";
import { EvidenceDrawer } from "@/components/space/shell/EvidenceDrawer";

export type TrustVariant = "compact" | "inline" | "expanded";

interface Props {
  envelope: PerspectiveEnvelope;
  variant?: TrustVariant;
  /** When true (and evidence rows exist), expose an Evidence affordance. */
  showEvidence?: boolean;
  className?: string;
}

function toneColor(tone: EnvelopeTone | undefined): string {
  return tone === "positive"
    ? "var(--accent-positive)"
    : tone === "warning"
      ? "var(--accent-warning)"
      : "var(--text-secondary)";
}

export function TrustIndicator({ envelope, variant = "compact", showEvidence = false, className = "" }: Props) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const completeness = envelope.completeness;
  const warnings = envelope.warnings ?? [];
  const evidence = envelope.evidence;
  const canPopover = !!completeness?.detail;
  const canDrawer = showEvidence && !!(evidence?.rows && evidence.rows.length > 0);
  // "Noteworthy" = the tier isn't the clean/positive case, or a caveat exists.
  const noteworthy = (completeness && completeness.tone !== "positive") || warnings.length > 0;

  // Nothing to say ⇒ render nothing (a local indicator, not the shell's inert "—").
  if (!completeness && warnings.length === 0) return null;

  // ── inline: a muted caveat line, only when noteworthy ─────────────────────────
  if (variant === "inline") {
    if (!noteworthy) return null;
    const lead = completeness && completeness.tone !== "positive"
      ? (completeness.detail ?? completeness.label)
      : null;
    return (
      <p className={["text-[11px] leading-snug text-[var(--accent-warning)]", className].join(" ")}>
        {lead}
        {lead && warnings.length > 0 ? " " : ""}
        {warnings.map((w) => w.label).join(" · ")}
      </p>
    );
  }

  // ── compact / expanded: a tier pill, with orthogonal warning + evidence ───────
  const warned = warnings.length > 0;
  const warnTitle = warnings.map((w) => w.detail ?? w.label).join("\n");

  return (
    <span className={["inline-flex flex-wrap items-center gap-1.5", className].join(" ")}>
      {completeness && (
        <button
          type="button"
          onClick={canPopover ? () => setPopoverOpen(true) : undefined}
          disabled={!canPopover}
          title={completeness.detail ?? completeness.label}
          className={[
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
            "border-[var(--border-hairline)] bg-[var(--surface-inset)]",
            canPopover
              ? "hover:border-[var(--border-hairline-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] cursor-pointer"
              : "cursor-default",
          ].join(" ")}
          style={{ color: toneColor(completeness.tone) }}
        >
          <ShieldCheck size={12} aria-hidden className="opacity-80" />
          {completeness.label}
        </button>
      )}

      {warned && (
        <span
          className="inline-flex items-center gap-1 rounded-full border border-[var(--border-hairline)] px-2 py-0.5 text-[11px] font-medium"
          style={{ color: "var(--accent-warning)", background: "color-mix(in srgb, var(--accent-warning) 12%, transparent)" }}
          title={warnTitle}
        >
          <AlertTriangle size={11} aria-hidden className="shrink-0 opacity-80" />
          {warnings.length === 1 ? warnings[0].label : `${warnings.length} caveats`}
        </span>
      )}

      {canDrawer && (
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          title={`Evidence: ${evidence?.label ?? ""}`}
          className="inline-flex items-center gap-1 rounded-full border border-[var(--border-hairline)] bg-[var(--surface-inset)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-secondary)] hover:border-[var(--border-hairline-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] cursor-pointer"
        >
          <FileSearch size={11} aria-hidden className="opacity-80" />
          {evidence?.label}
        </button>
      )}

      {variant === "expanded" && completeness?.detail && (
        <span className="basis-full text-[11px] leading-snug text-[var(--text-muted)]">
          {completeness.detail}
        </span>
      )}

      {completeness && (
        <CompletenessPopover open={popoverOpen} onClose={() => setPopoverOpen(false)} completeness={completeness} />
      )}
      {evidence && (
        <EvidenceDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} evidence={evidence} />
      )}
    </span>
  );
}
