"use client";

/**
 * components/space/widgets/liquidity/CashAccountsLedger.tsx   (v2.7 — Cash accounts)
 *
 * Section ⑤ of the Cash slice — every cash account behind TOTAL CASH, always
 * visible (never folded behind a disclosure): Institution · Account · Type ·
 * Reported · Pending · Total cash (ADJUSTED — the summed column) · % of total
 * cash · Available · Holds · Status, with a "Pending not reconciled" badge on an
 * UNPROVEN account. A readable table at ≥lg; compact rows below lg (CSS-only).
 *
 * FIGURES — the pure cash-accounts helper's, from the host's account array (the
 * classifier's per-row conversion over countedBalance, and `reachableForAccount`):
 * Σ Total cash = total cash (the Cash hero present-day and the donut centre),
 * Σ Available = accessible (reachableNow). The footer states both totals and two
 * reconciling lines built only from those per-account figures — reported →
 * total cash (pending not yet deducted), and total cash → accessible — so every
 * dollar is explained.
 *
 * STATUS + DETAIL — the EXISTING authorized Accounts read (GET
 * /api/spaces/[id]/accounts/detail, the one AccountsLedger uses) supplies the
 * connection chip (healthChip) and the per-account freshness answer, and a row
 * opens the EXISTING AccountDetail panel. Until it loads (or if it fails) the
 * Accounts workspace's own honest fallback rows are used — the same interim
 * answer that surface gives. No figure on this ledger comes from that read.
 *
 * TRANSIT (v2.7-P2) — GET /api/spaces/[id]/liquidity/cash-transit supplies recent
 * outgoing transfer legs with the transfer authority's verdict; the pure
 * lib/balances/cash-transit classifies them against the SAME adjusted basis and
 * the footer states only NEUTRAL lines ("not yet matched to a destination",
 * "still pending at the destination"). Never added to total cash, never a figure
 * in any column, nothing on a failed read.
 *
 * Aggregated privacy rows are shown as-is (no detail — they name no single
 * account); redacted accounts are not in the array and are disclosed by count.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatCurrency } from "@/lib/currency";
import { formatRelativeTime } from "@/lib/format";
import {
  accountBalanceClaimLabel, balanceClaimLabel, isStaleBand,
} from "@/lib/freshness/observation";
import type { ConversionContext } from "@/lib/money/types";
import type { AccountDetailRow } from "@/app/api/spaces/[id]/accounts/detail/route";
import { Surface } from "@/components/atlas/Surface";
import { WorkspaceLayout, RightPanel, PanelHeader, PanelContent } from "@/components/atlas/panels";
import { healthChip } from "@/components/space/widgets/accounts/AccountsPerspective";
import { AccountDetail } from "@/components/space/widgets/accounts/AccountDetail";
import { accountDetailDisplay, accountDetailFallbackRows } from "@/components/space/widgets/accounts/AccountsLedger";
import {
  pendingLine, reconcileTerms, type CashBalanceBasis, type CashAccountRow, type CashAccountsSummary, type CashLedgerAccount,
} from "./cash-accounts";
import { cashTransitDisclosure, summarizeCashTransit, type CashTransitLeg } from "@/lib/balances/cash-transit";
import { convertMoney } from "@/lib/money/convert";
import { yesterdayUTCISO } from "@/lib/fx/config";

export function CashAccountsLedger({
  spaceId,
  accounts,
  summary,
  ctx,
  currency,
  detailRows: detailRowsProp,
  transitLegs: transitLegsProp,
  now: nowProp,
}: {
  spaceId:  string;
  accounts: CashLedgerAccount[];
  summary:  CashAccountsSummary;
  ctx?:     ConversionContext;
  currency: string;
  /** Test seam — pre-supplied detail rows (skips the fetch). */
  detailRows?: AccountDetailRow[];
  /** Test seam — pre-supplied transit legs (skips the fetch). */
  transitLegs?: CashTransitLeg[];
  /** Test seam — the clock the transit window is measured against. */
  now?: Date;
}) {
  const [fetched, setFetched] = useState<AccountDetailRow[] | null>(null);
  const [redactedCount, setRedactedCount] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(() => {
    if (detailRowsProp) return;
    fetch(`/api/spaces/${spaceId}/accounts/detail`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((data) => {
        setFetched(Array.isArray(data) ? data : Array.isArray(data?.rows) ? data.rows : []);
        setRedactedCount(Array.isArray(data) ? 0 : Number(data?.redactedCount) || 0);
      })
      .catch(() => { /* honest fallback rows stay in place */ });
  }, [spaceId, detailRowsProp]);
  useEffect(() => { load(); }, [load]);

  // v2.7-P2 — recent outgoing transfers and the transfer authority's verdict on
  // each (presentation only). A failed read shows nothing — never a guess.
  const [fetchedLegs, setFetchedLegs] = useState<CashTransitLeg[] | null>(null);
  useEffect(() => {
    if (transitLegsProp) return;
    let alive = true;
    fetch(`/api/spaces/${spaceId}/liquidity/cash-transit`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((data) => { if (alive) setFetchedLegs(Array.isArray(data?.legs) ? data.legs : []); })
      .catch(() => { /* no disclosure */ });
    return () => { alive = false; };
  }, [spaceId, transitLegsProp]);

  const transitLines = useMemo(() => {
    const legs = transitLegsProp ?? fetchedLegs;
    if (!legs || legs.length === 0) return [];
    // The SAME adjusted-balance basis total cash uses, per account.
    const basis = new Map(accounts.map((a) => [a.id, (a.currentState?.basis ?? null) as CashBalanceBasis | null]));
    const asOf = yesterdayUTCISO();
    const toDisplay = (amount: number, cur: string | null) =>
      ctx ? convertMoney({ amount, currency: cur }, asOf, ctx).amount : amount;
    const s = summarizeCashTransit(legs, (id) => basis.get(id) ?? null, nowProp ?? new Date(), toDisplay);
    return cashTransitDisclosure(s, (v) => formatCurrency(v, currency));
  }, [transitLegsProp, fetchedLegs, accounts, ctx, currency, nowProp]);

  const detailById = useMemo(() => {
    const cashIds = new Set(summary.rows.map((r) => r.account.id));
    const source = detailRowsProp ?? fetched
      ?? accountDetailFallbackRows(accounts.filter((a) => cashIds.has(a.id)), new Date());
    return new Map(source.map((d) => [d.id, d]));
  }, [detailRowsProp, fetched, accounts, summary]);

  const selectedRow = selectedId ? summary.rows.find((r) => r.account.id === selectedId && !r.isAggregate) ?? null : null;
  const selectedDetail = selectedRow ? detailById.get(selectedRow.account.id) ?? null : null;

  if (summary.rows.length === 0) {
    return (
      <Surface className="px-4 py-8">
        <p className="text-center text-sm text-[var(--text-muted)]">No cash accounts in this Space yet.</p>
      </Surface>
    );
  }

  const fmt = (v: number) => formatCurrency(v, currency);
  const open = (id: string) => setSelectedId(id);

  return (
    <WorkspaceLayout>
      <Surface className="overflow-hidden min-w-0">
        {/* ≥lg — a readable table. */}
        <div className="max-lg:hidden overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Cash accounts — balances behind total cash, with what is available now</caption>
            <thead>
              <tr className="border-b border-[var(--border-hairline)] text-[10px] font-medium uppercase tracking-wide text-[var(--text-faint)]">
                <th scope="col" className="px-4 py-2.5 font-medium">Institution</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Account</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Type</th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">Reported</th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">Pending</th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">Total cash</th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">% of cash</th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">Available</th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">Holds</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-hairline)]">
              {summary.rows.map((r) => (
                <tr key={r.account.id} className="align-top transition-colors hover:bg-[var(--surface-hover)]">
                  <td className="px-4 py-3 text-[13px] text-[var(--text-muted)]">{institutionLabel(r)}</td>
                  <th scope="row" className="px-4 py-3 font-normal">
                    <AccountName row={r} mask={detailById.get(r.account.id)?.mask ?? null} onOpen={open} />
                  </th>
                  <td className="px-4 py-3 text-[13px] text-[var(--text-secondary)]">{r.typeLabel}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-[13px] text-[var(--text-muted)]">{r.unconverted ? "—" : fmt(r.reported)}</td>
                  <td className="px-4 py-3 text-right"><Pending row={r} fmt={fmt} /></td>
                  <td className="px-4 py-3 text-right"><Balance row={r} fmt={fmt} /></td>
                  <td className="px-4 py-3 text-right tabular-nums text-[13px] text-[var(--text-muted)]">{pct(r.share)}</td>
                  <td className="px-4 py-3 text-right"><Available row={r} fmt={fmt} /></td>
                  <td className="px-4 py-3 text-right tabular-nums text-[13px] text-[var(--text-muted)]">{holdText(r, fmt)}</td>
                  <td className="px-4 py-3"><Status detail={detailById.get(r.account.id) ?? null} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* <lg — compact rows, every account visible; a row opens its detail. */}
        <ul className="lg:hidden divide-y divide-[var(--border-hairline)]" data-compact-cash-accounts>
          {summary.rows.map((r) => {
            const body = (
              <>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-[var(--text-primary)]">{r.account.name}</p>
                    <p className="mt-0.5 truncate text-[11px] text-[var(--text-muted)]">{institutionLabel(r)} · {r.typeLabel}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <Balance row={r} fmt={fmt} />
                    <p className="mt-0.5 tabular-nums text-[11px] text-[var(--text-faint)]">{pct(r.share)} of cash</p>
                  </div>
                </div>
                {(r.pendingCorrection !== 0 || r.unproven) && (
                  <p className="mt-1 tabular-nums text-[11px] text-[var(--text-faint)]">
                    Reported {fmt(r.reported)}
                    {r.pendingCorrection !== 0 && <> · {r.pendingCorrection < 0 ? "−" : "+"} {fmt(Math.abs(r.pendingCorrection))} pending</>}
                    {r.unproven && <> · <UnprovenBadge /></>}
                  </p>
                )}
                <div className="mt-1.5 flex items-start justify-between gap-3 text-[11px]">
                  <Status detail={detailById.get(r.account.id) ?? null} />
                  <span className="shrink-0 text-right"><span className="text-[var(--text-faint)]">Available </span><Available row={r} fmt={fmt} inline /></span>
                </div>
              </>
            );
            return (
              <li key={r.account.id}>
                {r.isAggregate ? (
                  <div className="px-4 py-3">{body}</div>
                ) : (
                  <button
                    type="button"
                    onClick={() => open(r.account.id)}
                    aria-label={`Open details for ${r.account.name}`}
                    className="block min-h-11 w-full px-4 py-3 text-left transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--meridian-400)]"
                  >
                    {body}
                  </button>
                )}
              </li>
            );
          })}
        </ul>

        <LedgerFooter summary={summary} fmt={fmt} redactedCount={redactedCount} transitLines={transitLines} />
      </Surface>

      <RightPanel open={selectedRow != null && selectedDetail != null} onClose={() => setSelectedId(null)} ariaLabel="Account detail">
        {selectedRow && selectedDetail && (
          <>
            <PanelHeader eyebrow={selectedRow.account.institution || selectedRow.typeLabel} title={selectedRow.account.name} />
            <PanelContent>
              <AccountDetail
                row={selectedDetail}
                display={accountDetailDisplay(selectedDetail, ctx)}
                currency={currency}
                spaceId={spaceId}
                onChanged={load}
              />
            </PanelContent>
          </>
        )}
      </RightPanel>
    </WorkspaceLayout>
  );
}

// ── Cells ─────────────────────────────────────────────────────────────────────

function pct(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

function institutionLabel(r: CashAccountRow): string {
  if (r.account.institution) return r.account.institution;
  return r.isAggregate ? "Shared (institution withheld)" : "—";
}

function AccountName({ row, mask, onOpen }: { row: CashAccountRow; mask: string | null; onOpen: (id: string) => void }) {
  const name = (
    <>
      <span className="truncate text-sm font-medium text-[var(--text-primary)]">{row.account.name}</span>
      {mask && <span className="ml-1.5 text-[11px] text-[var(--text-faint)]">••••{mask}</span>}
    </>
  );
  if (row.isAggregate) {
    return (
      <span className="block min-w-0">
        {name}
        <span className="mt-0.5 block text-[11px] text-[var(--text-faint)]">{row.memberCount} accounts combined · details withheld</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onOpen(row.account.id)}
      aria-label={`Open details for ${row.account.name}`}
      className="group inline-flex min-h-6 max-w-full items-baseline text-left hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--meridian-400)]"
    >
      {name}
      <span aria-hidden className="ml-1 text-[11px] text-[var(--meridian-400)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">→</span>
    </button>
  );
}

function Balance({ row, fmt }: { row: CashAccountRow; fmt: (v: number) => string }) {
  return (
    <>
      {row.unconverted ? (
        <p className="text-[13px] text-[var(--text-muted)]">Not converted</p>
      ) : (
        <p className={`tabular-nums text-sm ${row.value < 0 ? "text-[var(--accent-negative)]" : "text-[var(--text-primary)]"}`}>
          {row.estimated ? "≈ " : ""}{fmt(row.value)}
        </p>
      )}
      {row.native && (
        <p className="mt-0.5 tabular-nums text-[11px] text-[var(--text-faint)]">{formatCurrency(row.native.amount, row.native.currency)}</p>
      )}
    </>
  );
}

function Available({ row, fmt, inline = false }: { row: CashAccountRow; fmt: (v: number) => string; inline?: boolean }) {
  const a = row.available;
  if (a.kind === "restricted") {
    return <span className="text-[13px] text-[var(--text-muted)]" title="Restricted use (e.g. HSA) — not counted as accessible">Restricted</span>;
  }
  if (a.kind === "not_reported") {
    return <span className="text-[13px] text-[var(--text-muted)]" title="The institution reported no available balance — excluded from accessible cash">Not reported</span>;
  }
  // v2.7-P0 — pending is no longer a note here: it is the correction between
  // Reported and Total cash (its own column). Holds stay beside Available on
  // compact rows (desktop has a Holds column).
  const notes = [
    inline && a.hold > 0.005 ? `${fmt(a.hold)} on hold` : null,
    inline && a.unreconciled > 0.005 ? `${fmt(a.unreconciled)} pending not reconciled` : null,
  ].filter(Boolean);
  return (
    <span className={inline ? "inline" : "block"}>
      <span className="tabular-nums text-sm text-[var(--text-primary)]">{fmt(a.value)}</span>
      {notes.length > 0 && (
        <span className={`${inline ? "ml-1" : "mt-0.5 block"} tabular-nums text-[11px] text-[var(--text-faint)]`}>{notes.join(" · ")}</span>
      )}
    </span>
  );
}

/** The Pending column: P for the account, with how it was treated. */
function Pending({ row, fmt }: { row: CashAccountRow; fmt: (v: number) => string }) {
  if (row.pendingSum == null || Math.abs(row.pendingSum) < 0.005) {
    return <span className="tabular-nums text-[13px] text-[var(--text-faint)]">—</span>;
  }
  const note =
    row.basis === "PENDING_EXCLUDED" ? "deducted here"
    : row.basis === "PENDING_INCLUDED" ? "already in balance"
    : null;
  return (
    <span className="block">
      <span className="tabular-nums text-[13px] text-[var(--text-secondary)]">{row.pendingSum < 0 ? "−" : "+"}{fmt(Math.abs(row.pendingSum))}</span>
      {note && <span className="mt-0.5 block text-[11px] text-[var(--text-faint)]">{note}</span>}
      {row.unproven && <span className="mt-0.5 block"><UnprovenBadge /></span>}
    </span>
  );
}

/** The flag on an UNPROVEN account: the reported balance is used unchanged. */
function UnprovenBadge() {
  return (
    <span
      className="inline-flex items-center rounded-[var(--radius-full)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent-warning)]"
      style={{ background: "var(--surface-inset)" }}
      title="The institution reported pending activity that could not be reconciled with its available balance, so the bank-reported balance is used unchanged."
      data-cash-unproven
    >
      Pending not reconciled
    </span>
  );
}

function holdText(row: CashAccountRow, fmt: (v: number) => string): string {
  const a = row.available;
  if (a.kind !== "amount") return "—";
  return a.hold > 0.005 ? fmt(a.hold) : "—";
}

function Status({ detail }: { detail: AccountDetailRow | null }) {
  if (!detail) return <span className="text-[11px] text-[var(--text-faint)]">—</span>;
  const chip = healthChip(detail.connectionState);
  const fresh = detail.freshness.balance;
  const stale = isStaleBand(fresh.band);
  const freshText = fresh.observedAt
    ? `${accountBalanceClaimLabel(fresh.basis)} ${formatRelativeTime(fresh.observedAt)}`
    : balanceClaimLabel(fresh.basis);
  return (
    <span className="block min-w-0 text-[11px]">
      {chip && (
        <span
          className="block font-medium"
          style={{ color: chip.tone === "positive" ? "var(--accent-positive)" : chip.tone === "warning" ? "var(--accent-warning)" : "var(--text-muted)" }}
        >
          {chip.label}
        </span>
      )}
      <span className="block" style={{ color: stale ? "var(--accent-warning)" : "var(--text-faint)" }}>
        {freshText}{stale ? " · stale" : ""}
      </span>
    </span>
  );
}

// ── Footer: both totals + the reconciling line ───────────────────────────────

function LedgerFooter({ summary, fmt, redactedCount, transitLines = [] }: { summary: CashAccountsSummary; fmt: (v: number) => string; redactedCount: number; transitLines?: string[] }) {
  const terms = reconcileTerms(summary);
  const pending = pendingLine(summary);
  const approx = summary.estimated ? "≈ " : "";
  return (
    <div className="border-t border-[var(--border-hairline)] bg-[var(--surface-inset)] px-4 py-3" data-cash-reconcile>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <p className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
          Total cash <span className="ml-1 text-sm font-semibold normal-case tracking-normal tabular-nums text-[var(--text-primary)]">{approx}{fmt(summary.totalCash)}</span>
        </p>
        <p className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
          Accessible now <span className="ml-1 text-sm font-semibold normal-case tracking-normal tabular-nums text-[var(--text-primary)]">{approx}{fmt(summary.accessible)}</span>
        </p>
      </div>
      {pending && (
        <p className="mt-1.5 tabular-nums text-[11px] leading-relaxed text-[var(--text-muted)] [overflow-wrap:anywhere]" data-cash-pending-line>
          Reported {fmt(pending.reported)} {pending.correction < 0 ? "−" : "+"} {pending.label} {fmt(Math.abs(pending.correction))} = Total cash {fmt(pending.totalCash)}
        </p>
      )}
      {terms.length > 0 && (
        <p className="mt-1.5 tabular-nums text-[11px] leading-relaxed text-[var(--text-muted)] [overflow-wrap:anywhere]" data-cash-reconcile-line>
          {fmt(summary.totalCash)} total cash
          {terms.map((t) => (
            <span key={t.id}> {t.amount <= 0 ? "−" : "+"} {fmt(Math.abs(t.amount))} {t.label}</span>
          ))}
          {" "}= {fmt(summary.accessible)} accessible
        </p>
      )}
      {summary.unprovenCount > 0 && (
        <p className="mt-1 text-[11px] text-[var(--text-faint)]" data-cash-unproven-note>
          {summary.unprovenCount} account{summary.unprovenCount === 1 ? "" : "s"}: pending not reconciled — the bank-reported balance is counted unchanged.
        </p>
      )}
      {transitLines.map((line) => (
        <p key={line} className="mt-1 tabular-nums text-[11px] text-[var(--text-faint)] [overflow-wrap:anywhere]" data-cash-transit-line>
          {line}
        </p>
      ))}
      {redactedCount > 0 && (
        <p className="mt-1 text-[11px] text-[var(--text-faint)]">
          {redactedCount} shared account{redactedCount === 1 ? "" : "s"} without balance disclosure {redactedCount === 1 ? "is" : "are"} excluded.
        </p>
      )}
    </div>
  );
}
