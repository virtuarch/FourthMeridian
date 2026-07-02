"use client";

/**
 * SpaceComingSoonPanel
 *
 * Shared placeholder for fixed-rail tabs with no real feature behind them
 * yet (Finances, Transactions, Documents — see PLACEHOLDER_SPACE_TABS in
 * lib/space-nav.ts). One component so all three read identically and so
 * swapping in a real implementation later only ever means deleting one
 * call site, not redesigning a bespoke "coming soon" block per tab.
 */

import { GlassPanel } from "@/components/atlas/GlassPanel";

export function SpaceComingSoonPanel({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <GlassPanel depth="thin" elevation="e2" radius="lg" className="p-10 flex flex-col items-center text-center">
      <div className="w-12 h-12 rounded-[var(--radius-md)] bg-[var(--surface-muted)] border border-[var(--border-hairline)] flex items-center justify-center mb-4 text-[var(--meridian-400)]">
        {icon}
      </div>
      <p className="text-sm font-semibold text-[var(--text-primary)]">{title}</p>
      <p className="text-xs text-[var(--text-secondary)] mt-1.5 max-w-xs">{description}</p>
    </GlassPanel>
  );
}
