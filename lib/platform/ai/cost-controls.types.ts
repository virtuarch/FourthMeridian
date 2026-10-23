/**
 * lib/platform/ai/cost-controls.types.ts  (AI COST CONTROLS — the frozen contract)
 *
 * THE ONE SHAPE THREE WORKSTREAMS BUILD AGAINST. Coordinator-owned; agents add
 * fields only by appending (never renaming or retyping) and say so in their
 * hand-off. Pure types and constants — no I/O, no imports from the server.
 *
 *   · Agent A (policy backend) implements the read model, the mutation service
 *     and the two routes named here.
 *   · Agent B (Platform Ops UI) renders the read model in Policies → "AI Cost
 *     Controls" and the budget utilization in Economics, and sends the PATCH.
 *   · Agent C (OpenAI environment separation) does not touch this file.
 *
 * ── Controls ────────────────────────────────────────────────────────────────
 * Seven controls, each backed by ONE PlatformSetting key (the existing settings
 * architecture; no migration). The two threshold keys already exist (BETA C7);
 * the two alert-enabled keys are the alert engine's own `alert_rule_enabled:`
 * convention (lib/alerts/evaluate.ts `alertEnabledKey`), registered as typed
 * descriptors so they can be validated and audited like every other key. The
 * `ai-spend-high` rule is SPLIT into `ai-spend-fleet-high` and
 * `ai-spend-user-high` so each alert is independently enable-able with the
 * engine's existing mechanism (one rule, one enabled key, one dedupe family).
 *
 * ── Precedence for the per-customer daily allowance ─────────────────────────
 *   USER_OVERRIDE  (CustomerPolicyAssignment.aiDailyUsdAllowanceOverride — the
 *                   one additive migration of this milestone)
 *   > OVERLAY      (catalogue overlay, e.g. FOUNDER_INTERNAL_V1 $20)
 *   > PLATFORM     (PlatformSetting ai_daily_allowance_usd — this milestone)
 *   > POLICY       (catalogue policy-group value, BETA $5)
 *   then the CEILING (catalogue, $20) clamps LAST — nothing exceeds it, so no
 *   override can escalate past code. The kill switch is judged BEFORE the
 *   allowance and no override can lift it.
 */

// ── Control keys ──────────────────────────────────────────────────────────────

export const AI_COST_CONTROL_KEYS = [
  "allowance.enforced",
  "allowance.usd",
  "userAlert.enabled",
  "userAlert.thresholdUsd",
  "fleetAlert.enabled",
  "fleetAlert.thresholdUsd",
  "killSwitch.paused",
] as const;

export type AiCostControlKey = (typeof AI_COST_CONTROL_KEYS)[number];

export function isAiCostControlKey(v: unknown): v is AiCostControlKey {
  return typeof v === "string" && (AI_COST_CONTROL_KEYS as readonly string[]).includes(v);
}

/** The alert rule ids the two spend alerts carry after the split. */
export const AI_SPEND_RULE_IDS = {
  fleet: "ai-spend-fleet-high",
  user:  "ai-spend-user-high",
} as const;

/** The PlatformSetting key behind each control. */
export const AI_COST_CONTROL_SETTING_KEYS: Readonly<Record<AiCostControlKey, string>> = {
  "allowance.enforced":     "ai_daily_allowance_enforced",
  "allowance.usd":          "ai_daily_allowance_usd",
  "userAlert.enabled":      `alert_rule_enabled:${AI_SPEND_RULE_IDS.user}`,
  "userAlert.thresholdUsd": "ai_spend_alert_user_usd_24h",
  "fleetAlert.enabled":     `alert_rule_enabled:${AI_SPEND_RULE_IDS.fleet}`,
  "fleetAlert.thresholdUsd":"ai_spend_alert_fleet_usd_24h",
  "killSwitch.paused":      "ai_paid_requests_paused",
};

/** The code-owned defaults (owner, 2026-10-15). Whole USD. */
export const AI_COST_CONTROL_DEFAULTS = {
  "allowance.enforced":     true,
  "allowance.usd":          5,
  "userAlert.enabled":      true,
  "userAlert.thresholdUsd": 3,
  "fleetAlert.enabled":     true,
  "fleetAlert.thresholdUsd":10,
  "killSwitch.paused":      false,
} as const satisfies Record<AiCostControlKey, boolean | number>;

export type AiCostControlValue<K extends AiCostControlKey> = (typeof AI_COST_CONTROL_DEFAULTS)[K] extends boolean ? boolean : number;

/** Controls whose change needs an explicit confirmation step in the UI (the server does not confirm; the UI does). */
export const AI_COST_CONTROL_CONFIRMATION: Readonly<Partial<Record<AiCostControlKey, { when: "ENABLE" | "DISABLE" | "ANY"; sentence: string }>>> = {
  "allowance.enforced": { when: "DISABLE", sentence: "Disabling enforcement lets every customer exceed their daily allowance. Usage and estimated cost are still recorded and the spend alerts still fire." },
  "killSwitch.paused":  { when: "ANY",     sentence: "Pausing refuses every new paid AI request (Conversations, the Daily Brief and harness runs) until resumed. Resuming re-admits them under the allowance." },
};

// ── Read model ────────────────────────────────────────────────────────────────

/** Where a control's effective value came from (the job-cadence idiom: a missing row is DEFAULT, an unreadable row is INVALID_SETTING with the default in force). */
export type ControlOrigin = "DEFAULT" | "SETTING" | "INVALID_SETTING";

export interface ControlValueView<V extends boolean | number> {
  control: AiCostControlKey;
  settingKey: string;
  label: string;
  description: string;
  /** The value IN FORCE. */
  value: V;
  defaultValue: V;
  origin: ControlOrigin;
  /** The stored row's version token (ISO) — echoed back as `expectedUpdatedAt`; null when no row exists. */
  updatedAt: string | null;
  /** Display name of the operator who last wrote the row (never an email); null when unknown or no row. */
  updatedByName: string | null;
  /** Integer bounds for numeric controls; null for booleans. */
  bounds: { min: number; max: number } | null;
}

export interface AllowanceOverrideView {
  /** Opaque customer reference ("user …abc123"); never an email, name or full id on this surface. */
  ref: string;
  usd: number;
  updatedAt: string;
}

export interface AllowanceControlsView {
  enforced: ControlValueView<boolean>;
  usd: ControlValueView<number>;
  /** The code-owned ceiling: no platform value and no per-customer override exceeds it. */
  ceilingUsd: number;
  /** What a customer on the default policy with no overlay and no override gets today, after the ceiling. */
  effectiveDefaultUsd: number;
  effectiveDefaultSource: "PLATFORM_SETTING" | "POLICY" | "CEILING";
  overrides: { count: number; customers: AllowanceOverrideView[] };
  /** One sentence: where and when the allowance is judged. */
  enforcementNote: string;
}

export interface AlertTriggerView {
  at: string;
  severity: "warning" | "critical";
  summary: string;
  dedupeKey: string;
}

export interface AlertControlsView {
  ruleId: string;
  enabled: ControlValueView<boolean>;
  thresholdUsd: ControlValueView<number>;
  status: {
    live: boolean;
    firingNow: boolean;
    lastFiredAt: string | null;
    /** Newest first; capped by the reader. */
    recent: AlertTriggerView[];
  };
}

export interface KillSwitchView {
  paused: ControlValueView<boolean>;
  /** The sentence customers read while paused (the routes' refusal body carries the same words). */
  customerMessage: string;
}

export interface AiCostControlsReadModel {
  checkedAt: string;
  allowance: AllowanceControlsView;
  userAlert: AlertControlsView;
  fleetAlert: AlertControlsView;
  killSwitch: KillSwitchView;
  /** The caching posture, stated for the operator: whether any decision reads a cached copy and how a change propagates. */
  propagation: { cached: boolean; note: string };
}

// ── Mutation ──────────────────────────────────────────────────────────────────

export interface AiCostControlChange {
  control: AiCostControlKey;
  /** The desired value; `null` = restore the default (the override row is deleted, never written as if configured). */
  value: boolean | number | null;
  /** The row version the operator READ (ISO), or null for "no row". A row that moved ⇒ CONFLICT, nothing written. */
  expectedUpdatedAt: string | null;
}

export interface AiCostControlsPatchBody {
  /** One to seven changes, ONE transaction, all-or-nothing; one audit row per change. */
  changes: AiCostControlChange[];
  reason: { code: string; note?: string };
}

export type AiCostControlsMutationCode = "VALIDATION" | "CONFLICT" | "NOT_FOUND";

export interface AiCostControlsRefusal {
  error: string;
  code: AiCostControlsMutationCode;
  /** The control the refusal is about, when one is. */
  control?: AiCostControlKey;
  /** The canonical current model — replaces the surface on 409. */
  model: AiCostControlsReadModel;
}

/** GET = read model · PATCH = AiCostControlsPatchBody → read model | AiCostControlsRefusal. PLATFORM_OPS READ / fresh CONTROL. */
export const AI_COST_CONTROLS_URL = "/api/platform/platform-ops/ai-cost-controls";

// ── Budget utilization (Economics) ────────────────────────────────────────────

export interface CustomerBudgetView {
  /** Opaque reference; never an identity on this surface. */
  ref: string;
  /** Estimated USD this customer caused in the rolling 24 h window (what the per-customer alert judges). */
  rolling24hUsd: number;
  /** Estimated USD since midnight UTC (what the allowance judges). */
  todayUsd: number;
  /** The allowance in force for THIS customer (override / overlay / platform / policy, after the ceiling). */
  allowanceUsd: number;
  allowanceSource: "USER_OVERRIDE" | "OVERLAY" | "PLATFORM_SETTING" | "POLICY" | "CEILING";
  /** todayUsd / allowanceUsd × 100, capped nowhere (over 100 means over). */
  allowanceUtilizationPct: number;
  /** rolling24hUsd / per-customer alert threshold × 100. */
  alertUtilizationPct: number;
}

export interface SurfaceBudgetView {
  /** "chat" | "brief" | "harness" | "other" */
  surface: string;
  customer: boolean;
  estimatedUsd: number | null;
  invocations: number;
  unpricedInvocations: number;
}

export interface AiBudgetUtilization {
  checkedAt: string;
  windowHours: number;
  fleet: {
    /** Customer surfaces only (chat + brief); harness and unattributed traffic are overhead, never fleet. */
    estimatedUsd: number | null;
    thresholdUsd: number;
    alertEnabled: boolean;
    utilizationPct: number | null;
    invocations: number;
    customers: number;
  };
  overhead: { estimatedUsd: number | null; invocations: number };
  /** Top customers by rolling-24 h spend, opaque refs, capped by the reader. */
  customers: CustomerBudgetView[];
  bySurface: SurfaceBudgetView[];
  unpriced: { invocations: number; models: string[] };
  recentAlerts: AlertTriggerView[];
  controls: {
    allowanceEnforced: boolean;
    allowanceDefaultUsd: number;
    userAlertEnabled: boolean;
    userAlertThresholdUsd: number;
    paused: boolean;
  };
  /** The sentence every dollar on the surface is governed by. */
  estimateNote: string;
}

/** GET = AiBudgetUtilization. PLATFORM_OPS READ. */
export const AI_BUDGET_URL = "/api/platform/platform-ops/ai-budget";

export const ESTIMATE_NOT_BILLING =
  "Every dollar here is an ESTIMATE: provider-reported tokens priced by the code-owned rate card at the day they occurred. It is not provider billing; no invoice is read.";
