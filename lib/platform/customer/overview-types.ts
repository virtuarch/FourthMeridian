/**
 * lib/platform/customer/overview-types.ts  (Platform Spaces 2.0 — Customer Success)
 *
 * The DTO GET /api/platform/customer-success/overview returns: where customers
 * are in onboarding, who needs help and why, connection health, and the sync
 * incident trend. Client-safe (types only). COUNTS ONLY — the actionable
 * per-customer list stays the audited Customers list (cs_customers).
 *
 * Not available, so never shown: support tickets (no ticketing system) and
 * customer health scores (no authoritative model).
 */

import type { AcquisitionResponse } from "@/lib/platform/growth/acquisition-types";
import type { HealthState } from "@/lib/connections/health";

export interface CsOverviewResponse {
  checkedAt: string;
  windowDays: 30 | 90;
  /** Customers = role USER accounts. */
  customers: { active: number; deactivated: number };
  /** Active customers by the furthest onboarding stage reached THROUGH (strict funnel), now. */
  stages: { key: string; label: string; count: number }[];
  attention: {
    /** Distinct active customers with at least one reason below. */
    customers: number;
    reasons: { key: AttentionKey; label: string; count: number }[];
  };
  /** Live connections by health (REVOKED / owner-inactive are retired, not members). */
  connections: { total: number; counts: Record<HealthState, number>; retired: { revoked: number; ownerInactive: number } };
  incidents: {
    days: { day: string; opened: number; resolved: number }[];
    floor: boolean;
    /** Unresolved sync-issue episodes now, by kind. */
    openByKind: { kind: string; label: string; count: number }[];
    open: number;
  };
  onboarding: AcquisitionResponse["onboarding"];
  notes: string[];
}

export type AttentionKey = "reconnect" | "incident" | "policy" | "stalled";
