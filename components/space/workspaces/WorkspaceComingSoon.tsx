"use client";

/**
 * components/space/workspaces/WorkspaceComingSoon.tsx  (UI-014)
 *
 * The honest placeholder for a Perspective workspace whose registry entry
 * (lib/perspectives.ts) says `status: "comingSoon"`. The renderer map
 * (workspaceRenderers.tsx) mounts this INSTEAD of the workspace's
 * implementation while the status holds — the implementation itself is not
 * deleted, so flipping the registry word restores it.
 *
 * It says only what is true: the destination's name, that it is coming, and
 * the registry's one-line description of what will live there. Nothing is
 * fetched, computed or invented; the trust slot gets the EMPTY envelope so the
 * previous workspace's completeness never lingers above a placeholder.
 */

import { useEffect } from "react";
import type { PerspectiveDef } from "@/lib/perspectives";
import type { PerspectiveEnvelope } from "@/lib/perspectives/envelope";

export function WorkspaceComingSoon({
  definition,
  onEnvelopeChange,
}: {
  definition: Pick<PerspectiveDef, "id" | "label" | "description">;
  onEnvelopeChange?: (env: PerspectiveEnvelope) => void;
}) {
  useEffect(() => {
    onEnvelopeChange?.({});
  }, [onEnvelopeChange]);

  return (
    <div data-workspace-coming-soon={definition.id} className="min-w-0 py-12 text-center">
      <h2 className="text-sm text-[var(--text-muted)]">{definition.label}</h2>
      <p className="mt-1 text-xs font-medium text-[var(--text-secondary)]">Coming soon.</p>
      <p className="mt-1 text-xs text-[var(--text-faint)]">{definition.description}</p>
    </div>
  );
}
