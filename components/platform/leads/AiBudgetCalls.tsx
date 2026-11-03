"use client";

/**
 * components/platform/leads/AiBudgetCalls.tsx  (AI & Costs — the 24 h budget KPI's records)
 *
 * The per-call drilldown opened from "Budget used" and the Budget utilisation
 * card: the customer AI calls in the KPI's exact rolling window, paged, from
 * GET /api/platform/platform-ops/ai-budget/calls (PLATFORM_OPS READ). The
 * summary line is the KPI's own words (budgetTileText over the route's summary,
 * which is the KPI's own fold), so the list and the tile read the same.
 *
 * Columns: time · surface · model · in / out / cached tokens · cost · outcome
 * (+ the opaque customer reference — Platform Ops is identity-free). Cost is
 * the estimate for a priced call, "unpriced" for a call the rate card could
 * not price, and "not counted" for a failure fact — never $0 for either.
 * State (open · window end · page) lives in the URL (ai-budget-calls-url.ts).
 */

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { BudgetCallRow, BudgetCallsResponse } from "@/lib/platform/ai/budget-calls-core";
import { ProvenanceChip } from "../ui/ProvenanceChip";
import { ChartMessage } from "./visual-kit";
import { budgetMeterOf, budgetTileText, usd } from "./ai-costs-model";
import { aiBudgetCallsApiPath, type AiBudgetCallsUrlState } from "./ai-budget-calls-url";

const n = (v: number) => v.toLocaleString("en-US");
const FIELD = "min-h-11 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] bg-transparent px-2 text-xs text-[var(--text-secondary)] lg:min-h-8";
const TD = "px-2 py-2 align-top text-[var(--text-secondary)] tabular-nums";

const OUTCOME_WORD: Readonly<Record<string, string>> = {
  RETURNED: "Returned", FAILED: "Failed", TIMEOUT: "Timed out", RATE_LIMITED: "Rate-limited", QUOTA: "Quota",
};

/** The cost cell. Only a PRICED call shows dollars; nothing else is ever $0. */
export function callCostText(r: Pick<BudgetCallRow, "pricing" | "costUsd">): string {
  switch (r.pricing) {
    case "PRICED": return r.costUsd === null ? "unpriced" : usd(r.costUsd);
    case "UNPRICED": return "unpriced";
    case "NO_TOKENS": return "no tokens";
    case "NOT_COUNTED": return "not counted";
  }
}

export function callOutcomeText(r: Pick<BudgetCallRow, "outcome" | "errorCode">): string {
  const w = OUTCOME_WORD[r.outcome] ?? r.outcome.toLowerCase();
  return r.errorCode ? `${w} · ${r.errorCode}` : w;
}

/** "14:02:09 UTC · 3 Nov" — the window is ≤ 24 h, so time first. */
export function callTimeText(iso: string): string {
  const d = new Date(iso);
  return `${d.toISOString().slice(11, 19)} UTC · ${d.getUTCDate()} ${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })}`;
}

/** "Showing 26–50 of 112 calls · 108 counted · 4 not counted" — from the server's own counts. */
export function callsPopulationLine(d: Pick<BudgetCallsResponse, "page" | "counts">): string {
  const p = d.page;
  if (p.total === 0) return "No customer calls in this window";
  const from = (p.page - 1) * p.pageSize + 1;
  const to = from + p.rows.length - 1;
  const span = p.rows.length > 0 ? `Showing ${n(from)}–${n(to)} of ${n(p.total)} calls` : `${n(p.total)} calls`;
  return `${span} · ${n(d.counts.returned)} returned (counted) · ${n(d.counts.notCounted)} not counted`;
}

export function AiBudgetCallsTable({ data, onPage }: { data: BudgetCallsResponse; onPage: (p: number) => void }) {
  const t = budgetTileText(budgetMeterOf(data.summary));
  const pageCount = Math.max(1, Math.ceil(data.page.total / data.page.pageSize));
  return (
    <div className="flex min-w-0 flex-col gap-3" data-budget-calls data-fleet-spend-status={data.summary.status}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-lg font-semibold tabular-nums text-[var(--text-primary)]" data-budget-calls-headline>{t.headline}</span>
        <span className="text-[11px] tabular-nums text-[var(--text-muted)]" data-budget-calls-detail>{t.detail}</span>
        <ProvenanceChip kind={t.provenance} />
      </div>
      <p className="text-[11px] text-[var(--text-muted)]" data-budget-calls-window>
        {`Window ${data.window.since.slice(0, 16).replace("T", " ")} – ${data.window.until.slice(0, 16).replace("T", " ")} UTC · customer surfaces (Conversations, Daily Brief)`}
      </p>
      <p className="text-[11px] tabular-nums text-[var(--text-muted)]" data-budget-calls-population>{callsPopulationLine(data)}</p>
      {data.page.rows.length === 0 ? (
        <ChartMessage>{data.page.total === 0 ? "No customer AI calls were recorded in this window." : "No calls on this page."}</ChartMessage>
      ) : (
        <div className="min-w-0 overflow-x-auto">
          <table className="w-full min-w-[640px] text-xs" aria-label="Customer AI calls in the budget window">
            <thead><tr className="border-b border-[var(--border-hairline)] text-[10px] uppercase tracking-wide text-[var(--text-faint)]">
              {["Time", "Surface", "Model", "In", "Out", "Cached", "Cost", "Outcome", "Customer"].map((h) => <th key={h} scope="col" className="px-2 py-1.5 text-left font-medium">{h}</th>)}
            </tr></thead>
            <tbody className="divide-y divide-[var(--border-hairline)]">
              {data.page.rows.map((r) => (
                <tr key={r.id} data-call-pricing={r.pricing}>
                  <td className={TD}>{callTimeText(r.occurredAt)}</td>
                  <td className={TD}>{r.surface}</td>
                  <td className={`${TD} font-mono text-[11px]`}>{r.model}</td>
                  <td className={TD}>{n(r.promptTokens)}</td>
                  <td className={TD}>{n(r.completionTokens)}</td>
                  <td className={TD}>{n(r.cachedPromptTokens)}</td>
                  <td className={`${TD} ${r.pricing === "PRICED" ? "text-[var(--text-primary)]" : "text-[var(--text-faint)]"}`}>{callCostText(r)}</td>
                  <td className={TD}>{callOutcomeText(r)}</td>
                  <td className={`${TD} font-mono text-[10px]`}>{r.customerRef ?? "customer"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pageCount > 1 && (
        <nav aria-label="Pages" className="flex items-center justify-end gap-2 text-[11px] text-[var(--text-muted)]" data-pager>
          <button type="button" className={FIELD} disabled={data.page.page <= 1} onClick={() => onPage(data.page.page - 1)} aria-label="Previous page"><ChevronLeft size={12} aria-hidden /></button>
          <span className="tabular-nums">{`Page ${n(data.page.page)} of ${n(pageCount)}`}</span>
          <button type="button" className={FIELD} disabled={data.page.page >= pageCount} onClick={() => onPage(data.page.page + 1)} aria-label="Next page"><ChevronRight size={12} aria-hidden /></button>
        </nav>
      )}
      <p className="text-[10px] leading-relaxed text-[var(--text-faint)]">{data.estimateNote}</p>
    </div>
  );
}

/** Fetching wrapper (keyed, so a stale page never lands over a newer one). */
export function AiBudgetCalls({ state, onState }: { state: AiBudgetCallsUrlState; onState: (next: AiBudgetCallsUrlState) => void }) {
  const path = aiBudgetCallsApiPath(state);
  const [res, setRes] = useState<{ key: string | null; data: BudgetCallsResponse | null; error: string | null }>({ key: null, data: null, error: null });
  useEffect(() => {
    if (!path) return;
    let alive = true;
    fetch(path, { credentials: "same-origin" })
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 403 ? "Not authorized" : `Request failed (${r.status})`);
        return (await r.json()) as BudgetCallsResponse;
      })
      .then((data) => { if (alive) setRes({ key: path, data, error: null }); })
      .catch((e: unknown) => { if (alive) setRes({ key: path, data: null, error: e instanceof Error ? e.message : "Failed to load" }); });
    return () => { alive = false; };
  }, [path]);
  const fresh = res.key === path;
  if (fresh && res.error) return <ChartMessage>{`Calls unavailable — ${res.error}`}</ChartMessage>;
  if (!res.data) return <ChartMessage>Reading calls…</ChartMessage>;
  return <AiBudgetCallsTable data={res.data} onPage={(p) => onState({ ...state, page: p })} />;
}
