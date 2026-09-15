"use client";

/**
 * components/platform/widgets/OpsBriefOpsWidget.tsx  (PLATFORM OPS OBSERVABILITY · ops_brief_ops)
 *
 * Daily Brief operations over GET /api/platform/platform-ops/brief-ops:
 * generated / failed / in progress / on an older version, the reasons, the
 * per-generation economics joined by correlationId, and the rows behind them.
 *
 * What the authority cannot say is said, not approximated: reuse (a cached
 * read writes nothing), generation duration (never persisted) and the cost
 * of a failed attempt (no invocation row) are all labelled as not recorded.
 * Presentation only.
 */

import { useState } from "react";
import { Newspaper } from "lucide-react";
import { WidgetMessage, timeAgo, type PlatformSection } from "../widget-kit";
import { useKeyedFetch } from "../keyed-fetch";
import { BigStat, GroupLabel, KeyRow, SectionSurface, StatusWord, TONE_COLOR, Unavailable } from "../platform-surface";
import type { BriefOps, BriefRowState } from "@/lib/platform/ai/brief-ops";
import type { AiWindow } from "@/lib/platform/ai/invocations-core";

const WINDOWS: readonly { value: AiWindow; label: string }[] = [
  { value: "24h", label: "24 h" }, { value: "7d", label: "7 days" }, { value: "30d", label: "30 days" },
];

const STATE_WORD: Record<BriefRowState, string> = { GENERATED: "Generated", FAILED: "Failed", IN_PROGRESS: "In progress", EMPTY: "Empty" };
const STATE_TOKEN: Record<BriefRowState, string> = { GENERATED: TONE_COLOR.ok, FAILED: TONE_COLOR.bad, IN_PROGRESS: TONE_COLOR.info, EMPTY: TONE_COLOR.muted };

const FOOTNOTE =
  "States are derived from the Brief rows (generated / failed / claimed / version). Cost is the joined invocation priced by the rate card — exact per successful generation. Reuse of a cached Brief is not counted, generation duration is not persisted, and a failed attempt's cost is unknown.";

const usd = (v: number | null) => (v === null ? null : `$${v.toFixed(4)}`);

function Chip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button" onClick={onClick} aria-pressed={active}
      className="rounded-[var(--radius-sm)] border px-2 py-0.5 text-[11px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--meridian-400)]"
      style={{ borderColor: active ? "var(--meridian-400)" : "var(--border-hairline)", color: active ? "var(--text-primary)" : "var(--text-secondary)", background: active ? "color-mix(in srgb, var(--meridian-500) 10%, transparent)" : "transparent" }}
    >
      {label}
    </button>
  );
}

function Tally({ title, hint, entries }: { title: string; hint: string; entries: Readonly<Record<string, number>> }) {
  const keys = Object.keys(entries);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <GroupLabel hint={hint}>{title}</GroupLabel>
      {keys.length === 0 ? <Unavailable reason="none in this window" /> : (
        <div className="flex flex-col gap-1.5">{keys.map((k) => <KeyRow key={k} label={k.toLowerCase().replace(/_/g, " ")} value={entries[k]} />)}</div>
      )}
    </div>
  );
}

function BriefBody({ window }: { window: AiWindow }) {
  const { data, loading, error } = useKeyedFetch<BriefOps>(`/api/platform/platform-ops/brief-ops?window=${window}`);
  if (loading || error || !data) return <WidgetMessage loading={loading} error={error} />;
  const c = data.counts;
  const e = data.economics;

  return (
    <div className="flex flex-col gap-8">
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        <BigStat label="Generated" value={c.generated} qualifier={`${data.window.key} · ${c.distinctSpaces} Space${c.distinctSpaces === 1 ? "" : "s"}`} />
        <BigStat label="Failed" value={c.failed} qualifier={c.coolingDown ? `${c.coolingDown} cooling down` : "newer than any generation"} />
        <BigStat label="In progress" value={c.inProgress} qualifier="claimed within the lease" />
        <BigStat label="Older version" value={c.versionStale} qualifier={`current ${data.currentGenerationVersion}`} />
      </div>

      <div className="grid gap-8 md:grid-cols-2 xl:grid-cols-4">
        <div className="flex min-w-0 flex-col gap-2">
          <GroupLabel hint="Invocations joined 1:1 to a generated Brief by correlationId, priced by the rate card.">Generation economics</GroupLabel>
          <div className="flex flex-col gap-1.5">
            <KeyRow label="Generations priced" value={`${e.correlated.invocations - e.correlated.unpricedInvocations} of ${e.correlated.invocations}`} />
            <KeyRow label="Spend (exact, successes)" value={usd(e.correlated.usd) ?? <Unavailable reason="nothing priced" />} />
            <KeyRow label="Mean provider latency" value={e.correlated.meanLatencyMs === null ? "—" : `${(e.correlated.meanLatencyMs / 1000).toFixed(1)} s`} />
            <KeyRow label="Surface total (all brief calls)" value={`${e.surfaceTotal.invocations} · ${usd(e.surfaceTotal.usd) ?? "unpriced"}`} />
            <KeyRow label="Generated without a join" value={<span style={e.uncorrelatedGenerations ? { color: TONE_COLOR.warn } : undefined}>{e.uncorrelatedGenerations}</span>} />
          </div>
        </div>
        <Tally title="Failure reasons" hint="The typed reason on the row's last failure." entries={data.failureReasons} />
        <Tally title="Why generated" hint="Recovered from the success correlator: daily, material change, or a generation-version bump." entries={data.generationReasons} />
        <div className="flex min-w-0 flex-col gap-2">
          <GroupLabel hint="Generated and failed per Brief day, newest first.">By day</GroupLabel>
          {data.byDay.length === 0 ? <Unavailable reason="no rows" /> : (
            <div className="flex flex-col gap-1.5">{data.byDay.slice(0, 7).map((d) => <KeyRow key={d.day} label={d.day} value={`${d.generated} generated · ${d.failed} failed`} />)}</div>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <GroupLabel hint="Newest rows first. Space references are opaque; owners are never shown.">Rows</GroupLabel>
        {data.rows.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)]">No Brief rows in this window — Briefs generate on demand, so an empty window is not a failure.</p>
        ) : (
          <ul className="flex flex-col">
            {data.rows.map((r) => (
              <li key={`${r.spaceRef}-${r.briefDay}`} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b py-2 text-xs last:border-b-0" style={{ borderColor: "var(--border-hairline)" }}>
                <span className="flex min-w-0 items-baseline gap-3">
                  <StatusWord word={STATE_WORD[r.state]} token={STATE_TOKEN[r.state]} />
                  <span className="truncate text-[var(--text-primary)]">
                    {r.briefDay} · Space {r.spaceRef}
                    <span className="text-[var(--text-muted)]">
                      {r.generationReason ? ` · ${r.generationReason}` : ""}{r.model ? ` · ${r.model}` : ""}{r.versionStale ? " · older version" : ""}{r.coolingDown ? " · cooling down" : ""}
                    </span>
                  </span>
                </span>
                <span className="shrink-0 tabular-nums text-[var(--text-secondary)]">
                  {r.state === "FAILED"
                    ? <span style={{ color: TONE_COLOR.bad }}>{r.lastFailureReason ?? "failed"} · {r.lastFailedAt ? `${timeAgo(r.lastFailedAt)} ago` : ""}</span>
                    : r.invocation
                      ? `${(r.invocation.latencyMs / 1000).toFixed(1)} s · ${usd(r.invocation.usd) ?? "unpriced"} · ${r.generatedAt ? `${timeAgo(r.generatedAt)} ago` : ""}`
                      : r.generatedAt ? `generated ${timeAgo(r.generatedAt)} ago · no invocation joined` : "—"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function OpsBriefOpsWidget({ section }: { section: PlatformSection }) {
  const [window, setWindow] = useState<AiWindow>("7d");
  return (
    <SectionSurface icon={Newspaper} title={section.label} footnote={FOOTNOTE}>
      <div className="mb-6 flex flex-wrap items-center gap-1" role="group" aria-label="Window">
        {WINDOWS.map((w) => <Chip key={w.value} active={window === w.value} label={w.label} onClick={() => setWindow(w.value)} />)}
      </div>
      <BriefBody key={window} window={window} />
    </SectionSurface>
  );
}
