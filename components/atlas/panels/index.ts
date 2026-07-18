/**
 * components/atlas/panels — the canonical Fourth Meridian PANEL system.
 *
 * The edge-anchored contextual-surface primitive family, sibling to the centered
 * `OverlaySurface` modal. Panels preserve workspace context ("continue working while
 * inspecting"); modals interrupt for a decision ("pause and complete"). See
 * docs/architecture/WORKSPACE_CONTRACT_DOCTRINE.md — The Experience Layer.
 *
 * These are PRESENTATION primitives, not ownership boundaries: they know layout,
 * animation, open/close, accessibility, responsiveness, and stacking — never a domain.
 * Domain panels are COMPOSED from these slots by their domain; there is no
 * <TransactionPanel> or <InvestmentPanel> here.
 */

export { Panel, type PanelProps, type PanelSize } from "./Panel";
export { LeftPanel, RightPanel, type SidePanelProps } from "./SidePanels";
export {
  PanelHeader,
  PanelContent,
  PanelFooter,
  type PanelHeaderProps,
  type PanelContentProps,
  type PanelFooterProps,
} from "./PanelParts";
export { PanelStack, usePanelStack } from "./PanelStack";
export { WorkspaceLayout, type WorkspaceLayoutProps } from "./WorkspaceLayout";
export { type PanelSide } from "./panel-context";
