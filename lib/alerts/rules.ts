/**
 * lib/alerts/rules.ts  (OPS-5 S5 — Alerting)
 *
 * THE alert rule registry — the small, declarative vocabulary of the alerting
 * slice. A rule is a NAMED BINDING of a condition to an EXISTING health
 * authority; it holds NO health computation of its own. This is the load-bearing
 * discipline of OPS-5 S5:
 *
 *     One canonical alert evaluation · no duplicated health computation ·
 *     consume existing health authorities.
 *
 * Every live rule reads one of three authorities that already ship:
 *   - OPS-4 Jobs         checkScheduledJobHealth()  (lib/jobs/health.ts)
 *   - OPS-5 Freshness    checkResourceFreshness()   (lib/platform/resource-freshness.ts)
 *   - Connection health  getConnectionHealth()      (lib/connections/health.ts)
 * and the destination is OPS-1's sendEmail() (lib/email/send.ts). The engine
 * (lib/alerts/evaluate.ts) NEVER queries a product table or re-derives a health
 * state — it only classifies signals over authority OUTPUT.
 *
 * ── The five initial rules (intentionally small; NOT a generic engine) ────────
 *   resource-stale       an archive's newest observation is stale/empty    (LIVE)
 *   provider-unhealthy   a syncing provider connection is not healthy       (LIVE)
 *   job-failing          a scheduled job's last runs all failed             (LIVE)
 *   scheduler-silent     a scheduled job is overdue (dispatcher/cron silent)(LIVE)
 *   quota-low            a provider's remaining API quota is low         (DORMANT)
 *
 * ── Dormant rules (future-safe, not recreated) ───────────────────────────────
 * `quota-low` is a first-class rule KIND but has NO authority to consume yet:
 * FX provider quota (OXR /usage.json) is owned by a sibling slice (OPS-5 S3,
 * "Providers") that has not shipped. Per the slice discipline ("if another
 * slice owns a concern, consume it rather than recreating it") this rule is
 * declared `live: false` — it is inert (the engine never evaluates it, it cannot
 * fire) and surfaces in the UI as "awaiting OPS-5 S3". When the quota authority
 * lands, wiring it is: flip `live` to true and add one evaluator branch — no
 * schema, no engine, no UI change. Adding a NEW rule is likewise one registry
 * entry + (for a live rule) one evaluator branch.
 */

import type { AlertAuthority } from "@/lib/alerts/authorities";

// ── Vocabulary ────────────────────────────────────────────────────────────────

export type AlertRuleKind =
  | "resource-stale"
  | "provider-unhealthy"
  | "job-failing"
  | "scheduler-silent"
  | "quota-low";

/** Two levels only — a solo operator's pager does not need more (alert fatigue
 *  is the failure mode). `critical` = acute (a job broke, an archive is cold);
 *  `warning` = degraded (stale, transiently degraded). */
export type AlertSeverity = "warning" | "critical";

/** One breach produced by a rule's evaluator over its authority's output. */
export interface AlertSignal {
  ruleId: string;
  kind: AlertRuleKind;
  severity: AlertSeverity;
  /** Stable identity of THIS breach — the suppress-while-open key across cycles.
   *  Carries only system identifiers (job/resource names, provider types, opaque
   *  IDs) — never user content or monetary values. */
  dedupeKey: string;
  /** System-generated description (counts/states/kinds only). No PII. */
  summary: string;
}

/** One rule in the registry. */
export interface AlertRuleDefinition {
  id: string;
  kind: AlertRuleKind;
  title: string;
  description: string;
  /** Which existing authority this rule reads. */
  authority: AlertAuthority;
  /** Whether the rule's authority ships today. A dormant rule (`false`) is never
   *  evaluated and cannot fire; it exists so the vocabulary is future-safe. */
  live: boolean;
  /** Default on/off, overridable at runtime by a PlatformSetting (config.ts). */
  defaultEnabled: boolean;
}

// ── The registry ──────────────────────────────────────────────────────────────

export const ALERT_RULES: readonly AlertRuleDefinition[] = [
  {
    id: "resource-stale",
    kind: "resource-stale",
    title: "Resource stale",
    description:
      "A refreshable archive's newest observation is older than its stale threshold, or the archive is unexpectedly empty. Reads the OPS-5 Resource Freshness authority (content-derived, not job-status) so a green refresh over a cold archive still fires.",
    authority: "resource-freshness",
    live: true,
    defaultEnabled: true,
  },
  {
    id: "provider-unhealthy",
    kind: "provider-unhealthy",
    title: "Provider unhealthy",
    description:
      "One or more syncing provider connections (Plaid / wallet / exchange / brokerage) are not healthy. Reads the Connection Health authority; never re-derives provider state.",
    authority: "connection-health",
    live: true,
    defaultEnabled: true,
  },
  {
    id: "job-failing",
    kind: "job-failing",
    title: "Repeated job failures",
    description:
      "A scheduled job's recent runs have all failed (the dead-job detector's `failing` state). Reads the OPS-4 job-health authority over the JobRun ledger.",
    authority: "job-health",
    live: true,
    defaultEnabled: true,
  },
  {
    id: "scheduler-silent",
    kind: "scheduler-silent",
    title: "Scheduler silent",
    description:
      "A scheduled job is overdue — its schedule has silently stopped (a dead cron/dispatcher, or a misconfigured CRON_SECRET). Reads the OPS-4 job-health authority (`overdue` state).",
    authority: "job-health",
    live: true,
    defaultEnabled: true,
  },
  {
    id: "quota-low",
    kind: "quota-low",
    title: "Quota low",
    description:
      "A provider's remaining API quota is running low. DORMANT — the provider-quota authority (OXR /usage.json) is owned by OPS-5 S3 (Providers) and has not shipped; this rule activates when that authority lands, with no engine/schema/UI change.",
    authority: "provider-quota",
    live: false,
    defaultEnabled: false,
  },
];

/** Lookup by id (small registry — a linear find is fine and keeps it pure). */
export function findAlertRule(id: string): AlertRuleDefinition | undefined {
  return ALERT_RULES.find((r) => r.id === id);
}
