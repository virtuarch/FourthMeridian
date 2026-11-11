/**
 * lib/platform/incidents/customer-update/service.ts  (Incident customer update, PR-C1 — the route bodies)
 *
 * Owner yes; S2 ruling 09gg (c). The four Customer Success routes under
 * app/api/platform/customer-success/incidents/[id]/ authorize, rate-limit and
 * mint the incident token THEMSELVES (the census pins read them there) and hand
 * everything after that to one function here. Every function takes its I/O as
 * DEPS, so the order, the refusals and the dedupe are unit-tested without a
 * database (customer-update.test.ts); the production deps are ./deps.ts.
 *
 * THE SEND, in this exact order (S2 09gg c):
 *   1. FLAG    INCIDENT_CUSTOMER_MESSAGE_SEND_ENABLED (strict "true"); off ⇒ 404
 *              NOT_AVAILABLE before the body is read — nothing else happens.
 *   2. BODY    exactly { paragraph, reason, expectedDraftHash? }; the reason is
 *              REQUIRED; any other key (a recipient, a user id …) ⇒ 400.
 *   3. INCIDENT read through the intelligence module with the route's CS token;
 *              the recipient is the incident's OWN attributed subject, never the client's.
 *   4. LINT    lintIncidentCustomerUpdate ⇒ 422 LINT_FAILED (codes only).
 *   5. DEDUPE  one sent update per episode (the ledger, by incident id) ⇒ 409
 *              ALREADY_SENT; a reconnect-request notice (created OR
 *              suppressed_duplicate) for the same connection within 24 h ⇒ 409
 *              REAUTH_NOTICE_RECENT. An unreadable dedupe fact refuses (500).
 *   6. AUDIT   INCIDENT_CUSTOMER_UPDATE_APPROVED (reason required, target the
 *              incident, the customer only as a PRIV-ref, the text only as a
 *              length + hash) — written BEFORE the send. Failure ⇒ nothing sent.
 *   7. SEND    createNotification(INCIDENT_CUSTOMER_UPDATE) for the subject,
 *              in-app only, the ledger rows tagged with the incident id; the
 *              Notification carries the approval's audit id. A throw / error ⇒
 *              502: the approval stays on record and nothing is marked sent.
 *
 * Every refusal returns its ControlRefusal code so the route records it
 * (recordControlRefusal, area CUSTOMER_SUCCESS). Codes and counts only.
 */

import "server-only";
import { createHash } from "node:crypto";
import { OperatorActionValidationError, parseOperatorReason, type OperatorActionInput, type OperatorReason } from "@/lib/audit";
import { AuditAction } from "@/lib/audit-actions";
import type { CreateNotificationResult } from "@/lib/notifications/create";
import {
  INCIDENT_UPDATE_CLOSING, INCIDENT_UPDATE_HREF, INCIDENT_UPDATE_OPENING, INCIDENT_UPDATE_TITLE,
  renderIncidentCustomerUpdate,
} from "@/lib/notifications/incident-customer-update";
import type { ControlRefusalCode } from "@/lib/platform/control-refusal.core";
import type { CsToken, OpsToken } from "../intelligence/audience";
import type { CsIncidentVerdict, IncidentInvestigation, IncidentVerdict } from "../intelligence/types";
import { incidentDetailDTO, type IncidentDetailDTO } from "../investigation-dto";
import {
  INCIDENT_CUSTOMER_UPDATE_TYPE, INCIDENT_UPDATE_PARAGRAPH_MAX, REAUTH_NOTICE_QUIET_MS,
  draftIncidentCustomerUpdate, episodeSendState, lintIncidentCustomerUpdate, reauthNoticeState, sendBlocks,
  type EpisodeDeliveryFact, type IncidentCustomerUpdateDraft, type LintResult, type ReauthNoticeFact,
} from "./core";

/** The ledger keeps 90 days; a delivery read never looks further back. */
const LEDGER_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** A raw paragraph longer than this is not parsed at all (the lint's cap is 600). */
const RAW_PARAGRAPH_LIMIT = 4000;
const INCIDENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface CreateIncidentUpdateInput {
  type: typeof INCIDENT_CUSTOMER_UPDATE_TYPE;
  userId: string;
  data: { incidentId: string; paragraph: string };
  auditLogId: string | null;
}
export interface CreateIncidentUpdateCtx { inAppOnly: true; ledgerTag: { incidentId: string } }

export interface CustomerUpdateDeps {
  now(): Date;
  /** INCIDENT_CUSTOMER_MESSAGE_SEND_ENABLED === "true" (lib/env.ts). */
  sendEnabled(): boolean;
  investigate(token: CsToken, id: string, now: Date): Promise<IncidentInvestigation<CsIncidentVerdict> | null>;
  /** This incident's INCIDENT_CUSTOMER_UPDATE ledger rows, bounded by the subject + window first. */
  readDeliveries(q: { incidentId: string; recipientUserId: string; since: Date }): Promise<EpisodeDeliveryFact[]>;
  /** CONNECTION_REAUTH_REQUESTED rows for the connection since `since`: outcome + time. */
  readReauthNotices(q: { plaidItemId: string; since: Date }): Promise<ReauthNoticeFact[]>;
  /** The subject can still receive a notice (exists, not deactivated, not scheduled for deletion). */
  recipientActive(userId: string): Promise<boolean>;
  /** PRIV-ref (opaqueUserRef) — the only form the customer takes in the audit. */
  privRef(userId: string): string;
  recordApproval(input: OperatorActionInput): Promise<{ id: string }>;
  createNotification(input: CreateIncidentUpdateInput, ctx: CreateIncidentUpdateCtx): Promise<CreateNotificationResult>;
}

/** What a route returns: the HTTP answer and, for a refusal, the code it records. */
export interface CustomerUpdateResult {
  status: number;
  body: Record<string, unknown>;
  refusal: ControlRefusalCode | null;
  /** The parsed reason code, when one parsed (recorded on a refusal; never the note). */
  reasonCode?: string;
}

const reply = (status: number, body: Record<string, unknown>, refusal: ControlRefusalCode | null = null, reasonCode?: string): CustomerUpdateResult =>
  ({ status, body, refusal, ...(reasonCode ? { reasonCode } : {}) });

/** sha256 hex of the paragraph exactly as stored (trimmed). */
export function paragraphHash(paragraph: string): string {
  return createHash("sha256").update(paragraph.trim(), "utf8").digest("hex");
}

// ── Shared: the incident, through the route's CS token ───────────────────────

interface Loaded {
  dto: IncidentDetailDTO;
  verdict: CsIncidentVerdict;
  subjectUserId: string | null;
  plaidItemId: string | null;
  eligible: boolean;
  draft: IncidentCustomerUpdateDraft;
  draftHash: string;
}

async function loadIncident(token: CsToken | OpsToken | null, id: string, deps: CustomerUpdateDeps, now: Date): Promise<{ ok: true; v: Loaded } | { ok: false; r: CustomerUpdateResult }> {
  // Customer Success only: an Ops (identity-free) token never reaches a customer.
  if (!token || token.audience !== "CUSTOMER_SUCCESS") return { ok: false, r: reply(403, { error: "Not authorized to message customers about incidents.", code: "FORBIDDEN" }, "FORBIDDEN") };
  if (!INCIDENT_ID.test(id)) return { ok: false, r: reply(404, { error: "Incident not found.", code: "NOT_FOUND" }, "NOT_FOUND") };
  let inv: IncidentInvestigation<CsIncidentVerdict> | null;
  try { inv = await deps.investigate(token as CsToken, id, now); }
  catch { return { ok: false, r: reply(500, { error: "Incident read failed." }) }; }
  if (!inv) return { ok: false, r: reply(404, { error: "Incident not found.", code: "NOT_FOUND" }, "NOT_FOUND") };
  const dto = incidentDetailDTO(inv as IncidentInvestigation<IncidentVerdict | CsIncidentVerdict>, "cs", now);
  const v = inv.verdict;
  const draft = draftIncidentCustomerUpdate(dto);
  return {
    ok: true,
    v: {
      dto, verdict: v,
      subjectUserId: typeof v.subjectUserId === "string" && v.subjectUserId !== "" ? v.subjectUserId : null,
      plaidItemId: v.plaidItemId,
      // A real condition row, not a folded legacy duplicate of a newer episode.
      eligible: v.rowClass === "incident" && v.duplicateOf === null,
      draft,
      draftHash: paragraphHash(draft.paragraph),
    },
  };
}

function lintFor(paragraph: string, v: Loaded): LintResult {
  return lintIncidentCustomerUpdate(paragraph, { verifiedRecovery: v.draft.verifiedRecovery, institution: v.dto.affected.institution });
}

/** The ledger window for this incident: from its first sighting, never past the ledger's retention. */
function deliveriesSince(v: Loaded, now: Date): Date {
  const first = Date.parse(v.verdict.firstSeenAt);
  const floor = now.getTime() - LEDGER_RETENTION_MS;
  return new Date(Number.isFinite(first) ? Math.max(first, floor) : floor);
}

type DedupeFacts = { episode: ReturnType<typeof episodeSendState>; reauthNotice: ReturnType<typeof reauthNoticeState>; rows: EpisodeDeliveryFact[] };

async function readDedupe(v: Loaded, deps: CustomerUpdateDeps, now: Date): Promise<DedupeFacts> {
  const [rows, notices] = await Promise.all([
    v.subjectUserId ? deps.readDeliveries({ incidentId: v.verdict.id, recipientUserId: v.subjectUserId, since: deliveriesSince(v, now) }) : Promise.resolve([]),
    v.plaidItemId ? deps.readReauthNotices({ plaidItemId: v.plaidItemId, since: new Date(now.getTime() - REAUTH_NOTICE_QUIET_MS) }) : Promise.resolve([]),
  ]);
  return { rows, episode: episodeSendState(rows), reauthNotice: reauthNoticeState(notices, now) };
}

const TEMPLATE = {
  title: INCIDENT_UPDATE_TITLE, opening: INCIDENT_UPDATE_OPENING, closing: INCIDENT_UPDATE_CLOSING,
  href: INCIDENT_UPDATE_HREF, paragraphMax: INCIDENT_UPDATE_PARAGRAPH_MAX,
};

// ── GET …/customer-update — the drawer's read model ──────────────────────────

export async function customerUpdateReadModel(token: CsToken | OpsToken | null, id: string, deps: CustomerUpdateDeps): Promise<CustomerUpdateResult> {
  const now = deps.now();
  const loaded = await loadIncident(token, id, deps, now);
  if (!loaded.ok) return { ...loaded.r, refusal: null };
  const v = loaded.v;
  let facts: DedupeFacts;
  try { facts = await readDedupe(v, deps, now); }
  catch { return reply(500, { error: "Delivery state read failed." }); }
  const sendEnabled = deps.sendEnabled();
  const blockedBy = sendBlocks({ sendEnabled, eligible: v.eligible, recipient: v.subjectUserId !== null, episode: facts.episode, reauthNotice: facts.reauthNotice });
  return reply(200, {
    incidentId: v.verdict.id,
    // The drawer hides the send control when false (the send route refuses either way).
    sendEnabled,
    eligible: v.eligible,
    recipient: { attributed: v.subjectUserId !== null },
    template: TEMPLATE,
    draft: { paragraph: v.draft.paragraph, draftClass: v.draft.draftClass, verifiedRecovery: v.draft.verifiedRecovery, draftHash: v.draftHash },
    lint: lintFor(v.draft.paragraph, v),
    dedupe: { episode: facts.episode, reauthNotice: facts.reauthNotice },
    blockedBy,
    canSend: blockedBy.length === 0,
    checkedAt: now.toISOString(),
  });
}

// ── POST …/customer-update/preview — render after lint, never send ───────────

export async function customerUpdatePreview(token: CsToken | OpsToken | null, id: string, body: unknown, deps: CustomerUpdateDeps): Promise<CustomerUpdateResult> {
  const now = deps.now();
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => k !== "paragraph")
    || typeof (body as { paragraph?: unknown }).paragraph !== "string" || (body as { paragraph: string }).paragraph.length > RAW_PARAGRAPH_LIMIT) {
    return reply(400, { error: "Body must be { paragraph }.", code: "VALIDATION" }, "VALIDATION");
  }
  const paragraph = (body as { paragraph: string }).paragraph.trim();
  const loaded = await loadIncident(token, id, deps, now);
  if (!loaded.ok) return loaded.r;
  const v = loaded.v;
  const lint = lintFor(paragraph, v);
  if (!lint.ok) return reply(422, { error: "The paragraph did not pass the message checks.", code: "LINT_FAILED", lint }, "LINT_FAILED");
  return reply(200, {
    incidentId: v.verdict.id,
    message: renderIncidentCustomerUpdate({ paragraph }),
    lint,
    paragraphHash: paragraphHash(paragraph),
    edited: paragraph !== v.draft.paragraph,
    sendEnabled: deps.sendEnabled(),
    checkedAt: now.toISOString(),
  });
}

// ── POST …/customer-update/send — approve (audited) and send ─────────────────

type SendBody = { paragraph: string; reason: OperatorReason; expectedDraftHash: string | null };

/** PURE — exactly { paragraph, reason, expectedDraftHash? }. Any other key (a recipient, a user id) is refused. */
export function parseSendBody(raw: unknown): { ok: true; body: SendBody } | { ok: false; error: string; reasonCode?: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Body must be { paragraph, reason: { code, note? }, expectedDraftHash? }." };
  const b = raw as Record<string, unknown>;
  const extra = Object.keys(b).filter((k) => k !== "paragraph" && k !== "reason" && k !== "expectedDraftHash");
  // Never a recipient (or anything else) from the client: the recipient is the incident's own subject.
  if (extra.length > 0) return { ok: false, error: "Unexpected field(s): only paragraph, reason and expectedDraftHash are accepted." };
  const code = typeof b.reason === "object" && b.reason !== null ? (b.reason as { code?: unknown }).code : undefined;
  const reasonCode = typeof code === "string" ? code : undefined;
  let reason: OperatorReason;
  try { reason = parseOperatorReason(b.reason); }
  catch (e) { return { ok: false, error: e instanceof OperatorActionValidationError ? e.message : "A reason is required." }; }
  if (typeof b.paragraph !== "string" || b.paragraph.length > RAW_PARAGRAPH_LIMIT) return { ok: false, error: "paragraph must be a string.", reasonCode };
  if (b.expectedDraftHash !== undefined && b.expectedDraftHash !== null && (typeof b.expectedDraftHash !== "string" || !SHA256_HEX.test(b.expectedDraftHash))) {
    return { ok: false, error: "expectedDraftHash must be the draftHash the read model returned.", reasonCode };
  }
  return { ok: true, body: { paragraph: b.paragraph.trim(), reason, expectedDraftHash: (b.expectedDraftHash as string | null | undefined) ?? null } };
}

export async function customerUpdateSend(
  token: CsToken | OpsToken | null,
  id: string,
  rawBody: unknown,
  ctx: { actor: OperatorActionInput["actor"]; ipAddress?: string | null; userAgent?: string | null },
  deps: CustomerUpdateDeps,
): Promise<CustomerUpdateResult> {
  // 1. FLAG — before anything else; off ⇒ nothing is read, linted, audited or created.
  if (!deps.sendEnabled()) return reply(404, { error: "Sending incident updates to customers is not available.", code: "NOT_AVAILABLE" }, "SEND_DISABLED");
  const now = deps.now();

  // 2. BODY — reason required; the client never names the recipient.
  const parsed = parseSendBody(rawBody);
  if (!parsed.ok) return reply(400, { error: parsed.error, code: "VALIDATION" }, "VALIDATION", parsed.reasonCode);
  const { paragraph, reason, expectedDraftHash } = parsed.body;
  const rc = reason.code;

  // 3. INCIDENT — through the CS token; the recipient is its own subject.
  const loaded = await loadIncident(token, id, deps, now);
  if (!loaded.ok) return { ...loaded.r, ...(loaded.r.refusal ? { reasonCode: rc } : {}) };
  const v = loaded.v;
  if (!v.eligible) return reply(409, { error: "Only a live incident episode can carry a customer update.", code: "NOT_ELIGIBLE" }, "NOT_ELIGIBLE", rc);
  const recipient = v.subjectUserId;
  if (!recipient) return reply(409, { error: "This incident is not attributed to a customer.", code: "NO_RECIPIENT" }, "NO_RECIPIENT", rc);
  if (expectedDraftHash !== null && expectedDraftHash !== v.draftHash) {
    return reply(409, { error: "The incident changed since the draft was read. Reload and review it again.", code: "DRAFT_CHANGED", draftHash: v.draftHash }, "DRAFT_CHANGED", rc);
  }

  // 4. LINT
  const lint = lintFor(paragraph, v);
  if (!lint.ok) return reply(422, { error: "The paragraph did not pass the message checks.", code: "LINT_FAILED", lint }, "LINT_FAILED", rc);

  // 5. DEDUPE — fail closed: a fact that cannot be read refuses the send.
  let facts: DedupeFacts;
  try { facts = await readDedupe(v, deps, now); }
  catch { return reply(500, { error: "Delivery state read failed; nothing was sent.", code: "DEDUPE_UNREADABLE" }); }
  if (facts.episode.sent) return reply(409, { error: "An update was already sent for this incident episode.", code: "ALREADY_SENT", episode: facts.episode }, "ALREADY_SENT", rc);
  if (facts.reauthNotice?.blocksSend) {
    return reply(409, { error: "A reconnect request notice reached this customer in the last 24 hours.", code: "REAUTH_NOTICE_RECENT", reauthNotice: facts.reauthNotice }, "REAUTH_NOTICE_RECENT", rc);
  }
  let active: boolean;
  try { active = await deps.recipientActive(recipient); }
  catch { return reply(500, { error: "Recipient read failed; nothing was sent." }); }
  if (!active) return reply(409, { error: "The customer's account cannot receive updates (deactivated or being deleted).", code: "NO_RECIPIENT" }, "NO_RECIPIENT", rc);

  // 6. AUDIT — BEFORE the send. Never the text: its length and a hash.
  let approval: { id: string };
  try {
    approval = await deps.recordApproval({
      actor: ctx.actor,
      action: AuditAction.INCIDENT_CUSTOMER_UPDATE_APPROVED,
      target: { kind: "SYNC_INCIDENT", id: v.verdict.id },
      reason,
      result: "SUCCESS",
      detail: {
        recipientRef: deps.privRef(recipient),
        draftClass: v.draft.draftClass,
        verifiedRecovery: v.draft.verifiedRecovery,
        edited: paragraph !== v.draft.paragraph,
        paragraphLength: paragraph.length,
        paragraphHash: paragraphHash(paragraph),
        draftHash: v.draftHash,
      },
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
    });
  } catch (e) {
    if (e instanceof OperatorActionValidationError) return reply(400, { error: e.message, code: "VALIDATION" }, "VALIDATION", rc);
    return reply(500, { error: "The approval could not be recorded; nothing was sent.", code: "AUDIT_FAILED" });
  }

  // 7. SEND — in-app only, ledger rows tagged with the incident id.
  let res: CreateNotificationResult;
  try {
    res = await deps.createNotification(
      { type: "INCIDENT_CUSTOMER_UPDATE", userId: recipient, data: { incidentId: v.verdict.id, paragraph }, auditLogId: approval.id || null },
      { inAppOnly: true, ledgerTag: { incidentId: v.verdict.id } },
    );
  } catch {
    return reply(502, { error: "The approval was recorded but the update could not be created; nothing was sent.", code: "SEND_FAILED", approvalRecorded: true, sent: false });
  }
  switch (res.status) {
    case "created":
      return reply(200, { ok: true, outcome: "sent", approvalRecorded: true, sent: true, checkedAt: now.toISOString() });
    case "suppressed":
      // The ":once" key already holds an update for this episode (a race with another send).
      return reply(409, { error: "An update was already sent for this incident episode.", code: "ALREADY_SENT", approvalRecorded: true, sent: false }, "ALREADY_SENT", rc);
    case "skipped":
      return reply(200, { ok: true, outcome: "not_delivered_preference", approvalRecorded: true, sent: false, checkedAt: now.toISOString() });
    default:
      return reply(502, { error: "The approval was recorded but the update could not be created; nothing was sent.", code: "SEND_FAILED", approvalRecorded: true, sent: false });
  }
}

// ── GET …/deliveries — delivery status rows for the incident ─────────────────

export async function incidentDeliveries(token: CsToken | OpsToken | null, id: string, deps: CustomerUpdateDeps): Promise<CustomerUpdateResult> {
  const now = deps.now();
  const loaded = await loadIncident(token, id, deps, now);
  if (!loaded.ok) return { ...loaded.r, refusal: null };
  const v = loaded.v;
  let rows: EpisodeDeliveryFact[];
  try {
    rows = v.subjectUserId ? await deps.readDeliveries({ incidentId: v.verdict.id, recipientUserId: v.subjectUserId, since: deliveriesSince(v, now) }) : [];
  } catch { return reply(500, { error: "Delivery read failed." }); }
  return reply(200, {
    incidentId: v.verdict.id,
    // Codes and status only — never a recipient, title, body or provider text.
    items: rows
      .slice()
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((r) => ({
        channel: r.channel, status: r.status, reason: r.reason, errorCode: r.errorCode, attempt: r.attempt, mode: r.mode,
        createdAt: r.createdAt.toISOString(), acceptedAt: r.acceptedAt ? r.acceptedAt.toISOString() : null,
      })),
    episode: episodeSendState(rows),
    checkedAt: now.toISOString(),
  });
}
