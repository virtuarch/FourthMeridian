"use client";

/**
 * components/platform/widgets/SecSessionsWidget.tsx  (PO1.1 · sec_sessions → BETA V2 group)
 *
 * The Sessions GROUP of the one Security posture surface
 * (SecurityPostureWidget.tsx), over GET /api/platform/security-ops/sessions:
 * live count + distinct users as BigStats with their derivation, then the most
 * recently active sessions as parsed browser · device · OS — never the
 * user-agent string, an IP, a userId or an email — with the page depth stated.
 *
 * `SecSessionsWidget` (the registry export for `sec_sessions`) renders nothing:
 * the section is absorbed by the surface `sec_auth_posture` hosts.
 */

import type { PlatformSection } from "../widget-kit";
import { TwoLine } from "../platform-surface";
import type { PlatformSessionsResponse } from "@/app/api/platform/security-ops/sessions/route";
import { feedDepthText, sessionLine, sessionsReadings, type Fetched } from "./security-posture-view";
import { ReadingStat, SourceGate } from "./SecurityPostureParts";
import { relTime } from "./job-health-format";

export function SessionsGroup({ sessions, nowMs }: { sessions: Fetched<PlatformSessionsResponse>; nowMs: number }) {
  return (
    <SourceGate source="Sessions" fetched={sessions}>
      {(d) => (
        <div className="flex flex-col gap-4">
          <div className="grid gap-6 sm:grid-cols-2">
            {sessionsReadings(d).map((r) => <ReadingStat key={r.label} r={r} />)}
          </div>
          {d.recent.length === 0 ? (
            <p role="status" className="text-xs text-[var(--text-secondary)]">{feedDepthText(0, "recently active sessions")}</p>
          ) : (
            <div>
              <ul className="flex flex-col">
                {d.recent.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-3 border-b px-1 py-2 last:border-b-0" style={{ borderColor: "var(--border-hairline)" }}>
                    <TwoLine value={sessionLine(s)} qualifier="last recorded activity" />
                    <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-muted)]">{relTime(s.at, nowMs)}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[10px] leading-relaxed text-[var(--text-faint)]">{feedDepthText(d.recent.length, "recently active sessions")}</p>
            </div>
          )}
        </div>
      )}
    </SourceGate>
  );
}

/** Registry export for `sec_sessions` — absorbed into the Security posture surface; renders nothing. */
export function SecSessionsWidget(_props: { section: PlatformSection }) {
  return null;
}
