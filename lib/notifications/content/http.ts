/**
 * lib/notifications/content/http.ts  (Comms Center B1 — the content endpoints, contract v1.1 §3, §4)
 *
 * Handlers behind injected services, so tests run the SAME code the routes run
 * over the in-memory Prisma fake and a fake AI client. The route files under
 * app/api/platform/customer-success/notifications/catalog/[key]/ name the gate
 * and the bucket where the route-guard census can see them.
 *
 * ORDER in every write handler (§3, with protection before validation so a
 * protected template never yields a validation hint):
 *   gate (401/403) → bucket (429) → key (404) → definition lock (409 PROTECTED /
 *   NOT_EDITABLE) → version (404) → leg lock (409) → body (400) → work.
 *
 *   GET  /catalog/[key]/versions                     CS READ     cs-comms-read
 *   POST /catalog/[key]/versions                     fresh WRITE cs-comms-write    COMMS_TEMPLATE_DRAFT_SAVED
 *   GET  /catalog/[key]/versions/[id]                CS READ     cs-comms-read
 *   POST /catalog/[key]/versions/[id]/publish        fresh CONTROL + reason        COMMS_TEMPLATE_PUBLISHED
 *   POST /catalog/[key]/versions/[id]/rollback       fresh CONTROL + reason        COMMS_TEMPLATE_ROLLED_BACK
 *   POST /catalog/[key]/versions/[id]/ai-suggest     fresh WRITE cs-comms-ai       COMMS_TEMPLATE_AI_SUGGESTED
 *   POST /catalog/[key]/render                       CS READ     cs-comms-render   (persists nothing, audits nothing)
 *   GET  /catalog/[key]/preview?versionId=           CS READ     cs-comms-read     (synthetic only)
 *
 * Every response carries Cache-Control: no-store. A throw is 503 UNAVAILABLE
 * with a fixed message (the error is never echoed).
 */

import { NextResponse } from "next/server";
import { UserRole } from "@prisma/client";
import { decidePlatformAccess } from "@/lib/platform/authorize";
import { OperatorActionValidationError, parseOperatorReason, type OperatorReason } from "@/lib/audit";
import { getCatalogDefinition } from "@/lib/notifications/catalog/definitions";
import { EMAIL_TEMPLATE_VERSIONS, IN_APP_TEMPLATE_VERSION } from "@/lib/notifications/catalog/definitions";
import { NO_STORE, contractRefusal, catalogPreview, toCatalogDetail, toCatalogItem, unobservedSeries } from "@/lib/notifications/catalog/http";
import { previewVariants } from "@/lib/notifications/catalog/preview";
import { PREVIEW_CHANNELS, type CatalogDetail, type CatalogItem, type CommsDefinition, type DaySeries, type PreviewChannel } from "@/lib/notifications/catalog/types";
import { PREVIEW_APP_BASE } from "@/lib/email/preview";
import { decideRecipient, emailEnvironment, type RecipientGuardEnv } from "@/lib/email/recipient-guard";
import type { PaidRequestsAdmission } from "@/lib/platform/ai/paid-requests-admission";
import type { GlobalCostFreezeVerdict } from "@/lib/platform/cost-freeze.core";
import { NOTIFICATION_REGISTRY } from "@/lib/notifications/registry";
import { ACTIVATION_DISABLED_REASON, AUTOMATION_ACTIVATION_ENABLED } from "@/lib/notifications/automations/types";
import {
  AI_SUGGEST_MODES, AI_TONES, EDITABLE_CHANNELS,
  type AiAvailability, type AiSuggestMode, type AiSuggestResult, type AiTone, type AiUnavailableReason, type CatalogContentLeg,
  type ContentBody, type ContentIssue, type ContentLimits, type ContentStreamRef, type EditableChannel, type RollbackUnavailableReason, type TemplateVersionDTO, type Viewer, type VersionsResponse,
} from "./types";
import {
  DEFAULT_VARIANT, LIMITS, contentVariants, definitionLock, divergesFrom, editableChannels, legEditability, legSpec, placeholderViews, type LegSpec,
} from "./legs";
import { BLOCK_KINDS_BY_CHANNEL, hasErrors, parseContentBody, placeholdersUsed, validateContent } from "./validate";
import { iconOf, renderContentEmail, inAppRender, textValues } from "./render";
import { AI_RESPONSE_SCHEMA, SUGGESTION_TTL_MS, buildAiRequest, checkSuggestion, cleanNotes, diffContent, normaliseSuggestion } from "./ai";
import { secondsToUtcMidnight, type AuthoringReservation, type AuthoringVerdict } from "./ai-allowance";
import type { ContentWriteResult, SaveDraftInput, PublishInput, RollbackInput, SuggestionRowInput, TemplateRow, VersionRow, ContentActor } from "./store";
import { CODE_DEFAULT_ID, bodyOf, contentHash, currentIssues, stateOf, toVersionDTO } from "./store";

// ── Buckets (§3.1) ───────────────────────────────────────────────────────────

export const CS_COMMS_RENDER_BUCKET = "cs-comms-render";
export const CS_COMMS_RENDER_LIMIT = { limit: 30, windowSec: 60 } as const;
export const CS_COMMS_WRITE_BUCKET = "cs-comms-write";
export const CS_COMMS_WRITE_LIMIT = { limit: 20, windowSec: 60 } as const;
export const CS_COMMS_AI_BUCKET = "cs-comms-ai";
export const CS_COMMS_AI_LIMIT = { limit: 10, windowSec: 600 } as const;
export const CS_COMMS_CONTROL_BUCKET = "cs-comms-control";
export const CS_COMMS_CONTROL_LIMIT = { limit: 10, windowSec: 60 } as const;

/** §3.8 — the render body cap; every other POST body is capped at twice that. */
export const RENDER_BODY_MAX_BYTES = 32 * 1024;
export const WRITE_BODY_MAX_BYTES = 64 * 1024;

// ── Shapes ────────────────────────────────────────────────────────────────────

export interface ContentAuth {
  user: { id: string; role: UserRole | string };
  /** null exactly when access came from the SYSTEM_ADMIN break-glass bypass. */
  grant: { area: string; level: string } | null;
}

export interface ContentRouteDeps {
  guard: () => Promise<[ContentAuth, null] | [null, Response]>;
  rateLimit: (userId: string) => Promise<Response | null>;
  now?: () => Date;
}

export interface AiServices {
  admission(): Promise<PaidRequestsAdmission>;
  freeze(): Promise<GlobalCostFreezeVerdict>;
  readAllowance(operatorId: string, now: Date): Promise<AuthoringVerdict>;
  reserve(operatorId: string, now: Date): Promise<AuthoringReservation>;
  /** The ONE model call, inside the AI invocation context (surface comms_authoring). Throws on any provider failure. */
  call(args: { suggestionId: string; operatorId: string; mode: AiSuggestMode; system: string; messages: Array<{ role: "user"; content: string }>; schema: typeof AI_RESPONSE_SCHEMA }): Promise<{ value: unknown; model: string }>;
  newId(): string;
}

export interface ContentServices {
  readStream(s: ContentStreamRef): Promise<TemplateRow | null>;
  listVersionRows(templateId: string): Promise<VersionRow[]>;
  readVersion(key: string, id: string): Promise<{ version: VersionRow; head: TemplateRow } | null>;
  readHeads(key: string): Promise<Array<TemplateRow & { publishedCount: number }>>;
  liveVersionNumber(head: TemplateRow | null): Promise<number | null>;
  saveDraft(input: SaveDraftInput): Promise<ContentWriteResult<{ version: VersionRow; head: TemplateRow }>>;
  publishVersion(input: PublishInput): Promise<ContentWriteResult<{ version: VersionRow; head: TemplateRow; superseded: { versionId: string; version: number } | null }>>;
  rollbackVersion(input: RollbackInput): Promise<ContentWriteResult<{ published: { version: VersionRow } | null; head: TemplateRow; superseded: { versionId: string; version: number } | null }>>;
  recordSuggestion(stream: ContentStreamRef, row: SuggestionRowInput, actor: ContentActor, reason: OperatorReason | undefined): Promise<string>;
  /** The session operator's own address facts (test-send eligibility). Null when unreadable. */
  readSelf(userId: string): Promise<{ email: string | null; verified: boolean } | null>;
  env: RecipientGuardEnv;
  ai: AiServices;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => NextResponse.json(body, { status, headers: { ...NO_STORE, ...headers } });
const validation = (error: string) => json({ error, code: "VALIDATION" }, 400);
const notFound = (error = "No catalog definition has that key.") => json({ error, code: "NOT_FOUND" }, 404);
const unavailable = () => json({ error: "The notification content is unavailable.", code: "UNAVAILABLE" }, 503);
const locked = (reason: "PROTECTED" | "NOT_EDITABLE") => json(
  reason === "PROTECTED"
    ? { error: "This message is protected: its content cannot be edited.", code: "PROTECTED" }
    : { error: "This message's content is not editable.", code: "NOT_EDITABLE" },
  409,
);

/** Gate → bucket → work, passing the auth on. Every refusal leaves in the contract shape; a throw is 503. */
export async function runContent(deps: ContentRouteDeps, work: (auth: ContentAuth, now: Date) => Response | Promise<Response>): Promise<Response> {
  const [auth, err] = await deps.guard();
  if (err) return contractRefusal(err);
  const limited = await deps.rateLimit(auth.user.id);
  if (limited) return contractRefusal(limited);
  try {
    return await work(auth, (deps.now ?? (() => new Date()))());
  } catch (e) {
    if (e instanceof OperatorActionValidationError) return validation(e.message);
    return unavailable();
  }
}

/** Read a JSON body under a byte cap. */
export async function readJsonBody(req: Request, maxBytes: number): Promise<{ ok: true; value: unknown } | { ok: false; res: Response }> {
  let text: string;
  try { text = await req.text(); } catch { return { ok: false, res: validation("The request body could not be read.") }; }
  if (Buffer.byteLength(text, "utf8") > maxBytes) return { ok: false, res: validation(`The request body is larger than ${maxBytes} bytes.`) };
  if (text.trim() === "") return { ok: true, value: {} };
  try { return { ok: true, value: JSON.parse(text) as unknown }; } catch { return { ok: false, res: validation("The request body is not JSON.") }; }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isRevision = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 1_000_000_000;
const VARIANT_RE = /^[a-z0-9-]{1,80}$/;
const VERSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function actorOf(auth: ContentAuth, meta: { ip?: string | null; userAgent?: string | null }): ContentActor {
  return { userId: auth.user.id, via: auth.grant ? "PLATFORM_GRANT" : "SYSTEM_ADMIN", ipAddress: meta.ip ?? null, userAgent: meta.userAgent ?? null };
}

function parseReason(raw: unknown, required: boolean): OperatorReason | undefined {
  if (raw === undefined || raw === null) {
    if (required) throw new OperatorActionValidationError("A reason { code, note? } is required.");
    return undefined;
  }
  return parseOperatorReason(raw);
}

// ── The viewer block (§1.1, D2, D6a) ─────────────────────────────────────────

function hasLevel(auth: ContentAuth, level: "READ" | "WRITE" | "CONTROL"): boolean {
  const role = auth.user.role as UserRole;
  const grants = auth.grant ? [{ area: auth.grant.area, level: auth.grant.level, status: "ACTIVE" }] : [];
  return decidePlatformAccess(role, "CUSTOMER_SUCCESS", level, grants as never);
}

export async function testSendFacts(auth: ContentAuth, svc: Pick<ContentServices, "readSelf" | "env">): Promise<Pick<Viewer, "testSendEligible" | "testSendIneligibleReason">> {
  let self: { email: string | null; verified: boolean } | null = null;
  try { self = await svc.readSelf(auth.user.id); } catch { self = null; }
  if (!self || !self.verified || !self.email) return { testSendEligible: false, testSendIneligibleReason: "SELF_UNVERIFIED" };
  // Production: verified ⇒ eligible. Elsewhere: only whether THIS address is on the allowlist (nothing about the list).
  if (emailEnvironment(svc.env) !== "production" && !decideRecipient(self.email, svc.env).deliver) {
    return { testSendEligible: false, testSendIneligibleReason: "NONPROD_ALLOWLIST" };
  }
  return { testSendEligible: true, testSendIneligibleReason: null };
}

/** PURE — the flags, from the operator's level and the resource facts (§1.1 derivations). */
export function viewerFor(auth: ContentAuth, def: CommsDefinition, facts: { contentEditable: boolean; hasRollbackTarget: boolean },
  send: Pick<Viewer, "testSendEligible" | "testSendIneligibleReason">, activationEnabled: boolean = AUTOMATION_ACTIVATION_ENABLED): Viewer {
  const write = hasLevel(auth, "WRITE");
  const control = hasLevel(auth, "CONTROL");
  const customerFacing = def.audience !== "OPERATOR_INBOX" && def.audience !== "PLATFORM_STAFF";
  const deliverLeg = def.channels.some((c) => c.channel === "EMAIL" || c.channel === "IN_APP");
  const canRollback = control && facts.contentEditable && facts.hasRollbackTarget;
  // v1.1.1 — permission (incl. a locked leg) is reported before "nothing to restore".
  const rollbackUnavailableReason: RollbackUnavailableReason | null = canRollback ? null
    : !control || !facts.contentEditable ? "NO_PERMISSION" : "NOTHING_TO_RESTORE";
  return {
    canEditContent: write && facts.contentEditable,
    canPublish: control && facts.contentEditable,
    canRollback,
    ...(rollbackUnavailableReason ? { rollbackUnavailableReason } : {}),
    canAiSuggest: write && facts.contentEditable,
    canTestSend: write && deliverLeg,
    canEditAutomation: write && def.editable && !def.protected,
    canDryRun: write && def.editable,
    // Comms Center B2 — the activation hard gate (automations/types.ts): false while activation is disabled.
    canActivate: control && def.editable && activationEnabled,
    activationDisabledReason: activationEnabled ? null : ACTIVATION_DISABLED_REASON,
    canApproveAsOwner: auth.user.role === UserRole.SYSTEM_ADMIN && customerFacing && def.editable,
    canPauseDisable: write,
    ...send,
  };
}

// ── The ai availability block (§3.2, D4) ─────────────────────────────────────

type Gate = { ok: true; remainingCalls: number; remainingUsd: number | null } | { ok: false; reason: Exclude<AiUnavailableReason, "PROVIDER">; detail: string; retryAfterSeconds?: number };

/** §4.5 checks 1–3, in order. Never throws: a reader failure is that check's fail-closed reason. */
async function gateChecks(ai: AiServices, operatorId: string, now: Date, allowance: "READ" | AuthoringReservation): Promise<Gate> {
  let adm: PaidRequestsAdmission;
  try { adm = await ai.admission(); } catch { adm = { paused: true, state: "UNAVAILABLE", raw: null, cause: "UNAVAILABLE" }; }
  if (adm.paused) return { ok: false, reason: "KILL_SWITCH", detail: adm.cause ?? (adm.state === "UNAVAILABLE" ? "UNAVAILABLE" : "KILL_SWITCH") };
  let fr: GlobalCostFreezeVerdict;
  try { fr = await ai.freeze(); } catch { fr = { frozen: true, state: "UNAVAILABLE", reason: "POLICY_UNAVAILABLE" }; }
  if (fr.frozen) return { ok: false, reason: "COST_FREEZE", detail: fr.state === "ON" ? "FROZEN" : "UNVERIFIED" };
  let v: AuthoringVerdict;
  if (allowance === "READ") {
    try { v = await ai.readAllowance(operatorId, now); } catch { v = { allowed: false, detail: "UNAVAILABLE", remainingCalls: 0, remainingUsd: null }; }
  } else {
    v = allowance.verdict;
  }
  if (!v.allowed) return { ok: false, reason: "ALLOWANCE", detail: v.detail, retryAfterSeconds: secondsToUtcMidnight(now) };
  return { ok: true, remainingCalls: v.remainingCalls, remainingUsd: v.remainingUsd };
}

export async function aiAvailability(ai: AiServices, operatorId: string, now: Date): Promise<AiAvailability> {
  const g = await gateChecks(ai, operatorId, now, "READ");
  return g.ok
    ? { available: true, remainingCallsToday: g.remainingCalls, remainingUsdToday: g.remainingUsd, checkedAt: now.toISOString() }
    : { available: false, reason: g.reason, detail: g.detail, checkedAt: now.toISOString() };
}

// ── Common resolution ────────────────────────────────────────────────────────

type DefLookup = { ok: true; def: CommsDefinition } | { ok: false; res: Response };

/** key → 404, then the whole-definition lock → 409. */
function writableDef(key: string): DefLookup {
  const def = getCatalogDefinition(key);
  if (!def) return { ok: false, res: notFound() };
  const lock = definitionLock(def);
  if (lock) return { ok: false, res: locked(lock.reason) };
  return { ok: true, def };
}

function streamOf(head: TemplateRow): ContentStreamRef {
  return { definitionKey: head.definitionKey, channel: head.channel as EditableChannel, variant: head.variant };
}

function refusal(r: Extract<ContentWriteResult<unknown>, { ok: false }>): Response {
  const status = r.code === "NOT_FOUND" ? 404 : r.code === "CONTENT_INVALID" || r.code === "VALIDATION" ? 400 : 409;
  return json({ error: r.error, code: r.code, ...(r.current !== undefined ? { current: r.current } : {}), ...(r.issues ? { issues: r.issues } : {}) }, status);
}

// ── GET /catalog/[key]/versions (§3.2) ───────────────────────────────────────

/** §3.2 `limits` (v1.1.1 per-block) — the very numbers validateContent enforces; null where the block kind is not allowed. */
export function limitsFor(channel: EditableChannel): ContentLimits {
  const L = LIMITS[channel];
  const blockLimit = (kind: "hero" | "info", n: number) => (BLOCK_KINDS_BY_CHANNEL[channel].has(kind) ? n : null);
  return {
    blocks: L.blocks, subject: L.subject, preheader: L.preheader, paragraph: L.paragraph, ctaLabel: L.ctaLabel,
    heading: blockLimit("hero", L.heading), greeting: blockLimit("hero", L.greeting),
    infoTitle: blockLimit("info", L.infoTitle), infoItems: blockLimit("info", L.infoItems), infoItem: blockLimit("info", L.infoItem),
  };
}

function encodeCursor(version: number) { return Buffer.from(JSON.stringify({ v: version }), "utf8").toString("base64url"); }
function decodeCursor(c: string): number | null {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(c)) return null;
  try { const v = (JSON.parse(Buffer.from(c, "base64url").toString("utf8")) as { v?: unknown }).v; return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null; } catch { return null; }
}

export async function versionsList(key: string, url: URL, auth: ContentAuth, now: Date, svc: ContentServices): Promise<Response> {
  const def = getCatalogDefinition(key);
  if (!def) return notFound();
  const p = url.searchParams;
  for (const name of p.keys()) if (!["channel", "variant", "state", "cursor", "limit"].includes(name)) return validation(`Unknown parameter ${name.slice(0, 40)}.`);
  const editable = editableChannels(def);
  const rawChannel = p.get("channel");
  if (rawChannel !== null && !(EDITABLE_CHANNELS as readonly string[]).includes(rawChannel)) return validation("channel must be EMAIL or IN_APP.");
  if (rawChannel === null && editable.length > 1) return validation("channel is required for this definition.");
  const channel = (rawChannel ?? editable[0] ?? (def.channels.some((c) => c.channel === "EMAIL") ? "EMAIL" : "IN_APP")) as EditableChannel;
  const variant = p.get("variant") ?? DEFAULT_VARIANT;
  if (!VARIANT_RE.test(variant)) return validation("Unknown variant.");
  const state = p.get("state");
  if (state !== null && !["DRAFT", "PUBLISHED", "SUPERSEDED"].includes(state)) return validation("state must be DRAFT, PUBLISHED or SUPERSEDED.");
  const limitRaw = p.get("limit");
  const limit = limitRaw === null ? 50 : /^\d{1,3}$/.test(limitRaw) ? Number(limitRaw) : NaN;
  if (!(limit >= 1 && limit <= 100)) return validation("limit must be an integer from 1 to 100.");
  const cursorRaw = p.get("cursor");
  const before = cursorRaw === null ? null : decodeCursor(cursorRaw);
  if (cursorRaw !== null && before === null) return validation("Invalid cursor.");

  const leg = legEditability(def, channel);
  const spec = leg.editable ? legSpec(key, channel) : undefined;
  if (spec && !spec.variants.includes(variant)) return validation("Unknown variant.");
  const stream: ContentStreamRef = { definitionKey: def.key, channel, variant };

  const [head, ai, send] = await Promise.all([
    spec ? svc.readStream(stream) : Promise.resolve(null),
    aiAvailability(svc.ai, auth.user.id, now),
    testSendFacts(auth, svc),
  ]);
  const rows = head ? await svc.listVersionRows(head.id) : [];
  const all = rows.filter((r) => state === null || stateOf(r, head) === state).filter((r) => before === null || r.version < before);
  const items = all.slice(0, limit).map((r) => toVersionDTO(r, head!, spec));
  const liveNumber = await svc.liveVersionNumber(head);
  const hasRollbackTarget = rows.some((r) => r.publishedAt !== null);
  const codeDefault = spec ? spec.codeDefault(variant) : { subject: "", preheader: null, blocks: [] };
  const body: VersionsResponse = {
    items,
    checkedAt: now.toISOString(),
    nextCursor: all.length > limit && items.length > 0 ? encodeCursor(items[items.length - 1].version) : null,
    limit,
    floor: false,
    capped: false,
    stream,
    revision: head?.revision ?? 0,
    live: head?.publishedVersionId && liveNumber !== null ? { source: "PUBLISHED", versionId: head.publishedVersionId, version: liveNumber } : { source: "CODE_DEFAULT" },
    codeDefault: { ...codeDefault, placeholdersUsed: spec ? placeholdersUsed(codeDefault, channel) : [] },
    placeholders: spec ? placeholderViews(spec) : [],
    limits: limitsFor(channel),
    contentEditable: Boolean(spec),
    locked: leg.editable ? null : { reason: leg.reason },
    viewer: viewerFor(auth, def, { contentEditable: Boolean(spec), hasRollbackTarget }, send),
    ai,
  };
  return json(body);
}

// ── GET /catalog/[key]/versions/[id] ─────────────────────────────────────────

export async function versionGet(key: string, id: string, svc: ContentServices): Promise<Response> {
  if (!getCatalogDefinition(key)) return notFound();
  const found = VERSION_ID_RE.test(id) ? await svc.readVersion(key, id) : null;
  if (!found) return notFound("No version with that id for this definition.");
  return json(toVersionDTO(found.version, found.head, legSpec(key, found.head.channel)) satisfies TemplateVersionDTO);
}

// ── POST /catalog/[key]/versions (§3.3) ──────────────────────────────────────

export async function saveDraftHandler(key: string, raw: unknown, auth: ContentAuth, meta: { ip?: string | null; userAgent?: string | null }, now: Date, svc: ContentServices): Promise<Response> {
  const d = writableDef(key);
  if (!d.ok) return d.res;
  // Leg protection BEFORE validation: read the channel leniently.
  const rawBody = isObj(raw) && isObj(raw.body) ? raw.body : null;
  const ch = rawBody && typeof rawBody.channel === "string" ? rawBody.channel : null;
  if (ch !== null && (EDITABLE_CHANNELS as readonly string[]).includes(ch)) {
    const leg = legEditability(d.def, ch);
    if (!leg.editable) return locked(leg.reason);
  }
  if (!isObj(raw) || !rawBody) return validation("Body must be { expectedRevision, body: { channel, variant?, parentVersionId, content, source }, reason? }.");
  if (ch === null || !(EDITABLE_CHANNELS as readonly string[]).includes(ch)) return validation("body.channel must be EMAIL or IN_APP.");
  if (!isRevision(raw.expectedRevision)) return validation("expectedRevision must be a non-negative integer.");
  const variant = rawBody.variant === undefined ? DEFAULT_VARIANT : rawBody.variant;
  if (typeof variant !== "string" || !contentVariants(key).includes(variant)) return validation("Unknown variant.");
  const parent = rawBody.parentVersionId;
  if (parent !== null && (typeof parent !== "string" || !VERSION_ID_RE.test(parent))) return validation("parentVersionId must be a version id or null.");
  const src = rawBody.source;
  if (!isObj(src) || (src.kind !== "MANUAL" && !(src.kind === "AI_SUGGESTION" && typeof src.suggestionId === "string" && VERSION_ID_RE.test(src.suggestionId)))) {
    return validation("source must be { kind: \"MANUAL\" } or { kind: \"AI_SUGGESTION\", suggestionId }.");
  }
  const content = parseContentBody(rawBody.content);
  if (!content.ok) return validation(content.error);
  const reason = parseReason(raw.reason, false);

  const r = await svc.saveDraft({
    stream: { definitionKey: d.def.key, channel: ch as EditableChannel, variant },
    expectedRevision: raw.expectedRevision,
    parentVersionId: parent as string | null,
    content: content.value,
    source: src.kind === "MANUAL" ? { kind: "MANUAL" } : { kind: "AI_SUGGESTION", suggestionId: src.suggestionId as string },
    ...(reason ? { reason } : {}),
    actor: actorOf(auth, meta),
    now,
  });
  if (!r.ok) return refusal(r);
  const dto = toVersionDTO(r.value.version, r.value.head, legSpec(key, ch));
  return json({ success: true, result: dto, auditLogId: dto.auditLogId }, 201);
}

// ── Version-scoped writes: shared resolution ─────────────────────────────────

async function writableVersion(key: string, id: string, svc: ContentServices): Promise<{ ok: true; def: CommsDefinition; version: VersionRow; head: TemplateRow } | { ok: false; res: Response }> {
  const d = writableDef(key);
  if (!d.ok) return d;
  if (id === CODE_DEFAULT_ID) return { ok: false, res: notFound("No version with that id for this definition.") };
  const found = VERSION_ID_RE.test(id) ? await svc.readVersion(key, id) : null;
  if (!found) return { ok: false, res: notFound("No version with that id for this definition.") };
  const leg = legEditability(d.def, found.head.channel);
  if (!leg.editable) return { ok: false, res: locked(leg.reason) };
  return { ok: true, def: d.def, ...found };
}

// ── POST /catalog/[key]/versions/[id]/publish (§3.4) ─────────────────────────

export async function publishHandler(key: string, id: string, raw: unknown, auth: ContentAuth, meta: { ip?: string | null; userAgent?: string | null }, now: Date, svc: ContentServices): Promise<Response> {
  const w = await writableVersion(key, id, svc);
  if (!w.ok) return w.res;
  if (!isObj(raw)) return validation("Body must be { reason, expectedRevision, body: { acknowledgeWarnings } }.");
  if (!isRevision(raw.expectedRevision)) return validation("expectedRevision must be a non-negative integer.");
  const ack = isObj(raw.body) ? raw.body.acknowledgeWarnings : undefined;
  if (typeof ack !== "boolean") return validation("body.acknowledgeWarnings must be a boolean.");
  const reason = parseReason(raw.reason, true)!;
  const r = await svc.publishVersion({ key, versionId: id, expectedRevision: raw.expectedRevision, acknowledgeWarnings: ack, reason, actor: actorOf(auth, meta), now });
  if (!r.ok) return refusal(r);
  const spec = legSpec(key, r.value.head.channel);
  const published = toVersionDTO(r.value.version, r.value.head, spec);
  return json({
    success: true,
    result: { published, superseded: r.value.superseded ?? { source: "CODE_DEFAULT" }, revision: r.value.head.revision },
    auditLogId: published.publishAuditLogId,
  });
}

// ── POST /catalog/[key]/versions/[id]/rollback (§3.5) ────────────────────────

export async function rollbackHandler(key: string, id: string, raw: unknown, auth: ContentAuth, meta: { ip?: string | null; userAgent?: string | null }, now: Date, svc: ContentServices): Promise<Response> {
  let stream: ContentStreamRef | undefined;
  if (id === CODE_DEFAULT_ID) {
    const d = writableDef(key);
    if (!d.ok) return d.res;
    const b = isObj(raw) && isObj(raw.body) ? raw.body : {};
    const ch = typeof b.channel === "string" ? b.channel : (editableChannels(d.def).length === 1 ? editableChannels(d.def)[0] : null);
    if (ch !== null && (EDITABLE_CHANNELS as readonly string[]).includes(ch)) {
      const leg = legEditability(d.def, ch);
      if (!leg.editable) return locked(leg.reason);
    }
    if (ch === null || !(EDITABLE_CHANNELS as readonly string[]).includes(ch)) return validation("body.channel must be EMAIL or IN_APP.");
    const variant = b.variant === undefined ? DEFAULT_VARIANT : b.variant;
    if (typeof variant !== "string" || !contentVariants(key).includes(variant)) return validation("Unknown variant.");
    stream = { definitionKey: d.def.key, channel: ch as EditableChannel, variant };
  } else {
    const w = await writableVersion(key, id, svc);
    if (!w.ok) return w.res;
  }
  if (!isObj(raw)) return validation("Body must be { reason, expectedRevision, body? }.");
  if (!isRevision(raw.expectedRevision)) return validation("expectedRevision must be a non-negative integer.");
  const reason = parseReason(raw.reason, true)!;
  const r = await svc.rollbackVersion({ key, versionId: id, ...(stream ? { stream } : {}), expectedRevision: raw.expectedRevision, reason, actor: actorOf(auth, meta), now });
  if (!r.ok) return refusal(r);
  const spec = legSpec(key, r.value.head.channel);
  return json({
    success: true,
    result: {
      published: r.value.published ? toVersionDTO(r.value.published.version, r.value.head, spec) : { source: "CODE_DEFAULT" },
      superseded: r.value.superseded,
      revision: r.value.head.revision,
    },
  });
}

// ── POST /catalog/[key]/versions/[id]/ai-suggest (§4.3) ──────────────────────

/** Typed 503 (§4.5): always AI_UNAVAILABLE, so the UI has a single branch. */
function aiUnavailable(reason: AiUnavailableReason, detail: string, retryAfterSeconds?: number): Response {
  return json(
    { error: "AI assistance is unavailable right now. Manual editing still works.", code: "AI_UNAVAILABLE", reason, detail, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) },
    503,
    retryAfterSeconds ? { "Retry-After": String(retryAfterSeconds) } : {},
  );
}

/** Classify a provider throw (names, not instanceof, so this module stays free of the SDK). */
function providerOutcome(e: unknown): { reason: "KILL_SWITCH" | "PROVIDER"; detail: string; retryAfter?: number } {
  const name = typeof e === "object" && e !== null && typeof (e as { name?: unknown }).name === "string" ? (e as { name: string }).name : "";
  if (name === "AiPausedError") {
    const cause = (e as { denialCause?: unknown }).denialCause;
    return { reason: "KILL_SWITCH", detail: typeof cause === "string" && /^[A-Z_]{1,20}$/.test(cause) ? cause : "KILL_SWITCH" };
  }
  if (name === "UnpricedModelError") return { reason: "PROVIDER", detail: "UNPRICED_MODEL" };
  if (name === "StructuredOutputTimeoutError" || /abort|timeout/i.test(name)) return { reason: "PROVIDER", detail: "TIMEOUT" };
  if (name === "StructuredOutputRefusalError") return { reason: "PROVIDER", detail: "REFUSED" };
  const status = (e as { status?: unknown } | null)?.status;
  const code = (e as { code?: unknown } | null)?.code;
  if (code === "insufficient_quota") return { reason: "PROVIDER", detail: "QUOTA" };
  if (status === 429) return { reason: "PROVIDER", detail: "RATE_LIMITED", retryAfter: 60 };
  return { reason: "PROVIDER", detail: "FAILED" };
}

export async function aiSuggestHandler(key: string, id: string, raw: unknown, auth: ContentAuth, meta: { ip?: string | null; userAgent?: string | null }, now: Date, svc: ContentServices): Promise<Response> {
  const w = await writableVersion(key, id, svc);
  if (!w.ok) return w.res;
  const b = isObj(raw) && isObj(raw.body) ? raw.body : null;
  if (!b || !(AI_SUGGEST_MODES as readonly string[]).includes(String(b.mode))) return validation("body.mode must be POLISH or CHECK.");
  if (b.tone !== undefined && !(AI_TONES as readonly string[]).includes(String(b.tone))) return validation("body.tone must be NEUTRAL, WARM or CONCISE.");
  const mode = b.mode as AiSuggestMode;
  const tone = (b.tone as AiTone | undefined) ?? "NEUTRAL";
  const reason = parseReason((raw as Record<string, unknown>).reason, false);
  const spec = legSpec(key, w.head.channel) as LegSpec;
  const stream = streamOf(w.head);
  const base = bodyOf(w.version);
  const actor = actorOf(auth, meta);
  const suggestionId = svc.ai.newId();
  const expiresAt = new Date(now.getTime() + SUGGESTION_TTL_MS);
  const rowBase = { id: suggestionId, templateId: w.head.id, baseVersionId: w.version.id, mode, tone: mode === "POLISH" ? tone : null, expiresAt };

  const unavailableRow = async (r: AiUnavailableReason, detail: string, retryAfter?: number) => {
    await svc.recordSuggestion(stream, { ...rowBase, status: "UNAVAILABLE", unavailableReason: r, unavailableDetail: detail }, actor, reason);
    return aiUnavailable(r, detail, retryAfter);
  };

  // §4.5 checks 1–2 (no reservation taken yet), then the reservation (check 3).
  const pre = await gateChecks(svc.ai, auth.user.id, now, { verdict: { allowed: true, remainingCalls: 0, remainingUsd: null }, release: async () => {} });
  if (!pre.ok) return unavailableRow(pre.reason, pre.detail, pre.retryAfterSeconds);
  const reservation = await svc.ai.reserve(auth.user.id, now);
  try {
    if (!reservation.verdict.allowed) return await unavailableRow("ALLOWANCE", reservation.verdict.detail, secondsToUtcMidnight(now));

    const request = buildAiRequest(base, placeholdersUsed(base, spec.channel), mode, tone);
    let value: unknown;
    let model: string;
    try {
      const out = await svc.ai.call({ suggestionId, operatorId: auth.user.id, mode, system: request.system, messages: request.messages as Array<{ role: "user"; content: string }>, schema: AI_RESPONSE_SCHEMA });
      value = out.value;
      model = out.model;
    } catch (e) {
      const o = providerOutcome(e);
      return await unavailableRow(o.reason, o.detail, o.retryAfter);
    }

    const norm = normaliseSuggestion(value, base);
    const issues: ContentIssue[] = norm.ok ? checkSuggestion(spec, w.head.variant, base, norm.body) : norm.issues;
    if (issues.length > 0 || !norm.ok) {
      await svc.recordSuggestion(stream, { ...rowBase, status: "REJECTED", rejectionCodes: [...new Set(issues.map((i) => i.code))], model }, actor, reason);
      // The rejected text is never returned and never stored.
      return json({ error: "The AI suggestion did not pass the content checks and was discarded.", code: "SUGGESTION_REJECTED", suggestionId, issues }, 422);
    }
    const notes = cleanNotes(norm.rawNotes, base);
    const hash = contentHash(norm.body);
    await svc.recordSuggestion(stream, { ...rowBase, status: "OFFERED", suggestedContent: norm.body, suggestedHash: hash, notes, model }, actor, reason);
    const result: AiSuggestResult = {
      suggestionId,
      baseVersionId: w.version.id,
      mode,
      base,
      suggestion: norm.body,
      changes: diffContent(spec, base, norm.body),
      notes,
      checks: { structurePreserved: true, placeholdersPreserved: true, linksAdded: false, financialClaimsAdded: false, adviceAdded: false },
      model,
      expiresAt: expiresAt.toISOString(),
      checkedAt: now.toISOString(),
    };
    return json(result);
  } finally {
    await reservation.release();
  }
}

// ── Rendering for preview / render (synthetic only) ──────────────────────────

const SOURCE_OF: Record<PreviewChannel, EditableChannel | null> = { "email-html": "EMAIL", "email-text": "EMAIL", "in-app": "IN_APP", operator: null, banner: null };

/** Synthetic render of a body for a preview channel. Throws when the content cannot render. */
function renderSynthetic(spec: LegSpec, def: CommsDefinition, body: ContentBody, variant: string, channel: PreviewChannel) {
  const values = textValues(spec, "SAMPLE");
  if (spec.channel === "EMAIL") {
    const reg = NOTIFICATION_REGISTRY[spec.key];
    const r = renderContentEmail({ spec, body, values, variant, appBaseUrl: PREVIEW_APP_BASE, category: reg.category, preview: true });
    if (!r.subject.startsWith("[PREVIEW]")) throw new Error("content preview: subject is not marked [PREVIEW]");
    return { subject: r.subject, html: channel === "email-text" ? null : r.html, text: r.text, inApp: null };
  }
  const r = inAppRender(spec, body, values, variant);
  void def;
  return { subject: null, html: null, text: r.body ?? null, inApp: { title: r.title, body: r.body ?? null, href: r.href ?? null, icon: iconOf(spec) } };
}

/** A preview variant name (in-app fixture / email preview slug) → the content variant it shows. */
export function contentVariantOfPreview(key: string, previewVariant: string): string | null {
  const vs = contentVariants(key);
  let v = previewVariant.replace(/^notification--/, "");
  if (vs.includes(v)) return v;
  v = v.replace(/^(connection|wallet)-/, "");
  return vs.includes(v) ? v : null;
}

// ── GET /catalog/[key]/preview?versionId= (§3.7) ─────────────────────────────

export async function previewHandler(key: string, url: URL, now: Date, svc: Pick<ContentServices, "readVersion" | "readStream">): Promise<Response> {
  const def = getCatalogDefinition(key);
  if (!def) return notFound();
  const p = url.searchParams;
  for (const name of p.keys()) if (!["channel", "variant", "versionId"].includes(name)) return validation("Only channel, variant and versionId are accepted.");
  const channel = p.get("channel");
  if (channel === null || !(PREVIEW_CHANNELS as readonly string[]).includes(channel)) return validation(`channel must be one of ${PREVIEW_CHANNELS.join(", ")}.`);
  const pc = channel as PreviewChannel;
  const variantParam = p.get("variant");
  if (variantParam !== null && !VARIANT_RE.test(variantParam)) return validation("Unknown preview variant.");
  const versionId = p.get("versionId");
  const source = SOURCE_OF[pc];
  const variants = previewVariants(def, pc);
  const templateVersion = source === "EMAIL" ? EMAIL_TEMPLATE_VERSIONS.notification : IN_APP_TEMPLATE_VERSION;

  const answer = (spec: LegSpec, version: VersionRow, variant: string) => {
    let rendered;
    try { rendered = renderSynthetic(spec, def, bodyOf(version), variant, pc); }
    catch { return json({ error: "This version could not be rendered.", code: "RENDER" }, 503); }
    return json({
      key: def.key, definitionVersion: def.definitionVersion, templateVersion, channel: pc, synthetic: true, ...rendered,
      variants, checkedAt: now.toISOString(), versionId: version.id, source: "VERSION", issues: currentIssues(spec, bodyOf(version), variant),
    });
  };

  if (versionId !== null) {
    if (!VERSION_ID_RE.test(versionId)) return notFound("No version with that id for this definition.");
    const found = await svc.readVersion(key, versionId);
    if (!found) return notFound("No version with that id for this definition.");
    if (source !== found.head.channel) return json({ error: "That version belongs to another channel.", code: "INVALID_STATE" }, 409);
    if (variantParam !== null && contentVariantOfPreview(key, variantParam) !== found.head.variant) return json({ error: "That version belongs to another variant.", code: "INVALID_STATE" }, 409);
    const spec = legSpec(key, found.head.channel);
    if (!spec) return json({ error: "This message's content is not editable.", code: "INVALID_STATE" }, 409);
    return answer(spec, found.version, found.head.variant);
  }

  // No versionId: the LIVE content — the published version, or the code default.
  const spec = source ? legSpec(key, source) : undefined;
  if (spec && variants.length > 0) {
    const chosen = variantParam ?? variants[0];
    const cv = contentVariantOfPreview(key, chosen);
    if (cv !== null) {
      const head = await svc.readStream({ definitionKey: def.key, channel: spec.channel, variant: cv });
      if (head?.publishedVersionId) {
        const found = await svc.readVersion(key, head.publishedVersionId);
        if (found) return answer(spec, found.version, cv);
      }
    }
  }
  const code = catalogPreview(key, url, now);
  if (code.status !== 200) return code;
  const bodyJson = (await code.json()) as Record<string, unknown>;
  return json({ ...bodyJson, versionId: null, source: "CODE_DEFAULT", issues: [] });
}

// ── POST /catalog/[key]/render (§3.8) ────────────────────────────────────────

export function renderHandler(key: string, raw: unknown, now: Date): Response {
  const def = getCatalogDefinition(key);
  if (!def) return notFound();
  const lock = definitionLock(def);
  if (lock) return locked(lock.reason);
  const ch = isObj(raw) && typeof raw.channel === "string" ? raw.channel : null;
  if (ch !== null && (EDITABLE_CHANNELS as readonly string[]).includes(ch)) {
    const leg = legEditability(def, ch);
    if (!leg.editable) return locked(leg.reason);
  }
  if (!isObj(raw) || ch === null || !(EDITABLE_CHANNELS as readonly string[]).includes(ch)) return validation("Body must be { channel: EMAIL | IN_APP, variant?, content }.");
  for (const k of Object.keys(raw)) if (!["channel", "variant", "content"].includes(k)) return validation("Body must be { channel, variant?, content }.");
  const variant = raw.variant === undefined ? DEFAULT_VARIANT : raw.variant;
  if (typeof variant !== "string" || !contentVariants(key).includes(variant)) return validation("Unknown variant.");
  const parsed = parseContentBody(raw.content);
  if (!parsed.ok) return validation(parsed.error);
  const spec = legSpec(key, ch) as LegSpec;
  const issues = validateContent(spec, parsed.value, { mode: "manual", baseline: spec.codeDefault(variant), variant });
  const pc: PreviewChannel = ch === "EMAIL" ? "email-html" : "in-app";
  let rendered: { subject: string | null; html: string | null; text: string | null; inApp: unknown } = { subject: null, html: null, text: null, inApp: null };
  try { rendered = renderSynthetic(spec, def, parsed.value, variant, pc); } catch { /* not renderable: html/text/inApp stay null; the issues say why */ }
  return json({
    key: def.key, definitionVersion: def.definitionVersion,
    templateVersion: ch === "EMAIL" ? EMAIL_TEMPLATE_VERSIONS.notification : IN_APP_TEMPLATE_VERSION,
    channel: pc, synthetic: true, ...rendered, variants: contentVariants(key), checkedAt: now.toISOString(),
    versionId: null, source: "UNSAVED", issues,
  });
}

// ── GET /catalog/[key] additions (§1, §1.1, §2.1) ────────────────────────────

/** The DTO's supportedActions plus the v1.1 content actions (DTO only; definitions are unchanged). */
export function contentActions(def: CommsDefinition): CatalogItem["supportedActions"] {
  return editableChannels(def).length > 0 ? [...def.supportedActions, "EDIT_CONTENT", "AI_SUGGEST"] : [...def.supportedActions];
}

/** Per editable leg: its variants and what is live (from the heads read). */
export function contentLegs(def: CommsDefinition, heads: ReadonlyArray<TemplateRow & { liveVersion?: number | null }>): CatalogContentLeg[] {
  return editableChannels(def).map((channel) => ({
    channel,
    variants: contentVariants(def.key),
    live: contentVariants(def.key).map((variant) => {
      const h = heads.find((x) => x.channel === channel && x.variant === variant);
      return h?.publishedVersionId && typeof h.liveVersion === "number"
        ? { variant, source: "PUBLISHED" as const, versionId: h.publishedVersionId, version: h.liveVersion }
        : { variant, source: "CODE_DEFAULT" as const };
    }),
  }));
}

export async function catalogDetailV11(key: string, now: Date, auth: ContentAuth, svc: ContentServices, recentFor?: (key: string, now: Date) => Promise<DaySeries>): Promise<Response> {
  const def = getCatalogDefinition(key);
  if (!def) return notFound();
  const editable = editableChannels(def).length > 0;
  const [recent, heads, send] = await Promise.all([
    recentFor ? recentFor(def.key, now) : Promise.resolve(unobservedSeries(now)),
    editable ? svc.readHeads(def.key) : Promise.resolve([]),
    testSendFacts(auth, svc),
  ]);
  const withLive = await Promise.all(heads.map(async (h) => ({ ...h, liveVersion: await svc.liveVersionNumber(h) })));
  const base: CatalogDetail = toCatalogDetail(def, now, recent);
  const div = divergesFrom(def.key);
  return json({
    ...base,
    supportedActions: contentActions(def),
    content: contentLegs(def, withLive),
    contentLocked: !editable,
    ...(div ? { divergesFrom: div } : {}),
    viewer: viewerFor(auth, def, { contentEditable: editable, hasRollbackTarget: heads.some((h) => h.publishedCount > 0) }, send),
  });
}

/** The list DTO additions (§1 CatalogItemV11), from ONE read of every published head. */
export function catalogItemV11(def: CommsDefinition, published: ReadonlyArray<TemplateRow & { liveVersion?: number | null }>): CatalogItem & { content: CatalogContentLeg[]; contentLocked: boolean } {
  return {
    ...toCatalogItem(def),
    supportedActions: contentActions(def),
    content: contentLegs(def, published.filter((h) => h.definitionKey === def.key)),
    contentLocked: editableChannels(def).length === 0,
  };
}

export { hasErrors };
