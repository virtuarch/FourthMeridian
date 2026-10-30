"use client";

/**
 * components/platform/ui/DetailDrawer.tsx  (Platform Operations 2.0 — R1 primitive)
 *
 * Where full detail lives: the Atlas RightPanel (a docked side panel on desktop,
 * a full-width sheet on mobile — focus trap, Escape, scroll lock and return-focus
 * all come from the panel system). Header = eyebrow + title + close; an optional
 * footer holds the drawer's actions (sheet footer on mobile). No domain here.
 */

import type { ReactNode } from "react";
import { RightPanel, PanelHeader, PanelContent, PanelFooter, type PanelSize } from "@/components/atlas/panels";

export function DetailDrawer({
  open,
  onClose,
  title,
  eyebrow,
  size = "lg",
  footer,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  eyebrow?: ReactNode;
  size?: PanelSize;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <RightPanel open={open} onClose={onClose} size={size}>
      <PanelHeader eyebrow={eyebrow} title={title} />
      <PanelContent>{children}</PanelContent>
      {footer && <PanelFooter>{footer}</PanelFooter>}
    </RightPanel>
  );
}
