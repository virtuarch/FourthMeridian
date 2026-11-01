/**
 * lib/platform-settings.ts
 *
 * Keys, descriptors and helpers for PlatformSetting.
 * All reads/writes go through these helpers to avoid typos — and, since
 * PLATFORM OPS POLICIES (Slice 1), every application WRITE is validated here
 * against the key's descriptor. A route cannot bypass validation by knowing the
 * key string: `setSetting` is the canonical setter and it refuses what the
 * descriptor refuses.
 *
 * ⚠️ THE DESCRIPTOR TABLE LIVES HERE, NOT IN A SEPARATE MODULE, because the
 * admission boundary (lib/platform/admission/admission-boundary.test.ts) pins
 * that the two control-plane keys appear only in this registry and the fact
 * adapter. The SHAPE and the validation engine are pure and live in
 * lib/platform/settings/descriptor.core.ts.
 */

import { db } from "@/lib/db";
import { resolveConditionalWrite } from "@/lib/db/conditional-write";
import type { PrismaClient } from "@prisma/client";
import {
  DEFAULT_REFRESH_CADENCE, REFRESH_CADENCES, REFRESH_CADENCE_SETTING_KEY,
  type RefreshCadence, type RefreshSourceKind,
} from "@/lib/platform/refresh-policy.core";
import { cadenceIsHonourable } from "@/lib/platform/scheduler-capability";
import { SCHEDULED_JOB_FACTS } from "@/lib/jobs/registry.core";
import { defaultCadenceHours } from "@/lib/jobs/cadence-policy.core";
import {
  PlatformSettingValidationError, descriptorsForSurface, validateSettingValue,
  type SettingDescriptor, type SettingValidation, type SettingWriteSurface,
} from "@/lib/platform/settings/descriptor.core";
import { ENTITLEMENT_DIMENSIONS } from "@/lib/entitlements/catalogue";
import { AI_COST_CONTROL_DEFAULTS, AI_SPEND_RULE_IDS } from "@/lib/platform/ai/cost-controls.types";
import {
  INVITATION_VALIDITY_DEFAULT_DAYS, INVITATION_VALIDITY_MAX_DAYS, INVITATION_VALIDITY_MIN_DAYS,
} from "@/lib/platform/growth/invitation-issue.core";

export { PlatformSettingValidationError } from "@/lib/platform/settings/descriptor.core";
export type { SettingDescriptor, SettingValidation, SettingWriteSurface, PolicyClass } from "@/lib/platform/settings/descriptor.core";

export const PlatformSettingKey = {
  REQUIRE_TOTP_SYSTEM_ADMIN: "require_totp_system_admin",
  // SEC-PLAT-1 — `require_totp_admins` ("Require 2FA for Space admins") was
  // REMOVED: since v2.0 (639e9a5) it was a key, a seed row and an admin toggle
  // with no enforcement consumer anywhere (pinned by the discovery-branch
  // characterization test). Operator MFA is now mandatory in code
  // (lib/auth-totp-policy.ts operatorTotpMissing), not a setting. A stale row
  // may remain in PlatformSetting; nothing reads it.
  REQUIRE_TOTP_ALL_USERS:    "require_totp_all_users",
  RECOVERY_CODES_ENABLED:    "recovery_codes_enabled",
  MIN_PASSWORD_LENGTH:       "min_password_length",
  // Wave 1 S2 — platform-wide registration gate, read at the top of the register
  // route. One key, three values (below): two booleans would admit a
  // contradictory fourth state (closed-but-invite-required).
  REGISTRATION_MODE:         "registration_mode",
  // PO-3C — the LAUNCH dimension, deliberately SEPARATE from registration_mode:
  // "how mature is the product" (development/beta/live) is a different axis from
  // "who may sign up" (open/invite_only/closed). Presentation/framing only — it
  // gates no behavior by itself; registration_mode remains the only signup gate.
  PRODUCT_STATUS:            "product_status",
  // OPS-2D-3 — the first CONTROL-PLANE facts: operator declarations about
  // whether operational work may begin, as opposed to every key above, which
  // configures how the product behaves for customers. Read only through
  // lib/platform/admission; no route reads them directly.
  //
  // Two keys, not one, because they answer different questions and an operator
  // needs to be able to say either without saying the other: "the platform is
  // under maintenance" is broader than "stop calling providers", and pausing
  // ingestion during a provider incident should not imply the product is down.
  //
  // Both ship absent, and absence means off — see policy-core.ts for why that
  // exception is bounded to never-configured and not extended to unreadable.
  MAINTENANCE_MODE:          "maintenance_mode",
  INGESTION_PAUSED:          "ingestion_paused",
  // Expected refresh cadence per source kind — policy that source health judges
  // "overdue" against. Read only through lib/platform/refresh-policy.ts; the
  // enum, grace and defaults live in refresh-policy.core.ts.
  REFRESH_CADENCE_BANK:      REFRESH_CADENCE_SETTING_KEY.BANK,
  REFRESH_CADENCE_WALLET:    REFRESH_CADENCE_SETTING_KEY.WALLET,
  // P1 HUMAN OPERABILITY — per-job EXECUTION cadence for the jobs that are not
  // governed by a refresh policy and are not fixed: hours between runs, bounded
  // by the registry's code-owned min/max (lib/jobs/registry.core.ts `cadence`).
  // Read only through lib/jobs/cadence-policy.ts; written only through
  // lib/platform/policies/job-cadence.ts behind CONTROL, with a reason.
  JOB_CADENCE_FX:            "job_cadence_hours_fetch-fx-rates",
  JOB_CADENCE_PRICES:        "job_cadence_hours_fetch-security-prices",
  JOB_CADENCE_ALERTS:        "job_cadence_hours_evaluate-alerts",
  JOB_CADENCE_SOL_BACKFILL:  "job_cadence_hours_sol-history-backfill",
  // BETA C7 — the two spend-alert thresholds the `ai-spend-fleet-high` and
  // `ai-spend-user-high` rules judge against (estimated USD over the trailing
  // 24 h, priced by the code-owned rate card). Whole dollars; read only through
  // lib/alerts; written through the validated setting path behind CONTROL
  // (AI COST CONTROLS: lib/platform/ai/cost-controls.ts). Provisional values
  // set by the owner on 2026-10-15: fleet $10, per customer $3.
  AI_SPEND_ALERT_FLEET_USD:  "ai_spend_alert_fleet_usd_24h",
  AI_SPEND_ALERT_USER_USD:   "ai_spend_alert_user_usd_24h",
  // AI COST CONTROLS (2026-10-15) — the five keys behind the remaining operator
  // controls (lib/platform/ai/cost-controls.types.ts is the frozen contract):
  //   · ai_daily_allowance_enforced   whether ALLOWANCE_EXHAUSTED is refused at
  //                                   all (pricing validation stays either way);
  //   · ai_daily_allowance_usd        the PLATFORM value of the per-customer
  //                                   daily allowance, between policy and overlay
  //                                   in precedence, bounded by the catalogue
  //                                   ceiling (derived, never hand-copied);
  //   · alert_rule_enabled:<rule>     the alert engine's own enabled-override
  //                                   convention (lib/alerts/evaluate.ts
  //                                   alertEnabledKey) for the two spend rules,
  //                                   registered so they validate and audit like
  //                                   every other key;
  //   · ai_paid_requests_paused       the kill switch. ABSENT_MEANS_OFF and an
  //                                   unreadable row DENIES (the admission-fact
  //                                   idiom, lib/platform/ai/paid-requests-admission.ts).
  // Read only through lib/platform/ai; written only by the cost-controls
  // mutation service behind CONTROL, with a reason. Reset = delete.
  AI_DAILY_ALLOWANCE_ENFORCED: "ai_daily_allowance_enforced",
  AI_DAILY_ALLOWANCE_USD:      "ai_daily_allowance_usd",
  ALERT_RULE_ENABLED_AI_SPEND_USER_HIGH:  "alert_rule_enabled:ai-spend-user-high",
  ALERT_RULE_ENABLED_AI_SPEND_FLEET_HIGH: "alert_rule_enabled:ai-spend-fleet-high",
  AI_PAID_REQUESTS_PAUSED:     "ai_paid_requests_paused",
  // PR B (2026-10-31) — how long a NEW beta invitation stays redeemable, in
  // whole days (1–30, default 7). Read and written only through
  // lib/platform/growth/invitation-policy.ts (GROWTH_REVENUE WRITE, a reason,
  // optimistic version, audit in the same transaction); every issuance path
  // (approve, direct invite, resend) takes its expiry from it. Changing it
  // never alters an invitation already issued — that is the audited Extend.
  BETA_INVITATION_VALIDITY_DAYS: "beta_invitation_validity_days",
  // R2 (2026-10-31) — the GLOBAL ceiling on public beta-access submissions per
  // fixed UTC hour, across all callers (app/api/access-request). Integer
  // 10–1000, default 60. Read per request by getBetaIntakeGlobalLimitPerHour()
  // (an unreadable or invalid value ⇒ the default, so a settings outage can
  // neither close nor unbound the intake). GROWTH_REVENUE WRITE, resettable.
  BETA_INTAKE_GLOBAL_LIMIT_PER_HOUR: "beta_intake_global_limit_per_hour",
  // BETA LIFECYCLE L2 (owner ruling 2026-10-31) — the GLOBAL cost freeze. While
  // "true", no operation that can incur a provider charge may start: every
  // policy group reads as cost-frozen (folded in by the policy-group catalogue
  // loader) and platform-wide vendor jobs refuse before the vendor call. Absence
  // is off; an unreadable value FREEZES. Read only through lib/platform/cost-freeze*.ts
  // and the catalogue loader; written through the validated setter behind
  // CONTROL (scripts/set-platform-setting.ts until an operator surface exists).
  PLATFORM_COST_FROZEN: "platform_cost_frozen",
} as const;

/** Bounds + default of beta_intake_global_limit_per_hour (owner ruling, R2). */
export const BETA_INTAKE_GLOBAL_LIMIT_DEFAULT = 60;
export const BETA_INTAKE_GLOBAL_LIMIT_MIN = 10;
export const BETA_INTAKE_GLOBAL_LIMIT_MAX = 1000;

export type PlatformSettingKeyType = typeof PlatformSettingKey[keyof typeof PlatformSettingKey];

/**
 * The three registration modes (registration_mode setting):
 *   open        — anyone may register (an explicit operator act; see
 *                 DEFAULT_REGISTRATION_MODE — the absent-row default is invite_only).
 *   invite_only — registration requires a valid beta-access invite token (S3).
 *   closed      — registration is disabled entirely (403 before any validation).
 */
export const REGISTRATION_MODES = ["open", "invite_only", "closed"] as const;

/**
 * SEC-008 — the mode an ABSENT or UNRECOGNISED `registration_mode` row means.
 * `invite_only`, never `open`: a deployment whose row has not been written yet
 * (a fresh Production database) or has been corrupted must fail CLOSED to
 * public sign-up. Opening registration is an explicit operator act that writes
 * the row. lib/registration-policy.ts and the register route both resolve the
 * mode through getRegistrationMode(), so this one constant is the whole default.
 */
export const DEFAULT_REGISTRATION_MODE = "invite_only" as const satisfies RegistrationMode;
export type RegistrationMode = typeof REGISTRATION_MODES[number];

/**
 * Product maturity (product_status setting) — the LAUNCH axis, orthogonal to
 * registration_mode. It frames the platform ("we're in beta") without gating
 * signup ("who may register"). A team can be `beta` + `open` (public beta) or
 * `live` + `invite_only` (soft launch); the two never collapse into one control.
 */
export const PRODUCT_STATUSES = ["development", "beta", "live"] as const;
export type ProductStatus = typeof PRODUCT_STATUSES[number];

/** Defaults if the row doesn't exist yet (migration seeds these, but be safe). */
const DEFAULTS: Record<PlatformSettingKeyType, string> = {
  require_totp_system_admin: "false",
  require_totp_all_users:    "false",
  recovery_codes_enabled:    "true",
  min_password_length:       "8",
  // SEC-008 — ships `invite_only`. A fresh database (Production after cutover,
  // before the setting row is written) must NOT accept public sign-up with a
  // no-op CAPTCHA; an operator opens registration deliberately by writing the
  // row (scripts/set-platform-setting.ts --key registration_mode --value open).
  registration_mode:         DEFAULT_REGISTRATION_MODE,
  // Ships `beta` — honest current maturity; changed only when the operator flips it.
  product_status:            "beta",
  // OPS-2D-3 — both ship OFF. Nothing about existing behaviour changes until an
  // operator declares otherwise. Note these defaults are documentation of the
  // contract, not the admission path's fallback: the admission resolver reads
  // the row itself so it can tell MISSING from INVALID, which getSetting()'s
  // `?? DEFAULTS[key]` deliberately collapses.
  maintenance_mode:          "false",
  ingestion_paused:          "false",
  refresh_cadence_bank:      DEFAULT_REFRESH_CADENCE.BANK,
  refresh_cadence_wallet:    DEFAULT_REFRESH_CADENCE.WALLET,
  "job_cadence_hours_fetch-fx-rates":        String(jobCadenceDefault("fetch-fx-rates")),
  "job_cadence_hours_fetch-security-prices": String(jobCadenceDefault("fetch-security-prices")),
  "job_cadence_hours_evaluate-alerts":       String(jobCadenceDefault("evaluate-alerts")),
  "job_cadence_hours_sol-history-backfill":  String(jobCadenceDefault("sol-history-backfill")),
  // AI COST CONTROLS — every default is the frozen contract's, never retyped here.
  ai_spend_alert_fleet_usd_24h: String(AI_COST_CONTROL_DEFAULTS["fleetAlert.thresholdUsd"]),
  ai_spend_alert_user_usd_24h:  String(AI_COST_CONTROL_DEFAULTS["userAlert.thresholdUsd"]),
  ai_daily_allowance_enforced:  String(AI_COST_CONTROL_DEFAULTS["allowance.enforced"]),
  ai_daily_allowance_usd:       String(AI_COST_CONTROL_DEFAULTS["allowance.usd"]),
  "alert_rule_enabled:ai-spend-user-high":  String(AI_COST_CONTROL_DEFAULTS["userAlert.enabled"]),
  "alert_rule_enabled:ai-spend-fleet-high": String(AI_COST_CONTROL_DEFAULTS["fleetAlert.enabled"]),
  // Ships OFF, and absence IS off (ABSENT_MEANS_OFF): the default documents the
  // contract; the admission reader tells MISSING from INVALID itself.
  ai_paid_requests_paused:      String(AI_COST_CONTROL_DEFAULTS["killSwitch.paused"]),
  // Owner ruling 2026-10-31: 7 calendar days (the bounds live beside the issuance rules).
  beta_invitation_validity_days: String(INVITATION_VALIDITY_DEFAULT_DAYS),
  beta_intake_global_limit_per_hour: String(BETA_INTAKE_GLOBAL_LIMIT_DEFAULT),
  // Ships OFF, and absence IS off (ABSENT_MEANS_OFF) — lib/platform/cost-freeze.core.ts.
  platform_cost_frozen: "false",
};

/** The catalogue ceiling of the per-customer daily allowance — the platform value's upper bound, derived. */
export const AI_DAILY_ALLOWANCE_CEILING_USD: number = ENTITLEMENT_DIMENSIONS.aiDailyUsdAllowance.ceiling;

/** The registry-derived default and bounds for an editable job's cadence. */
function jobCadenceFacts(name: string): { defaultHours: number; minHours: number; maxHours: number } {
  const job = SCHEDULED_JOB_FACTS.find((j) => j.name === name);
  if (!job?.cadence) throw new Error(`[platform-settings] ${name} has no editable cadence in the registry`);
  return { defaultHours: defaultCadenceHours(job), minHours: job.cadence.minHours, maxHours: job.cadence.maxHours };
}
function jobCadenceDefault(name: string): number { return jobCadenceFacts(name).defaultHours; }

// ── Descriptors — one per key; the shape is descriptor.core.ts ────────────────

type Descriptor = SettingDescriptor<PlatformSettingKeyType>;

const security = (
  key: PlatformSettingKeyType, label: string, description: string,
  over: Partial<Descriptor> = {},
): Descriptor => ({
  key, label, description,
  class: "SECURITY_SENSITIVE", valueType: "boolean", default: DEFAULTS[key],
  missingRow: "FALLBACK_TO_DEFAULT",
  writeSurfaces: ["ADMIN_SECURITY"], writeCapability: "SYSTEM_ADMIN",
  operatorConfigurable: false, resettable: false,
  ...over,
});

const refreshCadence = (sourceKind: RefreshSourceKind, label: string, description: string): Descriptor => ({
  key: REFRESH_CADENCE_SETTING_KEY[sourceKind], label, description,
  class: "OPERATOR_CONFIGURABLE", valueType: "enum", allowedValues: REFRESH_CADENCES,
  default: DEFAULT_REFRESH_CADENCE[sourceKind], missingRow: "FALLBACK_TO_DEFAULT",
  // Gate: control-plane-policy (lib/platform/capability-classification.ts).
  // The one application writer is lib/platform/policies/mutate.ts, behind CONTROL.
  writeSurfaces: ["PLATFORM_OPS"], writeCapability: "CONTROL",
  operatorConfigurable: true, resettable: true,
  // The scheduler-honourability rule, from the ONE derived authority. A cadence
  // the deployed slots cannot deliver is refused at the setter, never stored and
  // degraded — see refresh-policy.core.ts assessCadence.
  constraint: (v) => {
    const a = cadenceIsHonourable(sourceKind, v as RefreshCadence);
    return a.honourable ? null : a.reason;
  },
});

const jobCadence = (key: PlatformSettingKeyType, jobName: string, label: string, description: string): Descriptor => {
  const facts = jobCadenceFacts(jobName);
  return {
    key, label, description,
    class: "OPERATOR_CONFIGURABLE", valueType: "integer", min: facts.minHours, max: facts.maxHours,
    default: String(facts.defaultHours), missingRow: "FALLBACK_TO_DEFAULT",
    // The one application writer is lib/platform/policies/job-cadence.ts, behind CONTROL, with a reason.
    writeSurfaces: ["PLATFORM_OPS"], writeCapability: "CONTROL",
    operatorConfigurable: true, resettable: true,
  };
};

const admissionFact = (key: PlatformSettingKeyType, label: string, description: string): Descriptor => ({
  key, label, description,
  class: "OPERATOR_CONFIGURABLE", valueType: "boolean", default: DEFAULTS[key],
  // Absence is OFF by contract (policy-core.ts); an explicit "false" row is
  // equivalent, and reset = delete returns to the never-configured state.
  missingRow: "ABSENT_MEANS_OFF",
  writeSurfaces: ["PLATFORM_OPS"], writeCapability: "CONTROL",
  operatorConfigurable: true, resettable: true,
});

/**
 * AI COST CONTROLS — an operator-configurable boolean written only by the
 * cost-controls mutation service behind CONTROL. `missingRow` is the one thing
 * that differs between them: the enforcement flag and the two alert-enabled
 * keys FALL BACK to their default (an invalid row ⇒ enforced / enabled), while
 * the kill switch is an admission fact (absence is OFF; an unreadable row
 * denies — judged by lib/platform/ai/paid-requests-admission.ts).
 */
const aiCostBoolean = (
  key: PlatformSettingKeyType, label: string, description: string,
  missingRow: Descriptor["missingRow"] = "FALLBACK_TO_DEFAULT",
): Descriptor => ({
  key, label, description,
  class: "OPERATOR_CONFIGURABLE", valueType: "boolean", default: DEFAULTS[key],
  missingRow,
  writeSurfaces: ["PLATFORM_OPS"], writeCapability: "CONTROL",
  operatorConfigurable: true, resettable: true,
});

/**
 * THE descriptor table. Exhaustive by type: a new key without a descriptor is a
 * compile error, so nothing can be written that was never described.
 */
export const SETTING_DESCRIPTORS: Readonly<Record<PlatformSettingKeyType, Descriptor>> = {
  require_totp_system_admin: security(
    "require_totp_system_admin", "Require 2FA for system administrators",
    "Locked on. A SYSTEM_ADMIN session always requires TOTP.",
    { constraint: (v) => (v === "true" ? null : "require_totp_system_admin cannot be disabled. SYSTEM_ADMIN accounts must always use 2FA.") },
  ),
  require_totp_all_users: security(
    "require_totp_all_users", "Require 2FA for all users", "All users must set up 2FA before accessing the dashboard.",
  ),
  recovery_codes_enabled: security(
    "recovery_codes_enabled", "Recovery codes enabled", "Users can generate one-time backup codes as a 2FA fallback.",
  ),
  min_password_length: security(
    "min_password_length", "Minimum password length", "Enforced at registration and every password change. Never below 8.",
    { valueType: "integer", min: 8 },
  ),
  registration_mode: security(
    "registration_mode", "Registration mode", "Who may sign up: open, invite_only or closed.",
    { valueType: "enum", allowedValues: REGISTRATION_MODES, writeSurfaces: ["ADMIN_SECURITY", "GROWTH_REVENUE"], writeCapability: "WRITE" },
  ),
  product_status: {
    key: "product_status", label: "Product status", description: "Launch maturity shown to customers: development, beta or live. Gates nothing.",
    class: "OPERATOR_CONFIGURABLE", valueType: "enum", allowedValues: PRODUCT_STATUSES,
    default: DEFAULTS.product_status, missingRow: "FALLBACK_TO_DEFAULT",
    writeSurfaces: ["GROWTH_REVENUE"], writeCapability: "WRITE",
    operatorConfigurable: true, resettable: false,
  },
  maintenance_mode: admissionFact(
    "maintenance_mode", "Maintenance mode",
    "While on, no refresh execution, no new connection and no paid AI request may begin. An unreadable value also denies work.",
  ),
  ingestion_paused: admissionFact(
    "ingestion_paused", "Ingestion paused",
    "While on, no refresh execution may begin; connections may still be established.",
  ),
  refresh_cadence_bank: refreshCadence(
    "BANK", "Bank refresh cadence",
    "How often every bank connection is expected to refresh. Source health judges a bank overdue past this cadence plus grace.",
  ),
  refresh_cadence_wallet: refreshCadence(
    "WALLET", "Wallet refresh cadence",
    "How often every wallet is expected to refresh. The scheduled sweep attempts a wallet once it is due under this cadence.",
  ),
  "job_cadence_hours_fetch-fx-rates": jobCadence(
    "job_cadence_hours_fetch-fx-rates", "fetch-fx-rates", "FX rates cadence (hours)",
    "Hours between FX archive fetches. The archive closes daily, so the floor keeps fetches from being waste.",
  ),
  "job_cadence_hours_fetch-security-prices": jobCadence(
    "job_cadence_hours_fetch-security-prices", "fetch-security-prices", "Security prices cadence (hours)",
    "Hours between historical security-price fetches (vendor-gated; a no-op until a price vendor is keyed).",
  ),
  "job_cadence_hours_evaluate-alerts": jobCadence(
    "job_cadence_hours_evaluate-alerts", "evaluate-alerts", "Alert evaluation cadence (hours)",
    "Hours between alert passes over the health authorities. Re-notification is suppressed for 20 hours, so a tighter cadence costs reads, not mail.",
  ),
  "job_cadence_hours_sol-history-backfill": jobCadence(
    "job_cadence_hours_sol-history-backfill", "sol-history-backfill", "Solana history backfill cadence (hours)",
    "Hours between background Solana history runs when no work was deferred, so a newly connected wallet starts promptly. While wallets remain the job continues every ~15 minutes regardless. A run with nothing to do sends no provider request: it records its JobRun and makes a few indexed reads (the wake's start, the Solana wallet list, today's provider usage and, for wallets with history, a batched revaluation check). The daily request cap still bounds provider cost.",
  ),
  ai_spend_alert_fleet_usd_24h: {
    key: "ai_spend_alert_fleet_usd_24h", label: "AI spend alert — fleet (USD / 24 h)",
    description: `Estimated AI spend across every customer surface in the trailing 24 h at or above which the ${AI_SPEND_RULE_IDS.fleet} rule fires. Whole dollars.`,
    class: "OPERATOR_CONFIGURABLE", valueType: "integer", min: 1, max: 100000,
    default: DEFAULTS.ai_spend_alert_fleet_usd_24h, missingRow: "FALLBACK_TO_DEFAULT",
    writeSurfaces: ["PLATFORM_OPS"], writeCapability: "CONTROL",
    operatorConfigurable: true, resettable: true,
  },
  ai_spend_alert_user_usd_24h: {
    key: "ai_spend_alert_user_usd_24h", label: "AI spend alert — per customer (USD / 24 h)",
    description: `Estimated AI spend one customer caused in the trailing 24 h at or above which the ${AI_SPEND_RULE_IDS.user} rule fires. Whole dollars.`,
    class: "OPERATOR_CONFIGURABLE", valueType: "integer", min: 1, max: 10000,
    default: DEFAULTS.ai_spend_alert_user_usd_24h, missingRow: "FALLBACK_TO_DEFAULT",
    writeSurfaces: ["PLATFORM_OPS"], writeCapability: "CONTROL",
    operatorConfigurable: true, resettable: true,
  },
  // ── AI COST CONTROLS ────────────────────────────────────────────────────────
  ai_daily_allowance_enforced: aiCostBoolean(
    "ai_daily_allowance_enforced", "AI daily allowance enforced",
    "While on, a customer at or over their estimated daily AI allowance is refused their next Conversations turn or Daily Brief generation. While off, usage and estimated cost are still recorded and the spend alerts still fire; only the ALLOWANCE_EXHAUSTED refusal is withheld. An unpriceable model still refuses either way.",
  ),
  ai_daily_allowance_usd: {
    key: "ai_daily_allowance_usd", label: "AI daily allowance — platform value (USD / UTC day)",
    description: "The platform-wide estimated daily AI allowance per customer, in whole dollars. Precedence: a per-customer override, then an assigned overlay, then THIS value, then the policy group; the catalogue ceiling clamps last. Reset = the policy group's value is in force again.",
    class: "OPERATOR_CONFIGURABLE", valueType: "integer", min: 1, max: AI_DAILY_ALLOWANCE_CEILING_USD,
    default: DEFAULTS.ai_daily_allowance_usd, missingRow: "FALLBACK_TO_DEFAULT",
    writeSurfaces: ["PLATFORM_OPS"], writeCapability: "CONTROL",
    operatorConfigurable: true, resettable: true,
  },
  "alert_rule_enabled:ai-spend-user-high": aiCostBoolean(
    "alert_rule_enabled:ai-spend-user-high", "Per-customer AI spend alert enabled",
    `Whether the ${AI_SPEND_RULE_IDS.user} rule is evaluated. Disabling it changes evaluation only: the spend fold, the ledger and the Economics figures keep running.`,
  ),
  "alert_rule_enabled:ai-spend-fleet-high": aiCostBoolean(
    "alert_rule_enabled:ai-spend-fleet-high", "Fleet AI spend alert enabled",
    `Whether the ${AI_SPEND_RULE_IDS.fleet} rule (fleet spend + the unpriced-coverage warning) is evaluated. Disabling it changes evaluation only: the spend fold, the ledger and the Economics figures keep running.`,
  ),
  ai_paid_requests_paused: aiCostBoolean(
    "ai_paid_requests_paused", "Paid AI requests paused",
    "While on, every new paid AI request — Conversations, the Daily Brief and harness runs — is refused before the allowance is judged and before the provider is reached. No override lifts it. Absence is off; an unreadable value also refuses.",
    "ABSENT_MEANS_OFF",
  ),
  beta_invitation_validity_days: {
    key: "beta_invitation_validity_days", label: "Beta invitation validity (days)",
    description: `How many days a NEW beta invitation stays redeemable — approve, direct invite and resend alike — unless the operator chooses a different validity for that one invitation. Whole days, ${INVITATION_VALIDITY_MIN_DAYS}–${INVITATION_VALIDITY_MAX_DAYS}. Changing it never alters invitations already issued; extending one of those is a separate, audited action.`,
    class: "OPERATOR_CONFIGURABLE", valueType: "integer", min: INVITATION_VALIDITY_MIN_DAYS, max: INVITATION_VALIDITY_MAX_DAYS,
    default: DEFAULTS.beta_invitation_validity_days, missingRow: "FALLBACK_TO_DEFAULT",
    writeSurfaces: ["GROWTH_REVENUE"], writeCapability: "WRITE",
    operatorConfigurable: true, resettable: true,
  },
  beta_intake_global_limit_per_hour: {
    key: "beta_intake_global_limit_per_hour", label: "Beta intake global limit (requests / hour)",
    description: `The most beta-access requests accepted per UTC hour across ALL visitors (after the CAPTCHA). Further requests that hour get a "too many requests" response, and the hour is recorded once as BETA_INTAKE_THROTTLED. Whole numbers, ${BETA_INTAKE_GLOBAL_LIMIT_MIN}–${BETA_INTAKE_GLOBAL_LIMIT_MAX}. Per-IP and per-address limits are separate and unchanged.`,
    class: "OPERATOR_CONFIGURABLE", valueType: "integer", min: BETA_INTAKE_GLOBAL_LIMIT_MIN, max: BETA_INTAKE_GLOBAL_LIMIT_MAX,
    default: DEFAULTS.beta_intake_global_limit_per_hour, missingRow: "FALLBACK_TO_DEFAULT",
    writeSurfaces: ["GROWTH_REVENUE"], writeCapability: "WRITE",
    operatorConfigurable: true, resettable: true,
  },
  platform_cost_frozen: {
    key: "platform_cost_frozen", label: "Global cost freeze",
    description: "While on, no operation that can incur a provider charge may start — for any customer (every policy group reads as cost-frozen, whatever its own state) and platform-wide (market data, historical prices, FX refreshes, crypto price steps). Stored data, exports and existing Briefs stay readable; refused work is recorded as skipped, never completed. Absence is off; an unreadable value also freezes.",
    class: "OPERATOR_CONFIGURABLE", valueType: "boolean", default: DEFAULTS.platform_cost_frozen,
    missingRow: "ABSENT_MEANS_OFF",
    writeSurfaces: ["PLATFORM_OPS"], writeCapability: "CONTROL",
    operatorConfigurable: true, resettable: true,
  },
};

export function listSettingDescriptors(): Descriptor[] {
  return Object.values(SETTING_DESCRIPTORS);
}

export function getSettingDescriptor(key: PlatformSettingKeyType): Descriptor {
  return SETTING_DESCRIPTORS[key];
}

/** The keys a given surface may write — derived from the descriptors, never listed twice. */
export function settingKeysForSurface(surface: SettingWriteSurface): PlatformSettingKeyType[] {
  return descriptorsForSurface(listSettingDescriptors(), surface).map((d) => d.key);
}

/** True for a registered key (the typed API requires registration). */
export function isPlatformSettingKey(key: unknown): key is PlatformSettingKeyType {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(SETTING_DESCRIPTORS, key);
}

/** Validate without writing — the same rule the setter applies. */
export function validateSetting(key: PlatformSettingKeyType, raw: unknown): SettingValidation {
  return validateSettingValue(SETTING_DESCRIPTORS[key], raw);
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/** Read all platform settings as a key→value map. */
export async function getAllSettings(): Promise<Record<string, string>> {
  const rows = await db.platformSetting.findMany();
  const map: Record<string, string> = { ...DEFAULTS };
  for (const row of rows) map[row.key] = row.value;
  return map;
}

/** Read a single setting value (falls back to default). */
export async function getSetting(key: PlatformSettingKeyType): Promise<string> {
  const row = await db.platformSetting.findUnique({ where: { key } });
  return row?.value ?? DEFAULTS[key];
}

/**
 * The admin-configurable minimum password length, as an integer (SEC-4).
 *
 * Single source of truth for password-length enforcement: registration and
 * every password-set/change path read THIS instead of a hardcoded literal, so
 * the admin policy (min_password_length PlatformSetting) and actual enforcement
 * can never silently diverge. Floored at 8 (the historical minimum and the
 * admin UI's own lower bound) so a malformed/blank row can never weaken the
 * policy below the baseline. Defaults to 8 when unset or non-numeric.
 */
export async function getMinPasswordLength(): Promise<number> {
  const raw = await getSetting(PlatformSettingKey.MIN_PASSWORD_LENGTH);
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? Math.max(8, n) : 8;
}

/**
 * The current platform registration mode (Wave 1 S2). SEC-008 — falls back to
 * DEFAULT_REGISTRATION_MODE (`invite_only`) for an unset row or any
 * unrecognised value. This used to fall back to `open` "so a malformed row can
 * never lock users out" — which meant a fresh database accepted public sign-up
 * with a no-op CAPTCHA (runtime-confirmed: 201 with no invite). A security
 * control fails CLOSED: a missing or corrupt row steers visitors to
 * request-access, and an operator writes the row to open registration.
 */
export async function getRegistrationMode(): Promise<RegistrationMode> {
  const raw = await getSetting(PlatformSettingKey.REGISTRATION_MODE);
  return (REGISTRATION_MODES as readonly string[]).includes(raw)
    ? (raw as RegistrationMode)
    : DEFAULT_REGISTRATION_MODE;
}

/**
 * R2 — the global access-request ceiling per UTC hour. Validated through the
 * descriptor (10–1000 integers); a missing, invalid or UNREADABLE value
 * (store error) yields the default — the intake neither closes nor becomes
 * unbounded because the settings read failed. Uncached: one primary-key read
 * per request, the same posture as getRegistrationMode().
 */
export async function getBetaIntakeGlobalLimitPerHour(): Promise<number> {
  try {
    const raw = await getSetting(PlatformSettingKey.BETA_INTAKE_GLOBAL_LIMIT_PER_HOUR);
    const v = validateSettingValue(SETTING_DESCRIPTORS.beta_intake_global_limit_per_hour, raw);
    return v.ok ? Number.parseInt(v.value, 10) : BETA_INTAKE_GLOBAL_LIMIT_DEFAULT;
  } catch (err) {
    console.error("[platform-settings] beta_intake_global_limit_per_hour unreadable — using the default:", err instanceof Error ? err.message : err);
    return BETA_INTAKE_GLOBAL_LIMIT_DEFAULT;
  }
}

/** The current product maturity (PO-3C). Falls back to `beta` for an unset or
 *  unrecognized value — the honest current stage, never a silent "live". */
export async function getProductStatus(): Promise<ProductStatus> {
  const raw = await getSetting(PlatformSettingKey.PRODUCT_STATUS);
  return (PRODUCT_STATUSES as readonly string[]).includes(raw)
    ? (raw as ProductStatus)
    : "beta";
}

// ── Writes — the canonical, validated seam ────────────────────────────────────

/** The narrow client the write primitives need — the root client or a transaction client. */
export type SettingWriteClient = Pick<PrismaClient, "platformSetting">;

/**
 * PLATFORM OPS POLICIES (Slice 2) — CONDITIONAL primitives for the policy
 * mutation service (lib/platform/policies/mutate.ts). Each is validated by the
 * same descriptor rule as `setSetting`, takes a transaction-capable client, and
 * is CONDITIONAL on the row version the caller observed, so a concurrent change
 * is refused rather than overwritten:
 *
 *   createSettingIfAbsent   the caller observed NO row; a row appearing in the
 *                           meantime is a unique-key violation ⇒ false.
 *   updateSettingIfVersion  the caller observed `expectedUpdatedAt`; the update
 *                           is predicated on it ⇒ 0 rows ⇒ false.
 *   deleteSettingIfVersion  reset, predicated the same way ⇒ 0 rows ⇒ false.
 *
 * `updatedAt` is the version token (Prisma @updatedAt; no version column).
 * These stay in THIS file so PlatformSetting keeps exactly one writer module.
 *
 * ⚠️ RLS-C-S6a — `false` MEANS CONTENTION, SO IT MUST NOT ALSO MEAN REFUSED.
 * The two conditional primitives below returned `count === 1`, and the policy
 * editor renders a `false` as "This policy changed since you opened the editor"
 * — a 409 the operator is expected to resolve by reloading and trying again. A
 * zero row count from a policy refusal would render as that same sentence:
 * loud, specific, actionable, and a lie, which sends the operator in a loop
 * against a write that cannot ever succeed. Both now resolve the zero against
 * the row's VISIBILITY first and raise IndeterminateWriteError when the row
 * cannot be seen. That propagates out of mutate.ts's transaction — it is
 * neither a PolicyConflict nor a validation refusal, so the service's `catch`
 * rethrows it — and surfaces as a 500 the operator can escalate instead of a
 * 409 they cannot clear.
 *
 * ⚠️ THE DELETE CASE IS GENUINELY AMBIGUOUS, AND WE CHOOSE LOUD ON PURPOSE.
 * For `deleteSettingIfVersion` an invisible row has a THIRD innocent reading: a
 * concurrent operator already reset the override, which really is the conflict
 * the 409 describes. It is indistinguishable from a refusal, and only one of the
 * two is safe to be calm about, so the ambiguity resolves to the error. The cost
 * is a rare noisy 500 on a double reset; the alternative is a silent, permanent
 * phantom conflict. (Both callers in lib/platform/policies/mutate.ts read the
 * row inside the same transaction immediately before the write, so by the letter
 * of the rule their zero is already determinate — the probe stays because these
 * are EXPORTED primitives and the next caller may not read first.)
 */
export async function createSettingIfAbsent(
  client: SettingWriteClient,
  key: PlatformSettingKeyType,
  value: string,
  updatedById: string,
): Promise<boolean> {
  const v = validateSetting(key, value);
  if (!v.ok) throw new PlatformSettingValidationError(key, value, v.reason);
  try {
    await client.platformSetting.create({ data: { key, value: v.value, updatedById } });
    return true;
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") return false; // a row won the race
    throw err;
  }
}

export async function updateSettingIfVersion(
  client: SettingWriteClient,
  key: PlatformSettingKeyType,
  value: string,
  expectedUpdatedAt: Date,
  updatedById: string,
): Promise<boolean> {
  const v = validateSetting(key, value);
  if (!v.ok) throw new PlatformSettingValidationError(key, value, v.reason);
  const { count } = await client.platformSetting.updateMany({
    where: { key, updatedAt: expectedUpdatedAt },
    data:  { value: v.value, updatedById },
  });
  return resolveConditionalWrite(
    count,
    { table: "PlatformSetting", rowId: key, operation: "update" },
    () => client.platformSetting.count({ where: { key } }),
  );
}

export async function deleteSettingIfVersion(
  client: SettingWriteClient,
  key: PlatformSettingKeyType,
  expectedUpdatedAt: Date,
): Promise<boolean> {
  const d = SETTING_DESCRIPTORS[key];
  if (!d.resettable) throw new PlatformSettingValidationError(key, "", `${key} has no default to reset to; it must be set explicitly.`);
  const { count } = await client.platformSetting.deleteMany({ where: { key, updatedAt: expectedUpdatedAt } });
  return resolveConditionalWrite(
    count,
    { table: "PlatformSetting", rowId: key, operation: "delete" },
    () => client.platformSetting.count({ where: { key } }),
  );
}

/**
 * Write a setting value. THE ONLY application write path for PlatformSetting.
 * Validates against the key's descriptor first and throws
 * PlatformSettingValidationError on refusal — before any database call — so a
 * malformed admission flag or an unhonourable cadence can never be stored by a
 * route that merely knows the key string. The stored value is the NORMALISED
 * form ("true", "12h"), never the caller's raw text.
 */
export async function setSetting(
  key: PlatformSettingKeyType,
  value: string,
  updatedById?: string,
): Promise<void> {
  const v = validateSetting(key, value);
  if (!v.ok) throw new PlatformSettingValidationError(key, value, v.reason);
  await db.platformSetting.upsert({
    where:  { key },
    update: { value: v.value, updatedById: updatedById ?? null },
    create: { key, value: v.value, updatedById: updatedById ?? null },
  });
}

/**
 * Reset a setting to its default by DELETING the override row — never by
 * writing the default value, so `origin` stays DEFAULT and a later change to
 * the code default propagates. Only `resettable` descriptors allow it. Returns
 * true when a row was removed. No route calls this yet: it is the seam the
 * future policy editor's reset lands on.
 */
export async function deleteSetting(key: PlatformSettingKeyType): Promise<boolean> {
  const d = SETTING_DESCRIPTORS[key];
  if (!d.resettable) throw new PlatformSettingValidationError(key, "", `${key} has no default to reset to; it must be set explicitly.`);
  const { count } = await db.platformSetting.deleteMany({ where: { key } });
  return count > 0;
}
