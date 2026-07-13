"use client";

/**
 * components/platform/widgets/SecAuthPostureWidget.tsx  (PO1.1 · sec_auth_posture)
 *
 * TOTP / forced-reset / session posture summary, over
 * GET /api/platform/security-ops/auth-posture (requirePlatformAccess SECURITY_OPS READ).
 * A summary card — "X of Y users have TOTP", forced-reset pending, active sessions.
 */

import { ShieldCheck } from "lucide-react";
import {
  PlatformWidgetCard,
  WidgetMessage,
  WidgetStat,
  useWidgetFetch,
  type PlatformSection,
} from "../widget-kit";
import type { PlatformAuthPosture } from "@/app/api/platform/security-ops/auth-posture/route";

export function SecAuthPostureWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<PlatformAuthPosture>("/api/platform/security-ops/auth-posture");

  return (
    <PlatformWidgetCard label={section.label} icon={ShieldCheck}>
      {loading || error || !data ? (
        <WidgetMessage loading={loading} error={error} />
      ) : (
        <>
          <p className="text-sm text-[var(--text-primary)]">
            <span className="font-semibold tabular-nums">{data.totpEnabled}</span>
            <span className="text-[var(--text-secondary)]"> of </span>
            <span className="font-semibold tabular-nums">{data.totalUsers}</span>
            <span className="text-[var(--text-secondary)]"> users have TOTP enabled</span>
          </p>
          <div className="grid grid-cols-2 gap-3 mt-1">
            <WidgetStat value={data.forcedResetPending} label="Forced reset pending" />
            <WidgetStat value={data.activeSessions} label="Active sessions" />
            <WidgetStat value={data.usersWithRecoveryCodes} label="Have recovery codes" />
            <WidgetStat value={data.totalUsers} label="Total users" />
          </div>
        </>
      )}
    </PlatformWidgetCard>
  );
}
