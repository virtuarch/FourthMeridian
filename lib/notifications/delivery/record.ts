/**
 * lib/notifications/delivery/record.ts  (Comms Center Phase A-2a)
 *
 * The delivery LEDGER's row builders and its one non-throwing write. Pure
 * except for `recordDelivery`, which calls an INJECTED writer — the database
 * writer lives in lib/notifications/delivery/store.ts and is loaded lazily, so
 * nothing here (and nothing in lib/email/send.ts) touches a database at import.
 *
 * WHAT A ROW HOLDS (contract §6.1, owner decisions 2026-10-31): the catalog key
 * and its versions, the channel, the outcome status (+ reason / closed error
 * code), the provider and its message id, the attempt number, the environment
 * and timestamps. The recipient is the soft `recipientUserId`, or — only when
 * there is no user (an operator inbox, an applicant) — a SALTED HMAC of the
 * address. NEVER an address, subject, body, link, token, payload value or the
 * provider's error text (which can echo an address). No open/click fields.
 *
 * NEVER BLOCKS A SEND: `recordDelivery` runs after the transport answered,
 * swallows every failure with ONE redacted log line (key, channel, status and
 * the error's class/code — never its message), and gives up after
 * LEDGER_WRITE_TIMEOUT_MS so a slow database cannot hold a caller.
 */

import { createHmac, randomUUID } from "node:crypto";
import type { EmailResult, EmailSendContext, EmailTemplateName } from "@/lib/email/types";
import {
  COMMS_CATALOG,
  EMAIL_TEMPLATE_VERSIONS,
  IN_APP_TEMPLATE_VERSION,
  getCatalogDefinition,
} from "@/lib/notifications/catalog/definitions";
import type {
  CommsDeliveryRow,
  DeliveryErrorCode,
  DeliveryStatus,
  LedgerChannel,
  LedgerEnvironment,
  LedgerWriter,
  SuppressionReason,
} from "@/lib/notifications/delivery/types";

/** The longest a ledger write may hold the caller before it is abandoned (logged, never retried). */
export const LEDGER_WRITE_TIMEOUT_MS = 1_500;

/** The env var holding the recipient-hash salt. Unset ⇒ no hash is stored at all (never an unsalted one). */
export const RECIPIENT_HASH_SALT_ENV = "COMMS_RECIPIENT_HASH_SALT";

/** Key recorded for a send whose caller named no catalog key (tooling only; production sites are grep-pinned). */
export const UNCATALOGUED_KEY = "UNCATALOGUED";

/** The env keys the row builders read (a structural subset of process.env). */
export interface LedgerEnv {
  VERCEL?: string;
  VERCEL_ENV?: string;
  NODE_ENV?: string;
  COMMS_RECIPIENT_HASH_SALT?: string;
  /** Phase C — presence only (measured.delivered); the value is never read into output. */
  RESEND_WEBHOOK_SECRET?: string;
}

/** Same classification as lib/env.ts deploymentEnvironment(), over an injected env. */
export function ledgerEnvironment(e: LedgerEnv): LedgerEnvironment {
  if (e.VERCEL === "1") {
    if (e.VERCEL_ENV === "production") return "production";
    if (e.VERCEL_ENV === "preview") return "preview";
    return "development";
  }
  return e.NODE_ENV === "production" ? "production" : "development";
}

/**
 * HMAC-SHA256(salt, trimmed lower-cased address), hex. Null when the salt is
 * unset or empty: an unsalted SHA-256 of an address is a dictionary lookup
 * away from the address, so the ledger stores nothing rather than that.
 */
export function recipientHash(address: string, e: LedgerEnv): string | null {
  const salt = e.COMMS_RECIPIENT_HASH_SALT;
  if (!salt) return null;
  return createHmac("sha256", salt).update(address.trim().toLowerCase()).digest("hex");
}

/**
 * The key a send is recorded under. The caller's key when it names a catalog
 * entry; otherwise the single catalog leg that sends this template, when there
 * is exactly one; otherwise UNCATALOGUED (the smoke template, ad-hoc tooling).
 */
export function resolveEmailKey(template: EmailTemplateName, ctx: EmailSendContext | undefined): string {
  if (ctx?.key && getCatalogDefinition(ctx.key)) return ctx.key;
  const owners = Object.values(COMMS_CATALOG).filter((d) =>
    d.channels.some((c) => c.email?.template === template && c.path === "DIRECT"));
  return owners.length === 1 ? owners[0].key : UNCATALOGUED_KEY;
}

/** The channel a template's leg delivers on (OPERATOR_EMAIL for inbox legs), from the catalog. */
function emailChannelOf(key: string, template: EmailTemplateName): LedgerChannel {
  const leg = getCatalogDefinition(key)?.channels.find((c) => c.email?.template === template);
  return leg?.channel === "OPERATOR_EMAIL" ? "OPERATOR_EMAIL" : "EMAIL";
}

/** Classify a transport error string into the closed code set. The text itself is never stored. */
export function classifyEmailError(error: string | undefined): DeliveryErrorCode {
  const e = error ?? "";
  if (/failed to (render|build)/i.test(e)) return "RENDER";
  if (/timed out/i.test(e)) return "TIMEOUT";
  if (/RESEND_API_KEY is not set/.test(e)) return "NO_TRANSPORT";
  return "PROVIDER";
}

/** An opaque id from a caller, bounded; anything else is absent. */
function boundedId(v: string | null | undefined): string | null {
  return typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null;
}

/** One ledger row for one sendEmail outcome. Pure (apart from a generated send id). */
export function emailLedgerRow(args: {
  template: EmailTemplateName;
  to: string;
  result: EmailResult;
  ctx: EmailSendContext | undefined;
  env: LedgerEnv;
  now: Date;
}): CommsDeliveryRow {
  const { template, to, result, ctx, env, now } = args;
  const key = resolveEmailKey(template, ctx);
  const def = getCatalogDefinition(key);
  let status: DeliveryStatus;
  let reason: SuppressionReason | null = null;
  let errorCode: DeliveryErrorCode | null = null;
  switch (result.status) {
    case "sent": status = "ACCEPTED"; break;
    case "captured": status = "CAPTURED"; reason = result.reason ?? null; break;
    // The transports never answer "skipped". Its producers: the storm limit in
    // sendEmail (A-2b — its reason rides the result), and the notification
    // adapter's no-address path, whose explicit reason is NO_RECIPIENT.
    case "skipped": status = "SUPPRESSED"; reason = result.reason ?? "NO_RECIPIENT"; break;
    default:
      status = ctx?.terminalOnError ? "DEAD" : "FAILED";
      errorCode = classifyEmailError(result.error);
  }
  const userId = ctx?.recipientUserId ?? null;
  return {
    messageKey: boundedId(ctx?.messageKey) ?? randomUUID(),
    definitionKey: key,
    definitionVersion: def?.definitionVersion ?? 0,
    templateVersion: EMAIL_TEMPLATE_VERSIONS[template] ?? null,
    channel: emailChannelOf(key, template),
    status,
    reason,
    provider: result.provider || null,
    providerMessageId: result.status === "sent" && result.id ? result.id.slice(0, 200) : null,
    attempt: ctx?.attempt && ctx.attempt > 0 ? Math.floor(ctx.attempt) : 1,
    errorCode,
    recipientUserId: userId,
    recipientHash: userId === null && ctx?.hashRecipient !== false ? recipientHash(to, env) : null,
    notificationId: boundedId(ctx?.notificationId),
    environment: ledgerEnvironment(env),
    acceptedAt: status === "ACCEPTED" ? now : null,
    ...(boundedId(ctx?.contentVersionId) ? { contentVersionId: boundedId(ctx?.contentVersionId) } : {}),
    ...(ctx?.mode === "TEST" ? { mode: "TEST" as const } : {}),
    ...(boundedId(ctx?.automationRunItemId) ? { automationRunItemId: boundedId(ctx?.automationRunItemId) } : {}),
  };
}

/** One ledger row for an in-app (or preference-coupled email) outcome decided by createNotification. Pure. */
export function notificationLedgerRow(args: {
  key: string;
  channel: "IN_APP" | "EMAIL";
  status: Extract<DeliveryStatus, "ACCEPTED" | "SUPPRESSED" | "FAILED">;
  reason?: SuppressionReason | null;
  errorCode?: DeliveryErrorCode | null;
  recipientUserId: string;
  notificationId?: string | null;
  /** 1-based; the retry job's OBSOLETE closure is the attempt after the last one. */
  attempt?: number;
  /** Comms Center B1 — the published content version the in-app row rendered; absent = the code default. */
  contentVersionId?: string | null;
  env: LedgerEnv;
  now: Date;
}): CommsDeliveryRow {
  const def = getCatalogDefinition(args.key);
  return {
    // The Notification id when a row exists (shared with its email leg's rows,
    // told apart by channel); otherwise this outcome is a message of its own.
    messageKey: boundedId(args.notificationId) ?? randomUUID(),
    definitionKey: def ? args.key : UNCATALOGUED_KEY,
    definitionVersion: def?.definitionVersion ?? 0,
    templateVersion: args.channel === "IN_APP" ? IN_APP_TEMPLATE_VERSION : EMAIL_TEMPLATE_VERSIONS.notification,
    channel: args.channel,
    status: args.status,
    reason: args.reason ?? null,
    provider: args.channel === "IN_APP" ? "in-app" : null,
    providerMessageId: null,
    attempt: args.attempt && args.attempt > 0 ? Math.floor(args.attempt) : 1,
    errorCode: args.errorCode ?? null,
    recipientUserId: args.recipientUserId,
    recipientHash: null,
    notificationId: args.notificationId ?? null,
    environment: ledgerEnvironment(args.env),
    acceptedAt: args.status === "ACCEPTED" ? args.now : null,
    ...(boundedId(args.contentVersionId) ? { contentVersionId: boundedId(args.contentVersionId) } : {}),
  };
}

/** The class / Prisma code of a failure — the only part of it that may reach a log line. */
function errorTag(err: unknown): string {
  const e = (typeof err === "object" && err !== null ? err : {}) as { code?: unknown; name?: unknown };
  const code = typeof e.code === "string" && /^[A-Z0-9_]{1,12}$/.test(e.code) ? e.code : null;
  const name = typeof e.name === "string" && /^\w{1,60}$/.test(e.name) ? e.name : "Error";
  return code ? `${name}/${code}` : name;
}

const TIMED_OUT = Symbol("ledger-timeout");

/**
 * Write one row through `writer`. NEVER throws and never waits longer than
 * `timeoutMs`. Returns true only when the write completed. A failure is logged
 * ONCE with the key, channel, status and the error's class/code — no message
 * (a driver message can quote values), no recipient.
 */
export async function recordDelivery(
  writer: LedgerWriter,
  row: CommsDeliveryRow,
  opts: { timeoutMs?: number; log?: (line: string) => void } = {},
): Promise<boolean> {
  const log = opts.log ?? ((line: string) => console.warn(line));
  const where = `key=${row.definitionKey} channel=${row.channel} status=${row.status}`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const write = Promise.resolve().then(() => writer(row));
    // A write that loses the race must not surface later as an unhandled rejection.
    write.catch(() => undefined);
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), opts.timeoutMs ?? LEDGER_WRITE_TIMEOUT_MS);
    });
    const outcome = await Promise.race([write, timeout]);
    if (outcome === TIMED_OUT) {
      log(`[comms-ledger] delivery record timed out (non-fatal; the send is unaffected): ${where}`);
      return false;
    }
    return true;
  } catch (err) {
    log(`[comms-ledger] delivery record failed (non-fatal; the send is unaffected): ${where} error=${errorTag(err)}`);
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
