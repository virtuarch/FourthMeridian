"use client";

/**
 * components/platform/widgets/overview/block-doorway.tsx  (UX-P1 · Agent 5)
 *
 * THE ONE DOORWAY an Overview block ends in: a text button in the surface's
 * `actions` slot that opens the workspace holding the block's detail, through
 * the rail's switcher (`onOpenWorkspace`) — no Link, no router. Renders nothing
 * when the host passed no switcher, so a block rendered outside the dashboard
 * (a test, a panel) never shows a control that does nothing.
 *
 * Same idiom as StatusTile's "Open <workspace> →" so every doorway reads alike.
 */

export function BlockDoorway({ label, workspaceId, onOpenWorkspace }: {
  /** The workspace name as the operator knows it ("AI", "Economics", "Trends"). */
  label: string;
  workspaceId: string;
  onOpenWorkspace?: (workspaceId: string) => void;
}) {
  if (!onOpenWorkspace) return null;
  return (
    <button
      type="button"
      onClick={() => onOpenWorkspace(workspaceId)}
      className="text-[11px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--meridian-400)]"
      aria-label={`Open ${label}`}
    >
      {label} →
    </button>
  );
}
