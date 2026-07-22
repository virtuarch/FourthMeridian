"use client";

/**
 * components/atlas/panels/SidePanels.tsx
 *
 * Thin, intent-named presets over <Panel> — the way Dialog/FormModal preset
 * OverlaySurface. They fix `side` (and its sensible default width) and read as the
 * mental model at the call site:
 *
 *   LeftPanel   context / navigation / control — "what am I operating in?"
 *   RightPanel  detail / intelligence — "tell me more about what I selected."
 *
 * No new behavior; everything else is <Panel>. Domain content is composed INSIDE
 * them (PanelHeader/PanelContent/PanelFooter); these never become <TransactionPanel>.
 */

import { Panel, type PanelProps } from "./Panel";

export type SidePanelProps = Omit<PanelProps, "side">;

/** Context / navigation / control, docked to the left (wider, lighter scrim). */
export function LeftPanel(props: SidePanelProps) {
  return <Panel side="left" {...props} />;
}

/** Detail / intelligence, docked to the right (narrower, blurred scrim). */
export function RightPanel(props: SidePanelProps) {
  return <Panel side="right" {...props} />;
}
