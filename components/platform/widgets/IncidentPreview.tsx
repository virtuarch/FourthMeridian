"use client";

/**
 * components/platform/widgets/IncidentPreview.tsx  (OPS-2D-5D-1)
 *
 * The rendered operator surface for active sync incidents — the FIRST consumer
 * of the incident architecture built across OPS-2D-5A/5B.
 *
 * PRESENTATIONAL AND PROP-DRIVEN. It takes `{data, loading, error}` and renders;
 * the fetch lives in CsSyncIssuesWidget. That split is what makes the loading,
 * error, empty and populated states provable by rendering the real component
 * rather than asserted about a mock.
 *
 * It computes nothing. No severity map that reads `kind`, no counting, no
 * sorting, no filtering — order and totals arrive from
 * lib/platform/incidents/preview-core.ts, wording from incident-preview-view.ts,
 * and meaning from lib/platform/sync-issue-semantics.ts.
 *
 * ── THE STATES IT MUST KEEP APART ────────────────────────────────────────────
 * Loading, failure, "no active incidents" and "unknown subject" are four
 * different things and each has its own line. Collapsing any of them toward the
 * reassuring reading — a spinner that shows the empty state, a failed query that
 * shows "no incidents", a missing institution that shows a plausible bank — is
 * the specific dishonesty an operational preview cannot afford.
 */

import { Activity } from "lucide-react";
import { AlertTriangle, Loader2 } from "lucide-react";
import type { IncidentPreview as IncidentPreviewData } from "@/lib/platform/incidents/preview-core";
import { PlatformWidgetCard, timeAgo, type PlatformSection } from "../widget-kit";
import {
  RECOVERY_TEXT,
  SEVERITY_TOKEN,
  SUBJECT_UNAVAILABLE,
  occurrenceText,
  subjectText,
  summaryText,
} from "./incident-preview-view";

export function IncidentPreview({
  section,
  data,
  loading,
  error,
}: {
  section: PlatformSection;
  data:    IncidentPreviewData | null;
  loading: boolean;
  error:   string | null;
}) {
  return (
    <PlatformWidgetCard label={section.label} icon={Activity}>
      {loading ? (
        // The shared single-line loading state. Deliberately NOT the empty
        // state: "No active sync incidents" while a query is still in flight is
        // a claim we cannot support yet.
        <p className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]" role="status">
          <Loader2 size={12} className="animate-spin" aria-hidden /> Loading sync incidents…
        </p>
      ) : error || !data ? (
        // UNKNOWN STAYS UNKNOWN. A failed query says so; it never degrades into
        // "no incidents", which would read as a clean bill of health produced by
        // an outage.
        <p className="flex items-start gap-1.5 text-xs" style={{ color: "var(--coral-400)" }} role="alert">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            Sync incident status unavailable.
            <span className="text-[var(--text-muted)]"> The platform could not be asked — this is not a report of zero incidents.</span>
          </span>
        </p>
      ) : data.items.length === 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-sm text-[var(--text-primary)]">No active sync incidents</p>
          {/* Absence of incidents is not proof of health — this surface only
              sees what the incident model records. */}
          <p className="text-xs text-[var(--text-secondary)]">
            Nothing is currently open in the incident model. This does not describe overall platform health.
          </p>
        </div>
      ) : (
        <>
          <p className="text-xs text-[var(--text-secondary)]">
            {summaryText(data.activeTotal, data.severityCounts)}
            {data.truncated && (
              <span className="text-[var(--text-faint)]"> · count is a floor (scan limit reached)</span>
            )}
          </p>

          <ul className="flex flex-col gap-3">
            {data.items.map((item) => {
              const subject = subjectText(item.subject);
              return (
                <li
                  key={item.id}
                  className="flex flex-col gap-1 border-l-2 pl-3"
                  style={{ borderColor: SEVERITY_TOKEN[item.severity] }}
                >
                  {/* Severity is a WORD first and a colour second, so it survives
                      greyscale, a screen reader, and a colour-blind operator. */}
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span
                      className="text-[10px] font-medium uppercase tracking-wide"
                      style={{ color: SEVERITY_TOKEN[item.severity] }}
                    >
                      {item.severity}
                    </span>
                    <span className="min-w-0 text-sm text-[var(--text-primary)]">{item.title}</span>
                    {/* WHICH OPERATION FAILED. Two wallet episodes — one from
                        the balance operation, one from the price operation —
                        are two correct rows that used to read identically; this
                        is what tells them apart, on the line an operator scans
                        first. The words are the semantic authority's, never
                        this component's, and when the platform cannot prove the
                        operation the element is absent rather than guessed. */}
                    {item.operationLabel && (
                      <span className="min-w-0 text-xs text-[var(--text-secondary)]">
                        · {item.operationLabel}
                      </span>
                    )}
                  </div>

                  {/* An unavailable subject is rendered at the SAME weight as a
                      known one. Dimming it would say "less important" when what
                      it actually says is "we do not know" — and not knowing
                      which account is affected is not a lesser fact. */}
                  <p className="text-xs text-[var(--text-secondary)]">
                    {subject ?? SUBJECT_UNAVAILABLE}
                  </p>

                  <p className="text-[11px] text-[var(--text-muted)]">
                    {occurrenceText(item)}
                    {" · "}
                    <span title={new Date(item.lastOccurredAt).toLocaleString()}>
                      Last seen {timeAgo(item.lastOccurredAt)} ago
                    </span>
                  </p>

                  <p className="text-[11px] text-[var(--text-muted)]">
                    {RECOVERY_TEXT[item.recovery]}
                    {/* A restrained correlation signal. Its ABSENCE is not shown
                        as an error: most producers still have no execution
                        envelope, and "not linked" is not "nothing ran". */}
                    {item.executionCorrelated && (
                      <span className="text-[var(--text-faint)]"> · Linked to sync execution</span>
                    )}
                  </p>
                </li>
              );
            })}
          </ul>

          {/* No canonical incident browser route exists yet (OPS-2D-5D-2), so
              this states the remainder instead of offering a dead link. */}
          {data.moreCount > 0 && (
            <p className="text-[11px] text-[var(--text-faint)]">
              {data.moreCount} more active incident{data.moreCount === 1 ? "" : "s"}
            </p>
          )}
        </>
      )}
    </PlatformWidgetCard>
  );
}
