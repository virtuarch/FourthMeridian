"use client";

/**
 * components/atlas/panels/WorkspaceLayout.tsx
 *
 * The optional composable scaffold for a workspace that exposes context/detail panels
 * alongside its main content. It does two presentation-only things:
 *   1. establishes a <PanelStack> so panels opened from within panels layer correctly;
 *   2. marks the main region as the positioning context.
 *
 * Panels self-portal to the document body and dock to the viewport edge (so the main
 * content is never reflowed), which is why this is a light wrapper rather than a rigid
 * grid. It knows nothing about which panels or what content — the consumer composes:
 *
 *   <WorkspaceLayout>
 *     <LeftPanel open={filtersOpen} onClose={…}><PanelHeader title="Filters" />…</LeftPanel>
 *     <MyWorkspaceContent />
 *     <RightPanel open={!!selected} onClose={…}><PanelHeader title="Detail" />…</RightPanel>
 *   </WorkspaceLayout>
 */

import type { ReactNode } from "react";
import { PanelStack } from "./PanelStack";

export interface WorkspaceLayoutProps {
  children: ReactNode;
  className?: string;
}

export function WorkspaceLayout({ children, className = "" }: WorkspaceLayoutProps) {
  return (
    <PanelStack>
      <div className={`relative ${className}`}>{children}</div>
    </PanelStack>
  );
}
