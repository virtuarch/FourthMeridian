/**
 * lib/entitlements/catalogue.ts  (P1 HUMAN OPERABILITY — Policy Groups)
 *
 * WHAT A CUSTOMER MAY USE, AS VERSIONED DEFINITIONS IN CODE.
 *
 * Before this module the product's customer quotas were literals at six call
 * sites (a 60-minute Plaid cooldown, 10/min and 60/h Conversations windows,
 * 6/h wallet syncs, 3 exports/day …) and the only "super user" was
 * `role !== "SYSTEM_ADMIN"` at four of them — a role conditional that exempted an
 * account the role wall keeps out of the product, i.e. nobody. This catalogue is
 * the ONE place those numbers are declared, as three kinds of thing that must
 * never be confused:
 *
 *   PLATFORM CEILINGS   the hard bound nothing may exceed — provider safety,
 *                       economic abuse protection, the "stolen admin session"
 *                       bound. Code-owned, never assignable, never overridable.
 *   POLICY GROUPS       what a customer plan allows (BETA_FULL_ACCESS_V1).
 *   OVERLAYS            a named, code-owned set of per-dimension values an
 *                       operator may ASSIGN to one customer on top of their
 *                       policy — the explicit, audited Founder / Super User
 *                       override. An overlay is a catalogue entry, not a free
 *                       value, so what it grants is reviewable in this file.
 *
 * COHORT ≠ POLICY. Cohorts (CLOSED_BETA_2026) say why/how/when a customer is
 * part of a rollout population; they entitle nothing and are declared here only
 * so operator surfaces show a label and a definition.
 *
 * DOCTRINE: definitions in code, assignments as data (CustomerPolicyAssignment,
 * CustomerCohort), the effective value a read-time reduction (resolve.ts) with
 * deterministic precedence CEILING → POLICY → OVERLAY, clamped to the ceiling
 * last. "Unlimited" never appears: every count has a ceiling. Pure: no I/O.
 */

/** The dimensions a Policy Group speaks to. Each has a consumer in product code. */
export const ENTITLEMENT_DIMENSIONS = {
  /** Conversations surface available at all. Consumer: app/api/ai/chat. */
  conversations: { kind: "boolean", ceiling: true,
    label: "Conversations", description: "May open and use Conversations." },
  /** Daily Brief available at all. Consumer: app/api/brief/*. */
  dailyBrief: { kind: "boolean", ceiling: true,
    label: "Daily Brief", description: "May read and generate the Daily Brief." },
  /** Conversation turns per minute (abuse pacing). Consumer: app/api/ai/chat. */
  aiTurnsPerMinute: { kind: "count", ceiling: 30,
    label: "Conversation turns per minute", description: "Pacing window for Conversations." },
  /** Conversation turns per hour — the economic/stolen-session bound. Consumer: app/api/ai/chat. */
  aiTurnsPerHour: { kind: "count", ceiling: 60,
    label: "Conversation turns per hour", description: "Hourly bound on model calls a session may cause." },
  /** Minimum minutes between manual refreshes of one bank connection. Consumer: lib/plaid/refreshCooldown. */
  manualBankRefreshCooldownMinutes: { kind: "minutes-floor", ceiling: 15,
    label: "Bank refresh cooldown (minutes)", description: "How soon one bank connection may be manually refreshed again." },
  /** Manual wallet syncs per hour (shared-IP explorer protection). Consumer: app/api/accounts/[id]/sync. */
  manualWalletRefreshPerHour: { kind: "count", ceiling: 6,
    label: "Wallet syncs per hour", description: "Manual crypto wallet refreshes per hour." },
  /** Full data exports per day. Consumer: app/api/user/export. */
  exportsPerDay: { kind: "count", ceiling: 10,
    label: "Exports per day", description: "Full data exports per day." },
} as const;

export type EntitlementDimensionKey = keyof typeof ENTITLEMENT_DIMENSIONS;
export type EntitlementKind = (typeof ENTITLEMENT_DIMENSIONS)[EntitlementDimensionKey]["kind"];
export type EntitlementValue = boolean | number;
export type EntitlementValues = { readonly [K in EntitlementDimensionKey]: (typeof ENTITLEMENT_DIMENSIONS)[K]["ceiling"] extends boolean ? boolean : number };
export type PartialEntitlementValues = Partial<EntitlementValues>;

export const DIMENSION_KEYS = Object.keys(ENTITLEMENT_DIMENSIONS) as EntitlementDimensionKey[];

// ── Policy Groups ─────────────────────────────────────────────────────────────

export interface PolicyGroupDefinition {
  key: string;
  label: string;
  description: string;
  /** ISO date the definition took effect (a definition is versioned by its key). */
  effectiveFrom: string;
  values: EntitlementValues;
}

/** The first consumer-beta entitlement policy. Today's literals, named. */
export const BETA_FULL_ACCESS_V1: PolicyGroupDefinition = {
  key: "BETA_FULL_ACCESS_V1",
  label: "Beta — full access (v1)",
  description:
    "The first consumer-beta policy: every shipped surface, at the product's established pacing. " +
    "No customer-plan quota beyond the platform ceilings except the three-per-day export and the one-hour bank refresh cooldown.",
  effectiveFrom: "2026-10-08",
  values: {
    conversations: true,
    dailyBrief: true,
    aiTurnsPerMinute: 10,
    aiTurnsPerHour: 60,
    manualBankRefreshCooldownMinutes: 60,
    manualWalletRefreshPerHour: 6,
    exportsPerDay: 3,
  },
};

export const POLICY_GROUPS: Readonly<Record<string, PolicyGroupDefinition>> = {
  [BETA_FULL_ACCESS_V1.key]: BETA_FULL_ACCESS_V1,
};

/** What a customer with NO assignment row resolves to (reported as unassigned). */
export const DEFAULT_POLICY_GROUP = BETA_FULL_ACCESS_V1.key;

// ── Overlays (the explicit Founder / Super User override) ─────────────────────

export interface OverlayDefinition {
  key: string;
  label: string;
  description: string;
  effectiveFrom: string;
  /** Only the dimensions the overlay changes. Every value is still clamped to the ceiling. */
  values: PartialEntitlementValues;
}

/**
 * The founder / internal power-user overlay: customer-plan quotas lifted to the
 * platform ceilings for dogfooding and testing. It changes NOTHING that is a
 * ceiling (the 60/h Conversations bound, the 6/h wallet syncs) — those are the
 * safety limits an override exists under, not above.
 */
export const FOUNDER_INTERNAL_V1: OverlayDefinition = {
  key: "FOUNDER_INTERNAL_V1",
  label: "Founder / internal (v1)",
  description:
    "Internal power-user overlay: plan quotas raised to the platform ceilings for dogfooding and testing. " +
    "Subject to every provider, security and economic ceiling; assignable only from Customer Success with a reason.",
  effectiveFrom: "2026-10-08",
  values: {
    aiTurnsPerMinute: 30,
    manualBankRefreshCooldownMinutes: 15,
    exportsPerDay: 10,
  },
};

export const OVERLAYS: Readonly<Record<string, OverlayDefinition>> = {
  [FOUNDER_INTERNAL_V1.key]: FOUNDER_INTERNAL_V1,
};

// ── Cohorts (rollout populations — entitle nothing) ───────────────────────────

export interface CohortDefinition {
  key: string;
  label: string;
  description: string;
  /** How a customer normally enters it. */
  entry: "INVITE" | "OPERATOR";
}

export const CLOSED_BETA_2026: CohortDefinition = {
  key: "CLOSED_BETA_2026",
  label: "Closed beta 2026",
  description: "The invite-only consumer beta population of 2026. Entered by redeeming a beta invitation.",
  entry: "INVITE",
};

export const COHORTS: Readonly<Record<string, CohortDefinition>> = {
  [CLOSED_BETA_2026.key]: CLOSED_BETA_2026,
};

/** The cohort a redeemed beta invitation places a new customer in. */
export const INVITE_COHORT = CLOSED_BETA_2026.key;

// ── Lookups ───────────────────────────────────────────────────────────────────

export function isPolicyGroupKey(v: unknown): v is string { return typeof v === "string" && v in POLICY_GROUPS; }
export function isOverlayKey(v: unknown): v is string { return typeof v === "string" && v in OVERLAYS; }
export function isCohortKey(v: unknown): v is string { return typeof v === "string" && v in COHORTS; }
