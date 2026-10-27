/**
 * components/space/trust/figure-envelope.ts  (v2.7 final UX pass — Estimated badge confidence)
 *
 * WHICH envelope a hero's trust chip reads. Pure; no trust is computed here — it
 * only chooses which lens the ONE resolver (resolvePerspectiveEnvelope) is fed.
 *
 * The rule: a chip qualifies the FIGURE BESIDE IT. Debt's "Total debt" and Cash's
 * "Accessible cash" are PRESENT-DAY in every view (temporalCapability PARTIAL:
 * computed from today's accounts array, never the lens). In a past As-Of the
 * on-screen lens is the AS-OF reconstruction (cards walked back, loans held flat
 * ⇒ "Estimated"), which describes no figure in the header. So the hero reads the
 * present-day lens's envelope; present day, that is already the on-screen lens.
 *
 * This also removes the chip's dependence on the as-of fetch lifecycle: the as-of
 * lens is re-keyed (and briefly null) whenever a data refresh changes the present
 * lens's `computedAt`, which used to make the chip vanish and reappear.
 */

import type { LensResult } from "@/lib/perspective-engine/types";
import { resolvePerspectiveEnvelope, type PerspectiveEnvelope } from "@/lib/perspectives/envelope";

export function presentFigureEnvelope(args: {
  perspectiveId: "debt" | "liquidity";
  /** asOf < today — the on-screen lens is the as-of reconstruction. */
  historical:    boolean;
  /** The host's present-day lens (the basis of the present-day headline). */
  presentLens:   LensResult | null | undefined;
  /** The envelope of the on-screen lens (what the shell receives). */
  onScreen:      PerspectiveEnvelope;
}): PerspectiveEnvelope {
  if (!args.historical) return args.onScreen;
  return resolvePerspectiveEnvelope({ perspectiveId: args.perspectiveId, lensResult: args.presentLens ?? null });
}
