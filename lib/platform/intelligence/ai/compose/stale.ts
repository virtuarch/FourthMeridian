/**
 * lib/platform/intelligence/ai/compose/stale.ts — STALE figures (owner rule: stale facts are never shown as current):
 * the figure class, the stale test and the server's stale wording.
 *
 * P1a (Platform AI modular architecture, 2026-11-09): MOVED VERBATIM from core.ts — a pure
 * move, no behaviour change. core.ts re-exports every exported symbol (the facade), so
 * importers and tests are unchanged. compose/* never imports ../core.
 */

import type { MetricEnvelope } from "@/lib/platform/intelligence/metrics/retrieve-core";
import { absoluteUtcStamp, lastEvaluatedStale } from "@/lib/platform/stale-wording";

// ── STALE figures (owner rule: stale facts are never shown as current) ──────
//
// A figure is STALE when its envelope carries a figure and the registry's per-metric
// limit (maxAgeMs) says its asOf is too old — stamped at retrieval with the server's
// clock (freshness.stale) — or when its asOf is missing or unreadable (checked here
// too: a missing timestamp is never assumed current). A stale figure keeps its value
// but is worded "last evaluated <time>, may be out of date" (the shared phrasebook,
// lib/platform/stale-wording.ts — the same words Platform Ops shows), its typed
// segment carries figureClass "STALE", and the model path adds a server note and the
// RESOLVED_WITH_STALE_NOTE verdict. A stale signal never triggers a derived section.

/** The figure class of a typed figure segment: absent = current; "STALE" = see above. */
export const FIGURE_CLASSES = ["STALE"] as const;
export type FigureClass = (typeof FIGURE_CLASSES)[number];

/** True when `e` carries a figure that must not be presented as current. */
export function isStaleEnvelope(e: Pick<MetricEnvelope, "status" | "value" | "freshness">): boolean {
  if (e.status === "UNAVAILABLE" || e.value === null) return false;
  if (e.freshness?.stale === true) return true;
  const asOf = e.freshness?.asOf ?? null;
  return asOf === null || asOf === "" || !Number.isFinite(Date.parse(asOf));
}

/** "last evaluated 2026-11-08 06:30 UTC, may be out of date" for this envelope (server text). */
export const staleQualifierOf = (e: Pick<MetricEnvelope, "freshness">): string => lastEvaluatedStale(absoluteUtcStamp(e.freshness?.asOf ?? null));

/** A registry label as the SUBJECT of a stale sentence: a trailing "now" (e.g. "Alert rules firing now") is never repeated for a stale figure. */
export const staleSubjectLabel = (label: string): string => label.replace(/\s+(?:right\s+)?now$/i, "").trim();

/** The model-path server note for stale placed metrics: "Note: Alert rules firing — last evaluated …, may be out of date." */
export function staleNoteText(stale: readonly MetricEnvelope[], labelOf: (metric: string) => string): string {
  return stale.map((e) => `Note: ${staleSubjectLabel(labelOf(e.metric))} — ${staleQualifierOf(e)}.`).join(" ");
}
