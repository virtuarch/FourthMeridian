"use client";

/**
 * components/platform/widgets/SecurityPostureWidget.tsx  (BETA V2 · Workstream W4)
 *
 * ONE SectionSurface "Security posture" for Security Operations, replacing the
 * five card-grain Sec* widgets with one composed presentation over the SAME five
 * shipped routes (each behind requirePlatformAccess SECURITY_OPS READ):
 *
 *   /security-ops/anomalies         Detections column + the Anomaly trips group
 *   /security-ops/auth-posture      Coverage column
 *   /security-ops/audit             End-user auth group
 *   /security-ops/operator-actions  Operator actions group
 *   /security-ops/sessions          Sessions group
 *
 * Form (Platform-Spaces-Visualization-Investigation §15.1 Brief 1, folded into one
 * frame per the W4 brief): a three-column posture row — Detections | Coverage |
 * Notes, Scheduler grammar with VRule separators, stacking Detections-first
 * below md — then four movements, each a group that states its depth. The Notes
 * column is the ABSENCE block: what this surface has no authority for, as
 * `Unavailable` + `Provenance "no authority"`, never a quiet zero.
 *
 * Each route is fetched once (five string-literal reads — the static-url
 * contract) and each group renders its own loading / error state, so one failing
 * route leaves its group absent-and-saying-so while the other four still answer.
 * `SecurityPostureSurface` is prop-driven so every state is renderable in a test;
 * the widget fetches. Presentation only: words and readings come from the pure
 * security-posture-view.ts, which authors no metric.
 *
 * HOSTING. The widget registry (the coordinator's PlatformSpaceDashboard) still
 * maps five section keys to five exports. The adapter in SecAuthPostureWidget.tsx
 * — the first key composed into the SECURITY_OPS Overview — renders this surface;
 * the other four adapters render nothing, and the coordinator declares them
 * absorbed (PLATFORM_SECTION_REPRESENTATION) and drops them from the composition.
 */

import { useState, type ReactNode } from "react";
import { ShieldCheck } from "lucide-react";
import { useWidgetFetch, type PlatformSection } from "../widget-kit";
import { GroupLabel, KeyRow, NO_AUTHORITY, Provenance, SectionSurface, Unavailable, VRule } from "../platform-surface";
import type { AnomaliesResponse, AnomalyTrip } from "@/app/api/platform/security-ops/anomalies/route";
import type { PlatformAuthPosture } from "@/app/api/platform/security-ops/auth-posture/route";
import type { PlatformSessionsResponse } from "@/app/api/platform/security-ops/sessions/route";
import {
  COLUMN,
  COLUMN_HINT,
  DETECTOR_COVERAGE,
  NOTES_ABSENT,
  NOTES_SOURCES,
  POSTURE_FOOTNOTE,
  POSTURE_TITLE,
  coverageReadings,
  pulseReading,
  tripsReading,
  type Fetched,
  type Reading,
} from "./security-posture-view";
import { ReadingStat, SourceGate } from "./SecurityPostureParts";
import { AnomalyTripsGroup } from "./SecAnomaliesWidget";
import { SessionsGroup } from "./SecSessionsWidget";

// ── OBS-009 · platform access refusals ───────────────────────────────────────
//
// `requirePlatformAccess` refusals are recorded as SECURITY_ANOMALY_DETECTED
// trips of type "platform_access_denied" (lib/platform/ops/access-denied.ts:
// one per user × area per hour). They ride the anomalies route the surface
// already reads, so the reading below is a COUNT OVER THE ROUTE'S NEWEST PAGE —
// a floor, labelled as one — never a new query and never a verdict.

export const ACCESS_DENIED_TRIP_TYPE = "platform_access_denied";

export function accessDenialsReading(trips: readonly AnomalyTrip[]): Reading {
  const denials = trips.filter((t) => t.type === ACCESS_DENIED_TRIP_TYPE);
  return {
    label: "Platform access refused · newest page",
    value: String(denials.length),
    qualifier: denials.length === 0 ? "no refusal in the route's newest trips" : "one trip per user × area per hour · a floor, not a total",
    derivation: "COUNT(trips of type platform_access_denied) in the anomalies route's newest page — a 403 from requirePlatformAccess, recorded rate-limited and off the request path",
  };
}

// ── Layout pieces ─────────────────────────────────────────────────────────────

function Column({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4">
      <GroupLabel hint={hint}>{label}</GroupLabel>
      {children}
    </div>
  );
}

/** A movement inside the surface: eyebrow, then content, separated by one hairline. */
function Movement({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="mt-8 border-t pt-6" style={{ borderColor: "var(--border-hairline)" }}>
      <GroupLabel hint={hint}>{label}</GroupLabel>
      <div className="mt-4">{children}</div>
    </div>
  );
}

// ── The surface (prop-driven; every state renderable in a test) ───────────────

export interface SecurityPostureSources {
  anomalies: Fetched<AnomaliesResponse>;
  posture: Fetched<PlatformAuthPosture>;
  sessions: Fetched<PlatformSessionsResponse>;
}

export function SecurityPostureSurface({ sources, nowMs }: { sources: SecurityPostureSources; nowMs: number }) {
  return (
    <SectionSurface icon={ShieldCheck} title={POSTURE_TITLE} footnote={POSTURE_FOOTNOTE}>
      {/* Posture row — Detections | Coverage | Notes; columns stack Detections-first below md. */}
      <div className="flex flex-col gap-8 md:flex-row">
        <Column label={COLUMN.detections} hint={COLUMN_HINT.detections}>
          <SourceGate source="Anomalies" fetched={sources.anomalies}>
            {(a) => (
              <>
                <ReadingStat r={pulseReading(a.summary)} />
                <ReadingStat r={tripsReading(a.summary)} />
                <ReadingStat r={accessDenialsReading(a.trips)} />
              </>
            )}
          </SourceGate>
        </Column>
        <VRule />
        <Column label={COLUMN.coverage} hint={COLUMN_HINT.coverage}>
          <SourceGate source="Authentication posture" fetched={sources.posture}>
            {(p) => <>{coverageReadings(p).map((r) => <ReadingStat key={r.label} r={r} />)}</>}
          </SourceGate>
        </Column>
        <VRule />
        <Column label={COLUMN.notes} hint={COLUMN_HINT.notes}>
          <div className="flex flex-col">
            {NOTES_ABSENT.map((n) => <KeyRow key={n.label} label={n.label} value={<Unavailable reason={n.reason} />} />)}
          </div>
          <div className="flex flex-wrap gap-2">
            <Provenance source={NO_AUTHORITY}>for the four above</Provenance>
            {NOTES_SOURCES.map((s) => <Provenance key={s.source} source={s.source}>{s.note}</Provenance>)}
          </div>
        </Column>
      </div>

      <Movement label="Anomaly trips" hint={DETECTOR_COVERAGE}>
        <AnomalyTripsGroup anomalies={sources.anomalies} nowMs={nowMs} />
      </Movement>
      {/* Platform redesign §4.9 — End-user security events and Operator actions
          moved to their own Security workspaces (Audit, Operator actions). */}
      <Movement label="Sessions" hint="Live sessions and the most recently active ones as parsed browser · device · OS — never the user-agent string, an IP or a user.">
        <SessionsGroup sessions={sources.sessions} nowMs={nowMs} />
      </Movement>
    </SectionSurface>
  );
}

// ── The widget (fetches once per route) ───────────────────────────────────────

export function SecurityPostureWidget(_props: { section: PlatformSection }) {
  const anomalies = useWidgetFetch<AnomaliesResponse>("/api/platform/security-ops/anomalies");
  const posture = useWidgetFetch<PlatformAuthPosture>("/api/platform/security-ops/auth-posture");
  const sessions = useWidgetFetch<PlatformSessionsResponse>("/api/platform/security-ops/sessions");
  const [nowMs] = useState(() => Date.now());
  return <SecurityPostureSurface sources={{ anomalies, posture, sessions }} nowMs={nowMs} />;
}
