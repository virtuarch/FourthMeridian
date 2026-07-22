"use client";

/**
 * components/atlas/panels/panel-context.ts
 *
 * The internal wiring that lets the composition slots (PanelHeader / PanelContent /
 * PanelFooter) talk to their enclosing <Panel> without the consumer threading props.
 * Domain-free: it carries only presentation concerns (close handler, side, the
 * accessible-name id, and the busy guard).
 */

import { createContext, useContext } from "react";

export type PanelSide = "left" | "right";

export interface PanelContextValue {
  /** Dismiss the panel (the close button + any in-content close affordance). */
  onClose: () => void;
  /** Which edge the panel is docked to — informs slot styling if needed. */
  side: PanelSide;
  /** Blocks dismissal affordances while true (e.g. an in-flight commit). */
  preventClose: boolean;
  /** The id the header's title carries, wired to the dialog's aria-labelledby. */
  titleId: string;
  /** PanelHeader calls this on mount so <Panel> switches from aria-label to
   *  aria-labelledby (a visible title is a better accessible name than a prop). */
  registerTitle: (present: boolean) => void;
}

export const PanelContext = createContext<PanelContextValue | null>(null);

/** Read the enclosing panel's context; throws if a slot is used outside <Panel>. */
export function usePanelContext(slot: string): PanelContextValue {
  const ctx = useContext(PanelContext);
  if (!ctx) throw new Error(`${slot} must be rendered inside <Panel>.`);
  return ctx;
}
