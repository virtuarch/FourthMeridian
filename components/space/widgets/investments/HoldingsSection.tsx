"use client";

/**
 * components/space/widgets/investments/HoldingsSection.tsx
 *
 * The inline Holdings section of the Investments Workspace (SD-4 §3-6, §10). It OWNS
 * its local view state (`mode: "grid" | "detail"` + `selectedId`) so the Workspace does
 * not carry low-level card interaction. Default view is the responsive top-5 GRID (the
 * shared HoldingsGrid); clicking a card switches THIS section to the shared HoldingDetail
 * (no navigation, no dropdown/accordion). A compact "Show all" in the section HEADER
 * (top utility, visually secondary) opens the full HoldingsModal (grid → detail there).
 *
 * The card grid and the detail are the SAME shared components the modal uses — one card,
 * one detail, multiple composition contexts. Ranking/order is the DTO's, unchanged.
 */

import { useState } from "react";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import type { ValuedHoldingRow } from "@/lib/investments/investments-time-machine-core";
import { HoldingsGrid } from "./HoldingsGrid";
import { HoldingDetail } from "./HoldingDetail";
import { HoldingsModal } from "./HoldingsModal";
import { rowKey } from "./holdings-util";

const TOP_N = 5;

export function HoldingsSection({ holdings, reportingCurrency, accounts }: {
  holdings: ValuedHoldingRow[]; reportingCurrency: string; accounts: { id: string; name: string }[];
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const accountName = (id: string): string => accounts.find((a) => a.id === id)?.name ?? "Unknown account";
  const selected = selectedId ? holdings.find((r) => rowKey(r) === selectedId) ?? null : null;
  const top = holdings.slice(0, TOP_N);

  return (
    <GlassPanel depth="thin" elevation="e2" radius="lg" className="p-4 min-w-0">
      {/* Section header: title + a secondary "Show all" (top utility, §4). */}
      <div className="flex items-center justify-between gap-2 px-1 mb-2">
        <p className="text-sm font-semibold text-[var(--text-primary)]">Holdings</p>
        {holdings.length > TOP_N && !selected && (
          <button type="button" onClick={() => setShowModal(true)}
            className="text-xs font-medium hover:underline" style={{ color: "var(--text-muted)" }}>
            Show all {holdings.length}
          </button>
        )}
      </div>

      {selected ? (
        <HoldingDetail row={selected} reportingCurrency={reportingCurrency} accountName={accountName(selected.accountId)}
          onBack={() => setSelectedId(null)} />
      ) : (
        <HoldingsGrid rows={top} reportingCurrency={reportingCurrency} onSelect={setSelectedId} />
      )}

      {showModal && (
        <HoldingsModal holdings={holdings} reportingCurrency={reportingCurrency} accounts={accounts} onClose={() => setShowModal(false)} />
      )}
    </GlassPanel>
  );
}
