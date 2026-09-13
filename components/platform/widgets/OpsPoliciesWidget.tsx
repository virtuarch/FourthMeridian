"use client";

/**
 * components/platform/widgets/OpsPoliciesWidget.tsx  (PLATFORM OPS POLICIES — Slice 1)
 *
 * FINANCIAL REFRESH POLICY, READ-ONLY — over GET /api/platform/platform-ops/policies
 * (requirePlatformAccess PLATFORM_OPS READ).
 *
 * One `SectionSurface`, two columns (Bank refresh | Wallet refresh), each led by
 * the EFFECTIVE cadence as a `BigStat` and followed by the consequences an
 * operator needs before this policy ever becomes editable:
 *
 *     Source                 Platform default / Override / Default in force — override invalid
 *     Considered overdue     cadence + grace, as hours
 *     Scheduler              Supported / Not supported — and why
 *     Available today        the cadences the deployed scheduler can honour
 *     Latest sweep           Current / Pending / Unknown — from the job ledger
 *     Last changed           when and by whom the override was written
 *
 * ── READ-ONLY MEANS READ-ONLY ────────────────────────────────────────────────
 * No select, no input, no button, no disabled save. This is the future editor's
 * read model rendered as prose. Editing declared operational policy is a
 * capability that is not issuable yet; the editor arrives with it and consumes
 * the SAME read model.
 *
 * ── WHAT THIS WIDGET REFUSES TO RENDER ───────────────────────────────────────
 *   • An invalid override as if it were the configured value. The headline says
 *     the DEFAULT is in force and the qualifier says the override is invalid.
 *   • A cadence the scheduler cannot deliver as "Supported".
 *   • An execution verdict from configuration alone: the actual state is read
 *     from the ledger or is "Unknown", with its reason.
 *
 * `OpsPoliciesWidget` fetches; `PoliciesSurface` renders — the Scheduler
 * precedent, so every state is provable by handing the surface props.
 */

import { AlertTriangle, Loader2, SlidersHorizontal } from "lucide-react";
import type { PlatformSection } from "../widget-kit";
import { useSharedWidgetFetch, type SharedFetchState } from "../workspace-session";
import { BigStat, GroupLabel, KeyRow, SectionSurface, StatusWord, TONE_COLOR, VRule } from "../platform-surface";
import { LOADING_TEXT, unavailableText } from "./platform-health-view";
import type { PlatformPoliciesResponse } from "@/app/api/platform/platform-ops/policies/route";
import type { RefreshPolicyView } from "@/lib/platform/policies/refresh-policies.core";
import {
  POLICIES_FOOTNOTE, POLICIES_SUBJECT,
  actualText, attemptScheduleText, availableCadencesText, effectiveHeadline, hoursText,
  lastChangedText, schedulerSupportText, unsupportedOptions,
} from "./policies-view";

/** "13 Sep 2026, 18:32 UTC" — one date wording for the whole surface. */
function formatUtc(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const d = new Date(t);
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${day}, ${hh}:${mm} UTC`;
}

function ActualWord({ view }: { view: RefreshPolicyView }) {
  const { word } = actualText(view);
  const token =
    view.actual.state === "CURRENT" ? TONE_COLOR.ok
    : view.actual.state === "PENDING" ? TONE_COLOR.warn
    : TONE_COLOR.muted;
  return <StatusWord word={word} token={token} />;
}

/** One source kind's column. Prose only — no control of any kind. */
function PolicyColumn({ view }: { view: RefreshPolicyView }) {
  const headline = effectiveHeadline(view);
  const support = schedulerSupportText(view);
  const unsupported = unsupportedOptions(view);
  const actual = actualText(view);
  const invalid = view.mismatch?.kind === "INVALID_OVERRIDE";

  return (
    <div className="min-w-0 flex-1">
      <GroupLabel hint={view.description}>{view.label}</GroupLabel>
      <div className="mt-4 flex flex-col gap-5">
        <BigStat
          label="Effective cadence"
          value={headline.value}
          qualifier={headline.qualifier}
          derivation={
            invalid && view.mismatch ? (
              <span className="text-[11px]" style={{ color: TONE_COLOR.warn }} role="alert">
                {view.mismatch.message}
              </span>
            ) : undefined
          }
        />
        <div className="flex flex-col gap-2">
          <KeyRow label="Considered overdue after" value={hoursText(view.effective.overdueAfterHours)} />
          <KeyRow
            label="Scheduler"
            value={<StatusWord word={support.word} token={support.reason ? TONE_COLOR.warn : TONE_COLOR.ok} />}
          />
          {support.reason && (
            <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]" role="note">{support.reason}</p>
          )}
          <KeyRow label="Available with current scheduler" value={availableCadencesText(view)} />
          <KeyRow label="Attempt schedule" value={attemptScheduleText(view)} />
          <KeyRow label="Latest sweep" value={<ActualWord view={view} />} />
          <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">{actual.note}</p>
          <KeyRow label="Last changed" value={lastChangedText(view, formatUtc)} />
        </div>
        {unsupported.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
              Not available today
            </span>
            {unsupported.map((o) => (
              <p key={o.cadence} className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
                <span className="font-mono text-[10px] text-[var(--text-primary)]">{o.cadence}</span> — {o.reason}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** The presentational surface. Prop-driven and fetch-free. */
export function PoliciesSurface({
  section,
  state,
}: {
  section: PlatformSection;
  state: SharedFetchState<PlatformPoliciesResponse>;
}) {
  const data = state.error ? null : state.data;
  const actions = data ? (
    <span className="text-[11px] text-[var(--text-muted)]">
      Grace is code-owned: the larger of {data.grace.floorHours} hours and {Math.round(data.grace.share * 100)}% of the cadence.
    </span>
  ) : undefined;

  return (
    <SectionSurface icon={SlidersHorizontal} title={section.label} actions={actions} footnote={POLICIES_FOOTNOTE}>
      {state.loading ? (
        <p className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]" role="status">
          <Loader2 size={12} className="animate-spin" aria-hidden /> {LOADING_TEXT}
        </p>
      ) : !data ? (
        <p className="flex items-start gap-1.5 text-xs" style={{ color: "var(--coral-400)" }} role="alert">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden />
          <span>{unavailableText(POLICIES_SUBJECT)}</span>
        </p>
      ) : (
        <div className="flex flex-col gap-8 md:flex-row">
          {data.policies.map((view, i) => (
            <div key={view.sourceKind} className="contents">
              {i > 0 && <VRule />}
              <PolicyColumn view={view} />
            </div>
          ))}
        </div>
      )}
    </SectionSurface>
  );
}

export function OpsPoliciesWidget({ section }: { section: PlatformSection }) {
  // ONE literal url, one workspace-shared read (OPS-2C-6). The surface reads no
  // clock: every date it shows is an absolute UTC instant from the read model.
  const state = useSharedWidgetFetch<PlatformPoliciesResponse>("/api/platform/platform-ops/policies");
  return <PoliciesSurface section={section} state={state} />;
}
