"use client";

/**
 * components/platform/widgets/OpsUsersWidget.tsx  (OPS-6B · growth_users · SEC-PLAT-4)
 *
 * Customer-account aggregates for Growth, over GET /api/platform/growth-revenue/users
 * (GROWTH_REVENUE READ). Presentation-only: every figure arrives counted.
 *
 * SEC-PLAT-4 (owner ruling P-4, 2026-10-27): Growth is identity-minimized. The
 * former per-user list (usernames, search) and its deactivate / reactivate
 * buttons are gone from Growth; looking up and acting on ONE identified
 * customer is Customer Success's job (its customer list + audited profile +
 * POST …/customers/[userId]/access, fresh CUSTOMER_SUCCESS WRITE).
 */

import { Users } from "lucide-react";
import {
  PlatformWidgetCard,
  WidgetMessage,
  WidgetStat,
  useWidgetFetch,
  type PlatformSection,
} from "../widget-kit";
import type { GrowthUsersSummary } from "@/app/api/platform/growth-revenue/users/route";

/** Where per-customer work moved — shown once, so the change is discoverable. */
export const OPS_USERS_MOVED_LINE = "Looking up or deactivating a specific customer is done in Customer Success.";

export function OpsUsersWidget({ section }: { section: PlatformSection }) {
  const { data, loading, error } = useWidgetFetch<GrowthUsersSummary>("/api/platform/growth-revenue/users");

  return (
    <PlatformWidgetCard label={section.label} icon={Users}>
      {loading || error || !data ? (
        <WidgetMessage loading={loading} error={error} />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <WidgetStat value={data.total} label="Customer accounts" />
            <WidgetStat value={data.emailVerified} label="Email verified" />
            <WidgetStat value={data.withLiveSession} label="With a live session" />
          </div>
          <div className="grid grid-cols-3 gap-3 mt-1">
            <WidgetStat value={data.neverSignedIn} label="Never signed in" />
            <WidgetStat value={data.deactivated} label="Deactivated" />
            <WidgetStat value={data.deletionScheduled} label="Deletion scheduled" />
          </div>
          <p className="mt-1 text-[11px] leading-snug text-[var(--text-muted)]">{OPS_USERS_MOVED_LINE}</p>
        </>
      )}
    </PlatformWidgetCard>
  );
}
