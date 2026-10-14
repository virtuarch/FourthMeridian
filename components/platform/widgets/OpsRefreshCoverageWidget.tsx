"use client";

/**
 * components/platform/widgets/OpsRefreshCoverageWidget.tsx  (OPS-2C-2 · ops_refresh_coverage · UX-P1 page grain)
 *
 * Per-endpoint account coverage, over
 * GET /api/platform/platform-ops/refresh/coverage (requirePlatformAccess
 * PLATFORM_OPS READ).
 *
 * ── TWO HONESTY RULES, BOTH LOAD-BEARING ──────────────────────────────────────
 * 1. ABSENCE IS NOT 0% COVERAGE. When the projection observed no rows
 *    (`tier: "unknown"`) this renders "not observed" and shows NO percentage.
 *    A "0% covered" on an empty ledger would assert a measurement nobody made.
 *    Once rows exist, a genuine zero IS shown — `ratio()` returns null only when
 *    the denominator is zero, never for a real counted zero.
 * 2. THIS IS NOT A STALENESS VERDICT. DF-2E ships coverage facts and the reason
 *    vocabulary; deciding "stale now" needs a per-endpoint cadence authority
 *    that does not exist. The widget shows what was covered and when freshness
 *    last advanced, and stops there.
 *
 * UX-P1 — the same content on the page grain: one SectionSurface, the envelope
 * as its scope line, the per-endpoint facts as the house grid-row table, the
 * reason tallies beneath.
 */

import { Target } from "lucide-react";
import { WidgetMessage, useWidgetFetch, type PlatformSection } from "../widget-kit";
import { SectionSurface, TONE_COLOR } from "../platform-surface";
import type { CoverageEndpointRollup, CoverageSummary } from "@/lib/platform/refresh/types";
import { describeWindow, humanizeToken, isUnobserved, ratio, tallyEntries } from "./refresh-format";

const FOOTNOTE =
  "Coverage is per (account, endpoint) evidence from the refresh ledger: what was covered, skipped or failed, and how often freshness advanced. It is not a staleness verdict — no per-endpoint cadence authority exists to make one.";

const COLS = "minmax(0,1.6fr) 7rem 5rem 5rem 5rem";
const HEADINGS = ["Endpoint", "Covered", "Skipped", "Failed", "Fresh"] as const;

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="flex items-baseline gap-1.5 md:block">
      <span className="text-[10px] uppercase tracking-wide text-[var(--text-faint)] md:hidden">{label}</span>
      {children}
    </span>
  );
}

/** One endpoint row. The percentage is gated on a non-null ratio — never "0%" by division. */
function EndpointRow({ ep }: { ep: CoverageEndpointRollup }) {
  const total = ep.covered + ep.skipped + ep.failed;
  const pct = ratio(ep.covered, total);
  return (
    <li
      className="flex flex-col gap-1 border-b px-1 py-2 last:border-b-0 md:grid md:items-center md:gap-3"
      style={{ gridTemplateColumns: COLS, borderColor: "var(--border-hairline)" }}
    >
      <span className="text-xs font-medium text-[var(--text-primary)]">{ep.endpoint}</span>
      <div className="flex flex-wrap gap-x-5 gap-y-1 md:contents">
        <Labelled label="Covered">
          <span className="text-xs tabular-nums text-[var(--text-primary)]">
            {ep.covered}
            {pct != null && <span className="text-[var(--text-muted)]"> ({pct}%)</span>}
          </span>
        </Labelled>
        <Labelled label="Skipped">
          <span className="text-xs tabular-nums text-[var(--text-muted)]">{ep.skipped}</span>
        </Labelled>
        <Labelled label="Failed">
          <span className="text-xs tabular-nums" style={{ color: ep.failed > 0 ? TONE_COLOR.bad : "var(--text-muted)" }}>{ep.failed}</span>
        </Labelled>
        <Labelled label="Fresh">
          <span className="text-xs tabular-nums text-[var(--text-secondary)]">{ep.freshnessAdvanced}</span>
        </Labelled>
      </div>
    </li>
  );
}

/** The surface, given a fetch RESULT rather than performing one (renderable in every state). */
export function RefreshCoverageSurface({
  title,
  data,
  loading,
  error,
}: {
  title: string;
  data: CoverageSummary | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading || error || !data) {
    return (
      <SectionSurface icon={Target} title={title}>
        <WidgetMessage loading={loading} error={error} />
      </SectionSurface>
    );
  }

  const win = describeWindow(data);
  const unobserved = isUnobserved(data.tier);

  return (
    <SectionSurface
      icon={Target}
      title={title}
      count={unobserved ? undefined : data.distinctAccounts}
      actions={
        <p className="text-[11px] text-[var(--text-muted)]">
          {win.window} ·{" "}
          <span style={{ color: win.reproducible ? "var(--text-muted)" : "var(--brass-300)" }}>{win.detail}</span>
        </p>
      }
      footnote={FOOTNOTE}
    >
      {unobserved ? (
        <p className="text-xs text-[var(--text-muted)]">
          No per-account coverage recorded — <em>not observed</em>. No percentage is shown,
          because none was measured. Absence of a coverage row never means an account is
          fresh, and never means it is stale.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-xs tabular-nums text-[var(--text-secondary)]">
            {data.distinctAccounts} account{data.distinctAccounts === 1 ? "" : "s"} evaluated
            across {data.endpoints.length} endpoint{data.endpoints.length === 1 ? "" : "s"}
          </p>

          <div className="overflow-x-auto">
            <div
              className="mb-1 hidden items-center gap-3 border-b px-1 pb-2 md:grid"
              style={{ gridTemplateColumns: COLS, borderColor: "var(--border-hairline)" }}
            >
              {HEADINGS.map((h) => (
                <span key={h} className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-faint)]">{h}</span>
              ))}
            </div>
            <ul className="flex flex-col">
              {data.endpoints.map((ep) => (
                <EndpointRow key={ep.endpoint} ep={ep} />
              ))}
            </ul>
          </div>

          {data.endpoints.some((ep) => Object.keys(ep.reasons).length > 0) && (
            <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--text-muted)]">
              {data.endpoints.flatMap((ep) =>
                tallyEntries(ep.reasons).map((r) => (
                  <li key={`${ep.endpoint}:${r.key}`} className="tabular-nums">
                    {ep.endpoint} · {humanizeToken(r.key)} <span className="text-[var(--text-secondary)]">{r.count}</span>
                  </li>
                )),
              )}
            </ul>
          )}
        </div>
      )}
    </SectionSurface>
  );
}

export function OpsRefreshCoverageWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<CoverageSummary>(
    "/api/platform/platform-ops/refresh/coverage",
  );
  return <RefreshCoverageSurface title={section.label} data={data} loading={loading} error={error} />;
}
