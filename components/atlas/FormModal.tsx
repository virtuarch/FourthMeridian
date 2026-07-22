"use client";

/**
 * components/atlas/FormModal.tsx
 *
 * Thin preset over OverlaySurface for data-entry surfaces: one or many
 * fields with a clear commit / cancel contract, tall enough to scroll.
 * See docs/design-system/ATLAS_GLASS_MODAL_DOCTRINE.md §2 (intent: Form Modal).
 *
 * Defaults it sets over the primitive:
 *   - intent="form"   → mobile presentation is full-screen (fixed header +
 *                       action bar, safe-area aware) rather than a floating
 *                       dialog that fights the on-screen keyboard
 *   - size="md"       → max-w-xl on desktop
 *   - closeOnBackdrop → true (callers pass preventClose while committing or
 *                       when there are unsaved changes)
 *
 * Phase 1: additive, wired to nothing. AddWalletModal / TotpSection migrate
 * onto it in doctrine Phase 2 (this is where the two reported defects get
 * fixed), the rest of the form family in Phase 3.
 */

import { OverlaySurface, OverlaySurfaceProps } from "@/components/atlas/OverlaySurface";

export type FormModalProps = Omit<OverlaySurfaceProps, "intent">;

export function FormModal({ size = "md", ...rest }: FormModalProps) {
  return <OverlaySurface intent="form" size={size} {...rest} />;
}
