"use client";

/**
 * lib/space/use-active-envelope.ts  (SD-9B)
 *
 * The trust-PUBLICATION seam — extracted verbatim from SpaceDashboard. It answers
 * exactly one question: "which PerspectiveEnvelope is currently published to the
 * shell chrome?" It does NOT calculate trust.
 *
 * The trust AUTHORITY is unchanged and lives elsewhere:
 *   - resolvePerspectiveEnvelope / PerspectiveEnvelope  (lib/perspectives/envelope.ts)
 *   - CompletenessTier                                  (lib/perspective-engine/types.ts)
 *   - TrustIndicator                                    (components/space/trust)
 *
 * Every financial workspace (Wealth/Cash Flow/Liquidity/Investments/Debt) owns its
 * data + FX + as-of trust and emits its own envelope UP via onEnvelopeChange. Because
 * exactly one workspace is mounted at a time, a single state holds the active one.
 * The selection rule (the ternary formerly inline in the host):
 *   - workspace-backed lens (a WORKSPACE_RENDERERS entry) → the emitted envelope;
 *   - lens-only perspective (e.g. goals, no workspace) → resolvePerspectiveEnvelope
 *     over its LensResult (the canonical resolver's honest placeholder path).
 * The registry keys decide which — the host no longer contains this branch.
 */

import { useCallback, useState } from "react";
import { resolvePerspectiveEnvelope, type PerspectiveEnvelope } from "@/lib/perspectives/envelope";
import { WORKSPACE_RENDERERS } from "@/components/space/workspaces/workspaceRenderers";
import type { LensResult } from "@/lib/perspective-engine/types";

export interface UseActiveEnvelopeArgs {
  /** The engaged perspective id (null on the Overview summary / non-Overview tabs). */
  activePerspectiveId: string | null;
  /** The batch present-day lens results — the fallback source for a lens-only
   *  perspective that emits no workspace envelope. */
  lensResults: Record<string, LensResult> | null;
}

export interface ActiveEnvelope {
  /** The envelope to hand the shell (PerspectiveShell → ShellContextRow → TrustIndicator). */
  envelope: PerspectiveEnvelope;
  /** Passed into the WorkspaceRenderCtx so the engaged workspace emits its envelope up. */
  onEnvelopeChange: (env: PerspectiveEnvelope) => void;
}

export function useActiveEnvelope({ activePerspectiveId, lensResults }: UseActiveEnvelopeArgs): ActiveEnvelope {
  // The engaged workspace emits its OWN trust envelope into this state.
  const [emitted, setEmitted] = useState<PerspectiveEnvelope>({});
  const onEnvelopeChange = useCallback((env: PerspectiveEnvelope) => setEmitted(env), []);

  // A lens without a workspace (e.g. goals) falls through to the canonical resolver;
  // the registry keys (WORKSPACE_RENDERERS) decide which source is authoritative.
  const envelope: PerspectiveEnvelope =
    activePerspectiveId && WORKSPACE_RENDERERS[activePerspectiveId]
      ? emitted
      : resolvePerspectiveEnvelope({
          perspectiveId: activePerspectiveId ?? "",
          lensResult: activePerspectiveId ? lensResults?.[activePerspectiveId] ?? null : null,
        });

  return { envelope, onEnvelopeChange };
}
