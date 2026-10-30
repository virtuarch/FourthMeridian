/**
 * components/platform/leads/lead-contract.ts  (Platform Operations 2.0 — R2)
 *
 * THE INTERFACE every view LEAD implements (lib/platform/workspaces.ts
 * `PlatformWorkspaceView.lead`). A lead is the summary-first top of a view: it
 * reads existing READ routes, shows 3–5 items per section, and opens detail in
 * drawers / detail panes. Client-safe and type-only, so a lead never imports
 * the dashboard (no cycle).
 *
 * `renderHosted(key)` renders one of the view's HOSTED section keys through the
 * platform widget registry — with its enabled DB row and the operator's access,
 * exactly as an inline section would render — or null when the key is not
 * hosted by this view, has no enabled row, or has no widget. A lead therefore
 * never imports a hosted widget and never decides its gating: the widget does,
 * and the server route decides whether anything runs.
 */

import type { ReactNode } from "react";
import type { SpaceMountAccess } from "@/lib/space/mount-context";
import type { PlatformSectionVariant } from "@/lib/platform/workspaces";

/** `variant` (Policies only): the slice of a variant-taking widget to render —
 *  the same prop an inline view entry passes; the widget keeps its own gating. */
export type RenderHosted = (key: string, onOpenWorkspace?: (workspaceId: string) => void, variant?: PlatformSectionVariant) => ReactNode | null;

export interface PlatformViewLeadProps {
  renderHosted: RenderHosted;
  /** True when `renderHosted(key)` would render something (row enabled + widget). */
  hasHosted: (key: string) => boolean;
  /** The rail's workspace switcher (same mechanism every doorway uses). */
  onOpenWorkspace: (workspaceId: string) => void;
  /** The operator's resolved access (descriptive); forwarded to blocks that render a control. */
  access?: SpaceMountAccess;
}
