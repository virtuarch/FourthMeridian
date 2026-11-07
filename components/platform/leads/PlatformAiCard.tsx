"use client";

/**
 * components/platform/leads/PlatformAiCard.tsx  (Platform Economics — PR C: Platform AI in AI & Costs)
 *
 * The distinct PLATFORM AI category: AI invoked for operators (Comms Center
 * authoring), never customer spend. The card reads GET …/economics/platform-ai
 * (30 d) through the shared workspace fetch: the KPI (status chip, never $0 for
 * none), calls, failures, latency p50/p95 and the top model. "Calls" opens the
 * per-invocation records (model, in / out / cached tokens, latency, outcome,
 * cost, opaque operator ref). Read-only.
 */

import { useEffect, useState } from "react";
import { Block, Surface } from "@/components/atlas/Surface";
import { useSharedWidgetFetch } from "../workspace-session";
import { DetailDrawer } from "../ui";
import type { Fetched } from "../ops-visual/ops-visual-model";
import type { PlatformAiCallRow, PlatformAiRecords } from "@/lib/platform/economics/platform-ai";
import { ChartMessage, Doorway } from "./visual-kit";
import { figureSubText, figureValueText } from "./economics-model";
import { EconomicsStatusChip } from "./EconomicsOverviewLead";
import { usd } from "./ai-costs-model";

export const PLATFORM_AI_URL = "/api/platform/platform-ops/economics/platform-ai";
const n = (v: number) => v.toLocaleString("en-US");

/** The cost cell: only a priced, returned call shows dollars. */
export function platformAiCostText(r: Pick<PlatformAiCallRow, "pricing" | "costUsd">): string {
  if (r.pricing === "PRICED" && r.costUsd !== null) return usd(r.costUsd);
  return r.pricing === "NOT_COUNTED" ? "not counted" : r.pricing === "NO_TOKENS" ? "no tokens" : "unpriced";
}

export function PlatformAiSummary({ data, onOpenCalls }: { data: Fetched<PlatformAiRecords>; onOpenCalls?: () => void }) {
  const d = data.data;
  return (
    <Block id="ai-platform" label="Platform AI · 30 d" className="min-w-0"
      hint={d ? <EconomicsStatusChip status={d.figure.status} title={d.figure.basis} /> : undefined}
      action={d && d.counts.total > 0 && onOpenCalls ? <Doorway label="Calls" onSelect={onOpenCalls} dialog /> : undefined}>
      <Surface className="p-4 sm:p-5">
        {!d ? <ChartMessage>{data.loading ? "Reading Platform AI…" : `Platform AI unavailable${data.error ? ` — ${data.error}` : ""}`}</ChartMessage> : (
          <div className="flex min-w-0 flex-col gap-1" data-platform-ai={d.figure.status}>
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-2xl font-semibold tabular-nums text-[var(--text-primary)]" data-platform-ai-value>{figureValueText(d.figure)}</span>
              <span className="min-w-0 truncate text-[11px] text-[var(--text-muted)]">{figureSubText(d.figure)}</span>
            </span>
            <span className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-[11px] tabular-nums text-[var(--text-muted)]">
              <span>{`${n(d.counts.total)} calls · ${n(d.counts.failed)} failed · measured`}</span>
              <span>{d.latencyMs ? `latency p50 ${n(d.latencyMs.p50)} ms · p95 ${n(d.latencyMs.p95)} ms` : "latency: no returned calls"}</span>
              {d.byModel[0] && <span className="truncate">{`top model ${d.byModel[0].model}`}</span>}
            </span>
            <span className="truncate text-[10px] text-[var(--text-faint)]">Operator features (Comms authoring) · never customer spend</span>
          </div>
        )}
      </Surface>
    </Block>
  );
}

export function PlatformAiCallsList({ data }: { data: PlatformAiRecords }) {
  return (
    <div className="flex min-w-0 flex-col gap-3" data-platform-ai-calls>
      <p className="text-[11px] tabular-nums text-[var(--text-secondary)]" data-platform-ai-total>
        {`${figureValueText(data.figure)} · ${n(data.counts.returned)} returned · ${n(data.counts.failed)} failed (not counted) · ${n(data.counts.unpriced)} unpriced${data.truncated ? " · window truncated" : ""}`}
      </p>
      {data.byModel.length > 0 && (
        <ul aria-label="Platform AI by model" className="flex flex-col gap-0.5 text-[11px] text-[var(--text-muted)]">
          {data.byModel.map((m) => <li key={m.model} className="break-words tabular-nums">{`${m.model} · ${n(m.calls)} calls · ${n(m.failed)} failed · in ${n(m.promptTokens)} / out ${n(m.completionTokens)} / cached ${n(m.cachedPromptTokens)} · ${m.costUsd === null ? "unpriced" : usd(m.costUsd)}`}</li>)}
        </ul>
      )}
      {data.page.rows.length === 0 ? <ChartMessage>No Platform AI calls in this window.</ChartMessage> : (
        <ul aria-label="Platform AI calls" className="flex flex-col divide-y divide-[var(--border-hairline)]">
          {data.page.rows.map((r) => (
            <li key={r.id} className="flex min-h-11 min-w-0 flex-col gap-0.5 py-2 text-[11px]" data-platform-ai-pricing={r.pricing}>
              <span className="flex min-w-0 items-center justify-between gap-3">
                <span className="min-w-0 truncate text-[var(--text-secondary)]">{`${r.occurredAt.slice(0, 16).replace("T", " ")} UTC · ${r.subSurface ?? "comms_authoring"} · ${r.model}`}</span>
                <span className="shrink-0 tabular-nums text-[var(--text-primary)]">{platformAiCostText(r)}</span>
              </span>
              <span className="min-w-0 break-words tabular-nums text-[10px] text-[var(--text-muted)]">
                {`in ${n(r.promptTokens)} · out ${n(r.completionTokens)} · cached ${n(r.cachedPromptTokens)} · ${n(r.latencyMs)} ms · ${r.outcome}${r.errorCode ? ` · ${r.errorCode}` : ""} · ${r.operatorRef ?? "operator"}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {data.page.total > data.page.pageSize && <p className="text-[11px] text-[var(--text-muted)]">{`Showing the newest ${n(data.page.rows.length)} of ${n(data.page.total)}`}</p>}
    </div>
  );
}

/** The card + its records drawer (the drawer refetches page 1 at the card's own window end). */
export function PlatformAiCard() {
  const summary = useSharedWidgetFetch<PlatformAiRecords>(`${PLATFORM_AI_URL}?window=30d`);
  const [open, setOpen] = useState(false);
  const [calls, setCalls] = useState<{ data: PlatformAiRecords | null; error: string | null }>({ data: null, error: null });
  const until = summary.data ? Date.parse(summary.data.checkedAt) : null;
  useEffect(() => {
    if (!open || until === null) return;
    let alive = true;
    fetch(`${PLATFORM_AI_URL}?window=30d&until=${until}`, { credentials: "same-origin" })
      .then(async (r) => { if (!r.ok) throw new Error(`Request failed (${r.status})`); return (await r.json()) as PlatformAiRecords; })
      .then((data) => { if (alive) setCalls({ data, error: null }); })
      .catch((e: unknown) => { if (alive) setCalls({ data: null, error: e instanceof Error ? e.message : "Failed to load" }); });
    return () => { alive = false; };
  }, [open, until]);
  return (
    <>
      <PlatformAiSummary data={summary} onOpenCalls={() => setOpen(true)} />
      <DetailDrawer open={open} onClose={() => setOpen(false)} eyebrow="AI & Costs · Platform AI" title="Platform AI calls · 30 d" size="xl">
        {calls.error ? <ChartMessage>{`Calls unavailable — ${calls.error}`}</ChartMessage> : calls.data ? <PlatformAiCallsList data={calls.data} /> : <ChartMessage>Reading calls…</ChartMessage>}
      </DetailDrawer>
    </>
  );
}
