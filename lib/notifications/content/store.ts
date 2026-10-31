/**
 * lib/notifications/content/store.ts  (Comms Center B1 — the content store and its ONE mutation service)
 *
 * Contract v1.1 §3.3–§3.5, §5.4, §8.1, §9.2. fm_system (systemDb): the content
 * tables are revoked from fm_app and fm_auth; operators write through here and
 * the send path reads the live version through here.
 *
 *   saveDraft        COMMS_TEMPLATE_DRAFT_SAVED   a NEW immutable DRAFT version
 *   publishVersion   COMMS_TEMPLATE_PUBLISHED     a DRAFT becomes live (CONTROL + reason)
 *   rollbackVersion  COMMS_TEMPLATE_ROLLED_BACK   a NEW version copied from a SUPERSEDED
 *                                                 one and published, or `code-default`
 *   recordSuggestion COMMS_TEMPLATE_AI_SUGGESTED  the CommsAiSuggestion row
 *
 * THE GUARANTEES (pinned by store.test.ts):
 *   · ONE transaction per operation, under
 *     pg_advisory_xact_lock(hashtext('comms-template:<key>:<channel>:<variant>')),
 *     with ONE recordOperatorAction row written FIRST (its id is stored on the
 *     version) — the change and its audit commit together or not at all.
 *   · OPTIMISTIC TOKEN: `expectedRevision` ≠ the head's `revision` ⇒ CONFLICT
 *     with `current`, and nothing is written. Every write bumps `revision`.
 *   · VERSIONS ARE IMMUTABLE: this module only CREATES CommsTemplateVersion rows;
 *     its only update is `publishedAt` / `publishAuditLogId`, once, guarded by
 *     `publishedAt IS NULL` (the only columns fm_system may UPDATE).
 *   · Audit `change` / `detail` hold ids, versions, content HASHES, codes and
 *     counts — never the text.
 *   · The live-content cache (30 s) is invalidated after every commit.
 */

import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { systemDb } from "@/lib/db";
import { AuditAction } from "@/lib/audit-actions";
import { recordOperatorAction, type OperatorReason } from "@/lib/audit";
import type { ContentBlock, ContentBody, ContentIssue, ContentStreamRef, EditableChannel, TemplateVersionDTO, VersionCreatedByKind, VersionState } from "./types";
import { legSpec, streamId, type LegSpec } from "./legs";
import type { LiveVersion, LiveContentResolver } from "./send";
import { VALIDATOR_VERSION, hasErrors, placeholdersUsed, validateContent, warningsOf } from "./validate";

// ── Shapes ────────────────────────────────────────────────────────────────────

type Tx = Prisma.TransactionClient;
/** The client surface: a Prisma client (systemDb) or the in-memory fake installed over it. */
export interface ContentDb { $transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> }
const DB = (): ContentDb & Tx => systemDb as unknown as ContentDb & Tx;

export interface ContentActor { userId: string; via: "PLATFORM_GRANT" | "SYSTEM_ADMIN"; ipAddress?: string | null; userAgent?: string | null }

export type ContentRefusalCode =
  | "CONFLICT" | "NOT_FOUND" | "INVALID_STATE" | "STALE_DRAFT" | "CONTENT_INVALID" | "WARNINGS_UNACKNOWLEDGED"
  | "SUGGESTION_EXPIRED" | "VALIDATION";

export type ContentWriteResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ContentRefusalCode; error: string; current?: number; issues?: ContentIssue[] };

type Refusal = Extract<ContentWriteResult<never>, { ok: false }>;
const refuse = (code: ContentRefusalCode, error: string, extra: { current?: number; issues?: ContentIssue[] } = {}): Refusal => ({ ok: false, code, error, ...extra });

/** Thrown inside a transaction to ROLL BACK and answer a refusal. */
class RefusalRollback extends Error {
  constructor(readonly refusal: Refusal) { super(refusal.error); this.name = "RefusalRollback"; }
}
const rollback = (r: Refusal): never => { throw new RefusalRollback(r); };

export interface TemplateRow {
  id: string; definitionKey: string; channel: string; variant: string;
  publishedVersionId: string | null; revision: number; headVersion: number;
}
export interface VersionRow {
  id: string; templateId: string; version: number; subject: string; preheader: string | null; blocks: unknown;
  placeholdersUsed: string[]; contentHash: string; validatorVersion: number; createdByKind: string; actorKind: string;
  createdById: string | null; parentVersionId: string | null; basePublishedVersionId: string | null;
  restoredFromVersionId: string | null; sourceSuggestionId: string | null; aiEditedAfterAccept: boolean | null;
  createdAuditLogId: string; publishedAt: Date | null; publishAuditLogId: string | null; createdAt: Date;
}

export const lockKey = (s: ContentStreamRef) => `comms-template:${streamId(s.definitionKey, s.channel, s.variant)}`;

/** sha256 of the canonical JSON of {subject, preheader, blocks}. */
export function contentHash(body: ContentBody): string {
  const canon = (b: ContentBlock) => {
    switch (b.kind) {
      case "hero": return { kind: b.kind, heading: b.heading, greeting: b.greeting ?? null };
      case "paragraph": return { kind: b.kind, text: b.text };
      case "cta": return { kind: b.kind, label: b.label, link: b.link };
      case "info": return { kind: b.kind, title: b.title ?? null, items: b.items, ordered: b.ordered ?? null };
      case "divider": return { kind: b.kind };
    }
  };
  return createHash("sha256").update(JSON.stringify({ subject: body.subject, preheader: body.preheader, blocks: body.blocks.map(canon) })).digest("hex");
}

export const bodyOf = (v: Pick<VersionRow, "subject" | "preheader" | "blocks">): ContentBody =>
  ({ subject: v.subject, preheader: v.preheader, blocks: (Array.isArray(v.blocks) ? v.blocks : []) as ContentBlock[] });

export function stateOf(v: Pick<VersionRow, "id" | "publishedAt">, head: Pick<TemplateRow, "publishedVersionId"> | null): VersionState {
  if (head?.publishedVersionId === v.id) return "PUBLISHED";
  return v.publishedAt ? "SUPERSEDED" : "DRAFT";
}

/** The current validator's issues for a stored body (warnings; errors only if the validator tightened). */
export function currentIssues(spec: LegSpec, body: ContentBody, variant: string): ContentIssue[] {
  return validateContent(spec, body, { mode: "manual", baseline: spec.codeDefault(variant), variant });
}

export function toVersionDTO(v: VersionRow, head: TemplateRow, spec: LegSpec | undefined): TemplateVersionDTO {
  const body = bodyOf(v);
  return {
    id: v.id,
    version: v.version,
    state: stateOf(v, head),
    subject: body.subject,
    preheader: body.preheader,
    blocks: body.blocks,
    placeholdersUsed: [...v.placeholdersUsed],
    createdBy: { kind: v.createdByKind as VersionCreatedByKind, actorKind: v.actorKind === "SYSTEM_ADMIN" ? "SYSTEM_ADMIN" : "PLATFORM_OPERATOR" },
    createdAt: v.createdAt.toISOString(),
    publishedAt: v.publishedAt ? v.publishedAt.toISOString() : null,
    auditLogId: v.createdAuditLogId,
    revision: head.revision,
    stream: { definitionKey: head.definitionKey, channel: head.channel as EditableChannel, variant: head.variant },
    publishAuditLogId: v.publishAuditLogId,
    parentVersionId: v.parentVersionId,
    basePublishedVersionId: v.basePublishedVersionId,
    restoredFromVersionId: v.restoredFromVersionId,
    sourceSuggestionId: v.sourceSuggestionId,
    aiEditedAfterAccept: v.aiEditedAfterAccept,
    issues: spec ? currentIssues(spec, body, head.variant) : [],
  };
}

const actorKind = (a: ContentActor) => (a.via === "SYSTEM_ADMIN" ? "SYSTEM_ADMIN" : "PLATFORM_OPERATOR");

async function audit(tx: Tx, actor: ContentActor, action: (typeof AuditAction)[keyof typeof AuditAction], stream: ContentStreamRef,
  change: { before: Record<string, unknown> | null; after: Record<string, unknown> | null }, detail: Record<string, unknown>, reason?: OperatorReason): Promise<string> {
  const { id } = await recordOperatorAction(tx as unknown as Parameters<typeof recordOperatorAction>[0], {
    actor: { userId: actor.userId, via: actor.via, area: "CUSTOMER_SUCCESS" },
    action,
    target: { kind: "COMMS_TEMPLATE", id: streamId(stream.definitionKey, stream.channel, stream.variant) },
    ...(reason ? { reason } : {}),
    change,
    result: "SUCCESS",
    detail,
    ipAddress: actor.ipAddress ?? null,
    userAgent: actor.userAgent ?? null,
  });
  if (!id) throw new Error("comms-content: the audit row returned no id");
  return id;
}

async function lock(tx: Tx, s: ContentStreamRef): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey(s)}))`;
}

const headWhere = (s: ContentStreamRef) => ({ definitionKey_channel_variant: { definitionKey: s.definitionKey, channel: s.channel, variant: s.variant } });

async function readHead(tx: Tx, s: ContentStreamRef): Promise<TemplateRow | null> {
  return (await tx.commsTemplate.findUnique({ where: headWhere(s) })) as TemplateRow | null;
}

/** Bump the head under the optimistic token; anything but exactly one row is a CONFLICT (rolled back). */
async function bumpHead(tx: Tx, head: TemplateRow, expectedRevision: number, data: { publishedVersionId?: string | null; headVersion?: number }): Promise<number> {
  const r = await tx.commsTemplate.updateMany({ where: { id: head.id, revision: expectedRevision }, data: { ...data, revision: { increment: 1 } } });
  if (r.count !== 1) rollback(refuse("CONFLICT", "Someone else changed this template — reload and review again.", { current: head.revision }));
  return expectedRevision + 1;
}

async function run<T>(client: ContentDb, fn: (tx: Tx) => Promise<ContentWriteResult<T>>): Promise<ContentWriteResult<T>> {
  try {
    const r = await client.$transaction(fn);
    if (r.ok) invalidateLiveContent();
    return r;
  } catch (e) {
    if (e instanceof RefusalRollback) return e.refusal;
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return refuse("CONFLICT", "Someone else changed this template at the same time — reload and review again.", { current: -1 });
    throw e;
  }
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export async function readStream(s: ContentStreamRef, client: Tx = DB()): Promise<TemplateRow | null> {
  return readHead(client, s);
}

/** Versions of a stream, newest first, keyset on version (desc). */
export async function listVersionRows(templateId: string, opts: { beforeVersion: number | null; limit: number }, client: Tx = DB()): Promise<VersionRow[]> {
  return (await client.commsTemplateVersion.findMany({
    where: { templateId, ...(opts.beforeVersion !== null ? { version: { lt: opts.beforeVersion } } : {}) },
    orderBy: { version: "desc" },
    take: opts.limit + 1,
  })) as VersionRow[];
}

/** A version and its head, when it belongs to `key`. */
export async function readVersion(key: string, id: string, client: Tx = DB()): Promise<{ version: VersionRow; head: TemplateRow } | null> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  const v = (await client.commsTemplateVersion.findUnique({ where: { id }, include: { template: true } })) as (VersionRow & { template: TemplateRow }) | null;
  if (!v || v.template.definitionKey !== key) return null;
  const { template, ...version } = v;
  return { version, head: template };
}

/** Every head of a definition (catalog detail: live per leg, rollback availability). */
export async function readHeads(key: string, client: Tx = DB()): Promise<Array<TemplateRow & { publishedCount: number }>> {
  const heads = (await client.commsTemplate.findMany({ where: { definitionKey: key } })) as TemplateRow[];
  const out: Array<TemplateRow & { publishedCount: number }> = [];
  for (const h of heads) {
    const publishedCount = await client.commsTemplateVersion.count({ where: { templateId: h.id, publishedAt: { not: null } } });
    out.push({ ...h, publishedCount });
  }
  return out;
}

export async function liveVersionNumber(head: TemplateRow | null, client: Tx = DB()): Promise<number | null> {
  if (!head?.publishedVersionId) return null;
  const v = await client.commsTemplateVersion.findUnique({ where: { id: head.publishedVersionId }, select: { version: true } });
  return v?.version ?? null;
}

// ── saveDraft (§3.3) ─────────────────────────────────────────────────────────

export interface SaveDraftInput {
  stream: ContentStreamRef;
  expectedRevision: number;
  parentVersionId: string | null;
  content: ContentBody;
  source: { kind: "MANUAL" } | { kind: "AI_SUGGESTION"; suggestionId: string };
  reason?: OperatorReason;
  actor: ContentActor;
  now?: Date;
}

export async function saveDraft(input: SaveDraftInput, client: ContentDb = DB()): Promise<ContentWriteResult<{ version: VersionRow; head: TemplateRow }>> {
  const spec = legSpec(input.stream.definitionKey, input.stream.channel);
  if (!spec || !spec.variants.includes(input.stream.variant)) return refuse("VALIDATION", "Unknown content stream.");
  const now = input.now ?? new Date();
  return run(client, async (tx) => {
    await lock(tx, input.stream);
    let head = await readHead(tx, input.stream);
    const current = head?.revision ?? 0;
    if (current !== input.expectedRevision) rollback(refuse("CONFLICT", "This template changed since you loaded it — reload and review again.", { current }));

    const issues = validateContent(spec, input.content, { mode: "manual", baseline: spec.codeDefault(input.stream.variant), variant: input.stream.variant });
    if (hasErrors(issues)) rollback(refuse("CONTENT_INVALID", "The content has errors.", { issues }));

    if (input.parentVersionId !== null) {
      const parent = head ? await tx.commsTemplateVersion.findFirst({ where: { id: input.parentVersionId, templateId: head.id }, select: { id: true } }) : null;
      if (!parent) rollback(refuse("NOT_FOUND", "parentVersionId is not a version of this template."));
    }

    head ??= (await tx.commsTemplate.create({ data: { definitionKey: input.stream.definitionKey, channel: input.stream.channel, variant: input.stream.variant } })) as TemplateRow;
    const hash = contentHash(input.content);

    let createdByKind: VersionCreatedByKind = "OPERATOR";
    let aiEditedAfterAccept: boolean | null = null;
    let sourceSuggestionId: string | null = null;
    if (input.source.kind === "AI_SUGGESTION") {
      const sug = await tx.commsAiSuggestion.findUnique({ where: { id: input.source.suggestionId } });
      if (!sug || sug.templateId !== head.id) rollback(refuse("NOT_FOUND", "No suggestion with that id for this template."));
      if (sug!.status !== "OFFERED" || sug!.expiresAt.getTime() <= now.getTime()) rollback(refuse("SUGGESTION_EXPIRED", "That suggestion is no longer available — ask for a new one."));
      if (input.parentVersionId !== sug!.baseVersionId) rollback(refuse("VALIDATION", "parentVersionId must be the version the suggestion was made from."));
      createdByKind = "AI_ASSISTED";
      aiEditedAfterAccept = hash !== sug!.suggestedHash;
      sourceSuggestionId = sug!.id;
    }

    const versionId = randomUUID();
    const versionNumber = head.headVersion + 1;
    const auditLogId = await audit(tx, input.actor, AuditAction.COMMS_TEMPLATE_DRAFT_SAVED, input.stream,
      { before: { revision: head.revision, headVersion: head.headVersion }, after: { versionId, version: versionNumber, contentHash: hash } },
      { createdByKind, sourceSuggestionId, aiEditedAfterAccept, warningCodes: warningsOf(issues).map((i) => i.code), parentVersionId: input.parentVersionId },
      input.reason);

    const version = (await tx.commsTemplateVersion.create({
      data: {
        id: versionId, templateId: head.id, version: versionNumber,
        subject: input.content.subject, preheader: input.content.preheader, blocks: input.content.blocks as unknown as Prisma.InputJsonValue,
        placeholdersUsed: placeholdersUsed(input.content, spec.channel), contentHash: hash, validatorVersion: VALIDATOR_VERSION,
        createdByKind, actorKind: actorKind(input.actor), createdById: input.actor.userId,
        parentVersionId: input.parentVersionId, basePublishedVersionId: head.publishedVersionId,
        sourceSuggestionId, aiEditedAfterAccept, createdAuditLogId: auditLogId,
      },
    })) as VersionRow;

    if (sourceSuggestionId) {
      const r = await tx.commsAiSuggestion.updateMany({ where: { id: sourceSuggestionId, status: "OFFERED" }, data: { status: "ACCEPTED", acceptedVersionId: versionId, resolvedAt: now } });
      if (r.count !== 1) rollback(refuse("SUGGESTION_EXPIRED", "That suggestion is no longer available — ask for a new one."));
    }
    const revision = await bumpHead(tx, head, current, { headVersion: versionNumber });
    return { ok: true, value: { version, head: { ...head, revision, headVersion: versionNumber } } };
  });
}

// ── publishVersion (§3.4) ────────────────────────────────────────────────────

export interface PublishInput {
  key: string;
  versionId: string;
  expectedRevision: number;
  acknowledgeWarnings: boolean;
  reason: OperatorReason;
  actor: ContentActor;
  now?: Date;
}

export async function publishVersion(input: PublishInput, client: ContentDb = DB()): Promise<ContentWriteResult<{ version: VersionRow; head: TemplateRow; superseded: { versionId: string; version: number } | null }>> {
  const now = input.now ?? new Date();
  return run(client, async (tx) => {
    const found = await readVersion(input.key, input.versionId, tx);
    if (!found) return refuse("NOT_FOUND", "No version with that id for this definition.");
    const stream: ContentStreamRef = { definitionKey: found.head.definitionKey, channel: found.head.channel as EditableChannel, variant: found.head.variant };
    const spec = legSpec(stream.definitionKey, stream.channel);
    if (!spec) return refuse("INVALID_STATE", "This template is not editable.");
    await lock(tx, stream);
    const head = (await readHead(tx, stream))!;
    if (head.revision !== input.expectedRevision) rollback(refuse("CONFLICT", "This template changed since you loaded it — reload and review again.", { current: head.revision }));
    const v = (await tx.commsTemplateVersion.findUnique({ where: { id: input.versionId } })) as VersionRow;
    if (stateOf(v, head) !== "DRAFT") rollback(refuse("INVALID_STATE", "Only a draft can be published; to bring back an earlier version, roll back to it."));
    if (v.basePublishedVersionId !== head.publishedVersionId) rollback(refuse("STALE_DRAFT", "Another version was published after this draft was started — save a new draft from the live version."));
    const issues = currentIssues(spec, bodyOf(v), stream.variant);
    if (hasErrors(issues)) rollback(refuse("CONTENT_INVALID", "This version no longer passes validation — save a new draft.", { issues }));
    const warnings = warningsOf(issues);
    if (warnings.length > 0 && !input.acknowledgeWarnings) rollback(refuse("WARNINGS_UNACKNOWLEDGED", "Review and acknowledge the warnings to publish.", { issues: warnings }));

    const before = head.publishedVersionId;
    const supersededNumber = before ? (await tx.commsTemplateVersion.findUnique({ where: { id: before }, select: { version: true } }))?.version ?? null : null;
    const auditLogId = await audit(tx, input.actor, AuditAction.COMMS_TEMPLATE_PUBLISHED, stream,
      { before: { versionId: before }, after: { versionId: v.id, version: v.version, contentHash: v.contentHash } },
      { warningCodes: warnings.map((i) => i.code), createdByKind: v.createdByKind, sourceSuggestionId: v.sourceSuggestionId },
      input.reason);
    const marked = await tx.commsTemplateVersion.updateMany({ where: { id: v.id, publishedAt: null }, data: { publishedAt: now, publishAuditLogId: auditLogId } });
    if (marked.count !== 1) rollback(refuse("CONFLICT", "This version was published concurrently — reload.", { current: head.revision }));
    const revision = await bumpHead(tx, head, input.expectedRevision, { publishedVersionId: v.id });
    return {
      ok: true,
      value: {
        version: { ...v, publishedAt: now, publishAuditLogId: auditLogId },
        head: { ...head, publishedVersionId: v.id, revision },
        superseded: before && supersededNumber !== null ? { versionId: before, version: supersededNumber } : null,
      },
    };
  });
}

// ── rollbackVersion (§3.5) ───────────────────────────────────────────────────

export const CODE_DEFAULT_ID = "code-default";

export interface RollbackInput {
  key: string;
  /** A SUPERSEDED version id, or CODE_DEFAULT_ID with `stream`. */
  versionId: string;
  stream?: ContentStreamRef;
  expectedRevision: number;
  reason: OperatorReason;
  actor: ContentActor;
  now?: Date;
}

export interface RollbackValue { published: { version: VersionRow } | null; head: TemplateRow; superseded: { versionId: string; version: number } | null }

export async function rollbackVersion(input: RollbackInput, client: ContentDb = DB()): Promise<ContentWriteResult<RollbackValue>> {
  const now = input.now ?? new Date();
  return run<RollbackValue>(client, async (tx) => {
    let stream: ContentStreamRef;
    let target: VersionRow | null = null;
    if (input.versionId === CODE_DEFAULT_ID) {
      if (!input.stream) return refuse("VALIDATION", "Rolling back to the code default needs channel and variant.");
      stream = input.stream;
    } else {
      const found = await readVersion(input.key, input.versionId, tx);
      if (!found) return refuse("NOT_FOUND", "No version with that id for this definition.");
      stream = { definitionKey: found.head.definitionKey, channel: found.head.channel as EditableChannel, variant: found.head.variant };
      target = found.version;
    }
    const spec = legSpec(stream.definitionKey, stream.channel);
    if (!spec) return refuse("INVALID_STATE", "This template is not editable.");
    await lock(tx, stream);
    const head = await readHead(tx, stream);
    const current = head?.revision ?? 0;
    if (current !== input.expectedRevision) rollback(refuse("CONFLICT", "This template changed since you loaded it — reload and review again.", { current }));
    if (!head || head.publishedVersionId === null) {
      if (target === null) rollback(refuse("INVALID_STATE", "The code default is already live."));
    }
    const before = head!.publishedVersionId;
    const supersededNumber = before ? (await tx.commsTemplateVersion.findUnique({ where: { id: before }, select: { version: true } }))?.version ?? null : null;
    const superseded = before && supersededNumber !== null ? { versionId: before, version: supersededNumber } : null;

    if (target === null) {
      await audit(tx, input.actor, AuditAction.COMMS_TEMPLATE_ROLLED_BACK, stream,
        { before: { versionId: before }, after: { versionId: null, restoredFromVersionId: CODE_DEFAULT_ID } }, {}, input.reason);
      const revision = await bumpHead(tx, head!, current, { publishedVersionId: null });
      return { ok: true, value: { published: null, head: { ...head!, publishedVersionId: null, revision }, superseded } };
    }

    const t = (await tx.commsTemplateVersion.findUnique({ where: { id: target.id } })) as VersionRow;
    if (stateOf(t, head) !== "SUPERSEDED") rollback(refuse("INVALID_STATE", "Only a previously published version that is not live can be rolled back to."));
    const body = bodyOf(t);
    const issues = currentIssues(spec, body, stream.variant);
    if (hasErrors(issues)) rollback(refuse("CONTENT_INVALID", "That version no longer passes validation — edit a new draft instead.", { issues }));

    const versionId = randomUUID();
    const versionNumber = head!.headVersion + 1;
    const auditLogId = await audit(tx, input.actor, AuditAction.COMMS_TEMPLATE_ROLLED_BACK, stream,
      { before: { versionId: before }, after: { versionId, version: versionNumber, restoredFromVersionId: t.id, contentHash: t.contentHash } },
      { warningCodes: warningsOf(issues).map((i) => i.code) }, input.reason);
    const version = (await tx.commsTemplateVersion.create({
      data: {
        id: versionId, templateId: head!.id, version: versionNumber,
        subject: t.subject, preheader: t.preheader, blocks: t.blocks as Prisma.InputJsonValue,
        placeholdersUsed: [...t.placeholdersUsed], contentHash: t.contentHash, validatorVersion: VALIDATOR_VERSION,
        createdByKind: "ROLLBACK", actorKind: actorKind(input.actor), createdById: input.actor.userId,
        parentVersionId: t.id, basePublishedVersionId: before, restoredFromVersionId: t.id,
        createdAuditLogId: auditLogId, publishedAt: now, publishAuditLogId: auditLogId,
      },
    })) as VersionRow;
    const revision = await bumpHead(tx, head!, current, { publishedVersionId: versionId, headVersion: versionNumber });
    return { ok: true, value: { published: { version }, head: { ...head!, publishedVersionId: versionId, headVersion: versionNumber, revision }, superseded } };
  });
}

// ── AI suggestions (§4.8, §8.3) ──────────────────────────────────────────────

export interface SuggestionRowInput {
  id: string;
  templateId: string;
  baseVersionId: string;
  mode: string;
  tone: string | null;
  status: "OFFERED" | "REJECTED" | "UNAVAILABLE";
  unavailableReason?: string | null;
  unavailableDetail?: string | null;
  rejectionCodes?: string[];
  suggestedContent?: ContentBody | null;
  suggestedHash?: string | null;
  notes?: unknown;
  model?: string | null;
  expiresAt: Date;
}

/** The suggestion row and its audit row, in ONE transaction. Text only for OFFERED (template text, no customer data). */
export async function recordSuggestion(stream: ContentStreamRef, row: SuggestionRowInput, actor: ContentActor, reason: OperatorReason | undefined, client: ContentDb = DB()): Promise<string> {
  return client.$transaction(async (tx) => {
    const auditLogId = await audit(tx, actor, AuditAction.COMMS_TEMPLATE_AI_SUGGESTED, stream,
      { before: { baseVersionId: row.baseVersionId }, after: { suggestionId: row.id, status: row.status, suggestedHash: row.suggestedHash ?? null } },
      { mode: row.mode, tone: row.tone, status: row.status, unavailableReason: row.unavailableReason ?? null, unavailableDetail: row.unavailableDetail ?? null, rejectionCodes: row.rejectionCodes ?? [], model: row.model ?? null },
      reason);
    await tx.commsAiSuggestion.create({
      data: {
        id: row.id, templateId: row.templateId, baseVersionId: row.baseVersionId, mode: row.mode, tone: row.tone, status: row.status,
        unavailableReason: row.unavailableReason ?? null, unavailableDetail: row.unavailableDetail ?? null,
        rejectionCodes: row.rejectionCodes ?? [],
        ...(row.status === "OFFERED" && row.suggestedContent ? { suggestedContent: row.suggestedContent as unknown as Prisma.InputJsonValue, suggestedHash: row.suggestedHash ?? null } : {}),
        ...(row.status === "OFFERED" && row.notes !== undefined ? { notes: row.notes as Prisma.InputJsonValue } : {}),
        model: row.model ?? null, requestedById: actor.userId, requestAuditLogId: auditLogId, expiresAt: row.expiresAt,
      },
    });
    return auditLogId;
  });
}

// ── Live content at send time (§5.4) ─────────────────────────────────────────

export type { LiveVersion, LiveContentResolver };

/** In-process cache bound (the policy-catalogue freshness bound). */
export const LIVE_CONTENT_TTL_MS = 30_000;
const cache = new Map<string, { at: number; value: LiveVersion | null }>();
export function invalidateLiveContent(): void { cache.clear(); }

interface LiveReadClient {
  commsTemplate: { findUnique(args: unknown): Promise<{ publishedVersionId: string | null } | null> };
  commsTemplateVersion: { findUnique(args: unknown): Promise<{ id: string; subject: string; preheader: string | null; blocks: unknown } | null> };
}

/**
 * A resolver over a client: one indexed read of the head and the published
 * version, cached ≤ 30 s. A read failure is the CODE DEFAULT (content is
 * optional, delivery is not) and one log line — never a throw.
 */
export function liveContentResolver(client: LiveReadClient, now: () => number = Date.now): LiveContentResolver {
  return async (s) => {
    const k = streamId(s.definitionKey, s.channel, s.variant);
    const hit = cache.get(k);
    if (hit && now() - hit.at < LIVE_CONTENT_TTL_MS) return hit.value;
    try {
      const head = await client.commsTemplate.findUnique({ where: headWhere(s), select: { publishedVersionId: true } });
      let value: LiveVersion | null = null;
      if (head?.publishedVersionId) {
        const v = await client.commsTemplateVersion.findUnique({ where: { id: head.publishedVersionId }, select: { id: true, subject: true, preheader: true, blocks: true } });
        if (v) value = { versionId: v.id, body: bodyOf(v) };
      }
      cache.set(k, { at: now(), value });
      return value;
    } catch (e) {
      console.warn(`[comms-content] live content unreadable; the code default is used: stream=${k} error=${e instanceof Error ? e.name : "unknown"}`);
      return null;
    }
  };
}

/** The production resolver (fm_system). */
export const defaultLiveContentResolver: LiveContentResolver = (s) => liveContentResolver(systemDb as unknown as LiveReadClient)(s);
