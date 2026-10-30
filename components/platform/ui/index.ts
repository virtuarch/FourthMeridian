/**
 * components/platform/ui — the shared Platform presentation primitives
 * (Platform Operations 2.0 plan §3). Built on the Atlas tokens and components
 * (Surface, RightPanel, ConfirmDialog, MiniBars/ToneBadge from platform-surface);
 * NOT a second design system. Small, data-agnostic: every figure, word and tone
 * is supplied by the caller's authority.
 *
 * Workspace + view switching reuses the existing switchers (the SpaceShell rail
 * / PlatformViewSwitcher below lg and the sidebar's SpaceWorkspaceNav at lg+),
 * so there is deliberately no WorkspaceNav primitive here.
 */

export { StatusHeader, type StatusFact } from "./StatusHeader";
export { KpiTile, type KpiTileProps } from "./KpiTile";
export { AttentionQueue, type AttentionQueueItem, type AttentionViewAll } from "./AttentionQueue";
export { EntityList, EntityRow, type EntityRowProps } from "./EntityList";
export { DetailDrawer } from "./DetailDrawer";
export { ProvenanceChip, provenanceText, utcClock, type ProvenanceKind } from "./ProvenanceChip";
export { ControlledActionSurface, type ControlledAction } from "./ControlledActionSurface";
export { HistoryList, type HistoryEntry } from "./HistoryList";
