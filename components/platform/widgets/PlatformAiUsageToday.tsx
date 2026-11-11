/**
 * components/platform/widgets/PlatformAiUsageToday.tsx  (PLATFORM AI COST MANAGEMENT — today's usage card)
 *
 * READ-ONLY. Today's ESTIMATED Platform AI spend against the platform cap: spent,
 * remaining (or why every question is refused), questions / calls / failures, a meter,
 * by model and by feature, how many people are at or near a limit (counts only) and,
 * when given, the viewer's own figures. No button, no input, no network call: the data
 * arrives in its host's read model (AI Cost Controls for PLATFORM_OPS READ; the
 * SYSTEM_ADMIN caps page). Never another person's identity.
 */

import { TONE_COLOR, ToneBadge } from "../platform-surface";
import type { PlatformAiFleetUsageToday, PlatformAiUsageSlice } from "@/lib/platform/ai/cost-controls.types";
import {
  ESTIMATED_BADGE, USAGE_TODAY_TITLE, USAGE_UNAVAILABLE, estUsd, operatorCountsLine, operatorTodayLine, remainingLine,
  spentLine, stateBadge, usedShare,
} from "./platform-ai-usage-view";

type Usage = Omit<PlatformAiFleetUsageToday, "self"> & { self?: PlatformAiFleetUsageToday["self"] };

function Slices({ title, slices }: { title: string; slices: PlatformAiUsageSlice[] }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <h4 className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{title}</h4>
      {slices.length === 0 ? (
        <p className="text-xs text-[var(--text-secondary)]">No Platform AI calls today.</p>
      ) : (
        <dl className="flex flex-col gap-1">
          {slices.map((s) => (
            <div key={s.key} className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 text-xs">
              <dt className="min-w-0 break-words text-[var(--text-primary)]">{s.label}</dt>
              <dd className="tabular-nums text-[var(--text-secondary)]">
                {estUsd(s.estimatedUsd)} · {s.calls} call{s.calls === 1 ? "" : "s"}{s.failedCalls > 0 ? ` · ${s.failedCalls} failed` : ""}{s.unpricedCalls > 0 ? ` · ${s.unpricedCalls} unpriced` : ""}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

export function PlatformAiUsageTodayCard({ usage }: { usage: Usage | null | undefined }) {
  if (!usage) {
    return (
      <section className="flex min-w-0 flex-col gap-2 rounded-2xl border border-[var(--border-hairline-strong)] bg-[var(--surface-muted)] p-5 sm:p-6" aria-label={USAGE_TODAY_TITLE}>
        <h3 className="text-sm font-semibold leading-6 text-[var(--text-primary)]">{USAGE_TODAY_TITLE}</h3>
        <p className="text-xs text-[var(--text-secondary)]">{USAGE_UNAVAILABLE}</p>
      </section>
    );
  }
  const { budget, usage: figure } = usage.platform;
  const badge = stateBadge(budget.state);
  const share = usedShare(budget);
  return (
    <section className="flex min-w-0 flex-col gap-4 rounded-2xl border border-[var(--border-hairline-strong)] bg-[var(--surface-muted)] p-5 sm:p-6" aria-label={USAGE_TODAY_TITLE}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold leading-6 text-[var(--text-primary)]">{USAGE_TODAY_TITLE}</h3>
          <p className="text-[11px] text-[var(--text-muted)]">UTC day {usage.day} · all operators</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <ToneBadge word={badge.word} tone={badge.tone} />
          <ToneBadge word={ESTIMATED_BADGE} tone="muted" />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-3xl font-semibold tabular-nums text-[var(--text-primary)]">
          {estUsd(figure.estimatedUsd)}
          <span className="ml-2 text-sm font-normal text-[var(--text-secondary)]">{budget.capUsd === null ? "spent today (estimated)" : `of $${budget.capUsd} platform cap (estimated)`}</span>
        </p>
        {share !== null && (
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--border-hairline)]" role="meter" aria-label="Share of the platform cap used (estimated)"
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}>
            <div className="h-full rounded-full" style={{ width: `${Math.round(share * 100)}%`, background: TONE_COLOR[badge.tone] }} />
          </div>
        )}
        <p className="text-xs" style={{ color: budget.state === "OK" ? "var(--text-secondary)" : TONE_COLOR[badge.tone] }} role={budget.state === "OK" ? undefined : "status"}>{remainingLine(budget)}</p>
        <p className="text-xs text-[var(--text-secondary)]">{spentLine(figure)}</p>
        <p className="text-xs text-[var(--text-secondary)]">{operatorCountsLine(usage.operatorCounts)}</p>
        {usage.self && (
          <p className="text-xs text-[var(--text-primary)]"><span className="text-[var(--text-muted)]">You: </span>{operatorTodayLine(usage.self)}</p>
        )}
      </div>

      <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 14rem), 1fr))" }}>
        <Slices title="By model" slices={usage.byModel} />
        <Slices title="By feature" slices={usage.byFeature} />
      </div>

      <p className="text-xs leading-5 text-[var(--text-muted)]">{usage.estimateNote}</p>
    </section>
  );
}
