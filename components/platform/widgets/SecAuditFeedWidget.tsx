"use client";

/**
 * components/platform/widgets/SecAuditFeedWidget.tsx  (PO1.1 · sec_audit_feed → BETA V2 group)
 *
 * The End-user auth GROUP of the one Security posture surface
 * (SecurityPostureWidget.tsx), over GET /api/platform/security-ops/audit: the
 * newest security-relevant end-user audit events — action word · actor
 * (username or "system") · when — with the page depth stated.
 *
 * `SecAuditFeedWidget` (the registry export for `sec_audit_feed`) renders nothing:
 * the section is absorbed by the surface `sec_auth_posture` hosts.
 */

import { useState } from "react";
import { ScrollText } from "lucide-react";
import { useWidgetFetch, type PlatformSection } from "../widget-kit";
import { SectionSurface, TwoLine } from "../platform-surface";
import type { PlatformAuditResponse } from "@/app/api/platform/security-ops/audit/route";
import { auditRows, feedDepthText, type Fetched } from "./security-posture-view";
import { SourceGate } from "./SecurityPostureParts";

export function EndUserAuthGroup({ audit, nowMs }: { audit: Fetched<PlatformAuditResponse>; nowMs: number }) {
  return (
    <SourceGate source="Audit feed" fetched={audit}>
      {(d) => {
        const rows = auditRows(d.events, nowMs);
        return (
          <div>
            {rows.length === 0 ? (
              <p role="status" className="text-xs text-[var(--text-secondary)]">{feedDepthText(0, "security events")}</p>
            ) : (
              <ul className="flex flex-col">
                {rows.map((r) => (
                  <li key={r.id} className="flex items-start justify-between gap-3 border-b px-1 py-2 last:border-b-0" style={{ borderColor: "var(--border-hairline)" }}>
                    <TwoLine value={r.actionWord} qualifier={r.actor} />
                    <span className="shrink-0 text-right"><TwoLine value={r.when} qualifier={r.stamp} /></span>
                  </li>
                ))}
              </ul>
            )}
            {rows.length > 0 && <p className="mt-2 text-[10px] leading-relaxed text-[var(--text-faint)]">{feedDepthText(rows.length, "security events")}</p>}
          </div>
        );
      }}
    </SourceGate>
  );
}

/** Platform redesign §4.9 — the Audit workspace: the end-user security feed on its own surface. */
export const AUDIT_SURFACE_TITLE = "End-user security events";

/** Registry export for `sec_audit_feed` — the Security › Audit workspace (no longer absorbed by the posture surface). */
export function SecAuditFeedWidget(_props: { section: PlatformSection }) {
  const audit = useWidgetFetch<PlatformAuditResponse>("/api/platform/security-ops/audit");
  const [nowMs] = useState(() => Date.now());
  return (
    <SectionSurface icon={ScrollText} title={AUDIT_SURFACE_TITLE}>
      <EndUserAuthGroup audit={audit} nowMs={nowMs} />
    </SectionSurface>
  );
}
