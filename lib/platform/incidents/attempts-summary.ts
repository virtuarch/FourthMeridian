/**
 * lib/platform/incidents/attempts-summary.ts  (Incident detail v1 — PURE, client-safe)
 *
 * The recent refresh attempts of an incident's connection, reduced to what the
 * drawer shows: counts by outcome and the newest N attempts with their time,
 * trigger, status, HTTP status and provider error code. EVERY string is
 * allowlisted here (fixed vocabularies; provider codes via explanations.ts) —
 * an unknown value becomes "OTHER" / null, never echoed. No request id, no
 * request or response body, no error text.
 */

import { allowlistedProviderCode } from "./explanations";
import type { IncidentAttemptsSummary } from "./intelligence/types";

/** Executions read per incident (newest first) — a floor when reached. */
export const ATTEMPTS_READ_CAP = 50;
/** Attempts listed in the drawer. */
export const ATTEMPTS_SHOWN = 8;

const STATUSES = new Set(["RUNNING", "SUCCEEDED", "PARTIAL", "FAILED", "SKIPPED"]);
const TRIGGERS = new Set(["MANUAL", "CRON", "RECONNECT", "WEBHOOK", "ADMIN", "OPERATOR", "RESUME"]);
const CALL_STATUSES = new Set(["FAILED", "RATE_LIMITED"]);
const OPERATION = /^[a-zA-Z][a-zA-Z0-9]{0,47}$/;

export interface RawItemAttempt {
  startedAt: Date;
  trigger: string;
  overallStatus: string;
  failedCall: { status: string; httpStatus: number | null; errorCode: string | null; operation: string } | null;
}

const pick = (set: ReadonlySet<string>, v: string): string => (set.has(v) ? v : "OTHER");

export function summariseAttempts(rows: readonly RawItemAttempt[], window: { from: string; to: string }, readCap = ATTEMPTS_READ_CAP): IncidentAttemptsSummary {
  const counts = { total: rows.length, succeeded: 0, failed: 0, partial: 0, skipped: 0, running: 0 };
  for (const r of rows) {
    switch (r.overallStatus) {
      case "SUCCEEDED": counts.succeeded++; break;
      case "FAILED": counts.failed++; break;
      case "PARTIAL": counts.partial++; break;
      case "SKIPPED": counts.skipped++; break;
      case "RUNNING": counts.running++; break;
    }
  }
  const recent = [...rows]
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
    .slice(0, ATTEMPTS_SHOWN)
    .map((r) => {
      const c = r.failedCall;
      const http = c && typeof c.httpStatus === "number" && Number.isInteger(c.httpStatus) && c.httpStatus >= 100 && c.httpStatus <= 599 ? c.httpStatus : null;
      return {
        at: r.startedAt.toISOString(),
        trigger: pick(TRIGGERS, r.trigger),
        status: pick(STATUSES, r.overallStatus),
        httpStatus: http,
        errorCode: c ? allowlistedProviderCode(c.errorCode) : null,
        callStatus: c ? (CALL_STATUSES.has(c.status) ? c.status : "OTHER") : null,
        operation: c && OPERATION.test(c.operation) ? c.operation : null,
      };
    });
  const lastSuccess = rows.filter((r) => r.overallStatus === "SUCCEEDED").sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
  const lastFailure = rows.filter((r) => r.overallStatus === "FAILED" || r.overallStatus === "PARTIAL").sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
  return {
    readable: true,
    from: window.from,
    to: window.to,
    counts,
    truncated: rows.length >= readCap,
    lastSucceededAt: lastSuccess ? lastSuccess.startedAt.toISOString() : null,
    lastFailedAt: lastFailure ? lastFailure.startedAt.toISOString() : null,
    recent,
  };
}

/** The read failed — reported as such, never as "no attempts". */
export function unreadableAttempts(window: { from: string; to: string }): IncidentAttemptsSummary {
  return {
    readable: false, from: window.from, to: window.to,
    counts: { total: 0, succeeded: 0, failed: 0, partial: 0, skipped: 0, running: 0 },
    truncated: false, lastSucceededAt: null, lastFailedAt: null, recent: [],
  };
}
