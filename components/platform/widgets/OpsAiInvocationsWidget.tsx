"use client";

/**
 * components/platform/widgets/OpsAiInvocationsWidget.tsx  (PLATFORM OPS OBSERVABILITY · ops_ai_invocations)
 *
 * AI operations and economics over the per-invocation ledger, priced by the
 * code-owned rate card (GET /api/platform/platform-ops/ai-invocations).
 *
 * The operator filters by the dimensions the ledger RECORDS — window,
 * surface, model, environment — and nothing else: there is no user or Space
 * dimension because the ledger stores none, and the payload says so. The
 * filtered read is a keyed body remounted per query.
 *
 * Presentation only: every figure is the server's, every dollar the rate
 * card's. Nothing here adds, prices, or converts absence into zero.
 */

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { WidgetMessage, timeAgo, type PlatformSection } from "../widget-kit";
import { useKeyedFetch } from "../keyed-fetch";
import { BigStat, GroupLabel, KeyRow, SectionSurface, Unavailable } from "../platform-surface";
import type { AiOperations } from "@/lib/platform/ai/invocations";
import type { AiBucket, AiWindow } from "@/lib/platform/ai/invocations-core";

const WINDOWS: readonly { value: AiWindow; label: string }[] = [
  { value: "24h", label: "24 h" }, { value: "7d", label: "7 days" }, { value: "30d", label: "30 days" },
];

const FOOTNOTE =
  "Dollars are estimates from the code-owned rate card applied to recorded tokens (cached prompt tokens at the cached rate). The ledger records billed, returned calls only — a timeout writes no row — and carries no user or Space identity by design.";

const usd = (v: number | null) => (v === null ? null : `$${v.toFixed(v < 1 ? 4 : 2)}`);
const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)} M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)} k` : String(n));
const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);

function Chip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="rounded-[var(--radius-sm)] border px-2 py-0.5 text-[11px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--meridian-400)]"
      style={{
        borderColor: active ? "var(--meridian-400)" : "var(--border-hairline)",
        color: active ? "var(--text-primary)" : "var(--text-secondary)",
        background: active ? "color-mix(in srgb, var(--meridian-500) 10%, transparent)" : "transparent",
      }}
    >
      {label}
    </button>
  );
}

function BucketList({ title, hint, buckets, keyLabel }: { title: string; hint: string; buckets: readonly AiBucket[]; keyLabel?: (k: string) => string }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <GroupLabel hint={hint}>{title}</GroupLabel>
      {buckets.length === 0 ? (
        <Unavailable reason="nothing recorded in this window" />
      ) : (
        <div className="flex flex-col gap-1.5">
          {buckets.map((b) => (
            <KeyRow
              key={b.key}
              label={keyLabel ? keyLabel(b.key) : b.key}
              value={
                <span>
                  {b.invocations} · {tokens(b.promptTokens + b.completionTokens)} tok · {usd(b.usd) ?? <span className="text-[var(--text-muted)]">unpriced</span>}
                </span>
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AiBody({ query, onAvailable }: { query: string; onAvailable: (a: AiOperations["available"]) => void }) {
  const { data, loading, error } = useKeyedFetch<AiOperations>(`/api/platform/platform-ops/ai-invocations?${query}`);
  // The filter controls learn the window's distinct values from the payload.
  useEffect(() => { if (data) onAvailable(data.available); }, [data, onAvailable]);
  if (loading || error || !data) return <WidgetMessage loading={loading} error={error} />;
  const t = data.totals;

  return (
    <div className="flex flex-col gap-8">
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <BigStat label="Invocations" value={t.invocations} qualifier={`${data.window.key} · billed calls only`} />
        <BigStat
          label="Estimated spend"
          value={usd(t.usd) ?? <Unavailable reason={t.invocations ? "no rate for these models" : "nothing recorded"} />}
          qualifier={t.unpricedTokens ? `${tokens(t.unpricedTokens)} tokens unpriced` : "rate card"}
        />
        <BigStat label="Prompt tokens" value={tokens(t.promptTokens)} qualifier={`${pct(t.cacheShare)} served from cache`} />
        <BigStat label="Output tokens" value={tokens(t.completionTokens)} qualifier={t.reasoningTokens ? `${tokens(t.reasoningTokens)} reasoning` : "no reasoning tokens"} />
        <BigStat label="Tool calls" value={t.toolCalls} qualifier="requested by the model" />
        <BigStat label="Latency" value={t.meanLatencyMs === null ? <Unavailable reason="nothing recorded" /> : `${(t.meanLatencyMs / 1000).toFixed(1)} s`} qualifier={t.maxLatencyMs === null ? undefined : `mean · max ${(t.maxLatencyMs / 1000).toFixed(1)} s`} />
      </div>

      <div className="grid gap-8 md:grid-cols-2 xl:grid-cols-4">
        <BucketList title="By surface" hint="Where the call came from: chat, brief, harness. (none) = outside any context." buckets={data.bySurface} />
        <BucketList title="By model" hint="Provider and model, priced by the rate in force on the day." buckets={data.byModel} />
        <BucketList title="By environment" hint="The deployment environment recorded on the row." buckets={data.byEnvironment} />
        <BucketList title="By day (UTC)" hint="Each day priced at that day's rate." buckets={data.byDay.slice(-7)} />
      </div>

      <div className="flex flex-col gap-2">
        <GroupLabel hint="The newest invocations in the window: the request/turn grain the ledger records. The correlator is an opaque digest.">Recent invocations</GroupLabel>
        {data.recent.length === 0 ? (
          <Unavailable reason="nothing recorded" />
        ) : (
          <ul className="flex flex-col">
            {data.recent.map((r, i) => (
              <li key={`${r.occurredAt}-${i}`} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b py-2 text-xs last:border-b-0" style={{ borderColor: "var(--border-hairline)" }}>
                <span className="min-w-0 truncate text-[var(--text-primary)]">
                  {r.surface ?? data.unattributedSurfaceKey} · {r.model}
                  <span className="text-[var(--text-muted)]">{r.turnIndex !== null ? ` · turn ${r.turnIndex}` : ""}{r.correlationId ? ` · ${r.correlationId.slice(0, 18)}` : ""}</span>
                </span>
                <span className="shrink-0 tabular-nums text-[var(--text-secondary)]">
                  {tokens(r.promptTokens)} in ({pct(r.promptTokens ? r.cachedPromptTokens / r.promptTokens : null)} cached) · {tokens(r.completionTokens)} out · {r.toolCalls} tools · {(r.latencyMs / 1000).toFixed(1)} s · {timeAgo(r.occurredAt)} ago
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function OpsAiInvocationsWidget({ section }: { section: PlatformSection }) {
  const [window, setWindow] = useState<AiWindow>("7d");
  const [surface, setSurface] = useState("");
  const [model, setModel] = useState("");
  const [environment, setEnvironment] = useState("");
  const [available, setAvailable] = useState<AiOperations["available"]>({ surfaces: [], models: [], environments: [] });

  const params = new URLSearchParams({ window });
  if (surface) params.set("surface", surface);
  if (model) params.set("model", model.includes(":") ? model.slice(model.indexOf(":") + 1) : model);
  if (environment) params.set("environment", environment);
  const query = params.toString();

  return (
    <SectionSurface icon={Sparkles} title={section.label} footnote={FOOTNOTE}>
      <div className="mb-6 flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Window">
          {WINDOWS.map((w) => <Chip key={w.value} active={window === w.value} label={w.label} onClick={() => setWindow(w.value)} />)}
        </div>
        {(available.surfaces.length > 1 || available.models.length > 1 || available.environments.length > 1) && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {available.surfaces.length > 1 && (
              <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Surface">
                <Chip active={surface === ""} label="All surfaces" onClick={() => setSurface("")} />
                {available.surfaces.map((s) => <Chip key={s} active={surface === s} label={s} onClick={() => setSurface(s)} />)}
              </div>
            )}
            {available.models.length > 1 && (
              <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Model">
                <Chip active={model === ""} label="All models" onClick={() => setModel("")} />
                {available.models.map((m) => <Chip key={m} active={model === m} label={m} onClick={() => setModel(m)} />)}
              </div>
            )}
            {available.environments.length > 1 && (
              <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Environment">
                <Chip active={environment === ""} label="All environments" onClick={() => setEnvironment("")} />
                {available.environments.map((e) => <Chip key={e} active={environment === e} label={e} onClick={() => setEnvironment(e)} />)}
              </div>
            )}
          </div>
        )}
      </div>
      <AiBody key={query} query={query} onAvailable={setAvailable} />
    </SectionSurface>
  );
}
