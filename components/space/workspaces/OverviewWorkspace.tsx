"use client";

/**
 * components/space/workspaces/OverviewWorkspace.tsx  (SD-7)
 *
 * The Overview destination — the Space's primary canvas. Extracted verbatim from the
 * three sibling host branches (composition switcher, coming-soon panel, and the
 * Overview canvas: hero → day-zero setup / section stack → doorways). Byte-identical:
 * the same components, the same gating, the same order. The workspace now OWNS the
 * Overview composition switcher state (composition / compositionItems) — Overview-only
 * state that the host used to hold — while the SHARED data (accounts, snapshots, the
 * fetched doorway nodes) come in as props.
 *
 * OverviewSetupCard (the day-zero state) lives here — it is Overview's, not a section
 * renderer, so it left SpaceSections with SD-7.
 */

import { useMemo, useState, type ReactNode } from "react";
import { Compass, Landmark, Plus, Target } from "lucide-react";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import { SpaceTrendHero, type HeroPoint } from "@/components/dashboard/widgets/SpaceTrendHero";
import { PerspectiveSwitcher, COMPOSITION_ICON_MAP } from "@/components/dashboard/widgets/PerspectiveSwitcher";
import { SpaceComingSoonPanel } from "@/components/dashboard/widgets/SpaceComingSoonPanel";
import { getCompositionSwitcherItems } from "@/lib/perspectives";
import type { SpaceHeroDef } from "@/lib/space-hero";
import {
  SpaceSectionStack,
  NoSectionsCard,
  type SectionCardBundle,
} from "./SpaceSectionStack";
import type { DashboardSection, SpaceAccount } from "@/lib/space/dashboard-types";

// Day-zero Overview state (v2.5 honesty slice) — shown INSTEAD of the section-card
// stack when the Space has no shared accounts yet. Moved here from SpaceDashboard
// with SD-7 (it is Overview's, not a section renderer). Byte-identical markup.
function OverviewSetupCard({
  canManage,
  onAddAccounts,
  onAddGoal,
}: {
  canManage:     boolean;
  onAddAccounts: () => void;
  onAddGoal:     () => void;
}) {
  return (
    <GlassPanel depth="thin" elevation="e2" radius="lg" className="p-8 text-center">
      <Landmark size={24} className="text-[var(--text-muted)] mx-auto mb-3" />
      <p className="text-base font-semibold text-[var(--text-primary)]">No accounts shared yet</p>
      <p className="text-sm text-[var(--text-secondary)] mt-1 max-w-md mx-auto leading-relaxed">
        {canManage
          ? "Share accounts with this Space to see balances, net worth, and activity here. Everything on this dashboard is computed from real data — sections appear as their data exists."
          : "Once an Owner or Admin shares accounts with this Space, balances and activity appear here."}
      </p>
      {canManage && (
        <div className="flex items-center justify-center gap-2 mt-5">
          <button
            onClick={onAddAccounts}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-[var(--accent-info)] text-white transition-colors"
          >
            <Plus size={13} /> Add accounts
          </button>
          <button
            onClick={onAddGoal}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-medium text-[var(--text-secondary)] hover:text-white hover:bg-[var(--surface-hover)] border border-[var(--border-hairline)] hover:border-[var(--border-hairline-strong)] transition-colors"
          >
            <Target size={13} /> Add a goal
          </button>
        </div>
      )}
    </GlassPanel>
  );
}

export function OverviewWorkspace({
  category,
  spaceType,
  accounts,
  loading,
  canManage,
  onManage,
  onAddGoal,
  // Hero (host-derived; heroDef also gates the host snapshot fetch, so it stays there)
  heroDef,
  heroPoints,
  heroHeadlineOverride,
  heroSublineNote,
  heroCurrency,
  snapshotsLoading,
  // Section stack
  sectionsForTab,
  card,
  // Change-preview doorways (host-composed nodes — read data already fetched)
  recentTransactionsDoorway,
  perspectivesDoorway,
}: {
  category: string;
  spaceType: string;
  accounts: SpaceAccount[];
  loading: boolean;
  canManage: boolean;
  onManage: () => void;
  onAddGoal: () => void;
  heroDef: SpaceHeroDef | null;
  heroPoints: HeroPoint[];
  heroHeadlineOverride?: string;
  heroSublineNote?: string;
  heroCurrency: string;
  snapshotsLoading: boolean;
  sectionsForTab: DashboardSection[];
  card: SectionCardBundle;
  recentTransactionsDoorway: ReactNode;
  perspectivesDoorway: ReactNode;
}) {
  // Overview-only composition switcher (IA refactor point 2/3) — "overview" is the
  // default, always-available composition; any other value is a comingSoon lens.
  const [composition, setComposition] = useState<string>("overview");
  const compositionItems = useMemo(() => getCompositionSwitcherItems(category), [category]);
  const activeComposition = compositionItems.find((p) => p.id === composition);

  return (
    <>
      {/* Composition switcher — only once a second REAL composition exists (else a
          switcher whose only other options are coming-soon panels is a dead end). */}
      {compositionItems.filter((p) => p.status === "available").length > 1 && (
        <div className="flex items-center px-1 mb-3">
          <PerspectiveSwitcher items={compositionItems} value={composition} onChange={setComposition} />
        </div>
      )}

      {composition !== "overview" && activeComposition && (
        <SpaceComingSoonPanel
          icon={(() => {
            const Icon = COMPOSITION_ICON_MAP[activeComposition.icon] ?? Compass;
            return <Icon size={20} />;
          })()}
          title={activeComposition.label}
          description={activeComposition.description}
        />
      )}

      {composition === "overview" && (
        // M3 Design Lab convergence — airy editorial rhythm between the lede
        // blocks (hero → balance history → composition → doorways), replacing the
        // former dense 12px stack, to match the Design Lab's generous whitespace.
        <div className="space-y-8 sm:space-y-10">
          {/* Hero — the template contract's slot 1 (One Space, One Lede). Only
              chartable categories have a heroDef; day-zero Spaces show the setup card. */}
          {accounts.length > 0 && heroDef && (
            <SpaceTrendHero
              title={heroDef.title}
              points={heroPoints}
              framing={heroDef.framing}
              chartType={heroDef.chartType}
              scopeLabel={heroDef.scopeLabel}
              loading={snapshotsLoading}
              headlineOverride={heroHeadlineOverride}
              sublineNote={heroSublineNote}
              currency={heroCurrency}
            />
          )}

          {!loading && accounts.length === 0 ? (
            // Day-zero Overview — one consolidated setup card (v2.5 honesty slice).
            <OverviewSetupCard canManage={canManage} onAddAccounts={onManage} onAddGoal={onAddGoal} />
          ) : (
            // Section stack. When the trend hero is rendering, hero + preview + doorways
            // IS the composition, so an empty-state card under the lede reads as breakage
            // — suppress it (heroDef && accounts>0 ⇒ null); hero-less categories keep the
            // honest empty state.
            <SpaceSectionStack
              sections={sectionsForTab}
              emptyState={heroDef && accounts.length > 0 ? null : <NoSectionsCard canManage={canManage} onManage={onManage} />}
              card={card}
            />
          )}

          {/* Template contract slots 4 & 5 — change preview + Perspectives doorway.
              Order: Personal puts Perspectives above Recent transactions; shared Spaces
              keep Recent-then-Perspectives. */}
          <div className="space-y-3 pt-2">
            {spaceType === "PERSONAL" ? (
              <>
                {perspectivesDoorway}
                {recentTransactionsDoorway}
              </>
            ) : (
              <>
                {recentTransactionsDoorway}
                {perspectivesDoorway}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
