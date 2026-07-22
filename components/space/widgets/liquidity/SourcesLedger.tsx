"use client";

/**
 * components/space/widgets/liquidity/SourcesLedger.tsx
 *
 * Surface ③ of the Liquidity Workspace (present-day branch) — the SOURCES ledger, the
 * liquidity analogue of the Debt LiabilitiesLedger. NOT a card grid and NOT a ranked-bar
 * chart: an opaque read-Surface of divided rows GROUPED by access horizon (Available now
 * / Available in days / Illiquid), each carrying an inline weight bar whose LENGTH is its
 * share of total assets.
 *
 * The bar IS the concentration view, folded into the ledger where it's already relevant
 * ("most of your cash sits in one account" is visible at a glance — no second chart). It
 * is a NEUTRAL rule (share of assets is neither good nor bad, so it carries no colour).
 * The ledger shows the MOST IMPORTANT sources up front; "View all N sources →" opens the
 * full grouped list in a LeftPanel ("what am I operating in"). A row — in either place —
 * opens its detail in a RightPanel ("tell me more about what I selected"), stacked above
 * the LeftPanel via the shared PanelStack. All primitives are the generic Atlas panels —
 * no domain panel primitive is created here.
 *
 * PRESENT-DAY (the current anchor): every figure is display-converted here from the live
 * accounts array (the SAME source as classifyAccounts / the Ladder tiles), never the lens
 * and never a historical read. A historical view shows the reconstructed tier totals in
 * the workspace instead — per-account historical rows are not carried by the contract.
 */

import { useMemo, useState } from "react";
import { formatCurrency } from "@/lib/format";
import type { ConversionContext } from "@/lib/money/types";
import { Surface } from "@/components/atlas/Surface";
import {
  WorkspaceLayout, LeftPanel, RightPanel, PanelHeader, PanelContent,
} from "@/components/atlas/panels";
import type { LiquidityAdapterAccount } from "@/components/space/widgets/liquidity-adapters";
import {
  buildSourceRows, HORIZON_LABEL, HORIZON_META, HORIZON_COLOR, HORIZON_ORDER,
  type SourceHorizon, type LiquiditySourceRow,
} from "./liquidity-sources-util";
import { SourceAccountDetail } from "./SourceAccountDetail";
import { TierCompositionDetail } from "./TierCompositionDetail";

/** How many sources to show inline before folding the rest behind "View all". */
const MAX_INLINE = 5;

export function SourcesLedger({
  accounts,
  ctx,
  currency,
}: {
  accounts: LiquidityAdapterAccount[];
  ctx?:     ConversionContext;
  currency: string;
}) {
  const rows = useMemo(() => buildSourceRows(accounts, ctx), [accounts, ctx]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedTier, setSelectedTier] = useState<SourceHorizon | null>(null);
  const [allOpen, setAllOpen] = useState(false);
  const selected = selectedId ? rows.find((r) => r.account.id === selectedId) ?? null : null;
  // The tier's members are the SAME rows the ledger renders, so a tier total and
  // the accounts behind it are one set — no second partition.
  const tierRows = selectedTier ? rows.filter((r) => r.horizon === selectedTier) : [];
  const totalAssets = useMemo(() => rows.reduce((s, r) => s + r.value, 0), [rows]);

  if (rows.length === 0) {
    return (
      <Surface className="px-4 py-8">
        <p className="text-center text-sm text-[var(--text-muted)]">No liquidity sources yet — connect an asset account to see where your money sits.</p>
      </Surface>
    );
  }

  const inline = rows.slice(0, MAX_INLINE);
  const hidden = rows.length - inline.length;

  return (
    <WorkspaceLayout>
      <Surface className="overflow-hidden">
        <GroupedRows
          rows={inline}
          currency={currency}
          onOpen={setSelectedId}
          onOpenTier={setSelectedTier}
          selectedTier={selectedTier}
        />
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setAllOpen(true)}
            className="flex w-full items-center justify-between border-t border-[var(--border-hairline)] px-4 py-3 text-left text-[13px] font-medium text-[var(--meridian-400)] transition-colors hover:bg-[var(--surface-hover)]"
          >
            View all {rows.length} sources
            <span aria-hidden>→</span>
          </button>
        )}
      </Surface>

      {/* Full list — the context surface ("what am I operating in"). Tier headings
          stay INERT here on purpose: this panel already lists every account under
          every tier, so a tier drill would only re-show what is on screen. The
          drill exists on the main ledger because that one is truncated. */}
      <LeftPanel open={allOpen} onClose={() => setAllOpen(false)} ariaLabel="All liquidity sources">
        <PanelHeader eyebrow="Sources" title={`All ${rows.length} sources`} />
        <PanelContent>
          <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-hairline)]">
            <GroupedRows rows={rows} currency={currency} onOpen={setSelectedId} />
          </div>
        </PanelContent>
      </LeftPanel>

      {/* Tier composition — "what makes up my Available now?". */}
      <RightPanel open={selectedTier != null} onClose={() => setSelectedTier(null)} ariaLabel="Tier detail">
        {selectedTier && (
          <>
            <PanelHeader eyebrow="Reachability" title={HORIZON_LABEL[selectedTier]} />
            <PanelContent>
              <TierCompositionDetail
                horizon={selectedTier}
                rows={tierRows}
                totalAssets={totalAssets}
                currency={currency}
              />
            </PanelContent>
          </>
        )}
      </RightPanel>

      {/* Per-source detail — the drill surface, stacked above the list. */}
      <RightPanel open={selected != null} onClose={() => setSelectedId(null)} ariaLabel="Source detail">
        {selected && (
          <>
            <PanelHeader eyebrow={HORIZON_LABEL[selected.horizon]} title={selected.account.name} />
            <PanelContent>
              <SourceAccountDetail row={selected} currency={currency} />
            </PanelContent>
          </>
        )}
      </RightPanel>
    </WorkspaceLayout>
  );
}

/** Rows split under their horizon headings, in the canonical reachability order. */
function GroupedRows({
  rows, currency, onOpen, onOpenTier, selectedTier,
}: {
  rows:          LiquiditySourceRow[];
  currency:      string;
  onOpen:        (id: string) => void;
  onOpenTier?:   (horizon: SourceHorizon) => void;
  selectedTier?: SourceHorizon | null;
}) {
  const groups = HORIZON_ORDER
    .map((h) => ({ horizon: h, rows: rows.filter((r) => r.horizon === h) }))
    .filter((g) => g.rows.length > 0);

  return (
    <>
      {groups.map((g, gi) => (
        <div key={g.horizon} className={gi > 0 ? "border-t border-[var(--border-hairline)]" : ""}>
          <GroupHeading
            horizon={g.horizon}
            count={g.rows.length}
            onOpen={onOpenTier ? () => onOpenTier(g.horizon) : undefined}
            selected={selectedTier === g.horizon}
          />
          <div className="divide-y divide-[var(--border-hairline)]">
            {g.rows.map((r) => (
              <LedgerRow key={r.account.id} row={r} currency={currency} onOpen={() => onOpen(r.account.id)} />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

/**
 * The horizon heading — the LADDER TIER, and the ledger's second interrogable
 * level (UX-CLOSE-3). A row answers "what is this account"; the tier answers
 * "what makes up my Available now". Selectable only when a handler is supplied,
 * so it never renders a control that does nothing.
 */
function GroupHeading({
  horizon, count, onOpen, selected,
}: {
  horizon:  SourceHorizon;
  count:    number;
  onOpen?:  () => void;
  selected?: boolean;
}) {
  const inner = (
    <>
      <span className="flex min-w-0 items-center gap-2">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: HORIZON_COLOR[horizon] }} />
        <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-faint)]">{HORIZON_LABEL[horizon]}</span>
        <span className="truncate text-[10px] text-[var(--text-faint)]">· {HORIZON_META[horizon]}</span>
      </span>
      <span className="shrink-0 text-[10px] tabular-nums text-[var(--text-faint)]">{count}</span>
    </>
  );

  if (!onOpen) {
    return <div className="flex items-center justify-between px-4 pt-3 pb-1.5">{inner}</div>;
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${HORIZON_LABEL[horizon]} — show all accounts in this tier`}
      aria-pressed={selected}
      className="group relative flex w-full items-center justify-between px-4 pt-3 pb-1.5 text-left transition-colors hover:bg-[var(--surface-hover)]"
    >
      <span
        aria-hidden
        className={`absolute inset-y-1 left-0 w-0.5 rounded-full bg-[var(--meridian-400)] transition-opacity ${
          selected ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
        }`}
      />
      {inner}
    </button>
  );
}

function LedgerRow({ row, currency, onOpen }: { row: LiquiditySourceRow; currency: string; onOpen: () => void }) {
  const a = row.account;
  const approx = row.estimated ? "≈ " : "";

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group relative flex w-full items-center gap-3 overflow-hidden px-4 py-3 text-left transition-colors hover:bg-[var(--surface-hover)]"
    >
      {/* Weight bar — a 2px NEUTRAL rule on the row baseline; length = share of assets. */}
      <span
        aria-hidden
        className="absolute bottom-0 left-0 h-0.5 transition-[width] duration-500"
        style={{ width: `${row.share * 100}%`, background: "var(--border-hairline-strong)" }}
      />
      {/* Hover accent rail — the affordance that this row opens a detail. */}
      <span
        aria-hidden
        className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-[var(--meridian-400)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
      />

      <div className="relative min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-[var(--text-primary)]">{a.name}</p>
        {a.institution && <p className="mt-0.5 truncate text-[11px] text-[var(--text-muted)]">{a.institution}</p>}
      </div>

      <div className="relative shrink-0 text-right">
        <p className="tabular-nums text-sm text-[var(--text-primary)]">{approx}{formatCurrency(row.value, currency)}</p>
        <p className="mt-0.5 tabular-nums text-[11px] text-[var(--text-faint)]">{(row.share * 100).toFixed(0)}%</p>
      </div>
    </button>
  );
}
