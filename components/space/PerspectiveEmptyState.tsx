"use client";

/**
 * components/space/PerspectiveEmptyState.tsx  (Connections pass PR 4)
 *
 * The ONE empty state for Personal perspectives. A view passes its key and
 * whether it has content (rows or a computed figure — an observed zero counts);
 * this reads the Space's per-source health (GET /api/spaces/[id]/data-health,
 * the Daily Brief's own read) and renders:
 *
 *   - a body empty state, only when the view has NO content and there is a
 *     reason other than a genuine zero (classifyPerspectiveEmpty);
 *   - otherwise `fallback` (the view's own empty copy, e.g. "No debt") when it
 *     has no content, or nothing at all when it does;
 *   - optionally (`showNote`) a one-line note beside real content when a source
 *     that feeds the view is stale, failing or still importing.
 *
 * The host supplies the frame and padding (its existing Surface), so adopting
 * this changes no layout. While health is loading, or if it cannot be read, it
 * renders `fallback` —
 * the view's existing behaviour — so a failed read never changes a page.
 */

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, Clock, Loader2, Link2 } from "lucide-react";
import { classifyPerspectiveEmpty, EMPTY_COPY, type PerspectiveKey } from "@/lib/space/perspective-empty-state.core";
import type { DataSourceView } from "@/lib/connections/space-data-health.core";
import { useSpaceIdContext } from "@/components/space/space-id-context";
import type { ValuationCoverage } from "@/lib/connections/valuation-coverage.core";
import {
  BALANCE_COVERAGE_LOADING, BALANCE_COVERAGE_UNAVAILABLE, balanceCoverageLoadFailureLine, isBalanceCoverageUnavailable,
  type BalanceCoverage, type BalanceCoverageRead, type ClientBalanceCoverage,
} from "@/lib/connections/balance-coverage.core";

type DataHealthPayload = { sources: DataSourceView[] | null; valuationCoverage: ValuationCoverage | null; balanceCoverage: BalanceCoverageRead };

/**
 * S2 sweep — what a FAILED data-health read means for each part: the sources and
 * valuation note are simply unknown (the page keeps its own behaviour), but the
 * balance coverage is UNAVAILABLE, so the heroes WITHHOLD the changes it governs
 * instead of falling open to comparable.
 */
export const FAILED_DATA_HEALTH: DataHealthPayload = Object.freeze({ sources: null, valuationCoverage: null, balanceCoverage: BALANCE_COVERAGE_UNAVAILABLE });

/**
 * The wire value → BalanceCoverageRead. `{ unavailable: true }` is the route's failed read; anything malformed is unavailable too.
 *
 * S2 2026-11-03 — a MISSING key (`undefined`) is UNAVAILABLE, not null. Every OK
 * answer of the data-health route carries `balanceCoverage` (null included), so an
 * absent key means a payload from a different build (version skew mid-deploy) —
 * mapping it to null ("nothing to cover") would fall open. Only an explicit null
 * means nothing to cover.
 */
export function parseBalanceCoverage(v: unknown): BalanceCoverageRead {
  if (v === null) return null;
  if (v === undefined) return BALANCE_COVERAGE_UNAVAILABLE;
  if (isBalanceCoverageUnavailable(v as BalanceCoverageRead)) return BALANCE_COVERAGE_UNAVAILABLE;
  const c = v as Partial<BalanceCoverage>;
  const strings = (a: unknown) => Array.isArray(a) && a.every((x) => typeof x === "string");
  return strings(c.liabilityFloors) && strings(c.assetFloors) && strings(c.estimatedLiabilityFloors) ? (v as BalanceCoverage) : BALANCE_COVERAGE_UNAVAILABLE;
}
const cache = new Map<string, Promise<DataHealthPayload | null>>();

/**
 * PB-8c — the balance coverage rides this read; when it fails, the change gates
 * now FAIL CLOSED (S2 sweep: FAILED_DATA_HEALTH). One counts-only line (no ids,
 * no amounts) so frequent failures are noticed.
 */
function coverageReadFailed(): void {
  console.warn(balanceCoverageLoadFailureLine("client-data-health", 1, 1));
}

/**
 * B13 — the client timeout on the data-health read. The Net Worth / Debt charts
 * HOLD (balanceChartPending) until this read settles, so a stalled request held
 * them indefinitely. On timeout the fetch (or its body) rejects with a
 * TimeoutError and falls to the existing FAILED path below (FAILED_DATA_HEALTH ⇒
 * coverage UNAVAILABLE): the hold ends, the chart renders unclipped and the
 * governed changes are withheld, exactly as for any failed read. 15 s matches the
 * repo's other per-request read timeouts (DEFAULT_REQUEST_TIMEOUT_MS = 15_000 in
 * lib/crypto/sol-history-backfill.ts; provider/RPC reads use 10 s) — well above a
 * healthy read, short enough that a stuck one is not a permanent placeholder.
 */
export const DATA_HEALTH_FETCH_TIMEOUT_MS = 15_000;

/** Exported for tests only (`timeoutMs` too); components use the hooks below. */
export function loadPayload(spaceId: string, timeoutMs: number = DATA_HEALTH_FETCH_TIMEOUT_MS): Promise<DataHealthPayload | null> {
  let p = cache.get(spaceId);
  if (!p) {
    p = fetch(`/api/spaces/${encodeURIComponent(spaceId)}/data-health`, { cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(timeoutMs) })
      .then(async (r) => {
        if (!r.ok) { coverageReadFailed(); return FAILED_DATA_HEALTH; }
        const j = (await r.json()) as { sources?: DataSourceView[]; valuationCoverage?: ValuationCoverage | null; balanceCoverage?: unknown };
        const balanceCoverage = parseBalanceCoverage(j.balanceCoverage);
        if (isBalanceCoverageUnavailable(balanceCoverage)) coverageReadFailed();
        return { sources: j.sources ?? null, valuationCoverage: j.valuationCoverage ?? null, balanceCoverage };
      })
      .catch(() => { coverageReadFailed(); return FAILED_DATA_HEALTH; });
    cache.set(spaceId, p);
    // A short-lived memo: perspectives mounting together share one read.
    setTimeout(() => cache.delete(spaceId), 30_000);
  }
  return p;
}

function useDataHealth(spaceId: string | null | undefined): DataHealthPayload | null {
  const [payload, setPayload] = useState<DataHealthPayload | null>(null);
  useEffect(() => {
    if (!spaceId) return;
    let live = true;
    void loadPayload(spaceId).then((s) => { if (live) setPayload(s); });
    return () => { live = false; };
  }, [spaceId]);
  return payload;
}

export function useSpaceSources(spaceId: string | null | undefined): DataSourceView[] | null {
  return useDataHealth(spaceId)?.sources ?? null;
}

/** Why the Net Worth history starts where it does when prices bound it — the same one read. */
export function useSpaceValuationCoverage(spaceId: string | null | undefined): ValuationCoverage | null {
  return useDataHealth(spaceId)?.valuationCoverage ?? null;
}

/**
 * PB-8 — before which date debt / cash history is partial (balance floors) — the same one read.
 * The client tri-state (S2 2026-11-03), via `balanceCoverageState`:
 *   BALANCE_COVERAGE_LOADING      the read is in flight — governed changes render PENDING;
 *   BalanceCoverage | null        read (null = nothing to cover);
 *   BALANCE_COVERAGE_UNAVAILABLE  the read FAILED — governed changes are withheld (S2 sweep).
 */
export function useSpaceBalanceCoverage(spaceId: string | null | undefined): ClientBalanceCoverage {
  return balanceCoverageState(spaceId, useDataHealth(spaceId));
}

/**
 * The tri-state from the hook's inputs. No Space ⇒ no read will ever run, so there is
 * nothing to cover (null). A Space whose payload has not arrived ⇒ LOADING — never null,
 * which would let a governed change render and then be retracted.
 */
export function balanceCoverageState(spaceId: string | null | undefined, payload: DataHealthPayload | null): ClientBalanceCoverage {
  if (!spaceId) return null;
  if (payload === null) return BALANCE_COVERAGE_LOADING;
  return payload.balanceCoverage;
}

const NOTE_COPY = {
  STALE:      { icon: Clock,         text: "Some accounts behind this view haven’t updated recently." },
  FAILED:     { icon: AlertTriangle, text: "An account behind this view stopped updating." },
  PROCESSING: { icon: Loader2,       text: "Some accounts behind this view are still importing." },
} as const;

export function PerspectiveEmptyState({ spaceId: spaceIdProp, perspective, hasContent, fallback = null, showNote = false }: {
  /** Defaults to the SpaceIdProvider's value (SpaceDashboard). */
  spaceId?: string | null;
  perspective: PerspectiveKey;
  hasContent: boolean;
  fallback?: ReactNode;
  showNote?: boolean;
}) {
  const contextSpaceId = useSpaceIdContext();
  const sources = useSpaceSources(spaceIdProp ?? contextSpaceId);
  if (sources === null) return hasContent ? null : <>{fallback}</>;

  const s = classifyPerspectiveEmpty(perspective, sources, hasContent);

  if (hasContent) {
    if (!showNote || !s.note) return null;
    const n = NOTE_COPY[s.note];
    const Icon = n.icon;
    return (
      <p data-perspective-note={s.note} className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
        <Icon aria-hidden size={12} className={`shrink-0 ${s.note === "PROCESSING" ? "animate-spin motion-reduce:animate-none" : ""}`} />
        {n.text}
        <Link href="/dashboard/connections" className="font-medium text-[var(--text-secondary)] hover:underline">Connections</Link>
      </p>
    );
  }

  // NOT_FED: the view's own copy already says it best ("No liability accounts
  // in this Space.") — only the other reasons replace it.
  if (!s.reason || s.reason === "NOT_FED") return <>{fallback}</>;
  const copy = EMPTY_COPY[s.reason];
  return (
    <div data-perspective-empty={s.reason} className="flex flex-col items-center text-center">
      <span aria-hidden className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-[rgba(125,168,255,.10)] text-[var(--meridian-400)]">
        {s.reason === "PROCESSING" ? <Loader2 size={18} className="animate-spin motion-reduce:animate-none" />
          : s.reason === "FAILED" ? <AlertTriangle size={18} /> : <Link2 size={18} />}
      </span>
      <p className="text-sm font-semibold text-[var(--text-primary)]">{copy.title}</p>
      <p className="mt-1 max-w-sm text-xs leading-relaxed text-[var(--text-secondary)]">{copy.body}</p>
      {s.reason === "FAILED" && s.sources.length > 0 && (
        <p className="mt-1 text-xs text-[var(--text-muted)]">{s.sources.map((x) => x.label).join(", ")}</p>
      )}
      {copy.cta && (
        <Link href={copy.cta.href} className="mt-3 rounded-[var(--radius-sm)] px-3 py-1.5 text-sm font-medium text-[var(--meridian-400)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]">
          {copy.cta.label}
        </Link>
      )}
    </div>
  );
}
