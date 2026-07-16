"use client";

/**
 * components/space/widgets/investments/HoldingsModal.tsx
 *
 * The full-holdings modal (SD-4 §7-9). Opens in the GRID view (the same shared
 * HoldingsGrid as the inline section — no divergent implementation); clicking a card
 * transitions the SAME modal to the shared HoldingDetail (no nested modal, no second
 * overlay, no accordion). Two distinct controls: GlassModal's Close (X), and the
 * detail's own "← All holdings" back-to-grid.
 */

import { useState } from "react";
import { TrendingUp } from "lucide-react";
import type { ValuedHoldingRow } from "@/lib/investments/investments-time-machine-core";
import { GlassModal } from "@/components/dashboard/widgets/GlassModal";
import { HoldingsGrid } from "./HoldingsGrid";
import { HoldingDetail } from "./HoldingDetail";
import { rowKey } from "./holdings-util";

export function HoldingsModal({ holdings, reportingCurrency, accounts, onClose }: {
  holdings: ValuedHoldingRow[]; reportingCurrency: string; accounts: { id: string; name: string }[]; onClose: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const accountName = (id: string): string => accounts.find((a) => a.id === id)?.name ?? "Unknown account";
  const selected = selectedId ? holdings.find((r) => rowKey(r) === selectedId) ?? null : null;

  return (
    <GlassModal title="All holdings" subtitle={`${holdings.length} positions`} icon={TrendingUp} size="xl" onClose={onClose}>
      {selected ? (
        <HoldingDetail row={selected} reportingCurrency={reportingCurrency} accountName={accountName(selected.accountId)}
          onBack={() => setSelectedId(null)} backLabel="All holdings" />
      ) : (
        <HoldingsGrid rows={holdings} reportingCurrency={reportingCurrency} onSelect={setSelectedId} />
      )}
    </GlassModal>
  );
}
