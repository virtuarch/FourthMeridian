"use client";

/**
 * components/platform/widgets/CsSyncIssuesWidget.tsx  (PO1.4 · cs_sync_issues)
 *
 * OPS-2D-5D-1 — the fetch shell for the canonical incident Preview.
 *
 * WHAT THIS FILE USED TO BE: a triage widget that read a row-count summary,
 * humanised enum spelling into operator labels, kept a private severity→colour
 * map, and rendered a weight bar of "unresolved sync issues" per kind. All of it
 * rested on one row meaning one failed attempt — untrue since OPS-2D-5A-1, where
 * a row became an EPISODE and repeated failures converged onto it as
 * occurrences. A connection failing forty times rendered as "1".
 *
 * It is now a fetch and nothing else: the route returns a presentation-ready,
 * privacy-safe DTO and `IncidentPreview` renders it. There is no local
 * classification left to drift, because there is no local classification.
 */

import type { PlatformSyncIssuesResponse } from "@/app/api/platform/customer-success/sync-issues/route";
import { useWidgetFetch, type PlatformSection } from "../widget-kit";
import { IncidentPreview } from "./IncidentPreview";

export function CsSyncIssuesWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<PlatformSyncIssuesResponse>(
    "/api/platform/customer-success/sync-issues",
  );
  return <IncidentPreview section={section} data={data} loading={loading} error={error} />;
}
