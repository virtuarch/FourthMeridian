/**
 * lib/notifications/automations/rules.ts  (Comms Center B2 — the PURE rules)
 *
 * Everything the automation surface decides without I/O, so the HTTP layer,
 * the store, the dry run and the live engine all use the SAME functions:
 *
 *   validateAutomationInput   the write body against the closed sets (v1 §4.10, §5;
 *                             v1.1 §6.1): no copy, no code, closed predicates, a
 *                             resolver the trigger allows, channels the engine can
 *                             deliver, a non-PII dedupe template, caps that only
 *                             TIGHTEN the definition's
 *   activationBlockers        the §6.3 preconditions, in order
 *   lifecycleAllows           the §6.5 matrix (owner rule), per consent class / origin / channel
 *   idempotencyKey / liveKey  the claim keys (§6.6 step 3)
 *   evaluateConditions        the closed predicates over a fact + recipient facts
 *   retryDelayMs              STANDARD = +15 min, +4 h, then DEAD
 */

import { createHash } from "node:crypto";
import type { CommsDefinition, RecipientResolver, TriggerKey } from "@/lib/notifications/catalog/types";
import { TRIGGER_KEYS } from "@/lib/notifications/catalog/types";
import { TRIGGER_CATALOG } from "@/lib/notifications/catalog/triggers";
import { getNotificationDefinition } from "@/lib/notifications/registry";
import { SUPPRESSION_REASONS, type SuppressionReason } from "@/lib/notifications/delivery/types";
import type { UserLifecycleState } from "@/lib/entitlements/beta-lifecycle";
import { contentVariants } from "@/lib/notifications/content/legs";
import { FACT_SOURCES } from "./facts";
import {
  AUTOMATION_LIMITS as L, ENGINE_PREDICATES, RETRY_POLICIES, STANDARD_RETRY_DELAYS_MS,
  type ActivationBlocker, type AutomationChannel, type AutomationRunCounts, type AutomationState, type Condition, type RetryPolicy,
} from "./types";

// ── Definition facts ─────────────────────────────────────────────────────────

/** v1.1 §6.2 — derived: the audience is a customer, not staff or an inbox. */
export const isCustomerFacing = (def: Pick<CommsDefinition, "audience">): boolean =>
  def.audience !== "OPERATOR_INBOX" && def.audience !== "PLATFORM_STAFF";

/**
 * The channels an automation can DELIVER for this definition: IN_APP through
 * createNotification (a registry type), EMAIL only through the generic
 * `notification` template of a REGISTRY leg the registry does not exclude.
 * A DIRECT email leg (a ceremony / dedicated template, e.g. space-invite) is
 * never automatable: its copy and its tokens belong to its call site.
 */
export function automatableChannels(def: CommsDefinition): AutomationChannel[] {
  const reg = def.notificationTypeId ? getNotificationDefinition(def.notificationTypeId) : undefined;
  if (!reg) return [];
  const out: AutomationChannel[] = [];
  if (def.channels.some((c) => c.channel === "IN_APP" && c.path === "REGISTRY")) out.push("IN_APP");
  if (def.channels.some((c) => c.channel === "EMAIL" && c.path === "REGISTRY") && !reg.excludedChannels?.includes("EMAIL")) out.push("EMAIL");
  return out;
}

/** The trigger keys that produce this definition. */
export function definitionTriggers(def: CommsDefinition): TriggerKey[] {
  if (def.trigger.kind !== "TRIGGER" || !def.trigger.triggerKey) return [];
  return [def.trigger.triggerKey, ...(def.trigger.additionalTriggerKeys ?? [])];
}

/**
 * True when the ENGINE can fire this trigger: the catalog says AVAILABLE (its
 * emitter shipped) AND a recorded fact source exists for it (facts.ts). A
 * trigger whose emitter calls a code producer directly, with no recorded fact
 * the engine can read, is not yet automatable — activation says
 * TRIGGER_NOT_AVAILABLE rather than activating something that can never fire.
 */
export function engineTriggerAvailable(key: TriggerKey): boolean {
  return TRIGGER_CATALOG[key]?.status === "AVAILABLE" && FACT_SOURCES[key] !== undefined;
}

/** Why a definition can carry a DRAFT automation at all (null = it can). v1.1 §6.1, §0.2 (BUILD may hold a draft). */
export function definitionAutomatable(def: CommsDefinition): null | "PROTECTED" | "NOT_EDITABLE" {
  if (def.protected) return "PROTECTED";
  if (def.status !== "ENABLED" && def.status !== "BUILD") return "NOT_EDITABLE";
  if (def.consentClass === "OPERATOR" || def.consentClass === "SECURITY_CRITICAL" || def.consentClass === "CEREMONY") return "PROTECTED";
  if (definitionTriggers(def).length === 0 || automatableChannels(def).length === 0) return "NOT_EDITABLE";
  return null;
}

// ── The §6.5 lifecycle matrix (owner rule) ───────────────────────────────────

export type SendOrigin = "AUTOMATION" | "REGISTRY" | "DIRECT";

/** "SERVICE about the recipient's own data" (v1.1 §6.5): all three facts. */
export function isServiceOwnData(def: Pick<CommsDefinition, "consentClass" | "audience">, resolver: RecipientResolver | null): boolean {
  return def.consentClass === "SERVICE" && def.audience === "ACCOUNT_HOLDER" && resolver?.kind === "EVENT_SUBJECT_USER";
}

/**
 * PURE — may this send go to a recipient in `state`? false ⇒ SUPPRESSED /
 * BETA_LIFECYCLE. Precedence: the consent-class exemption first, then the state.
 *
 *   SECURITY_CRITICAL, CEREMONY (any origin)          always
 *   OPERATOR                                          not evaluated (staff are not beta customers)
 *   SERVICE about the recipient's own data            always (registry, direct OR automation)
 *   any AUTOMATION send otherwise (either channel)    ACTIVE only (PAUSED/ENDED/COST_FREEZE/UNKNOWN ⇒ no)
 *   AWARENESS (or other SERVICE) registry/direct EMAIL ACTIVE only
 *   AWARENESS registry IN_APP bell                    always (O-17)
 *   MARKETING                                         ACTIVE only
 */
export function lifecycleAllows(
  args: { consentClass: CommsDefinition["consentClass"]; origin: SendOrigin; channel: AutomationChannel; serviceOwnData: boolean },
  state: UserLifecycleState,
): boolean {
  const c = args.consentClass;
  if (c === "SECURITY_CRITICAL" || c === "CEREMONY" || c === "OPERATOR") return true;
  if (c === "SERVICE" && args.serviceOwnData) return true;
  if (args.origin === "AUTOMATION" || c === "MARKETING") return state === "ACTIVE";
  // AWARENESS, or SERVICE to someone else (treated as AWARENESS), from a registry / direct producer.
  if (args.channel === "IN_APP" && args.origin === "REGISTRY") return true; // O-17
  return state === "ACTIVE";
}

// ── Keys ─────────────────────────────────────────────────────────────────────

const sha = (parts: readonly (string | number)[]) => createHash("sha256").update(parts.map(String).join("‖")).digest("hex");

/** v1.1 §6.6 step 3 — the claim key: one item per (automation, activation, trigger fact, recipient, channel). */
export const idempotencyKey = (a: { automationId: string; activatedVersion: number; triggerRef: string; recipientId: string; channel: AutomationChannel }) =>
  sha([a.automationId, a.activatedVersion, a.triggerRef, a.recipientId, a.channel]);

/** One LIVE run per trigger fact per activation. */
export const liveKey = (a: { automationId: string; activatedVersion: number; triggerRef: string }) => sha(["run", a.automationId, a.activatedVersion, a.triggerRef]);

const DEDUPE_PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]{0,39})\}/g;

/** The non-PII fields a dedupe template may name for a trigger, plus {recipientId} and {definitionKey}. */
export function dedupeFieldsFor(trigger: TriggerKey): string[] {
  return [...TRIGGER_CATALOG[trigger].payload.filter((f) => !f.pii).map((f) => f.name), "recipientId", "definitionKey"];
}

/** Fill a validated dedupe template. A missing value is the literal "-" (the template was validated, a value can be absent). */
export function fillDedupeKey(template: string, values: Record<string, unknown>): string {
  return template.replace(DEDUPE_PLACEHOLDER, (_m, k: string) => {
    const v = values[k];
    return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v).slice(0, 80) : "-";
  }).slice(0, L.dedupeTemplateMax);
}

// ── Counts ───────────────────────────────────────────────────────────────────

export function emptyCounts(): AutomationRunCounts {
  return {
    matched: 0, eligible: 0, scheduled: 0, accepted: 0, failed: 0, captured: 0, cancelled: 0,
    suppressed: Object.fromEntries(SUPPRESSION_REASONS.map((r) => [r, 0])) as Record<SuppressionReason, number>,
  };
}

/** Read a stored counts JSON back into the full shape (every reason key present). */
export function countsOf(raw: unknown): AutomationRunCounts {
  const out = emptyCounts();
  if (typeof raw !== "object" || raw === null) return out;
  const r = raw as Record<string, unknown>;
  for (const k of ["matched", "eligible", "scheduled", "accepted", "failed", "captured", "cancelled"] as const) {
    if (typeof r[k] === "number") out[k] = r[k] as number;
  }
  const s = r.suppressed;
  if (typeof s === "object" && s !== null) for (const reason of SUPPRESSION_REASONS) {
    const v = (s as Record<string, unknown>)[reason];
    if (typeof v === "number") out.suppressed[reason] = v;
  }
  return out;
}

// ── Retry ────────────────────────────────────────────────────────────────────

/** After failed attempt `attempt` (1-based): the delay to the next, or null ⇒ DEAD. */
export function retryDelayMs(policy: RetryPolicy, attempt: number): number | null {
  if (policy === "NONE") return null;
  return STANDARD_RETRY_DELAYS_MS[attempt - 1] ?? null;
}

// ── Conditions ───────────────────────────────────────────────────────────────

export interface RecipientFacts {
  emailVerified: boolean;
  createdAt: Date | null;
  platformGrantAreas: readonly string[];
}

/** PURE — every condition holds (AND). An unevaluable condition is false (fail closed). */
export function evaluateConditions(conditions: readonly Condition[], fact: { payload: Record<string, unknown> }, r: RecipientFacts | null, now: Date): boolean {
  for (const c of conditions) {
    switch (c.op) {
      case "recipient.has_verified_email": if (!r?.emailVerified) return false; break;
      case "recipient.account_age_days": {
        if (!r?.createdAt) return false;
        const days = (now.getTime() - r.createdAt.getTime()) / 86_400_000;
        if (c.cmp === "gte" ? days < c.value : days > c.value) return false;
        break;
      }
      case "recipient.has_platform_grant": if (!r?.platformGrantAreas.includes(c.area)) return false; break;
      case "event.field_equals": if (fact.payload[c.field] !== c.value) return false; break;
      default: return false;
    }
  }
  return true;
}

// ── Write-body validation (v1 §4.10, §5; v1.1 §6.1) ──────────────────────────

export interface AutomationFields {
  name: string;
  description: string;
  conditions: Condition[];
  recipient: RecipientResolver;
  delayMinutes: number | null;
  dedupeKeyTemplate: string;
  frequencyCapMax: number;
  frequencyCapHours: number;
  retryPolicy: RetryPolicy;
  maxRecipientsPerRun: number;
  channels: AutomationChannel[];
  variant: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; code: "VALIDATION" | "PROTECTED" | "NOT_EDITABLE" | "NOT_FOUND"; error: string };

const PATCHABLE = ["name", "description", "conditions", "recipient", "delay", "dedupeKeyTemplate", "frequencyCap", "retryPolicy", "maxRecipientsPerRun", "channels", "variant"] as const;
/** Copy, template and code never ride an automation (v1 §4.10, O-11): named so the refusal says so. */
const COPY_FIELDS = new Set(["subject", "title", "body", "html", "text", "preheader", "blocks", "content", "copy", "template", "templateBody", "code", "script", "expression", "url", "href", "recipients", "audience", "broadcast", "addresses", "to"]);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]*$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function parseCondition(raw: unknown, trigger: TriggerKey): Condition | string {
  if (!isObj(raw) || typeof raw.op !== "string") return "Each condition must be { op, … }.";
  if (!(ENGINE_PREDICATES as readonly string[]).includes(raw.op)) return `Condition ${raw.op.slice(0, 40)} is not in the closed predicate set available to automations.`;
  const keys = Object.keys(raw);
  const only = (allowed: string[]) => keys.every((k) => allowed.includes(k));
  switch (raw.op) {
    case "recipient.has_verified_email":
      return only(["op"]) ? { op: raw.op } : "recipient.has_verified_email takes no arguments.";
    case "recipient.account_age_days":
      if (!only(["op", "cmp", "value"]) || (raw.cmp !== "gte" && raw.cmp !== "lte") || !isInt(raw.value, 0, 3650)) return "recipient.account_age_days needs cmp gte|lte and an integer value 0–3650.";
      return { op: raw.op, cmp: raw.cmp, value: raw.value };
    case "recipient.has_platform_grant":
      if (!only(["op", "area"]) || !["SECURITY_OPS", "PLATFORM_OPS", "CUSTOMER_SUCCESS", "GROWTH_REVENUE"].includes(String(raw.area))) return "recipient.has_platform_grant needs a platform area.";
      return { op: raw.op, area: raw.area as string };
    case "event.field_equals": {
      if (!only(["op", "field", "value"])) return "event.field_equals takes { field, value }.";
      const field = TRIGGER_CATALOG[trigger].payload.find((f) => f.name === raw.field);
      if (!field) return "event.field_equals names a field the trigger does not carry.";
      if (field.pii) return "event.field_equals may not test a personal field.";
      const v = raw.value;
      if (!(typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.length <= 80 && SAFE_TEXT.test(v)))) return "event.field_equals value must be a short string, a number or a boolean.";
      return { op: raw.op, field: field.name, value: v };
    }
  }
  return "Unknown condition.";
}

function parseResolver(raw: unknown, trigger: TriggerKey): RecipientResolver | string {
  if (!isObj(raw) || typeof raw.kind !== "string") return "recipient must be a resolver { kind, … }.";
  const allowed = TRIGGER_CATALOG[trigger].resolvers;
  const same = allowed.find((r) => r.kind === raw.kind);
  if (!same) return `The resolver ${raw.kind.slice(0, 40)} is not valid for this trigger.`;
  if (raw.kind === "EVENT_SUBJECT_USER" || raw.kind === "EVENT_ACTOR_USER") {
    return Object.keys(raw).length === 1 ? { kind: raw.kind } : "This resolver takes no arguments.";
  }
  if (raw.kind === "SPACE_ROLE" && same.kind === "SPACE_ROLE") {
    const roles = raw.roles;
    if (!Array.isArray(roles) || roles.length === 0 || roles.some((r) => !same.roles.includes(r as never)) || new Set(roles).size !== roles.length) {
      return `SPACE_ROLE roles must be a non-empty subset of ${same.roles.join(", ")}.`;
    }
    return { kind: "SPACE_ROLE", roles: roles as Array<"OWNER" | "ADMIN" | "MEMBER"> };
  }
  // PLATFORM_AREA_STAFF / OPERATOR_INBOX belong to staff mail: never a customer automation in v1.
  return "This resolver is not available to automations.";
}

function parseDedupeTemplate(raw: unknown, trigger: TriggerKey): string | { error: string } {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > L.dedupeTemplateMax || !/^[A-Za-z0-9:_.\-{}]+$/.test(raw)) {
    return { error: `dedupeKeyTemplate must be 1–${L.dedupeTemplateMax} characters of letters, digits, : _ . - and {field} placeholders.` };
  }
  const allowed = dedupeFieldsFor(trigger);
  const named = [...raw.matchAll(DEDUPE_PLACEHOLDER)].map((m) => m[1]);
  if (raw.replace(DEDUPE_PLACEHOLDER, "").includes("{") || raw.replace(DEDUPE_PLACEHOLDER, "").includes("}")) return { error: "dedupeKeyTemplate has a malformed placeholder." };
  const bad = named.find((n) => !allowed.includes(n));
  if (bad) return { error: `dedupeKeyTemplate may name only ${allowed.join(", ")} (non-personal fields).` };
  if (!named.includes("recipientId")) return { error: "dedupeKeyTemplate must include {recipientId}." };
  return raw;
}

/**
 * Validate a create (`existing` absent) or PATCH body's `body` object against
 * the definition and trigger. Copy fields and unknown keys are refused; every
 * field is checked against its closed set. Returns the COMPLETE field set
 * (PATCH merges over `existing`).
 */
export function validateAutomationInput(
  raw: unknown,
  ctx: { def: CommsDefinition; trigger: TriggerKey; existing?: AutomationFields },
): ValidationResult<AutomationFields> {
  const fail = (error: string): ValidationResult<AutomationFields> => ({ ok: false, code: "VALIDATION", error });
  if (!isObj(raw)) return fail("body must be an object.");
  const creating = ctx.existing === undefined;
  for (const k of Object.keys(raw)) {
    if (COPY_FIELDS.has(k)) return fail(`Automations carry no copy, template or code (${k.slice(0, 40)}): they send the definition's live content.`);
    if (creating && (k === "triggerKey" || k === "definitionKey")) continue;
    if (!(PATCHABLE as readonly string[]).includes(k)) return fail(`Unknown field ${k.slice(0, 40)}.`);
  }
  if (!creating && ("triggerKey" in raw || "definitionKey" in raw)) return fail("triggerKey and definitionKey are fixed at create; clone to change them.");

  const def = ctx.def;
  const e = ctx.existing;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(raw, k);

  const name = has("name") ? raw.name : e?.name;
  if (typeof name !== "string" || name.trim().length === 0 || name.length > L.nameMax || !SAFE_TEXT.test(name)) return fail(`name must be 1–${L.nameMax} characters on one line.`);
  const description = has("description") ? raw.description : (e?.description ?? "");
  if (typeof description !== "string" || description.length > L.descriptionMax || !SAFE_TEXT.test(description)) return fail(`description must be at most ${L.descriptionMax} characters on one line.`);

  let conditions: Condition[] = e?.conditions ?? [];
  if (has("conditions")) {
    if (!Array.isArray(raw.conditions) || raw.conditions.length > L.maxConditions) return fail(`conditions must be an array of at most ${L.maxConditions} (AND-ed).`);
    conditions = [];
    for (const c of raw.conditions) {
      const p = parseCondition(c, ctx.trigger);
      if (typeof p === "string") return fail(p);
      conditions.push(p);
    }
  }

  let recipient: RecipientResolver | undefined = e?.recipient;
  if (has("recipient")) {
    const r = parseResolver(raw.recipient, ctx.trigger);
    if (typeof r === "string") return fail(r);
    recipient = r;
  }
  if (!recipient) return fail("recipient is required.");

  let delayMinutes: number | null = e?.delayMinutes ?? null;
  if (has("delay")) {
    const d = raw.delay;
    if (d === null) delayMinutes = null;
    else if (isObj(d) && Object.keys(d).length === 1 && isInt(d.minutes, 0, L.maxDelayMinutes)) delayMinutes = d.minutes === 0 ? null : d.minutes;
    else return fail(`delay must be null or { minutes: 0–${L.maxDelayMinutes} }.`);
  }

  let dedupeKeyTemplate = e?.dedupeKeyTemplate ?? `${def.key}:{recipientId}`;
  if (has("dedupeKeyTemplate")) {
    const t = parseDedupeTemplate(raw.dedupeKeyTemplate, ctx.trigger);
    if (typeof t !== "string") return fail(t.error);
    dedupeKeyTemplate = t;
  }

  // The frequency cap may only TIGHTEN the definition's (v1 §5.5).
  const base = def.frequencyCap;
  let frequencyCapMax = e?.frequencyCapMax ?? base?.max ?? 1;
  let frequencyCapHours = e?.frequencyCapHours ?? base?.perHours ?? 24;
  if (has("frequencyCap")) {
    const f = raw.frequencyCap;
    if (!isObj(f) || Object.keys(f).some((k) => k !== "max" && k !== "perHours") || !isInt(f.max, 1, L.frequencyMaxCeiling) || !isInt(f.perHours, 1, L.frequencyHoursCeiling)) {
      return fail(`frequencyCap must be { max: 1–${L.frequencyMaxCeiling}, perHours: 1–${L.frequencyHoursCeiling} }.`);
    }
    if (base && (f.max > base.max || f.perHours < base.perHours)) return fail(`frequencyCap may only tighten the definition's (${base.max} per ${base.perHours} h).`);
    frequencyCapMax = f.max;
    frequencyCapHours = f.perHours;
  }

  const retryPolicy = has("retryPolicy") ? raw.retryPolicy : (e?.retryPolicy ?? "STANDARD");
  if (!(RETRY_POLICIES as readonly unknown[]).includes(retryPolicy)) return fail("retryPolicy must be NONE or STANDARD.");

  const maxRecipientsPerRun = has("maxRecipientsPerRun") ? raw.maxRecipientsPerRun : (e?.maxRecipientsPerRun ?? L.defaultMaxRecipientsPerRun);
  if (!isInt(maxRecipientsPerRun, 1, L.maxRecipientsCeiling)) return fail(`maxRecipientsPerRun must be an integer from 1 to ${L.maxRecipientsCeiling}.`);

  const deliverable = automatableChannels(def);
  let channels: AutomationChannel[] = e?.channels ?? deliverable;
  if (has("channels")) {
    const c = raw.channels;
    if (!Array.isArray(c) || c.length === 0 || new Set(c).size !== c.length || c.some((x) => !deliverable.includes(x as AutomationChannel))) {
      return fail(`channels must be a non-empty subset of ${deliverable.join(", ") || "(none)"}.`);
    }
    channels = c as AutomationChannel[];
  }

  const variants = contentVariants(def.key);
  const variant = has("variant") ? raw.variant : (e?.variant ?? (variants.includes("default") ? "default" : variants[0]));
  if (typeof variant !== "string" || !variants.includes(variant)) return fail("Unknown variant.");

  return {
    ok: true,
    value: {
      name: name.trim(), description, conditions, recipient, delayMinutes, dedupeKeyTemplate,
      frequencyCapMax, frequencyCapHours, retryPolicy: retryPolicy as RetryPolicy, maxRecipientsPerRun, channels, variant,
    },
  };
}

/** The create body's fixed keys, resolved against the code catalogs. */
export function resolveTarget(raw: unknown, getDef: (key: string) => CommsDefinition | undefined): ValidationResult<{ def: CommsDefinition; trigger: TriggerKey }> {
  const b = isObj(raw) ? raw : {};
  const key = typeof b.definitionKey === "string" ? b.definitionKey : null;
  const def = key ? getDef(key) : undefined;
  // Protection is checked BEFORE the rest of the body (v1.1 §2.1 idiom): a protected key never yields a validation hint.
  if (def) {
    const why = definitionAutomatable(def);
    if (why === "PROTECTED") return { ok: false, code: "PROTECTED", error: "This message is protected: it cannot be automated." };
  }
  if (!key || !SAFE_ID.test(key)) return { ok: false, code: "VALIDATION", error: "body.definitionKey is required." };
  if (!def) return { ok: false, code: "NOT_FOUND", error: "No catalog definition has that key." };
  const why = definitionAutomatable(def);
  if (why) return { ok: false, code: why, error: "This message cannot carry an automation." };
  const trigger = b.triggerKey;
  if (typeof trigger !== "string" || !(TRIGGER_KEYS as readonly string[]).includes(trigger)) return { ok: false, code: "VALIDATION", error: "body.triggerKey must be a key of the trigger catalog." };
  if (!definitionTriggers(def).includes(trigger as TriggerKey)) return { ok: false, code: "VALIDATION", error: "That trigger does not produce this definition." };
  return { ok: true, value: { def, trigger: trigger as TriggerKey } };
}

// ── Activation preconditions (v1.1 §6.3) ─────────────────────────────────────

export interface ActivationFacts {
  state: AutomationState;
  version: number;
  definitionVersion: number;
  triggerKey: TriggerKey;
  customerFacing: boolean;
  ownerApprovedVersion: number | null;
  ownerApprovedDefinitionVersion: number | null;
  /** The newest DRY_RUN of this automation (any version). */
  lastDryRun: { automationVersion: number; status: string; startedAt: Date; wouldExceedMaxRecipients: boolean } | null;
}

/** Is the owner approval CURRENT: this exact automation version against this exact definition version (§6.4)? */
export function ownerApprovalCurrent(f: Pick<ActivationFacts, "version" | "ownerApprovedVersion" | "ownerApprovedDefinitionVersion">, def: Pick<CommsDefinition, "definitionVersion">): boolean {
  return f.ownerApprovedVersion === f.version && f.ownerApprovedDefinitionVersion === def.definitionVersion;
}

/** Every §6.3 blocker, in the order the checks run. Empty ⇒ activate would pass. */
export function activationBlockers(f: ActivationFacts, def: CommsDefinition, now: Date): ActivationBlocker[] {
  const out: ActivationBlocker[] = [];
  if (f.state !== "DRAFT" && f.state !== "PAUSED") out.push("STATE");
  if (def.protected || definitionAutomatable(def) === "PROTECTED") out.push("PROTECTED");
  if (def.status !== "ENABLED" && def.status !== "BUILD") out.push("DEFINITION_NOT_ACTIVATABLE");
  if (!engineTriggerAvailable(f.triggerKey)) out.push("TRIGGER_NOT_AVAILABLE");
  if (def.consentClass === "MARKETING") out.push("MARKETING_NOT_IN_V1");
  if (f.customerFacing && !ownerApprovalCurrent(f, def)) out.push("OWNER_APPROVAL_REQUIRED");
  const d = f.lastDryRun;
  const fresh = d !== null && d.automationVersion === f.version && d.status === "SUCCEEDED" && !d.wouldExceedMaxRecipients
    && now.getTime() - d.startedAt.getTime() <= L.dryRunFreshDays * 86_400_000;
  if (!fresh) out.push("DRY_RUN_REQUIRED");
  return out;
}

/** The 409 code of the FIRST failing §6.3 check. */
export function blockerCode(b: ActivationBlocker): "INVALID_STATE" | "PROTECTED" | "OWNER_APPROVAL_REQUIRED" | "DRY_RUN_REQUIRED" {
  if (b === "PROTECTED") return "PROTECTED";
  if (b === "OWNER_APPROVAL_REQUIRED") return "OWNER_APPROVAL_REQUIRED";
  if (b === "DRY_RUN_REQUIRED") return "DRY_RUN_REQUIRED";
  return "INVALID_STATE";
}
