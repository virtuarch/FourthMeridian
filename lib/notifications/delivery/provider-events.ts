/**
 * lib/notifications/delivery/provider-events.ts  (Comms Center Phase C)
 *
 * THE RESEND DELIVERY WEBHOOK'S DECISION, as pure functions plus one
 * orchestrator over INJECTED I/O (the house pattern of
 * lib/plaid/webhook-receiver.ts), so app/api/webhooks/resend/route.ts is a thin
 * adapter and every branch is unit-testable without a database or a request.
 *
 * OWNER DECISIONS (2026-10-31, binding):
 *   - "Delivered" only from a VERIFIED provider event. Until one arrives a send
 *     stays ACCEPTED ("accepted by the provider").
 *   - Opens and clicks are NEVER tracked (O-13): `email.opened` /
 *     `email.clicked` are dropped before anything is written. No pixels, no
 *     link rewriting anywhere.
 *   - CommsProviderEvent rows live 90 days.
 *   - No PII beyond what the ledger already holds: from the payload only the
 *     event type, Resend's message id and the event instant are read. The
 *     recipient, subject, from, bounce message and every other field are
 *     never read into a stored value.
 *
 * FLOW (handleResendWebhook):
 *   1. INERT until configured: no usable RESEND_WEBHOOK_SECRET ⇒ 503, nothing
 *      verified, parsed, stored or counted.
 *   2. Body over MAX_WEBHOOK_BODY_BYTES ⇒ 413 (nothing parsed or stored).
 *   3. VERIFY the svix signature (lib/notifications/delivery/svix.ts). A
 *      rejection is 401, leaves NO row, and is counted by reason only.
 *   4. Parse; classify. Not one of the four handled types ⇒ 200, nothing stored.
 *   5–6. In ONE transaction (`reconcileEvent`, review F1): match by Resend
 *      message id; no row yet and the event is young ⇒ 409 RETRY, nothing
 *      stored (review F2); else take the per-message advisory lock, RE-READ,
 *      DECIDE (pure, forward-only, rank-aware — `decideReconciliation`), insert
 *      the event (svix-id UNIQUE) and, when the status moves forward, APPEND the
 *      ledger row. A duplicate svix-id rolls the whole thing back and is
 *      acknowledged as a no-op (200).
 *   A store failure is a 500 so the provider retries; the transaction left
 *   nothing behind, so the retry is safe.
 *
 * THE LEDGER STAYS APPEND-ONLY (contract v1.1 §10 B3): the event appends a
 * CommsDelivery row with the same messageKey and attempt and a later
 * createdAt, which wins as the final status under the v1.0.2 tie rule. Reads,
 * the rollup and the storm counter need no change (the storm limit counts
 * ACCEPTED rows; the appended row is not one).
 *
 * FORWARD ONLY. ACCEPTED → DELIVERED → BOUNCED → COMPLAINED (STATUS_RANK). An
 * event appends only when it ranks strictly above the message's current final
 * status: a late `delivered` never overwrites BOUNCED or COMPLAINED, a second
 * `delivered` is a NO_CHANGE, and `delivery_delayed` never writes the ledger
 * (a NOTE on the event row only). A message whose provider id belongs to an
 * attempt that a later attempt superseded is NO_CHANGE.
 *
 * UNKNOWN MESSAGE IDS (a send this deployment never recorded, or one already
 * past ledger retention) are stored UNMATCHED and never create a ledger row.
 *
 * SUPPRESSION (follow-up, not built): a BOUNCED / COMPLAINED final status is
 * the input a later recipient suppression list would read (by recipientUserId
 * / recipientHash on the ledger row). The contract does not specify that list,
 * so nothing here suppresses future sends.
 */

import { svixKey, verifySvix, type SvixRejection } from "@/lib/notifications/delivery/svix";
import type { CommsDeliveryRow, DeliveryStatus } from "@/lib/notifications/delivery/types";

/** The env var NAME holding the svix `whsec_…` signing secret. The value is never logged or returned. */
export const RESEND_WEBHOOK_SECRET_ENV = "RESEND_WEBHOOK_SECRET";

/** A Resend event body is a few hundred bytes; anything near this is not one. */
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

/** The ApiUsageCounter provider under which signature rejections are counted (unit "rejections"; never "calls"). */
export const WEBHOOK_USAGE_PROVIDER = "RESEND_WEBHOOK";
export const WEBHOOK_REJECTION_UNIT = "rejections";

/** The four event types that are stored, and the stored short name of each. */
export const HANDLED_EVENT_TYPES = {
  "email.delivered": "delivered",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.delivery_delayed": "delivery_delayed",
} as const;
export type ProviderEventType = (typeof HANDLED_EVENT_TYPES)[keyof typeof HANDLED_EVENT_TYPES];
export const PROVIDER_EVENT_TYPES = Object.values(HANDLED_EVENT_TYPES) as ProviderEventType[];

/** O-13 — dropped on sight, never stored, never counted. */
export const NEVER_TRACKED_EVENT_TYPES: readonly string[] = ["email.opened", "email.clicked"];

/** The ledger status each event type writes; null = recorded on the event row only. */
export const EVENT_STATUS: Record<ProviderEventType, Extract<DeliveryStatus, "DELIVERED" | "BOUNCED" | "COMPLAINED"> | null> = {
  delivered: "DELIVERED",
  bounced: "BOUNCED",
  complained: "COMPLAINED",
  delivery_delayed: null,
};

/** Forward-only order. A status absent here (FAILED, CAPTURED, …) is never moved by an event. */
export const STATUS_RANK: Partial<Record<DeliveryStatus, number>> = {
  ACCEPTED: 0,
  DELIVERED: 1,
  BOUNCED: 2,
  COMPLAINED: 3,
};

export type EventOutcome = "APPLIED" | "NO_CHANGE" | "NOTE" | "UNMATCHED";

// ── Parsing (pure) ───────────────────────────────────────────────────────────

export type ParsedEvent =
  | { kind: "handled"; type: ProviderEventType; providerMessageId: string; occurredAt: Date }
  | { kind: "ignored"; why: "NEVER_TRACKED" | "UNHANDLED_TYPE" | "NO_MESSAGE_ID" };

const MESSAGE_ID = /^[A-Za-z0-9_-]{1,200}$/;

/**
 * Read ONLY `type`, `created_at` and `data.email_id` from a verified body.
 * Every other field (to, from, subject, bounce text, tags …) is never touched.
 */
export function parseResendEvent(json: unknown, fallbackAt: Date): ParsedEvent {
  const body = typeof json === "object" && json !== null ? (json as { type?: unknown; created_at?: unknown; data?: unknown }) : {};
  const type = typeof body.type === "string" ? body.type : "";
  if (NEVER_TRACKED_EVENT_TYPES.includes(type)) return { kind: "ignored", why: "NEVER_TRACKED" };
  if (!Object.prototype.hasOwnProperty.call(HANDLED_EVENT_TYPES, type)) return { kind: "ignored", why: "UNHANDLED_TYPE" };
  const data = typeof body.data === "object" && body.data !== null ? (body.data as { email_id?: unknown }) : {};
  const id = typeof data.email_id === "string" ? data.email_id : "";
  if (!MESSAGE_ID.test(id)) return { kind: "ignored", why: "NO_MESSAGE_ID" };
  const at = typeof body.created_at === "string" ? new Date(body.created_at) : null;
  return {
    kind: "handled",
    type: HANDLED_EVENT_TYPES[type as keyof typeof HANDLED_EVENT_TYPES],
    providerMessageId: id,
    occurredAt: at && Number.isFinite(at.getTime()) ? at : fallbackAt,
  };
}

// ── Reconciliation (pure) ────────────────────────────────────────────────────

/** A stored ledger row of the message (CommsDeliveryRow as written, plus its identity and instant). */
export type LedgerRowRead = CommsDeliveryRow & { id: string; createdAt: Date };

/** The final row of a message: highest attempt, then latest createdAt, then id (the v1.0.2 order). */
export function finalRow<R extends { id: string; attempt: number; createdAt: Date }>(rows: readonly R[]): R | null {
  let best: R | null = null;
  for (const r of rows) {
    if (!best
      || r.attempt > best.attempt
      || (r.attempt === best.attempt && (r.createdAt.getTime() > best.createdAt.getTime()
        || (r.createdAt.getTime() === best.createdAt.getTime() && r.id > best.id)))) best = r;
  }
  return best;
}

/**
 * REVIEW F1 (defence in depth) — the message's CURRENT status, RANK-AWARE: highest attempt,
 * then the highest STATUS_RANK (unranked statuses = 0), then newest createdAt, then id. Two
 * appended rows of one attempt therefore resolve to the more advanced status whatever order
 * they were written in (createdAt is the transaction's start, not its commit). The same
 * order is used by the analytics read (read-store.ts) and the retention rollup (rollup.ts).
 */
export function currentRow<R extends { id: string; attempt: number; createdAt: Date; status: string }>(rows: readonly R[]): R | null {
  let best: R | null = null;
  const rank = (r: R) => STATUS_RANK[r.status as DeliveryStatus] ?? 0;
  for (const r of rows) {
    if (!best) { best = r; continue; }
    if (r.attempt !== best.attempt) { if (r.attempt > best.attempt) best = r; continue; }
    if (rank(r) !== rank(best)) { if (rank(r) > rank(best)) best = r; continue; }
    if (r.createdAt.getTime() !== best.createdAt.getTime()) { if (r.createdAt.getTime() > best.createdAt.getTime()) best = r; continue; }
    if (r.id > best.id) best = r;
  }
  return best;
}

export interface Reconciliation {
  outcome: EventOutcome;
  /** The ledger row the event matched (the message's final row at receipt); null when unmatched. */
  deliveryId: string | null;
  messageKey: string | null;
  /** The row to append, when the status moves forward. */
  append: CommsDeliveryRow | null;
}

/**
 * Decide what one verified event does, given every ledger row of the message
 * its provider id names (empty = unknown id). Pure and forward-only.
 */
export function decideReconciliation(event: { type: ProviderEventType; providerMessageId: string; occurredAt: Date }, rows: readonly LedgerRowRead[]): Reconciliation {
  const own = rows.filter((r) => r.providerMessageId === event.providerMessageId);
  const matched = finalRow(own);
  if (!matched) return { outcome: "UNMATCHED", deliveryId: null, messageKey: null, append: null };
  const message = rows.filter((r) => r.channel === matched.channel && r.messageKey === matched.messageKey);
  const current = currentRow(message) ?? matched;
  const base = { deliveryId: current.id, messageKey: current.messageKey };
  const next = EVENT_STATUS[event.type];
  if (next === null) return { ...base, outcome: "NOTE", append: null };
  const curRank = STATUS_RANK[current.status];
  // A later attempt superseded the one this provider id belongs to, or the
  // final status is not one an event may move (FAILED, CAPTURED …): no change.
  if (current.providerMessageId !== event.providerMessageId || curRank === undefined) {
    return { ...base, outcome: "NO_CHANGE", append: null };
  }
  if ((STATUS_RANK[next] ?? -1) <= curRank) return { ...base, outcome: "NO_CHANGE", append: null };
  const append: CommsDeliveryRow = {
    messageKey: current.messageKey,
    definitionKey: current.definitionKey,
    definitionVersion: current.definitionVersion,
    templateVersion: current.templateVersion,
    channel: current.channel,
    status: next,
    reason: null,
    provider: current.provider,
    providerMessageId: current.providerMessageId,
    attempt: current.attempt,
    errorCode: null,
    // What the ledger already holds for this message — nothing from the payload.
    recipientUserId: current.recipientUserId,
    recipientHash: current.recipientHash,
    notificationId: current.notificationId,
    environment: current.environment,
    acceptedAt: current.acceptedAt,
    contentVersionId: current.contentVersionId ?? null,
    mode: current.mode ?? "LIVE",
    automationRunItemId: current.automationRunItemId ?? null,
    deliveredAt: next === "DELIVERED" ? event.occurredAt : (current.deliveredAt ?? null),
  };
  return { ...base, outcome: "APPLIED", append };
}

// ── The orchestrator (injected I/O) ──────────────────────────────────────────

/** The CommsProviderEvent row, exactly as written. Nothing else is persisted. */
export interface ProviderEventInsert {
  provider: "resend";
  providerEventId: string;
  type: ProviderEventType;
  providerMessageId: string;
  deliveryId: string | null;
  messageKey: string | null;
  outcome: EventOutcome;
  occurredAt: Date;
}

/** What one reconciliation transaction may do. Production: Prisma interactive transaction (provider-event-store.ts). */
export interface ReconcileTx {
  /** Every ledger row of the message whose provider id this is (bounded); [] when unknown. */
  findMessageRows(providerMessageId: string): Promise<LedgerRowRead[]>;
  /** REVIEW F1 — serialise every event of one message: pg_advisory_xact_lock(hashtext(key)), held to commit. */
  lockMessage(key: string): Promise<void>;
  /** Insert the event row. A repeated svix id must make the transaction throw DuplicateProviderEvent. */
  insertEvent(event: ProviderEventInsert): Promise<void>;
  appendLedgerRow(row: CommsDeliveryRow): Promise<void>;
}

/** Thrown (by the store) when the svix id is already stored; the transaction rolled back. */
export class DuplicateProviderEvent extends Error {
  constructor() { super("duplicate provider event"); this.name = "DuplicateProviderEvent"; }
}

export interface ProviderEventStore {
  /** Run `fn` in ONE transaction; everything it wrote is rolled back if it throws. */
  transaction<T>(fn: (tx: ReconcileTx) => Promise<T>): Promise<T>;
}

/**
 * REVIEW F2 — an event whose message id matches no ledger row YET, and whose provider instant
 * is younger than this, is answered 409 WITHOUT being stored, so svix redelivers it (its svix
 * id is not consumed). The ACCEPTED row is written after the send's response
 * (runAfterResponse), so a fast `delivered` can beat it by a few seconds; svix retries after
 * ~5 s. Keyed on the event's own `created_at` (stable across retries), not on svix-timestamp
 * (fresh per attempt), so an id that is genuinely unknown here — another environment on the
 * same Resend account — is stored UNMATCHED once this window has passed.
 */
export const UNMATCHED_GRACE_MS = 5 * 60 * 1000;

/** The lock key of one message. */
export const messageLockKey = (channel: string, messageKey: string) => `comms-msg:${channel}:${messageKey}`;

export type ReconcileOutcome =
  | { kind: "stored"; event: ProviderEventInsert; append: CommsDeliveryRow | null }
  | { kind: "duplicate" }
  | { kind: "retry" };

/**
 * REVIEW F1 + F2 — the whole read → decide → write, INSIDE one transaction:
 *   1. find the message; none and the event is young ⇒ "retry" (nothing written);
 *   2. take the message lock, then RE-READ the rows — a concurrent event of the same message
 *      that committed while we waited is now visible (READ COMMITTED: a fresh snapshot per
 *      statement), so the decision is made against the true current status;
 *   3. decide (forward-only, rank-aware); insert the event; append the ledger row.
 * A duplicate svix id rolls everything back.
 */
export async function reconcileEvent(
  store: ProviderEventStore,
  parsed: { type: ProviderEventType; providerMessageId: string; occurredAt: Date },
  svixId: string,
  now: Date,
): Promise<ReconcileOutcome> {
  try {
    return await store.transaction(async (tx): Promise<ReconcileOutcome> => {
      let rows = await tx.findMessageRows(parsed.providerMessageId);
      const own = finalRow(rows.filter((r) => r.providerMessageId === parsed.providerMessageId));
      if (!own) {
        if (now.getTime() - parsed.occurredAt.getTime() < UNMATCHED_GRACE_MS) return { kind: "retry" };
      } else {
        await tx.lockMessage(messageLockKey(own.channel, own.messageKey));
        rows = await tx.findMessageRows(parsed.providerMessageId);
      }
      const r = decideReconciliation(parsed, rows);
      const event: ProviderEventInsert = {
        provider: "resend",
        providerEventId: svixId,
        type: parsed.type,
        providerMessageId: parsed.providerMessageId,
        deliveryId: r.deliveryId,
        messageKey: r.messageKey,
        outcome: r.outcome,
        occurredAt: parsed.occurredAt,
      };
      await tx.insertEvent(event);
      if (r.append) await tx.appendLedgerRow(r.append);
      return { kind: "stored", event, append: r.append };
    });
  } catch (err) {
    if (err instanceof DuplicateProviderEvent) return { kind: "duplicate" };
    throw err;
  }
}

export interface ResendWebhookDeps {
  /** process.env.RESEND_WEBHOOK_SECRET, read per request. */
  secret: string | undefined;
  now: () => Date;
  store: ProviderEventStore;
  /** Count one signature rejection by reason (non-throwing; the route defers it). */
  recordRejection?: (reason: SvixRejection) => void;
  log?: Pick<Console, "log" | "warn">;
}

export interface ResendWebhookRequest {
  rawBody: string;
  headers: { id: string | null; timestamp: string | null; signature: string | null };
}

export interface ResendWebhookResult {
  status: 200 | 400 | 401 | 409 | 413 | 500 | 503;
  body: Record<string, unknown>;
  /** The event row that was committed (null when none was). */
  stored: ProviderEventInsert | null;
  appended: CommsDeliveryRow | null;
}

const SVIX_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

/** Is a webhook secret configured AND usable? Presence only — the value never leaves. */
export function webhookConfigured(secret: string | undefined | null): boolean {
  return svixKey(secret) !== null;
}

export async function handleResendWebhook(req: ResendWebhookRequest, deps: ResendWebhookDeps): Promise<ResendWebhookResult> {
  const log = deps.log ?? console;
  const none = { stored: null, appended: null };

  // 1. INERT until the owner configures the secret.
  const key = svixKey(deps.secret);
  if (!key) return { status: 503, body: { error: "webhook not configured", code: "UNAVAILABLE" }, ...none };

  // 2. Bounded input.
  if (Buffer.byteLength(req.rawBody, "utf8") > MAX_WEBHOOK_BODY_BYTES) {
    return { status: 413, body: { error: "payload too large", code: "VALIDATION" }, ...none };
  }

  // 3. Verify FIRST. A rejection leaves no row — only a per-reason count.
  const now = deps.now();
  const verdict = verifySvix({ key, headers: req.headers, rawBody: req.rawBody, now });
  if (!verdict.ok) {
    log.warn(`[resend webhook] signature rejected: ${verdict.reason}`);
    try { deps.recordRejection?.(verdict.reason); } catch { /* counting never fails a request */ }
    return { status: 401, body: { error: "invalid webhook signature", code: "UNAUTHENTICATED" }, ...none };
  }
  const svixId = req.headers.id!.trim();
  if (!SVIX_ID.test(svixId)) return { status: 400, body: { error: "invalid event id", code: "VALIDATION" }, ...none };

  // 4. Parse + classify. Opens/clicks and every other type: acknowledged, nothing stored.
  let json: unknown;
  try { json = JSON.parse(req.rawBody); } catch {
    return { status: 400, body: { error: "invalid JSON body", code: "VALIDATION" }, ...none };
  }
  const tsAt = new Date(Number(req.headers.timestamp!.trim()) * 1000);
  const parsed = parseResendEvent(json, tsAt);
  if (parsed.kind === "ignored") return { status: 200, body: { received: true, handled: false }, ...none };

  // 5–6. Match, decide, commit — all inside one locked transaction (REVIEW F1).
  try {
    const out = await reconcileEvent(deps.store, parsed, svixId, now);
    if (out.kind === "duplicate") return { status: 200, body: { received: true, handled: false, duplicate: true }, ...none };
    // REVIEW F2 — not yet matchable and young: retryable, nothing stored, svix id not consumed.
    if (out.kind === "retry") return { status: 409, body: { error: "message not yet recorded; retry", code: "RETRY" }, ...none };
    log.log(`[resend webhook] ${parsed.type} → ${out.event.outcome}`);
    return { status: 200, body: { received: true, handled: true, outcome: out.event.outcome }, stored: out.event, appended: out.append };
  } catch (err) {
    // The class only: a driver message can quote values.
    log.warn(`[resend webhook] store failed (the provider will retry): ${err instanceof Error ? err.name : "Error"}`);
    return { status: 500, body: { error: "temporarily unavailable", code: "UNAVAILABLE" }, ...none };
  }
}

// ── Health (pure builder; Platform Ops → email health, read-only) ───────────

/**
 * REVIEW F3 — the events that count as "a verified event exists" for measured.delivered: an
 * UNMATCHED event proves only that the account's webhook works (Preview and Production may share
 * one Resend account), not that THIS environment's sends are being confirmed.
 */
export const MEASURING_EVENT_WHERE = { outcome: { not: "UNMATCHED" } } as const;

/** ACCEPTED with no verified outcome after this long is flagged (contract v1.1 §10 B3). Never resent. */
export const ACCEPTED_STALE_HOURS = 72;

export interface WebhookHealthRows {
  lastReceivedAt: Date | null;
  byTypeOutcome: Array<{ type: string; outcome: string; count: number }>;
  rejections: Array<{ metric: string; count: number }>;
  /** ACCEPTED provider emails (final status) WITH a provider id, older than 72 h, with no outcome event; null when not read. */
  acceptedWithoutEvent: number | null;
  /** N-b — ACCEPTED provider emails with NO provider id (UNCERTAIN_ACCEPTANCE) in the same range; null when not read. */
  acceptedUncertain?: number | null;
}

export interface ResendWebhookHealth {
  /** RESEND_WEBHOOK_SECRET is set and usable (presence only — never the value). */
  configured: boolean;
  windowDays: number;
  /** The latest verified event held (any age within retention). */
  lastVerifiedEventAt: string | null;
  /** Verified events received in the window, by type. Opens/clicks do not exist here (O-13). */
  countsByType: Record<ProviderEventType, number>;
  /** Of those, events whose message id matched no ledger row. */
  unmatched: number;
  /** Signature rejections in the window (UTC days), total and by reason. */
  signatureFailures: { total: number; byReason: Record<string, number> };
  /**
   * ACCEPTED emails older than 72 h with no verified outcome; null until the webhook is configured.
   * Flag only, never resent. EXCLUDES expected-unmatchable rows (no provider id — see acceptedUncertain72h).
   */
  acceptedWithoutEvent72h: number | null;
  /**
   * N-b — ACCEPTED-uncertain: accepted under an idempotency conflict (UNCERTAIN_ACCEPTANCE), so the
   * provider returned no message id and no event can ever match. Expected, not missing data. Null until configured.
   */
  acceptedUncertain72h: number | null;
}

/**
 * N-b — an ACCEPTED provider row with no provider message id (an UNCERTAIN_ACCEPTANCE send: the
 * provider refused a repeated idempotency key and returned no id) can never be matched to a
 * webhook event. It is EXPECTED-UNMATCHABLE: never "awaiting delivery confirmation", never unmatched.
 */
export function isExpectedUnmatchable(row: { status: string; provider: string | null; providerMessageId: string | null }): boolean {
  return row.status === "ACCEPTED" && row.provider === "resend" && !row.providerMessageId;
}

export function buildWebhookHealth(rows: WebhookHealthRows, configured: boolean, windowDays: number): ResendWebhookHealth {
  const countsByType = Object.fromEntries(PROVIDER_EVENT_TYPES.map((t) => [t, 0])) as Record<ProviderEventType, number>;
  let unmatched = 0;
  for (const g of rows.byTypeOutcome) {
    if ((PROVIDER_EVENT_TYPES as readonly string[]).includes(g.type)) countsByType[g.type as ProviderEventType] += g.count;
    if (g.outcome === "UNMATCHED") unmatched += g.count;
  }
  const byReason: Record<string, number> = {};
  let total = 0;
  for (const r of rows.rejections) {
    const reason = r.metric.startsWith("signature:") ? r.metric.slice("signature:".length) : r.metric;
    byReason[reason] = (byReason[reason] ?? 0) + r.count;
    total += r.count;
  }
  return {
    configured,
    windowDays,
    lastVerifiedEventAt: rows.lastReceivedAt ? rows.lastReceivedAt.toISOString() : null,
    countsByType,
    unmatched,
    signatureFailures: { total, byReason },
    acceptedWithoutEvent72h: configured ? rows.acceptedWithoutEvent : null,
    acceptedUncertain72h: configured ? (rows.acceptedUncertain ?? null) : null,
  };
}
