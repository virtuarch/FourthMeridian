"use client";

/**
 * components/platform/widgets/SecAnomaliesWidget.tsx  (Wave 3 ⑧ · sec_anomalies → BETA V2 group)
 *
 * The Anomaly trips GROUP of the one Security posture surface
 * (SecurityPostureWidget.tsx), over GET /api/platform/security-ops/anomalies.
 * A trip row is Type | Key | Magnitude | When — the key rendered as its kind in
 * words plus the route's opaque digest (the V2 honesty fix: two trips on two
 * accounts are now distinguishable, and no raw identifier or IP is shown), the
 * magnitude as count against the threshold that tripped.
 *
 * `SecAnomaliesWidget` (the registry export for `sec_anomalies`) renders nothing:
 * the section is absorbed by the surface `sec_auth_posture` hosts.
 */

import type { ReactNode } from "react";
import type { PlatformSection } from "../widget-kit";
import { TwoLine } from "../platform-surface";
import type { AnomaliesResponse } from "@/app/api/platform/security-ops/anomalies/route";
import { TRIP_HEADINGS, feedDepthText, tripRows, tripsEmptyText, type Fetched } from "./security-posture-view";
import { SourceGate } from "./SecurityPostureParts";

/** ONE grid for the trip rows: Type | Key | Magnitude | When. */
const TRIP_COLS = "minmax(0,1.4fr) minmax(0,1.2fr) minmax(0,1.2fr) 7rem";
const HEADING_CLASS = "text-[10px] font-medium uppercase tracking-wide text-[var(--text-faint)]";

/** A table cell that carries its column word below `md`, where the header row is hidden. */
function Cell({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-col text-xs text-[var(--text-primary)]">
      <span className={`${HEADING_CLASS} md:hidden`}>{heading}</span>
      {children}
    </span>
  );
}

export function AnomalyTripsGroup({ anomalies, nowMs }: { anomalies: Fetched<AnomaliesResponse>; nowMs: number }) {
  return (
    <SourceGate source="Anomalies" fetched={anomalies}>
      {(a) => {
        const rows = tripRows(a.trips, nowMs);
        if (rows.length === 0) return <p role="status" className="text-xs text-[var(--text-secondary)]">{tripsEmptyText()}</p>;
        return (
          <div className="overflow-x-auto">
            <div className="mb-1 hidden items-center gap-3 border-b px-1 pb-2 md:grid" style={{ gridTemplateColumns: TRIP_COLS, borderColor: "var(--border-hairline)" }}>
              {TRIP_HEADINGS.map((h) => <span key={h} className={HEADING_CLASS}>{h}</span>)}
            </div>
            <ul className="flex flex-col">
              {rows.map((r) => (
                <li key={r.id} className="flex flex-wrap gap-x-3 gap-y-2 border-b px-1 py-2.5 last:border-b-0 md:grid md:items-start" style={{ gridTemplateColumns: TRIP_COLS, borderColor: "var(--border-hairline)" }}>
                  <Cell heading="Type"><span className="font-medium">{r.typeWord}</span></Cell>
                  <Cell heading="Key"><span className="tabular-nums">{r.keyLabel}</span></Cell>
                  <Cell heading="Magnitude"><span className="tabular-nums">{r.magnitude}</span></Cell>
                  <Cell heading="When"><TwoLine value={r.when} qualifier={r.stamp} /></Cell>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[10px] leading-relaxed text-[var(--text-faint)]">{feedDepthText(rows.length, "trips")}</p>
          </div>
        );
      }}
    </SourceGate>
  );
}

/** Registry export for `sec_anomalies` — absorbed into the Security posture surface; renders nothing. */
export function SecAnomaliesWidget(_props: { section: PlatformSection }) {
  return null;
}
