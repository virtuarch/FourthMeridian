/**
 * lib/notifications/automations/http.ts  (Comms Center B2 — the automation + test-send endpoints)
 *
 * Contract v1 §4.6–§4.10 and v1.1 §6.1–§6.9. Handlers behind injected
 * services, so tests run the SAME code the routes run over the in-memory Prisma
 * fake with fake transports. The route files under
 * app/api/platform/customer-success/notifications/{automations,test-send} name
 * the gate and the bucket where the route-guard census can see them:
 *
 *   GET   /automations                         CS READ            cs-comms-read
 *   POST  /automations                         fresh CS WRITE     cs-comms-write    COMMS_AUTOMATION_CREATED
 *   GET   /automations/[id]                    CS READ            cs-comms-read     (+ viewer, D2)
 *   PATCH /automations/[id]                    fresh CS WRITE     cs-comms-write    COMMS_AUTOMATION_UPDATED
 *   GET   /automations/[id]/runs               CS READ            cs-comms-read
 *   POST  /automations/[id]/dry-run            fresh CS WRITE     cs-comms-dryrun   COMMS_AUTOMATION_DRY_RUN
 *   POST  /automations/[id]/owner-approval     fresh SYSTEM_ADMIN cs-comms-control  COMMS_AUTOMATION_OWNER_APPROVED
 *   POST  /automations/[id]/activate           fresh CS CONTROL   cs-comms-control  COMMS_AUTOMATION_ACTIVATED
 *   POST  /automations/[id]/pause              fresh CS WRITE     cs-comms-write    COMMS_AUTOMATION_PAUSED
 *   POST  /automations/[id]/disable            fresh CS WRITE     cs-comms-write    COMMS_AUTOMATION_DISABLED
 *   POST  /test-send                           fresh CS WRITE     cs-comms-test     COMMS_TEST_SEND
 *
 * Every write requires a reason (v1 §3.5; v1.1 §0.2) and audits in the same
 * transaction as its change. Every response is Cache-Control: no-store; a
 * throw is 503 UNAVAILABLE with a fixed message.
 */

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { parseOperatorReason, type recordOperatorAction, type OperatorReason } from "@/lib/audit";
import { AuditAction } from "@/lib/audit-actions";
import { getCatalogDefinition } from "@/lib/notifications/catalog/definitions";
import { NO_STORE } from "@/lib/notifications/catalog/http";
import { IN_APP_FIXTURES } from "@/lib/notifications/catalog/preview";
import type { CommsDefinition } from "@/lib/notifications/catalog/types";
import { decideRecipient, emailEnvironment } from "@/lib/email/recipient-guard";
import { PREVIEW_APP_BASE, previewCases } from "@/lib/email/preview";
import type { SendEmailFn } from "@/lib/email/send";
import { getNotificationDefinition, type NotificationTypeId } from "@/lib/notifications/registry";
import type { CreateNotificationResult, LedgerTag } from "@/lib/notifications/create";
import type { LiveContentResolver } from "@/lib/notifications/content/send";
import { emailDataFor } from "@/lib/notifications/channels/email";
import { DEFAULT_VARIANT, contentVariants, editableChannels, legSpec } from "@/lib/notifications/content/legs";
import { emailContent, textValues } from "@/lib/notifications/content/render";
import { bodyOf, type TemplateRow, type VersionRow } from "@/lib/notifications/content/store";
import { testSendFacts, viewerFor, type ContentAuth, type ContentServices } from "@/lib/notifications/content/http";
import type { LedgerWriter } from "@/lib/notifications/delivery/types";
import type { LedgerEnv } from "@/lib/notifications/delivery/record";
import type { NotificationRenderData } from "@/lib/notifications/types";
import { activationBlockers, ownerApprovalCurrent, resolveTarget, validateAutomationInput } from "./rules";
import { evaluateDryRun, type DryRunDeps } from "./dry-run";
import type * as Store from "./store";
import { AUTOMATION_STATES, type AutomationChannel, type AutomationDetail, type AutomationState, type DryRunResult } from "./types";

// ── Buckets (v1 §4.1, v1.1 §6.1) ─────────────────────────────────────────────

export const CS_COMMS_DRYRUN_BUCKET = "cs-comms-dryrun";
export const CS_COMMS_DRYRUN_LIMIT = { limit: 10, windowSec: 60 } as const;
export const CS_COMMS_TEST_BUCKET = "cs-comms-test";
export const CS_COMMS_TEST_LIMIT = { limit: 5, windowSec: 600 } as const;
export const AUTOMATION_BODY_MAX_BYTES = 32 * 1024;

// ── Services ──────────────────────────────────────────────────────────────────

export interface AutomationServices {
  store: Pick<typeof Store, "createAutomation" | "updateAutomation" | "recordDryRun" | "ownerApprove" | "activate" | "pause" | "disable"
    | "recordCancellations" | "readAutomation" | "readRun" | "latestRun" | "listAutomationRows" | "listRunRows" | "readHistory" | "factsOf" | "fieldsOf" | "toSummary" | "toRunDTO">;
  dryRun: DryRunDeps;
  /** B1 content services: heads (viewer facts), version reads (test send), self facts. */
  content: Pick<ContentServices, "readHeads" | "readVersion" | "readSelf" | "env">;
  liveContent: LiveContentResolver | null;
  ledger: LedgerWriter;
  ledgerEnv: LedgerEnv;
  sendEmail: SendEmailFn;
  createNotification(
    input: { type: NotificationTypeId; userId: string; data?: NotificationRenderData; expiresAt?: Date | null },
    ctx: { inAppOnly: true; ledgerTag: LedgerTag; ledger?: LedgerWriter; content?: LiveContentResolver | null },
  ): Promise<CreateNotificationResult>;
  /** Writes ONE audit row in its own transaction (test send: the audit precedes the send). */
  auditTestSend(row: Parameters<typeof recordOperatorAction>[1]): Promise<string>;
}

type Meta = { ip?: string | null; userAgent?: string | null };

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });
const validation = (error: string) => json({ error, code: "VALIDATION" }, 400);
const notFound = (error = "No automation with that id.") => json({ error, code: "NOT_FOUND" }, 404);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isVersion = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 1_000_000_000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function actorOf(auth: ContentAuth, meta: Meta): Store.AutomationActor {
  return { userId: auth.user.id, via: auth.grant ? "PLATFORM_GRANT" : "SYSTEM_ADMIN", ipAddress: meta.ip ?? null, userAgent: meta.userAgent ?? null };
}

/** v1 §3.5 — { reason, expectedVersion?, body }. The reason is REQUIRED on every B2 write. */
function envelope(raw: unknown, opts: { version: "required" | "optional" }): { ok: true; reason: OperatorReason; expectedVersion: number | undefined; body: Record<string, unknown> } | { ok: false; res: Response } {
  if (!isObj(raw)) return { ok: false, res: validation("Body must be { reason, expectedVersion?, body }.") };
  for (const k of Object.keys(raw)) if (!["reason", "expectedVersion", "body"].includes(k)) return { ok: false, res: validation(`Unknown field ${k.slice(0, 40)}.`) };
  if (raw.reason === undefined || raw.reason === null) return { ok: false, res: validation("A reason { code, note? } is required.") };
  const reason = parseOperatorReason(raw.reason); // throws OperatorActionValidationError → 400
  if (opts.version === "required" && !isVersion(raw.expectedVersion)) return { ok: false, res: validation("expectedVersion must be a non-negative integer.") };
  if (raw.expectedVersion !== undefined && !isVersion(raw.expectedVersion)) return { ok: false, res: validation("expectedVersion must be a non-negative integer.") };
  const body = raw.body === undefined ? {} : raw.body;
  if (!isObj(body)) return { ok: false, res: validation("body must be an object.") };
  return { ok: true, reason, expectedVersion: raw.expectedVersion as number | undefined, body };
}

function refusal(r: { code: string; error: string; current?: number; blockers?: unknown[] }): Response {
  const status = r.code === "NOT_FOUND" ? 404 : r.code === "VALIDATION" ? 400 : 409;
  return json({ error: r.error, code: r.code, ...(r.current !== undefined ? { current: r.current } : {}), ...(r.blockers ? { activationBlockers: r.blockers } : {}) }, status);
}

// ── Detail ────────────────────────────────────────────────────────────────────

async function liveContentOf(svc: AutomationServices, def: CommsDefinition, variant: string, channels: AutomationChannel[]): Promise<AutomationDetail["liveContent"]> {
  const out: AutomationDetail["liveContent"] = [];
  for (const channel of channels) {
    let v: Awaited<ReturnType<LiveContentResolver>> = null;
    if (svc.liveContent && legSpec(def.key, channel)) { try { v = await svc.liveContent({ definitionKey: def.key, channel, variant }); } catch { v = null; } }
    out.push({ channel, source: v ? "PUBLISHED" : "CODE_DEFAULT", versionId: v?.versionId ?? null });
  }
  return out;
}

export async function automationDetail(row: Store.AutomationRow, auth: ContentAuth, now: Date, svc: AutomationServices) {
  const def = getCatalogDefinition(row.definitionKey);
  const [last, dry, history, send, heads] = await Promise.all([
    svc.store.latestRun(row.id),
    svc.store.readRun(row.lastDryRunId),
    svc.store.readHistory(row.id),
    testSendFacts(auth, svc.content),
    def && editableChannels(def).length > 0 ? svc.content.readHeads(def.key) : Promise.resolve([] as Array<TemplateRow & { publishedCount: number }>),
  ]);
  const f = svc.store.fieldsOf(row);
  const dryOk = dry && dry.automationId === row.id && dry.mode === "DRY_RUN" ? dry : null;
  return {
    ...svc.store.toSummary(row, last),
    description: f.description,
    conditions: f.conditions,
    recipient: f.recipient,
    delay: f.delayMinutes ? { minutes: f.delayMinutes } : null,
    dedupeKeyTemplate: f.dedupeKeyTemplate,
    frequencyCap: { max: f.frequencyCapMax, perHours: f.frequencyCapHours },
    retryPolicy: f.retryPolicy,
    maxRecipientsPerRun: f.maxRecipientsPerRun,
    history,
    variant: row.variant,
    customerFacing: row.customerFacing,
    ownerApproval: row.ownerApprovedVersion !== null && row.ownerApprovedDefinitionVersion !== null && row.ownerApprovedAt
      ? { approvedVersion: row.ownerApprovedVersion, approvedDefinitionVersion: row.ownerApprovedDefinitionVersion, approvedAt: row.ownerApprovedAt.toISOString(), current: def ? ownerApprovalCurrent(row, def) : false }
      : null,
    lastDryRun: dryOk ? { runId: dryOk.id, at: dryOk.startedAt.toISOString(), automationVersion: dryOk.automationVersion, wouldExceedMaxRecipients: dryOk.error === "WOULD_EXCEED_MAX_RECIPIENTS" } : null,
    activationBlockers: def ? activationBlockers(svc.store.factsOf(row, dryOk), def, now) : ["DEFINITION_NOT_ACTIVATABLE" as const],
    liveContent: def ? await liveContentOf(svc, def, row.variant, f.channels) : [],
    viewer: def ? viewerFor(auth, def, { contentEditable: editableChannels(def).length > 0, hasRollbackTarget: heads.some((h) => h.publishedCount > 0) }, send) : null,
  } satisfies AutomationDetail & { viewer: unknown };
}

export async function detailHandler(id: string, auth: ContentAuth, now: Date, svc: AutomationServices): Promise<Response> {
  const row = await svc.store.readAutomation(id);
  if (!row) return notFound();
  return json(await automationDetail(row, auth, now, svc));
}

// ── Lists ─────────────────────────────────────────────────────────────────────

const enc = (at: Date, id: string) => Buffer.from(JSON.stringify({ t: at.toISOString(), i: id }), "utf8").toString("base64url");
function dec(c: string): { at: Date; id: string } | null {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(c)) return null;
  try {
    const v = JSON.parse(Buffer.from(c, "base64url").toString("utf8")) as { t?: unknown; i?: unknown };
    const at = typeof v.t === "string" ? new Date(v.t) : null;
    return at && !Number.isNaN(at.getTime()) && typeof v.i === "string" && ID_RE.test(v.i) ? { at, id: v.i } : null;
  } catch { return null; }
}

function paging(url: URL, allowed: string[]): { ok: true; limit: number; before: { at: Date; id: string } | null } | { ok: false; res: Response } {
  const p = url.searchParams;
  for (const name of p.keys()) if (!allowed.includes(name)) return { ok: false, res: validation(`Unknown parameter ${name.slice(0, 40)}.`) };
  const raw = p.get("limit");
  const limit = raw === null ? 50 : /^\d{1,3}$/.test(raw) ? Number(raw) : NaN;
  if (!(limit >= 1 && limit <= 100)) return { ok: false, res: validation("limit must be an integer from 1 to 100.") };
  const c = p.get("cursor");
  const before = c === null ? null : dec(c);
  if (c !== null && !before) return { ok: false, res: validation("Invalid cursor.") };
  return { ok: true, limit, before };
}

export async function listHandler(url: URL, now: Date, svc: AutomationServices): Promise<Response> {
  const pg = paging(url, ["state", "cursor", "limit"]);
  if (!pg.ok) return pg.res;
  const state = url.searchParams.get("state");
  if (state !== null && !(AUTOMATION_STATES as readonly string[]).includes(state)) return validation("state must be DRAFT, ACTIVE, PAUSED or DISABLED.");
  const rows = await svc.store.listAutomationRows({ state: state as AutomationState | null, before: pg.before, limit: pg.limit });
  const page = rows.slice(0, pg.limit);
  const items = await Promise.all(page.map(async (r) => svc.store.toSummary(r, await svc.store.latestRun(r.id))));
  const lastRow = page[page.length - 1];
  return json({
    items, checkedAt: now.toISOString(),
    nextCursor: rows.length > pg.limit && lastRow ? enc(lastRow.updatedAt, lastRow.id) : null,
    limit: pg.limit, floor: false, capped: false,
  });
}

export async function runsHandler(id: string, url: URL, now: Date, svc: AutomationServices): Promise<Response> {
  const row = await svc.store.readAutomation(id);
  if (!row) return notFound();
  const pg = paging(url, ["cursor", "limit"]);
  if (!pg.ok) return pg.res;
  const rows = await svc.store.listRunRows(row.id, { before: pg.before, limit: pg.limit });
  const page = rows.slice(0, pg.limit);
  const lastRow = page[page.length - 1];
  return json({
    items: page.map((r) => svc.store.toRunDTO(r)), checkedAt: now.toISOString(),
    nextCursor: rows.length > pg.limit && lastRow ? enc(lastRow.startedAt, lastRow.id) : null,
    limit: pg.limit, floor: false, capped: false,
  });
}

// ── POST /automations (create DRAFT) ─────────────────────────────────────────

export async function createHandler(raw: unknown, auth: ContentAuth, meta: Meta, now: Date, svc: AutomationServices): Promise<Response> {
  // Protection BEFORE validation (v1.1 §6.1, shape 5): a protected key never yields a validation hint.
  const target = resolveTarget(isObj(raw) ? raw.body : undefined, getCatalogDefinition);
  if (!target.ok && target.code === "PROTECTED") return refusal(target);
  const env = envelope(raw, { version: "optional" });
  if (!env.ok) return env.res;
  if (!target.ok) return refusal(target);
  const f = validateAutomationInput(env.body, { def: target.value.def, trigger: target.value.trigger });
  if (!f.ok) return refusal(f);
  const r = await svc.store.createAutomation({ def: target.value.def, trigger: target.value.trigger, fields: f.value, actor: actorOf(auth, meta), reason: env.reason });
  if (!r.ok) return refusal(r);
  return json({ ok: true, result: await automationDetail(r.value, auth, now, svc), auditLogId: r.auditLogId }, 201);
}

// ── PATCH /automations/[id] ──────────────────────────────────────────────────

export async function patchHandler(id: string, raw: unknown, auth: ContentAuth, meta: Meta, now: Date, svc: AutomationServices): Promise<Response> {
  const row = await svc.store.readAutomation(id);
  if (!row) return notFound();
  const def = getCatalogDefinition(row.definitionKey);
  if (def?.protected) return refusal({ code: "PROTECTED", error: "This message is protected: it cannot be automated." });
  const env = envelope(raw, { version: "required" });
  if (!env.ok) return env.res;
  if (!def) return refusal({ code: "INVALID_STATE", error: "The automation's definition no longer exists." });
  const r = await svc.store.updateAutomation({
    id: row.id, expectedVersion: env.expectedVersion!, actor: actorOf(auth, meta), reason: env.reason,
    fields: (cur) => {
      const v = validateAutomationInput(env.body, { def, trigger: cur.triggerKey as Parameters<typeof validateAutomationInput>[1]["trigger"], existing: svc.store.fieldsOf(cur) });
      return v.ok ? v.value : { error: v.error };
    },
  });
  if (!r.ok) return refusal(r);
  return json({ ok: true, result: await automationDetail(r.value, auth, now, svc), auditLogId: r.auditLogId });
}

// ── POST /automations/[id]/dry-run (§6.8) ────────────────────────────────────

export async function dryRunHandler(id: string, raw: unknown, auth: ContentAuth, meta: Meta, now: Date, svc: AutomationServices): Promise<Response> {
  const row = await svc.store.readAutomation(id);
  if (!row) return notFound();
  const def = getCatalogDefinition(row.definitionKey);
  if (def?.protected) return refusal({ code: "PROTECTED", error: "This message is protected: it cannot be automated." });
  const env = envelope(raw, { version: "optional" });
  if (!env.ok) return env.res;
  for (const k of Object.keys(env.body)) if (k !== "sample" && k !== "window") return validation(`Unknown field ${k.slice(0, 40)}.`);
  const w = env.body.window ?? "7d";
  if (w !== "7d" && w !== "30d") return validation("body.window must be 7d or 30d.");
  const sample = env.body.sample;
  if (sample !== undefined && (!isObj(sample) || Object.keys(sample).some((k) => k !== "triggerRef") || (sample.triggerRef !== undefined && (typeof sample.triggerRef !== "string" || !ID_RE.test(sample.triggerRef))))) {
    return validation("body.sample must be { triggerRef? }.");
  }
  if (!def) return refusal({ code: "INVALID_STATE", error: "The automation's definition no longer exists." });
  const ref = isObj(sample) && typeof sample.triggerRef === "string" ? sample.triggerRef : null;
  const evaluation = await evaluateDryRun(svc.dryRun, row, def, ref ? { triggerRef: ref } : { window: w }, now);
  if ("notFound" in evaluation) return notFound("No recorded trigger fact with that ref for this automation's trigger.");
  const r = await svc.store.recordDryRun({ id: row.id, ...(env.expectedVersion !== undefined ? { expectedVersion: env.expectedVersion } : {}), evaluation, actor: actorOf(auth, meta), reason: env.reason, now });
  if (!r.ok) return refusal(r);
  const blockers = activationBlockers(svc.store.factsOf(r.value.row, r.value.run), def, now);
  const result: DryRunResult = {
    runId: r.value.run.id,
    // C8 — echo the window actually replayed; null for a single triggerRef.
    window: evaluation.window ? { window: w, from: evaluation.window.from.toISOString().slice(0, 10), to: evaluation.window.to.toISOString().slice(0, 10) } : null,
    counts: evaluation.counts,
    deduped: evaluation.deduped,
    lifecycle: evaluation.lifecycle,
    content: evaluation.content,
    examples: evaluation.examples,
    wouldExceedMaxRecipients: evaluation.wouldExceedMaxRecipients,
    activationBlockers: blockers,
    floor: evaluation.floor,
    checkedAt: now.toISOString(),
  };
  return json({ ok: true, result: { ...result, ...(evaluation.haltReason ? { haltReason: evaluation.haltReason } : {}) }, auditLogId: r.auditLogId });
}

// ── State transitions + owner approval ───────────────────────────────────────

type Transition = "ACTIVATE" | "PAUSE" | "DISABLE" | "OWNER_APPROVAL";

export async function transitionHandler(kind: Transition, id: string, raw: unknown, auth: ContentAuth, meta: Meta, now: Date, svc: AutomationServices): Promise<Response> {
  const row = await svc.store.readAutomation(id);
  if (!row) return notFound();
  const def = getCatalogDefinition(row.definitionKey);
  // pause / disable REDUCE sending and stay possible on anything; activation and approval refuse a protected definition.
  if ((kind === "ACTIVATE" || kind === "OWNER_APPROVAL") && def?.protected) return refusal({ code: "PROTECTED", error: "This message is protected: it cannot be automated." });
  const env = envelope(raw, { version: "required" });
  if (!env.ok) return env.res;
  if (Object.keys(env.body).length > 0) return validation("body must be {}.");
  const input = { id: row.id, expectedVersion: env.expectedVersion!, actor: actorOf(auth, meta), reason: env.reason, now };
  if (kind === "ACTIVATE") {
    const r = await svc.store.activate(input);
    if (!r.ok) return refusal(r);
    return json({ ok: true, result: await automationDetail(r.value, auth, now, svc), auditLogId: r.auditLogId });
  }
  if (kind === "OWNER_APPROVAL") {
    const r = await svc.store.ownerApprove(input);
    if (!r.ok) return refusal(r);
    return json({ ok: true, result: await automationDetail(r.value, auth, now, svc), auditLogId: r.auditLogId });
  }
  const r = kind === "PAUSE" ? await svc.store.pause(input) : await svc.store.disable(input);
  if (!r.ok) return refusal(r);
  await svc.store.recordCancellations(svc.ledger, svc.ledgerEnv, r.value.row.definitionKey, r.value.cancelled);
  return json({ ok: true, result: await automationDetail(r.value.row, auth, now, svc), auditLogId: r.auditLogId });
}

// ── POST /test-send (§6.9) ───────────────────────────────────────────────────

export async function testSendHandler(raw: unknown, auth: ContentAuth, meta: Meta, now: Date, svc: AutomationServices): Promise<Response> {
  const b = isObj(raw) && isObj(raw.body) ? raw.body : null;
  // The request carries no recipient of any kind: the server resolves SELF.
  if (b) for (const k of Object.keys(b)) {
    if (!["key", "channel", "variant", "versionId", "fixture"].includes(k)) return validation(`Unknown field ${k.slice(0, 40)}: a test send goes only to your own account.`);
  }
  const key = b && typeof b.key === "string" ? b.key : null;
  const def = key ? getCatalogDefinition(key) : undefined;
  // versionId on a protected key → 409 PROTECTED, before validation of the rest.
  if (def?.protected && b && b.versionId !== undefined) return refusal({ code: "PROTECTED", error: "This message is protected: only its code content can be test-sent." });
  const env = envelope(raw, { version: "optional" });
  if (!env.ok) return env.res;
  if (!key) return validation("body.key is required.");
  if (!def) return refusal({ code: "NOT_FOUND", error: "No catalog definition has that key." });
  const channel = b!.channel;
  if (channel !== "EMAIL" && channel !== "IN_APP") return validation("body.channel must be EMAIL or IN_APP.");
  const leg = def.channels.find((c) => c.channel === channel);
  if (!leg) return refusal({ code: "INVALID_STATE", error: `This message has no ${channel} leg.` });
  const variant = b!.variant === undefined ? DEFAULT_VARIANT : b!.variant;
  if (typeof variant !== "string" || !/^[a-z0-9-]{1,80}$/.test(variant)) return validation("Unknown variant.");
  const fixture = b!.fixture === undefined ? null : b!.fixture;
  if (fixture !== null && (typeof fixture !== "string" || !/^[a-z0-9-]{1,120}$/.test(fixture))) return validation("Unknown fixture.");
  const versionId = b!.versionId === undefined ? null : b!.versionId;
  if (versionId !== null && (typeof versionId !== "string" || !ID_RE.test(versionId))) return validation("versionId must be a version id.");

  // The recipient: the operator's OWN verified address — and outside Production only if THAT address is allowlisted.
  const facts = await testSendFacts(auth, svc.content);
  if (!facts.testSendEligible) {
    return json({
      error: facts.testSendIneligibleReason === "SELF_UNVERIFIED"
        ? "Your account email is not verified, so a test cannot be sent to it."
        : "Outside Production a test can only go to an allowlisted address, and yours is not on the list. Nothing was sent.",
      code: "GUARD_REFUSED", guard: facts.testSendIneligibleReason,
    }, 422);
  }
  const self = await svc.content.readSelf(auth.user.id);
  if (!self?.email || !self.verified) return json({ error: "Your account email is not verified, so a test cannot be sent to it.", code: "GUARD_REFUSED", guard: "SELF_UNVERIFIED" }, 422);
  if (emailEnvironment(svc.content.env) !== "production" && !decideRecipient(self.email, svc.content.env).deliver) {
    return json({ error: "Outside Production a test can only go to an allowlisted address. Nothing was sent.", code: "GUARD_REFUSED", guard: "NONPROD_ALLOWLIST" }, 422);
  }

  // Content: a named version of this key's stream, or the live content.
  let version: { version: VersionRow; head: TemplateRow } | null = null;
  if (versionId) {
    version = await svc.content.readVersion(def.key, versionId);
    if (!version) return notFound("No version with that id for this definition.");
    if (version.head.channel !== channel) return refusal({ code: "INVALID_STATE", error: "That version belongs to another channel." });
  }
  const contentVariant = version?.head.variant ?? (contentVariants(def.key).includes(variant) ? variant : DEFAULT_VARIANT);
  const resolver: LiveContentResolver | null = version
    ? async (s) => (s.channel === channel && s.variant === contentVariant ? { versionId: version!.version.id, body: bodyOf(version!.version) } : null)
    : svc.liveContent;

  const deliveryId = randomUUID();
  const reg = def.notificationTypeId ? getNotificationDefinition(def.notificationTypeId) : undefined;
  const fixtures = def.notificationTypeId ? IN_APP_FIXTURES[def.notificationTypeId] : undefined;
  const fixtureName = fixture ?? (fixtures ? (fixtures[contentVariant] ? contentVariant : Object.keys(fixtures)[0]) : null);

  // Plan the send before the audit, so a request that cannot render is refused un-audited and unsent.
  type Plan = { kind: "IN_APP"; data: Record<string, unknown> } | { kind: "REGISTRY_EMAIL"; data: Record<string, unknown> } | { kind: "DIRECT_EMAIL"; template: Parameters<SendEmailFn>[0]; data: Record<string, unknown> };
  let plan: Plan;
  if (channel === "IN_APP" || leg.path === "REGISTRY") {
    if (!reg || !fixtures || !fixtureName || !fixtures[fixtureName]) return validation("Unknown fixture.");
    plan = channel === "IN_APP" ? { kind: "IN_APP", data: { ...fixtures[fixtureName] } } : { kind: "REGISTRY_EMAIL", data: { ...fixtures[fixtureName] } };
  } else {
    if (versionId) return refusal({ code: "PROTECTED", error: "This leg's content is code-only." });
    const slugs = leg.previewSlugs ?? [];
    const slug = fixture ?? slugs[0];
    const pc = slug && slugs.includes(slug) ? previewCases().find((c) => c.slug === slug) : undefined;
    if (!pc) return validation("Unknown fixture.");
    plan = { kind: "DIRECT_EMAIL", template: pc.template, data: pc.data };
  }

  // The audit row is a PRECONDITION of the send (v1.1 §9.2): written first, in its own transaction.
  const auditLogId = await svc.auditTestSend({
    actor: { userId: auth.user.id, via: auth.grant ? "PLATFORM_GRANT" : "SYSTEM_ADMIN", area: "CUSTOMER_SUCCESS" },
    action: AuditAction.COMMS_TEST_SEND,
    target: { kind: "COMMS_TEST_SEND", id: `${def.key}:${channel}` },
    reason: env.reason,
    result: "SUCCESS",
    detail: { deliveryId, key: def.key, channel, variant: contentVariant, versionId, fixture: fixtureName ?? null, recipient: "SELF" },
    ipAddress: meta.ip ?? null, userAgent: meta.userAgent ?? null,
  });

  if (plan.kind === "IN_APP") {
    const res = await svc.createNotification(
      { type: def.notificationTypeId as NotificationTypeId, userId: auth.user.id, data: { ...plan.data, _commsTest: true } as NotificationRenderData, expiresAt: new Date(now.getTime() + 24 * 3_600_000) },
      { inAppOnly: true, ledgerTag: { messageKey: deliveryId, mode: "TEST" }, ledger: svc.ledger, content: resolver },
    );
    const status = res.status === "created" ? "ACCEPTED" : res.status === "error" ? "FAILED" : "SUPPRESSED";
    return json({ ok: true, result: { deliveryId, status, provider: res.status === "created" ? "in-app" : null, contentVersionId: version?.version.id ?? null }, auditLogId });
  }

  let templateName: Parameters<SendEmailFn>[0];
  let data: Record<string, unknown>;
  let contentVersionId: string | null = null;
  if (plan.kind === "REGISTRY_EMAIL") {
    const code = reg!.render(plan.data as NotificationRenderData);
    const spec = legSpec(def.key, "EMAIL");
    let live: { versionId: string; content: ReturnType<typeof emailContent> } | null = null;
    if (spec && resolver) {
      const v = await resolver({ definitionKey: def.key, channel: "EMAIL", variant: contentVariant }).catch(() => null);
      if (v) { try { live = { versionId: v.versionId, content: emailContent(spec, v.body, textValues(spec, "SAMPLE"), contentVariant, PREVIEW_APP_BASE) }; } catch { live = null; } }
    }
    const built = emailDataFor({
      userId: auth.user.id, email: self.email, type: def.key, category: reg!.category, priority: reg!.priority, title: code.title,
      ...(code.body ? { body: code.body } : {}), ...(code.href ? { href: code.href } : {}), ...(code.actionLabel ? { actionLabel: code.actionLabel } : {}),
      ...(live ? { emailContent: live } : {}),
    }, PREVIEW_APP_BASE);
    templateName = "notification";
    data = { ...built.data, preview: true };
    contentVersionId = built.contentVersionId;
  } else {
    templateName = plan.template;
    data = plan.data;
  }
  const result = await svc.sendEmail(templateName, self.email, data, {
    key: def.key, recipientUserId: auth.user.id, messageKey: deliveryId, mode: "TEST", ...(contentVersionId ? { contentVersionId } : {}),
  });
  const status = result.status === "sent" ? "ACCEPTED" : result.status === "captured" ? "CAPTURED" : result.status === "skipped" ? "SUPPRESSED" : "FAILED";
  return json({ ok: true, result: { deliveryId, status, provider: result.provider || null, contentVersionId }, auditLogId });
}

