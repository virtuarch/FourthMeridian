"use client";

/**
 * components/platform/widgets/SecAuthPostureWidget.tsx  (PO1.1 · sec_auth_posture)
 *
 * TOTP / forced-reset / session posture summary, over
 * GET /api/platform/security-ops/auth-posture (requirePlatformAccess SECURITY_OPS READ).
 * A summary card — "X of Y users have TOTP", forced-reset pending, active sessions.
 */

import { ShieldCheck } from "lucide-react";
import { Figure } from "@/components/atlas/Surface";
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

  // MFA adoption — an honest ratio over the two counts the route already returns
  // (no fabricated metric). Null when there are no users, rendered as "—".
  const adoptionPct =
    data && data.totalUsers > 0 ? Math.round((data.totpEnabled / data.totalUsers) * 100) : null;

  return (
    <PlatformWidgetCard label={section.label} icon={ShieldCheck}>
      {loading || error || !data ? (
        <WidgetMessage loading={loading} error={error} />
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <Figure value={adoptionPct == null ? "—" : `${adoptionPct}%`} size="hero" />
            <span className="text-sm text-[var(--text-secondary)]">
              MFA adoption · {data.totpEnabled} of {data.totalUsers} users
            </span>
          </div>
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
