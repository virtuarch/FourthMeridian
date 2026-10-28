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

type DataHealthPayload = { sources: DataSourceView[] | null; valuationCoverage: ValuationCoverage | null };
const cache = new Map<string, Promise<DataHealthPayload | null>>();

function loadPayload(spaceId: string): Promise<DataHealthPayload | null> {
  let p = cache.get(spaceId);
  if (!p) {
    p = fetch(`/api/spaces/${encodeURIComponent(spaceId)}/data-health`, { cache: "no-store", credentials: "same-origin" })
      .then(async (r) => {
        if (!r.ok) return null;
        const j = (await r.json()) as { sources?: DataSourceView[]; valuationCoverage?: ValuationCoverage | null };
        return { sources: j.sources ?? null, valuationCoverage: j.valuationCoverage ?? null };
      })
      .catch(() => null);
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
