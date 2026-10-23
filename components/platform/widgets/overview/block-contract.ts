/**
 * components/platform/widgets/overview/block-contract.ts  (UX-P1 · coordinator-owned)
 *
 * THE FROZEN INTERFACE every Overview block implements. The Overview widget
 * (`OpsOverviewWidget.tsx`) is a thin COMPOSER: it lays the blocks out in the
 * approved order and passes each the same two things the host passes any
 * platform widget — the rail's workspace switcher and the operator's resolved
 * access. Blocks are owned by different workstreams and must not import one
 * another.
 *
 * Every block:
 *   · SELF-FETCHES through `useWidgetFetch` / `useSharedWidgetFetch` /
 *     `useKeyedFetch` (widget-kit, workspace-session, keyed-fetch) — never a
 *     projection import, never a server module (client boundary, c20c741).
 *   · Renders exactly ONE `SectionSurface` (frame rule) and owns its own
 *     loading / error / unobserved / empty states via `WidgetMessage` or the
 *     surface's honesty primitives. It never throws and never returns `null`
 *     once implemented — absence is a sentence, not a missing box.
 *   · Derives no verdict. Words and tones come from the route's own vocabulary
 *     through a pure `*-view.ts` beside the block.
 *   · Navigates ONLY through `onOpenWorkspace(workspaceId)` with a
 *     `platform-*` id from lib/platform/workspaces.ts — no Link, no router.
 *   · Reads `access.canControl` / `canWrite` only to decide whether to RENDER a
 *     control; the server gate decides whether it runs.
 */

import type { SpaceMountAccess } from "@/lib/space/mount-context";

export interface OverviewBlockProps {
  /** The rail's workspace switcher (same mechanism every doorway uses). */
  onOpenWorkspace?: (workspaceId: string) => void;
  /** The operator's resolved access. Absent ⇒ render READ-only. */
  access?: SpaceMountAccess;
}

/** The status board additionally carries the DB section label as its title. */
export interface StatusBoardProps extends OverviewBlockProps {
  title: string;
}
