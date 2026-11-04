/**
 * lib/platform/customer/overview-types.ts  (Platform Spaces 2.0 — Customer Success)
 *
 * The DTO GET /api/platform/customer-success/overview returns: where customers
 * are in onboarding, who needs help and why, connection health, and the sync
 * incident trend. Client-safe (types only). COUNTS ONLY — the actionable
 * per-customer list stays the audited Customers list (cs_customers).
 *
 * PB-4 — each reason row links to that list FILTERED to the reason
 * (`attention=<key>`); the reasons themselves are defined once, in
 * attention-core.ts, for both reads, so a count and its filtered list agree.
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
    /** True when a fleet read hit its row cap — every count here is a floor ("≥N"). */
    floor: boolean;
    reasons: { key: AttentionKey; label: string; count: number }[];
  };
  /** Live connections by health (REVOKED / owner-inactive are retired, not members). */
  connections: { total: number; counts: Record<HealthState, number>; retired: { revoked: number; ownerInactive: number } };
  incidents: {
    days: { day: string; opened: number; resolved: number }[];
    floor: boolean;
    /** Active sync incidents now (derived state, the Incidents workspace's read), by kind. */
    openByKind: { kind: string; label: string; count: number }[];
    open: number;
    /** True when the active-incident scan hit its ceiling — `open` is a floor (separate from the trend's `floor`). */
    openFloor: boolean;
  };
  onboarding: AcquisitionResponse["onboarding"];
  notes: string[];
}

/**
 * `policy` — an assignment naming an unknown / invalid / retired group.
 * `unassigned` — no assignment while the fail-closed switch is ENFORCED (the customer is restricted now);
 * never present otherwise (S2 ruling, 2026-11-02).
 */
export type AttentionKey = "reconnect" | "incident" | "policy" | "unassigned" | "stalled";
/** The Customers list's `attention` filter: one reason, or any reason. */
export type AttentionFilter = AttentionKey | "any";
