"use client";

/**
 * components/dashboard/PersonalDashboard.tsx
 *
 * Personal shell host (Unified Space Widget Layout, slice 1).
 *
 * `page.tsx` (a Server Component) can't own the ephemeral "view as" currency
 * override, so this thin client boundary does. It:
 *   - owns the in-memory `viewOverride` state,
 *   - wraps the shared SpaceDashboard in DisplayCurrencyProvider(effective…) so
 *     the override re-scopes EVERY widget (Net Worth, chart, allocation,
 *     Perspectives) — not a bespoke Personal hero,
 *   - renders the "view as" control into the shell's `displayCurrencyControl` seam
 *     (the only fixed Personal Overview control), above the section stack, and
 *   - forwards the Space's reporting currency as `snapshotCurrency` (the "from"
 *     side for the Net Worth chart section's snapshot conversion).
 *
 * The former `renderHero` seam is gone: Personal Overview's Net Worth / chart /
 * allocation are now section-backed widgets, so Personal is "just a Space" whose
 * Overview is an ordered section stack (Edit Layout works there naturally). No
 * duplicate fetching — the shell fetches accounts + snapshots itself.
 */

import { useState } from "react";
import { SpaceDashboard } from "@/components/dashboard/SpaceDashboard";
import type { SpaceMountContext } from "@/lib/space/mount-context";
import { DisplayCurrencyProvider, useDisplayCurrency } from "@/lib/currency-context";
import { ViewCurrencyOverride, type ViewOverride } from "@/components/dashboard/widgets/ViewCurrencyOverride";

interface Props {
  // Identity props forwarded to the shared shell.
  spaceId:       string;
  spaceName:     string;
  spaceType:     string;
  category:      string;
  myRole:        string;
  currentUserId: string;
  /** Mapped from the legacy `?tab=` deep link by page.tsx (unknown ⇒ OVERVIEW). */
  initialTab:    string;

  // The user's FICO score → the Debt workspace's credit-health companion.
  // CLEAN-0 removed the former accounts/snapshots/transactions/moneyCtx props:
  // the shared shell fetches its own section data, so page.tsx was passing
  // (and this component was discarding) those reads. Only ficoScore is consumed.
  ficoScore:     number | null;
  /** PS-6A — domain-neutral mount context, forwarded to the shared shell.
   *  Additive, not yet consumed (PS-6B owns the hydration cutover). */
  mountContext?: SpaceMountContext;
}

export function PersonalDashboard({
  spaceId, spaceName, spaceType, category, myRole, currentUserId, initialTab,
  ficoScore, mountContext,
}: Props) {
  // EPHEMERAL "view as" override — pure in-memory, never persisted; a reload
  // resets to the Space's saved currency by construction.
  const [viewOverride, setViewOverride] = useState<ViewOverride | null>(null);

  // Read OUTSIDE the effective provider below ⇒ the Space's persisted reporting
  // currency: the "off" position for the override control AND the "from" side
  // for the Net Worth chart section's snapshot conversion.
  const displayCurrency = useDisplayCurrency();
  const effectiveDisplayCurrency = viewOverride?.currency ?? displayCurrency;

  return (
    <DisplayCurrencyProvider currency={effectiveDisplayCurrency}>
      <SpaceDashboard
        key={spaceId}
        spaceId={spaceId}
        spaceName={spaceName}
        spaceType={spaceType}
        category={category}
        myRole={myRole}
        currentUserId={currentUserId}
        initialTab={initialTab}
        // UX-PER-3 Debt — the user's FICO score for the Debt workspace's
        // credit-health companion (never drives debt math).
        ficoScore={ficoScore}
        mountContext={mountContext}
        // Reporting currency (snapshot stamp) → the chart section's "from" side;
        // the shell's ctx.target (effective display currency) is the "to" side,
        // so the chart converts correctly even under a "view as" override.
        snapshotCurrency={displayCurrency}
        // view-as: only when an override is active (undefined otherwise) —
        // Perspectives then recompute in the override currency; no override ⇒
        // today's reporting-currency behavior.
        perspectiveTargetCurrency={viewOverride?.currency}
        // view-as: convert the Transactions summary (Spend / In) through the
        // override context when active; rows stay native either way.
        transactionsMoneyCtxOverride={viewOverride?.moneyCtx}
        // SD-2C — the "view as" control now mounts in the SpaceShell header (a
        // Space-level capability); the shell positions it, so no alignment
        // wrapper here. State + conversion are unchanged (owned here).
        displayCurrencyControl={
          <ViewCurrencyOverride
            spaceCurrency={displayCurrency}
            override={viewOverride}
            onChange={setViewOverride}
          />
        }
      />
    </DisplayCurrencyProvider>
  );
}
