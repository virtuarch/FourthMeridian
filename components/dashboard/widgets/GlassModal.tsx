"use client";

/**
 * GlassModal
 *
 * Shared shell for the Dashboard IA Refactor modals (KPI detail modals,
 * Perspective-card modals, TimelineModal). Historically its own hand-rolled
 * backdrop/sheet recipe (GlassPanel + tokens, portal-less, no focus trap, no
 * Escape). As of the Overlay Convergence slice it is **re-based in place onto
 * the canonical `OverlaySurface` primitive** — GlassModal is now a thin
 * adapter, not a parallel implementation.
 *
 * Why re-base rather than migrate every consumer: the public prop shape below
 * (title / subtitle / icon / onClose / children / footer / toolbar / size) is
 * preserved exactly, so `TimelineModal`, the KPI-detail modals and the
 * Perspective-card modals continue calling `<GlassModal …>` unchanged while
 * transparently gaining the primitive's portal, body-scroll-lock + scroll
 * preservation, focus trap, Escape handling and named z-index token.
 *
 * Behavioural notes vs. the old shell:
 *   - intent="workspace": these are large detail/tool surfaces. On mobile the
 *     primitive presents them full-screen (previously a ~94dvh bottom sheet —
 *     effectively the same footprint); on desktop, centered with the same
 *     width/height ladder (md→max-w-xl, lg→max-w-3xl, xl→max-w-5xl,
 *     full→max-w-[96vw]/92dvh) this shell already used.
 *   - closeOnBackdrop is forced true to preserve the old shell's behaviour
 *     (workspace intent otherwise defaults backdrop-click to non-closing).
 *
 * Not deleted: kept as the stable public entry point for its consumers. Full
 * per-consumer migration + removal is a later, separately-approved step.
 */

import { ReactNode, ElementType } from "react";
import { OverlaySurface } from "@/components/atlas/OverlaySurface";

export interface GlassModalProps {
  title: string;
  subtitle?: string;
  icon?: ElementType;
  onClose: () => void;
  children: ReactNode;
  /** Optional sticky footer slot (e.g. a "Manage accounts →" link). */
  footer?: ReactNode;
  /** Optional sub-nav / filter row rendered between header and body. */
  toolbar?: ReactNode;
  /** md ≈ max-w-xl; lg (default) ≈ max-w-3xl; xl ≈ max-w-5xl; full ≈ near-fullscreen (Timeline). */
  size?: "md" | "lg" | "xl" | "full";
}

export function GlassModal({
  title,
  subtitle,
  icon,
  onClose,
  children,
  footer,
  toolbar,
  size = "lg",
}: GlassModalProps) {
  // GlassModal is conditionally mounted by its callers (rendered only while
  // open), so `open` is always true here; unmounting is what closes it, which
  // fires OverlaySurface's cleanup (focus restore + scroll-lock release).
  return (
    <OverlaySurface
      open
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      icon={icon}
      intent="workspace"
      size={size}
      toolbar={toolbar}
      footer={footer}
      closeOnBackdrop
    >
      {children}
    </OverlaySurface>
  );
}
