/**
 * lib/platform/incidents/preview.ts  (OPS-2D-5D-1)
 *
 * The Preview's one server-side read path: canonical incidents in, a
 * presentation-ready and privacy-safe DTO out.
 *
 * It does exactly two things the pure core cannot:
 *   1. asks `getActiveIncidents()` — the canonical read authority — for the set;
 *   2. resolves each shown incident's SUBJECT to human names.
 *
 * It classifies nothing. Severity, domain, nature, state, label, description and
 * recovery all arrive already decided (projections.ts → sync-issue-semantics.ts),
 * and the ordering is the core's. This module is deliberately thin, because the
 * temptation on a preview surface is to "just tweak" a severity or a count here,
 * and that is how a second authority is born.
 *
 * SUBJECT RESOLUTION, AND WHY IT IS NOT IN projections.ts
 * ------------------------------------------------------
 * "Chase · Checking" is a LABEL. `projections.ts` is the incident read authority
 * and stays free of display concerns — enriching it would put wording on the
 * critical path of the lifecycle's own consumers. An unresolvable subject is
 * returned as null and rendered as unavailable; it is never filled with an id
 * and never with a plausible guess.
 */

import "server-only";
import { db } from "@/lib/db";
import { getActiveIncidentPage } from "./projections";
import {
  countBySeverity,
  sortIncidentsForOperator,
  toPreviewItem,
  type IncidentPreview,
  type IncidentSubject,
} from "./preview-core";
import type { IncidentView } from "./projections";

/**
 * How many active incidents the canonical projection is asked for. The preview
 * shows a handful; the rest exist only to make `moreCount` honest. Matches the
 * projection's own default so `truncated` means what it says.
 */
const ACTIVE_SCAN_LIMIT = 200;

/** Incidents rendered. Preview doctrine: a handful, not a browser. */
export const PREVIEW_LIMIT = 6;

/**
 * Names for the subjects of the incidents actually being shown. Batched, and
 * scoped to the visible slice — there is no reason to name 200 institutions to
 * render six rows.
 */
async function resolveSubjects(views: IncidentView[]): Promise<Map<string, IncidentSubject>> {
  const itemIds = [...new Set(views.map((v) => v.plaidItemId).filter((x): x is string => !!x))];
  const acctIds = [...new Set(views.map((v) => v.financialAccountId).filter((x): x is string => !!x))];

  const [items, accounts] = await Promise.all([
    itemIds.length
      ? db.plaidItem.findMany({ where: { id: { in: itemIds } }, select: { id: true, institutionName: true } })
      : Promise.resolve([]),
    acctIds.length
      ? db.financialAccount.findMany({
          where: { id: { in: acctIds } },
          select: { id: true, name: true, institution: true },
        })
      : Promise.resolve([]),
  ]);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const acctById = new Map(accounts.map((a) => [a.id, a]));

  const out = new Map<string, IncidentSubject>();
  for (const v of views) {
    // An account names both halves; an item names only the institution. A row
    // with neither — or one whose referent has been deleted — stays null on
    // both, which the surface renders as "affected account unavailable".
    const acct = v.financialAccountId ? acctById.get(v.financialAccountId) : undefined;
    if (acct) {
      out.set(v.id, { primary: acct.institution || null, secondary: acct.name || null });
      continue;
    }
    const item = v.plaidItemId ? itemById.get(v.plaidItemId) : undefined;
    out.set(v.id, { primary: item?.institutionName ?? null, secondary: null });
  }
  return out;
}

/**
 * The operator Preview.
 *
 * `activeTotal` counts every active incident the projection saw, not the six
 * rendered — an operator reading "2 shown" must still learn that eleven exist.
 */
export async function getIncidentPreview(limit: number = PREVIEW_LIMIT): Promise<IncidentPreview> {
  const { incidents, scanTruncated } = await getActiveIncidentPage(ACTIVE_SCAN_LIMIT);
  const ordered = sortIncidentsForOperator(incidents);
  const shown = ordered.slice(0, limit);
  const subjects = await resolveSubjects(shown);

  return {
    items: shown.map((v) => toPreviewItem(v, subjects.get(v.id) ?? { primary: null, secondary: null })),
    activeTotal: incidents.length,
    moreCount: Math.max(0, incidents.length - shown.length),
    severityCounts: countBySeverity(incidents),
    // Reported by the projection, which is the only layer that can tell a full
    // page from a complete one. Disclosed so a floor is never read as a total.
    truncated: scanTruncated,
  };
}
