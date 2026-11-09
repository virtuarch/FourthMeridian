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
    /** Each reason with its suggested next step for the operator (TEXT ONLY — nothing here contacts a customer). */
    reasons: { key: AttentionKey; label: string; action: string; count: number }[];
    /**
     * Of `customers`, how many have a reserved test e-mail domain (example.test, example.com, …).
     * A LABEL only: OD-4 (whether test accounts are excluded) is undecided, so they stay counted.
     */
    testAccounts: number;
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
 * `import_failed` / `import_stuck` — a recent bank connection's first import, by the import-status rule
 * (import-status-core.ts): failed, or in progress with its newest run failed (a resume is pending).
 * `link_exited` — Plaid Link closed without success in the last 7 days and no connection was made since.
 * `no_connection_24h` — registered 24 h – 7 d ago with no connection or account yet (`stalled` takes over at 7 d).
 */
export type AttentionKey =
  | "reconnect" | "incident" | "import_failed" | "import_stuck" | "link_exited"
  | "policy" | "unassigned" | "no_connection_24h" | "stalled";
/** The Customers list's `attention` filter: one reason, or any reason. */
export type AttentionFilter = AttentionKey | "any";
