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
 * Every live rule reads one of the authorities that already ship:
 *   - OPS-4 Jobs         checkScheduledJobHealth()  (lib/jobs/health.ts)
 *   - OPS-5 Freshness    checkResourceFreshness()   (lib/platform/resource-freshness.ts)
 *   - Connection health  getConnectionHealth()      (lib/connections/health.ts)
 *   - AI failures        getAiFailureHealth()       (lib/platform/ai/failures.ts)
 *   - AI spend           getAiSpendHealth()         (lib/platform/ai/spend-health.ts)
 *   - Sync incidents     getActiveIncidentPage()    (lib/platform/incidents/projections.ts)
 * and the destination is OPS-1's sendEmail() (lib/email/send.ts). The engine
 * (lib/alerts/evaluate.ts) NEVER queries a product table or re-derives a health
 * state — it only classifies signals over authority OUTPUT.
 *
 * ── The nine rules (intentionally small; NOT a generic engine) ───────────────
 *   resource-stale       an archive's newest observation is stale/empty    (LIVE)
 *   provider-unhealthy   a syncing provider connection is not healthy —
 *                        ONE breach PER CONNECTION since OBS-004            (LIVE)
 *   job-failing          a scheduled job's last runs all failed             (LIVE)
 *   scheduler-silent     a scheduled job is overdue/dead (dispatcher/cron silent)(LIVE)
 *   ai-provider-failing  the AI provider is refusing/failing calls          (LIVE)
 *   ai-spend-fleet-high  fleet AI spend at/over the fleet threshold, or any
 *                        invocation the rate card cannot price             (LIVE)
 *   ai-spend-user-high   ONE customer's AI spend at/over the per-customer
 *                        threshold                                         (LIVE)
 *   sync-incident-critical  an ACTIVE critical sync incident — canonical
 *                        financial data unpersisted behind a held cursor —
 *                        one breach per Item (OBS-004, 2026-10-22)          (LIVE)
 *   quota-low            a provider's remaining API quota is low         (DORMANT)
 *
 * sync-incident-critical (OBS-004, pre-beta audit) exists because no rule read
 * SyncIssue episodes or RefreshExecution: a TRANSACTION_PERSISTENCE_FAILED
 * (critical, cursor held, a customer's bank transactions unstored) never
 * paged anyone. It reads the incident projection's ACTIVE set (the semantic
 * authority decides "active" and "critical"; this rule decides nothing) and
 * dedupes PER ITEM, so a second customer's incident inside the 20 h window is
 * its own breach. The same audit row moved provider-unhealthy from one
 * aggregate breach keyed on the rule id — which silenced a second failing
 * connection for 20 h — to one breach per connection, keyed on the opaque
 * connection id.
 *
 * ai-provider-failing (OPERATIONALIZATION P0, 2026-10-07) exists because the
 * Oct 4 Daily Brief outage — the OpenAI account out of credits — was found by a
 * USER. Until then the AiInvocation ledger held billed, returned calls only, so
 * there was no fact to alert on. The provider chokepoint now writes a zero-token
 * failure row (outcome QUOTA / RATE_LIMITED / TIMEOUT / FAILED) and this rule
 * reads the fold of those rows over the last 24h.
 *
 * ai-spend-fleet-high and ai-spend-user-high (BETA C7, 2026-10-15; SPLIT by
 * AI COST CONTROLS the same day) are the first COST safeguards: the same
 * ledger's RETURNED customer-surface rows, priced by the code-owned rate card
 * over the trailing 24 h, judged against two operator thresholds
 * (PlatformSetting `ai_spend_alert_fleet_usd_24h`, `ai_spend_alert_user_usd_24h`).
 * They were ONE rule (`ai-spend-high`) until the controls milestone needed each
 * alert independently enable-able through the engine's existing
 * `alert_rule_enabled:<id>` mechanism — one rule, one enabled key, one dedupe
 * family. The fleet rule also fires — regardless of spend — when ANY invocation
 * in the window was on a model the rate card cannot price: a spend figure that
 * silently omits part of the spend is not a safeguard (owner rule: an
 * unpriceable model never counts as zero). Disabling either rule changes
 * evaluation only; the spend fold, the ledger and the Economics figures keep
 * running. The dedupe keys keep the `<rule>:<fleet|user|unpriced>:<day>` family,
 * so suppress-while-open (20 h) is unchanged.
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
  | "ai-failing"
  | "ai-spend-fleet"
  | "ai-spend-user"
  | "sync-incident"
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
      "A scheduled job is overdue or dead — its schedule has silently stopped (a dead cron/dispatcher, or a misconfigured CRON_SECRET). Reads the OPS-4 job-health authority (`overdue` and `dead` states; `dead` = silent for three cadences, the escalate-now signal).",
    authority: "job-health",
    live: true,
    defaultEnabled: true,
  },
  {
    id: "ai-provider-failing",
    kind: "ai-failing",
    title: "AI provider failing",
    description:
      "The AI provider is refusing or failing calls. Critical when the account is out of credits / over quota (insufficient_quota — waiting cannot cure it) or when every call in the window failed; warning when several calls failed or timed out while others returned. Reads the AiInvocation outcome fold (lib/platform/ai/failures.ts); never calls the provider.",
    authority: "ai-failures",
    live: true,
    defaultEnabled: true,
  },
  {
    id: "ai-spend-fleet-high",
    kind: "ai-spend-fleet",
    title: "AI spend high — fleet",
    description:
      "Estimated AI spend over the trailing 24 h across customer surfaces (Conversations + Daily Brief; harness traffic is overhead and excluded) is at or above the fleet threshold ai_spend_alert_fleet_usd_24h. Warning at or above the threshold; critical at or above twice it. Also fires a warning whenever any invocation in the window ran on a model the rate card cannot price — those invocations are counted, never priced at $0, and the summary names them. Reads the AiInvocation spend fold (lib/platform/ai/spend-health.ts) priced by lib/usage/pricing.ts; every figure is an estimate, not a bill.",
    authority: "ai-spend",
    live: true,
    defaultEnabled: true,
  },
  {
    id: "ai-spend-user-high",
    kind: "ai-spend-user",
    title: "AI spend high — one customer",
    description:
      "ONE customer caused estimated AI spend over the trailing 24 h at or above the per-customer threshold ai_spend_alert_user_usd_24h. Warning at or above the threshold; critical at or above twice it. The summary names the customer by an opaque reference only and says how many others are at or above it. Reads the same AiInvocation spend fold as the fleet rule; every figure is an estimate, not a bill.",
    authority: "ai-spend",
    live: true,
    defaultEnabled: true,
  },
  {
    id: "sync-incident-critical",
    kind: "sync-incident",
    title: "Critical sync incident",
    description:
      "An ACTIVE sync incident of critical severity — canonical financial data was not persisted and the provider cursor is held (TRANSACTION_PERSISTENCE_FAILED and its legacy shapes). One breach per Plaid Item (an opaque reference; never an institution or a customer), so a second Item's incident is never silenced by the first. Reads the incident projection (lib/platform/incidents/projections.ts) whose state and severity come from the sync-issue semantic authority; never re-derives either.",
    authority: "sync-incidents",
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
