/**
 * lib/platform/ai/platform-ai-caps-admin.ts  (PLATFORM AI CAPS D5 PR4 — the SA-only read model + write path)
 *
 * THE ONE APPLICATION WRITER of the Platform AI daily $ caps:
 *   · the two blanket PlatformSettings (platform_ai_daily_usd_per_operator /
 *     platform_ai_daily_usd_platform, D5 PR2), and
 *   · the per-operator PlatformAiOperatorCap rows (D5 PR3).
 * The route is app/api/admin/platform-ai-caps (requireSystemAdmin for GET,
 * requireFreshSystemAdmin for POST). Nothing else writes either.
 *
 * DISTINCT ACTIONS (S2 09fa-3 / 09fb C1). One request = one action:
 *   SET_BLANKET     { key: per_operator | platform, valueUsd: int | null, reason, expectedUpdatedAt }
 *                   null clears the row (back to "not set"). Validated by the descriptor
 *                   (0..20 / 0..100, S2 R4: refused here, not only clamped at read).
 *                   Audited PLATFORM_POLICY_CHANGED / PLATFORM_POLICY_RESET. Lowering the
 *                   platform cap below existing overrides is ALLOWED (09fb Q2); the result
 *                   carries a warning with the COUNT of overrides now above it.
 *   SET_OVERRIDE    { targetUserId, dailyUsd: int 0..20, reason, expectedUpdatedAt? }
 *                   target = a current SYSTEM_ADMIN or ACTIVE platform-grant holder (C3);
 *                   the platform cap must resolve (else PLATFORM_CAP_NOT_SET); dailyUsd must
 *                   not exceed the EFFECTIVE platform cap (09fb Q2 — a UX check: the
 *                   reservation stays the real bound). Audited PLATFORM_AI_OPERATOR_CAP_CHANGED.
 *   RESET_OVERRIDE  { targetUserId, reason, expectedUpdatedAt? } — deletes the row.
 *                   Audited PLATFORM_AI_OPERATOR_CAP_RESET.
 * A body carrying a field of another action is refused VALIDATION: the blanket value
 * and an override can never change in one request.
 *
 * AUTHORITY. The route's guard is the gate; the service re-checks the actor's role
 * (defence in depth) — a non-SYSTEM_ADMIN actor is refused FORBIDDEN, nothing written.
 * Self-edit is allowed (the actor IS an SA) and flagged `selfEdit` exactly when
 * actor == target (09fa).
 *
 * AUDIT (C4). One reason-required operator-action row per write, in the SAME
 * transaction as the write. The override rows' target is PLATFORM_AI_OPERATOR_CAP
 * keyed by the PRIV-ref (opaqueUserRef), never the raw user id; detail =
 * { targetRef, previous, next, selfEdit, reason }. Every refusal (past the route's
 * guard) records PLATFORM_CONTROL_REFUSED through recordControlRefusal: codes only,
 * never a submitted value, never an id.
 *
 * ⚠️ THE CAPS CANNOT ACTIVATE PLATFORM AI. They are read only inside the reservation,
 * which runs after the PLATFORM_AI_ENABLED gate (lib/platform/intelligence/ai/core.ts);
 * nothing here touches an env flag, a provider or a model.
 *
 * Logs: codes only — never an email, an id or a figure. fm_system throughout.
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { env } from "@/lib/env";
import { AuditAction } from "@/lib/audit-actions";
import {
  OperatorActionValidationError, parseOperatorReason, recordOperatorAction,
  type OperatorActionWriteClient, type OperatorReason,
} from "@/lib/audit";
import {
  PlatformSettingKey, PlatformSettingValidationError, createSettingIfAbsent, deleteSettingIfVersion,
  updateSettingIfVersion, validateSetting, type PlatformSettingKeyType, type SettingWriteClient,
} from "@/lib/platform-settings";
import { opaqueUserRef } from "@/lib/platform/opaque-user-ref";
import { recordControlRefusal, type ControlRefusal } from "@/lib/platform/control-refusal";
import { todayUTCISO } from "@/lib/time/clock";
import {
  PLATFORM_AI_OPERATOR_CAP_CEILING_USD, PLATFORM_AI_PLATFORM_CAP_CEILING_USD,
  capSettingUsdOf, parseCapSettingRow, parseOperatorCapRow, platformAiReserveUsd, platformAiTurnsThatFit,
  resolvePlatformAiCaps, type CapInputs, type CapRefusalCause, type CapSource, type PlatformAiCapOutcome,
} from "@/lib/platform/ai/platform-ai-spend.core";

// ── Vocabulary ────────────────────────────────────────────────────────────────

export const PLATFORM_AI_CAPS_ACTIONS = ["SET_BLANKET", "SET_OVERRIDE", "RESET_OVERRIDE"] as const;
export type PlatformAiCapsAction = (typeof PLATFORM_AI_CAPS_ACTIONS)[number];

/** The blanket caps by their body name → setting key. */
export const BLANKET_CAP_KEYS = Object.freeze({
  per_operator: PlatformSettingKey.PLATFORM_AI_DAILY_USD_PER_OPERATOR,
  platform: PlatformSettingKey.PLATFORM_AI_DAILY_USD_PLATFORM,
} as const);
export type BlanketCapName = keyof typeof BLANKET_CAP_KEYS;

/** Each action's closed field set — a field of another action is refused (one action per request). */
export const ACTION_FIELDS: Readonly<Record<PlatformAiCapsAction, readonly string[]>> = Object.freeze({
  SET_BLANKET: ["action", "key", "valueUsd", "reason", "expectedUpdatedAt"],
  SET_OVERRIDE: ["action", "targetUserId", "dailyUsd", "reason", "expectedUpdatedAt"],
  RESET_OVERRIDE: ["action", "targetUserId", "reason", "expectedUpdatedAt"],
});

export type PlatformAiCapsRefusalCode =
  | "VALIDATION" | "FORBIDDEN" | "NOT_ELIGIBLE" | "PLATFORM_CAP_NOT_SET" | "ABOVE_PLATFORM_CAP" | "NOT_FOUND" | "CONFLICT";

export const PLATFORM_AI_CAPS_CONTROL = "platform-ai-caps" as const;

// ── Read model ────────────────────────────────────────────────────────────────

export interface CapOutcomeView {
  /** The cap in force (after the ceiling), or null when it does not resolve. */
  usd: number | null;
  source: CapSource | null;
  /** Why it does not resolve (the reservation refuses with this cause). */
  refusal: CapRefusalCause | null;
}

export interface BlanketCapView {
  key: BlanketCapName;
  settingKey: PlatformSettingKeyType;
  ceilingUsd: number;
  /** The stored row: ABSENT (not set), SET, or INVALID (refuses CAP_INVALID). */
  stored: { state: "ABSENT" | "SET" | "INVALID"; usd: number | null; updatedAt: string | null; updatedBy: string | null };
  /** What the reservation resolves for this cap with no override (setting > env > test default). */
  effective: CapOutcomeView;
  fitsTurns: number | null;
}

export interface OperatorCapView {
  userId: string;
  /** PRIV-ref (opaqueUserRef) — the identity the audit rows carry. */
  ref: string;
  /** username → name → ref; never an email. */
  label: string;
  via: "SYSTEM_ADMIN" | "PLATFORM_GRANT";
  override: { state: "SET" | "INVALID"; dailyUsd: number | null; updatedAt: string } | null;
  effective: CapOutcomeView;
  fitsTurns: number | null;
}

export interface PlatformAiCapsReadModel {
  checkedAt: string;
  model: string;
  /** One worst-case turn on `model`, USD (null ⇒ unpriced ⇒ every turn refused). */
  reserveUsd: number | null;
  blanket: { perOperator: BlanketCapView; platform: BlanketCapView };
  operators: OperatorCapView[];
  /** Overrides above the effective platform cap (null when the platform cap does not resolve). */
  overridesAbovePlatformCap: number | null;
  note: string;
}

export const CAPS_NOTE =
  "Estimated-dollar caps per UTC day, judged before every Platform AI turn under the reservation locks. " +
  "They only ever refuse turns: Platform AI stays off unless its deployment flag is on.";

// ── Clients (narrow; systemDb or a test fake) ─────────────────────────────────

interface SettingRow { key: string; value: string; updatedAt: Date; updatedById: string | null }
interface CapRow { userId: string; dailyUsd: number; updatedAt: Date; updatedById: string | null }
interface UserRow { id: string; name: string | null; username: string | null; role: string; deactivatedAt: Date | null }

export interface CapsAdminReadClient {
  platformSetting: { findMany(args: unknown): Promise<SettingRow[]> };
  platformAiOperatorCap: { findMany(args: unknown): Promise<CapRow[]> };
  platformGrant: { findMany(args: unknown): Promise<Array<{ userId: string }>> };
  user: { findMany(args: unknown): Promise<UserRow[]> };
}

export type CapsAdminTx = SettingWriteClient & OperatorActionWriteClient & {
  platformAiOperatorCap: {
    findUnique(args: unknown): Promise<{ dailyUsd: number; updatedAt: Date } | null>;
    create(args: unknown): Promise<unknown>;
    updateMany(args: unknown): Promise<{ count: number }>;
    deleteMany(args: unknown): Promise<{ count: number }>;
    count(args: unknown): Promise<number>;
  };
  user: { findUnique(args: unknown): Promise<{ id: string; role: string; deactivatedAt: Date | null } | null> };
  platformGrant: { count(args: unknown): Promise<number> };
};

export interface CapsAdminClient extends CapsAdminReadClient {
  $transaction<T>(fn: (tx: CapsAdminTx) => Promise<T>): Promise<T>;
}

const DEFAULT_CLIENT = (): CapsAdminClient => systemDb as unknown as CapsAdminClient;

export interface CapsAdminDeps {
  client?: CapsAdminClient;
  /** The caps' raw env inputs (default lib/env.ts). */
  capInputs?: CapInputs;
  /** The PRIV-ref (default opaqueUserRef). */
  refOf?: (userId: string) => string;
  /** The refusal recorder (default recordControlRefusal as a SYSTEM_ADMIN actor). */
  recordRefusal?: (refusal: ControlRefusal) => Promise<void>;
  now?: Date;
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

const view = (o: PlatformAiCapOutcome): CapOutcomeView =>
  o.ok ? { usd: o.usd, source: o.source, refusal: null } : { usd: null, source: null, refusal: o.cause };

function settingsOf(rows: readonly { key: string; value: string }[]) {
  const of = (k: string) => parseCapSettingRow(rows.find((r) => r.key === k)?.value);
  return { perOperator: of(BLANKET_CAP_KEYS.per_operator), platform: of(BLANKET_CAP_KEYS.platform) };
}

/** PURE — the caps for one operator (override may be null), exactly as the reservation resolves them. */
export function resolveForAdmin(
  capInputs: CapInputs,
  settingRows: readonly { key: string; value: string }[],
  overrideRow: { dailyUsd: unknown } | null,
) {
  const s = settingsOf(settingRows);
  return resolvePlatformAiCaps({
    ...capInputs,
    operatorOverrideUsd: capSettingUsdOf(parseOperatorCapRow(overrideRow)),
    settingPerOperatorUsd: capSettingUsdOf(s.perOperator),
    settingPlatformUsd: capSettingUsdOf(s.platform),
  });
}

const isWholeInRange = (v: unknown, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;

const SETTING_SELECT = { key: true, value: true, updatedAt: true, updatedById: true } as const;
const BLANKET_WHERE = { key: { in: [BLANKET_CAP_KEYS.per_operator, BLANKET_CAP_KEYS.platform] } };

/** Current operators: SYSTEM_ADMIN users + ACTIVE platform-grant holders, open accounts only. */
async function loadOperators(client: CapsAdminReadClient): Promise<Array<UserRow & { via: OperatorCapView["via"] }>> {
  const grants = await client.platformGrant.findMany({ where: { status: "ACTIVE" }, select: { userId: true }, distinct: ["userId"] });
  const grantIds = [...new Set(grants.map((g) => g.userId))];
  const users = await client.user.findMany({
    where: { deactivatedAt: null, OR: [{ role: "SYSTEM_ADMIN" }, { id: { in: grantIds } }] },
    select: { id: true, name: true, username: true, role: true, deactivatedAt: true },
    orderBy: { username: "asc" },
  });
  return users
    .filter((u) => u.deactivatedAt === null && (u.role === "SYSTEM_ADMIN" || grantIds.includes(u.id)))
    .map((u) => ({ ...u, via: u.role === "SYSTEM_ADMIN" ? "SYSTEM_ADMIN" as const : "PLATFORM_GRANT" as const }));
}

export async function loadPlatformAiCapsReadModel(model: string, deps: CapsAdminDeps = {}): Promise<PlatformAiCapsReadModel> {
  const client = deps.client ?? DEFAULT_CLIENT();
  const capInputs = deps.capInputs ?? env.platformAiSpendCapInputs;
  const refOf = deps.refOf ?? opaqueUserRef;
  const now = deps.now ?? new Date();
  const [settingRows, capRows, operators] = await Promise.all([
    client.platformSetting.findMany({ where: BLANKET_WHERE, select: SETTING_SELECT }),
    client.platformAiOperatorCap.findMany({ select: { userId: true, dailyUsd: true, updatedAt: true, updatedById: true } }),
    loadOperators(client),
  ]);
  let reserveUsd: number | null = null;
  try { reserveUsd = platformAiReserveUsd(model, todayUTCISO(now)); } catch { reserveUsd = null; }

  const writerIds = [...new Set(settingRows.map((r) => r.updatedById).filter((x): x is string => !!x))];
  const writers = writerIds.length > 0
    ? await client.user.findMany({ where: { id: { in: writerIds } }, select: { id: true, name: true, username: true, role: true, deactivatedAt: true } })
    : [];
  const labelOf = (u: Pick<UserRow, "id" | "name" | "username">) => u.username ?? u.name ?? refOf(u.id);

  const blanketResolution = resolveForAdmin(capInputs, settingRows, null);
  const s = settingsOf(settingRows);
  const blanketView = (key: BlanketCapName, parsed: ReturnType<typeof parseCapSettingRow>, outcome: PlatformAiCapOutcome, ceilingUsd: number): BlanketCapView => {
    const row = settingRows.find((r) => r.key === BLANKET_CAP_KEYS[key]) ?? null;
    const writer = row?.updatedById ? writers.find((w) => w.id === row.updatedById) : undefined;
    const effective = view(outcome);
    return {
      key, settingKey: BLANKET_CAP_KEYS[key], ceilingUsd,
      stored: {
        state: parsed.state, usd: parsed.state === "SET" ? parsed.usd : null,
        updatedAt: row ? row.updatedAt.toISOString() : null, updatedBy: writer ? labelOf(writer) : null,
      },
      effective, fitsTurns: platformAiTurnsThatFit(effective.usd, reserveUsd),
    };
  };

  const platformUsd = blanketResolution.platform.ok ? blanketResolution.platform.usd : null;
  const rows: OperatorCapView[] = operators.map((u) => {
    const row = capRows.find((c) => c.userId === u.id) ?? null;
    const parsed = parseOperatorCapRow(row);
    const effective = view(resolveForAdmin(capInputs, settingRows, row).operator);
    return {
      userId: u.id, ref: refOf(u.id), label: labelOf(u), via: u.via,
      override: row ? { state: parsed.state === "SET" ? "SET" : "INVALID", dailyUsd: parsed.state === "SET" ? parsed.usd : null, updatedAt: row.updatedAt.toISOString() } : null,
      effective, fitsTurns: platformAiTurnsThatFit(effective.usd, reserveUsd),
    };
  });

  return {
    checkedAt: now.toISOString(),
    model,
    reserveUsd,
    blanket: {
      perOperator: blanketView("per_operator", s.perOperator, blanketResolution.operator, PLATFORM_AI_OPERATOR_CAP_CEILING_USD),
      platform: blanketView("platform", s.platform, blanketResolution.platform, PLATFORM_AI_PLATFORM_CAP_CEILING_USD),
    },
    operators: rows,
    overridesAbovePlatformCap: platformUsd === null ? null : capRows.filter((c) => c.dailyUsd > platformUsd).length,
    note: CAPS_NOTE,
  };
}

// ── Mutation ──────────────────────────────────────────────────────────────────

export interface CapsAdminActor {
  id: string;
  role: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface PlatformAiCapsWarning {
  code: "OVERRIDES_ABOVE_PLATFORM_CAP";
  /** How many overrides are now above the effective platform cap. */
  count: number;
  platformCapUsd: number;
}

export type PlatformAiCapsMutationResult =
  | { ok: true; action: PlatformAiCapsAction; changed: boolean; selfEdit?: boolean; warning?: PlatformAiCapsWarning }
  | { ok: false; code: PlatformAiCapsRefusalCode; reason: string; action: PlatformAiCapsAction | null };

class Refusal extends Error {
  constructor(readonly code: PlatformAiCapsRefusalCode, reason: string) { super(reason); this.name = "PlatformAiCapsRefusal"; }
}

function versionMatches(expected: string | null, row: { updatedAt: Date } | null): boolean {
  if (expected === null) return row === null;
  if (row === null) return false;
  const t = Date.parse(expected);
  return Number.isFinite(t) && t === row.updatedAt.getTime();
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function refusalTarget(action: PlatformAiCapsAction | null, body: Record<string, unknown> | null): string | null {
  if (action === "SET_OVERRIDE" || action === "RESET_OVERRIDE") return "override";
  if (action === "SET_BLANKET" && typeof body?.key === "string" && body.key in BLANKET_CAP_KEYS) return body.key;
  return null;
}

/**
 * Apply ONE caps action. Never throws for a refusal (only for an unexpected store
 * error, which the route turns into a 500). Every refusal is recorded (codes only).
 */
export async function applyPlatformAiCapsAction(
  rawBody: unknown,
  actor: CapsAdminActor,
  deps: CapsAdminDeps = {},
): Promise<PlatformAiCapsMutationResult> {
  const client = deps.client ?? DEFAULT_CLIENT();
  const capInputs = deps.capInputs ?? env.platformAiSpendCapInputs;
  const refOf = deps.refOf ?? opaqueUserRef;
  const recordRefusal = deps.recordRefusal ?? ((r: ControlRefusal) => recordControlRefusal(
    { user: { id: actor.id } as never, grant: null }, r, { ipAddress: actor.ipAddress ?? null, userAgent: actor.userAgent ?? null },
  ));

  const body = isRecord(rawBody) ? rawBody : null;
  const action = body && typeof body.action === "string" && (PLATFORM_AI_CAPS_ACTIONS as readonly string[]).includes(body.action)
    ? body.action as PlatformAiCapsAction : null;
  const reasonCode = body && isRecord(body.reason) ? body.reason.code : undefined;
  const verb: ControlRefusal["verb"] =
    action === "RESET_OVERRIDE" || (action === "SET_BLANKET" && body?.valueUsd === null) ? "reset" : "change";

  const refuse = async (code: PlatformAiCapsRefusalCode, reason: string): Promise<PlatformAiCapsMutationResult> => {
    await recordRefusal({ control: PLATFORM_AI_CAPS_CONTROL, verb, code, targetKey: refusalTarget(action, body), reasonCode });
    return { ok: false, code, reason, action };
  };

  // 1. Authority (defence in depth — the route's fresh SYSTEM_ADMIN guard runs first).
  if (actor.role !== "SYSTEM_ADMIN") return refuse("FORBIDDEN", "Only a System Admin may change the Platform AI caps.");

  // 2. One action per request, with exactly its own fields.
  if (!body || !action) return refuse("VALIDATION", `action must be one of ${PLATFORM_AI_CAPS_ACTIONS.join(", ")}.`);
  const foreign = Object.keys(body).filter((k) => !ACTION_FIELDS[action].includes(k));
  if (foreign.length > 0) {
    return refuse("VALIDATION", `${action} takes only ${ACTION_FIELDS[action].join(", ")}; the blanket caps and an override are changed by separate actions.`);
  }

  // 3. A reason, always.
  let reason: OperatorReason;
  try { reason = parseOperatorReason(body.reason); }
  catch (e) { return refuse("VALIDATION", e instanceof OperatorActionValidationError ? e.message : "A reason is required."); }

  // 4. The concurrency token's shape.
  const expected = body.expectedUpdatedAt;
  if (expected !== undefined && expected !== null && typeof expected !== "string") {
    return refuse("VALIDATION", "expectedUpdatedAt must be the version you observed (an ISO instant) or null.");
  }

  try {
    if (action === "SET_BLANKET") {
      return await setBlanket(client, capInputs, actor, reason, body, refuse);
    }
    return await setOrResetOverride(client, capInputs, refOf, actor, reason, action, body, refuse);
  } catch (err) {
    if (err instanceof Refusal) return refuse(err.code, err.message);
    if (err instanceof PlatformSettingValidationError) return refuse("VALIDATION", err.reason);
    throw err;
  }
}

type Refuse = (code: PlatformAiCapsRefusalCode, reason: string) => Promise<PlatformAiCapsMutationResult>;

async function setBlanket(
  client: CapsAdminClient, capInputs: CapInputs, actor: CapsAdminActor, reason: OperatorReason,
  body: Record<string, unknown>, refuse: Refuse,
): Promise<PlatformAiCapsMutationResult> {
  const name = body.key;
  if (typeof name !== "string" || !(name in BLANKET_CAP_KEYS)) return refuse("VALIDATION", "key must be per_operator or platform.");
  const key = BLANKET_CAP_KEYS[name as BlanketCapName];
  if (body.expectedUpdatedAt === undefined) return refuse("VALIDATION", "expectedUpdatedAt is required (null when no value is set).");
  const expected = body.expectedUpdatedAt as string | null;
  const value = body.valueUsd;
  const clearing = value === null;
  let stored: string | null = null;
  if (!clearing) {
    if (typeof value !== "number" || !Number.isInteger(value)) return refuse("VALIDATION", "valueUsd must be a whole number of dollars, or null to clear.");
    // S2 R4 — the descriptor's bounds (0..20 / 0..100) refuse at the single writer.
    const v = validateSetting(key, String(value));
    if (!v.ok) return refuse("VALIDATION", v.reason);
    stored = v.value;
  }

  let warning: PlatformAiCapsWarning | undefined;
  await client.$transaction(async (tx) => {
    const before = await tx.platformSetting.findUnique({ where: { key }, select: { value: true, updatedAt: true } });
    if (!versionMatches(expected, before)) throw new Refusal("CONFLICT", `${name} changed since you opened the editor.`);
    if (clearing) {
      if (!before) throw new Refusal("NOT_FOUND", `${name} is not set; there is nothing to clear.`);
      if (!(await deleteSettingIfVersion(tx, key, before.updatedAt))) throw new Refusal("CONFLICT", `${name} changed while the clear was being saved.`);
    } else {
      const written = before
        ? await updateSettingIfVersion(tx, key, stored!, before.updatedAt, actor.id)
        : await createSettingIfAbsent(tx, key, stored!, actor.id);
      if (!written) throw new Refusal("CONFLICT", `${name} changed while your change was being saved.`);
    }
    await recordOperatorAction(tx, {
      actor: { userId: actor.id, via: "SYSTEM_ADMIN" },
      action: clearing ? AuditAction.PLATFORM_POLICY_RESET : AuditAction.PLATFORM_POLICY_CHANGED,
      target: { kind: "PLATFORM_SETTING", id: key },
      reason,
      change: { before: { value: before ? before.value : null }, after: { value: stored } },
      detail: { control: PLATFORM_AI_CAPS_CONTROL, settingKey: key },
      result: "SUCCESS",
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    });
    // 09fb Q2 — lowering the platform cap below existing overrides is allowed; say how many.
    if (name === "platform") {
      const rows = await tx.platformSetting.findMany({ where: BLANKET_WHERE, select: { key: true, value: true } }) as Array<{ key: string; value: string }>;
      const platform = resolveForAdmin(capInputs, rows, null).platform;
      if (platform.ok) {
        const count = await tx.platformAiOperatorCap.count({ where: { dailyUsd: { gt: platform.usd } } });
        if (count > 0) warning = { code: "OVERRIDES_ABOVE_PLATFORM_CAP", count, platformCapUsd: platform.usd };
      }
    }
  });
  return { ok: true, action: "SET_BLANKET", changed: true, ...(warning ? { warning } : {}) };
}

async function setOrResetOverride(
  client: CapsAdminClient, capInputs: CapInputs, refOf: (id: string) => string, actor: CapsAdminActor, reason: OperatorReason,
  action: "SET_OVERRIDE" | "RESET_OVERRIDE", body: Record<string, unknown>, refuse: Refuse,
): Promise<PlatformAiCapsMutationResult> {
  const targetUserId = body.targetUserId;
  if (typeof targetUserId !== "string" || targetUserId.length === 0 || targetUserId.length > 64) return refuse("VALIDATION", "targetUserId is required.");
  const dailyUsd = body.dailyUsd;
  if (action === "SET_OVERRIDE" && !isWholeInRange(dailyUsd, PLATFORM_AI_OPERATOR_CAP_CEILING_USD)) {
    return refuse("VALIDATION", `dailyUsd must be a whole number of dollars from 0 to ${PLATFORM_AI_OPERATOR_CAP_CEILING_USD}.`);
  }
  const expected = body.expectedUpdatedAt as string | null | undefined;
  const selfEdit = actor.id === targetUserId;
  const targetRef = refOf(targetUserId);

  const changed = await client.$transaction(async (tx) => {
    const before = await tx.platformAiOperatorCap.findUnique({ where: { userId: targetUserId }, select: { dailyUsd: true, updatedAt: true } });
    if (expected !== undefined && !versionMatches(expected, before)) throw new Refusal("CONFLICT", "This operator's cap changed since you opened the editor.");
    const previous = before ? before.dailyUsd : null;

    if (action === "RESET_OVERRIDE") {
      if (!before) throw new Refusal("NOT_FOUND", "This operator has no override; the blanket cap already applies.");
      const { count } = await tx.platformAiOperatorCap.deleteMany({ where: { userId: targetUserId, updatedAt: before.updatedAt } });
      if (count !== 1) throw new Refusal("CONFLICT", "This operator's cap changed while the reset was being saved.");
      await recordOperatorAction(tx, {
        actor: { userId: actor.id, via: "SYSTEM_ADMIN" },
        action: AuditAction.PLATFORM_AI_OPERATOR_CAP_RESET,
        target: { kind: "PLATFORM_AI_OPERATOR_CAP", id: targetRef },
        reason,
        change: { before: { dailyUsd: previous }, after: { dailyUsd: null } },
        detail: { targetRef, previous, next: null, selfEdit, reason: reason.code },
        result: "SUCCESS",
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      });
      return true;
    }

    // C3 — the target must be a current operator (open SYSTEM_ADMIN account or ACTIVE grant holder).
    const target = await tx.user.findUnique({ where: { id: targetUserId }, select: { id: true, role: true, deactivatedAt: true } });
    const eligible = !!target && target.deactivatedAt === null
      && (target.role === "SYSTEM_ADMIN" || (await tx.platformGrant.count({ where: { userId: targetUserId, status: "ACTIVE" } })) > 0);
    if (!eligible) throw new Refusal("NOT_ELIGIBLE", "The target is not a current System Admin or active platform-grant holder.");

    // 09fb Q2 — the override may not exceed the EFFECTIVE platform cap (a UX check; the reservation is the real bound).
    const rows = await tx.platformSetting.findMany({ where: BLANKET_WHERE, select: { key: true, value: true } }) as Array<{ key: string; value: string }>;
    const platform = resolveForAdmin(capInputs, rows, null).platform;
    if (!platform.ok) {
      throw new Refusal("PLATFORM_CAP_NOT_SET", platform.cause === "CAP_MISSING"
        ? "Set the platform cap before setting an operator override."
        : "The platform cap is invalid; fix it before setting an operator override.");
    }
    const next = dailyUsd as number;
    if (next > platform.usd) throw new Refusal("ABOVE_PLATFORM_CAP", `An override may not exceed the platform cap ($${platform.usd}).`);
    if (previous === next) return false; // no-op: no write, no audit

    if (before) {
      const { count } = await tx.platformAiOperatorCap.updateMany({ where: { userId: targetUserId, updatedAt: before.updatedAt }, data: { dailyUsd: next, updatedById: actor.id } });
      if (count !== 1) throw new Refusal("CONFLICT", "This operator's cap changed while your change was being saved.");
    } else {
      try {
        await tx.platformAiOperatorCap.create({ data: { userId: targetUserId, dailyUsd: next, updatedById: actor.id } });
      } catch (err) {
        if ((err as { code?: string })?.code === "P2002") throw new Refusal("CONFLICT", "This operator's cap was set while your change was being saved.");
        throw err;
      }
    }
    await recordOperatorAction(tx, {
      actor: { userId: actor.id, via: "SYSTEM_ADMIN" },
      action: AuditAction.PLATFORM_AI_OPERATOR_CAP_CHANGED,
      target: { kind: "PLATFORM_AI_OPERATOR_CAP", id: targetRef },
      reason,
      change: { before: { dailyUsd: previous }, after: { dailyUsd: next } },
      detail: { targetRef, previous, next, selfEdit, reason: reason.code },
      result: "SUCCESS",
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    });
    return true;
  });
  return { ok: true, action, changed, selfEdit };
}
