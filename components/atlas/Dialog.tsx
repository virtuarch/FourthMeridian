"use client";

/**
 * components/atlas/Dialog.tsx
 *
 * Thin preset over OverlaySurface for short, bounded, decision- or
 * read-oriented overlays: confirmations, small detail cards, "are you sure".
 * See docs/design-system/ATLAS_GLASS_MODAL_DOCTRINE.md §2 (intent: Dialog).
 *
 * Defaults it sets over the primitive:
 *   - intent="dialog"  → mobile presentation is a content-sized bottom sheet
 *   - size="sm"        → max-w-md on desktop
 *   - closeOnBackdrop  → true
 *
 * For a destructive confirmation, pass role="alertdialog".
 *
 * Phase 1: additive, wired to nothing. Confirmation modals migrate onto it
 * in doctrine Phase 4.
 */

import { OverlaySurface, OverlaySurfaceProps } from "@/components/atlas/OverlaySurface";

export type DialogProps = Omit<OverlaySurfaceProps, "intent" | "size"> & {
  size?: Extract<OverlaySurfaceProps["size"], "sm" | "md">;
};

export function Dialog({ size = "sm", role = "dialog", ...rest }: DialogProps) {
  return <OverlaySurface intent="dialog" size={size} role={role} {...rest} />;
}
