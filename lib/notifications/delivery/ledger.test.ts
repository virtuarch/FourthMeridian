/**
 * lib/notifications/delivery/ledger.test.ts  (Comms Center Phase A-2a)
 *
 * The delivery LEDGER's recording, end to end through the real chokepoints
 * with injected transports and an injected ledger writer (no database, no
 * network — the run-tests scope rule):
 *
 *   1. sendEmail writes exactly ONE row per send, per outcome: ACCEPTED (the
 *      provider accepted it), CAPTURED (the non-production guard), FAILED
 *      (provider / render / timeout / no transport), DEAD (declared last attempt);
 *   2. the row is keyed by the caller's catalog key and its channel / versions
 *      come from the catalog (OPERATOR_EMAIL for an inbox leg);
 *   3. NO PII: no address, subject, body, link or token in any written row;
 *      the recipient is the userId, or a SALTED HMAC only when there is no
 *      user (none at all without a salt, none for the post-purge goodbye);
 *   4. a ledger failure — a throw OR a hang — never blocks or changes the send,
 *      and logs one redacted line;
 *   5. createNotification records IN_APP ACCEPTED / SUPPRESSED (PREFERENCE_OFF,
 *      DEDUPE_OPEN) / FAILED, plus the email legs that never reach sendEmail;
 *   6. the production writer never writes under NODE_ENV=test or for the
 *      in-memory capture transport, and does write the guard's captures.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/notifications/delivery/ledger.test.ts
 */

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createEmailSender, type EmailSendEnv } from "@/lib/email/send";
import type { EmailMessage, EmailProvider, EmailResult } from "@/lib/email/types";
import { createNotification, type NotificationWriteClient } from "@/lib/notifications/create";
import type { PreferenceClient, PreferenceOverride } from "@/lib/notifications/preferences";
import type { ChannelAdapter, ChannelMessage } from "@/lib/notifications/types";
import {
  LEDGER_WRITE_TIMEOUT_MS,
  UNCATALOGUED_KEY,
  emailLedgerRow,
  recipientHash,
  recordDelivery,
} from "@/lib/notifications/delivery/record";
import { skipProductionWrite } from "@/lib/notifications/delivery/store";
import type { CommsDeliveryRow, LedgerWriter } from "@/lib/notifications/delivery/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}

// Importing lib/notifications/create pulls lib/db (constructs, never queries, a client).
process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("  ✗ unexpected unhandled rejection:", err);
  process.exit(1);
});

const NOW = new Date("2026-10-31T12:00:00.000Z");
const ADDRESS = "Person.Private@example.invalid";
const SECRET_URL = "https://app.example.invalid/reset?token=0123456789abcdef0123456789abcdef0123";
const SALT = "unit-test-salt";

function sink() {
  const rows: CommsDeliveryRow[] = [];
  const writer: LedgerWriter = async (row) => { rows.push(row); };
  return { rows, writer };
}
const provider = (result: EmailResult | ((m: EmailMessage) => EmailResult)): EmailProvider & { sent: EmailMessage[] } => {
  const sent: EmailMessage[] = [];
  return { name: "resend", sent, async send(m) { sent.push(m); return typeof result === "function" ? result(m) : result; } };
};
const capture: EmailProvider = { name: "capture", async send() { return { status: "captured", provider: "capture" }; } };
const PROD: EmailSendEnv = { VERCEL: "1", VERCEL_ENV: "production", NODE_ENV: "production", RESEND_API_KEY: "re_test", COMMS_RECIPIENT_HASH_SALT: SALT };
const PREVIEW: EmailSendEnv = { VERCEL: "1", VERCEL_ENV: "preview", NODE_ENV: "production", RESEND_API_KEY: "re_test", COMMS_RECIPIENT_HASH_SALT: SALT };

const allWritten: string[] = [];
function sender(env: EmailSendEnv, p: EmailProvider, writer: LedgerWriter, logs: string[] = []) {
  return createEmailSender({ env, provider: p, capture, ledger: async (row) => { allWritten.push(JSON.stringify(row)); return writer(row); }, log: (l) => logs.push(l), now: () => NOW });
}

async function outcomes(): Promise<void> {
  console.log("1. one row per send, per outcome");
  {
    const { rows, writer } = sink();
    const p = provider({ status: "sent", provider: "resend", id: "msg_123" });
    const r = await sender(PROD, p, writer)("password-reset", ADDRESS, { resetUrl: SECRET_URL }, { key: "PASSWORD_RESET_LINK_SENT", recipientUserId: "user_1" });
    const row = rows[0];
    check("sent → exactly one row, ACCEPTED (never DELIVERED), with the provider message id and acceptedAt",
      r.status === "sent" && rows.length === 1 && row.status === "ACCEPTED" && row.providerMessageId === "msg_123" && row.acceptedAt?.getTime() === NOW.getTime(), row);
    check("…keyed by the caller's catalog key; channel EMAIL; template + definition versions from the catalog",
      row.definitionKey === "PASSWORD_RESET_LINK_SENT" && row.channel === "EMAIL" && row.templateVersion === 1 && row.definitionVersion === 1 && row.attempt === 1);
    check("…recipient is the userId, and no hash when a userId exists", row.recipientUserId === "user_1" && row.recipientHash === null);
    check("…environment from the deployment (production)", row.environment === "production");
  }
  {
    const { rows, writer } = sink();
    const p = provider({ status: "sent", provider: "resend", id: "x" });
    const r = await sender(PREVIEW, p, writer)("security-alert", ADDRESS, { title: "t", message: "m" }, { key: "PASSWORD_CHANGED", recipientUserId: "user_1" });
    check("guard capture (Preview, not allowlisted) → CAPTURED with reason ENVIRONMENT_GUARD, provider none; nothing reached the provider",
      r.status === "captured" && rows.length === 1 && rows[0].status === "CAPTURED" && rows[0].reason === "ENVIRONMENT_GUARD"
      && rows[0].provider === "none" && rows[0].environment === "preview" && p.sent.length === 0 && rows[0].acceptedAt === null, rows[0]);
  }
  {
    const { rows, writer } = sink();
    const p = provider({ status: "error", provider: "resend", error: `422 invalid recipient ${ADDRESS}` });
    await sender(PROD, p, writer)("security-alert", ADDRESS, { title: "t", message: "m" }, { key: "PASSWORD_CHANGED", recipientUserId: "u" });
    check("provider error → FAILED with the closed code PROVIDER (the error text is NOT stored)",
      rows[0].status === "FAILED" && rows[0].errorCode === "PROVIDER" && !JSON.stringify(rows[0]).includes("invalid recipient"), rows[0]);
  }
  {
    const { rows, writer } = sink();
    const p = provider({ status: "error", provider: "resend", error: "boom" });
    await sender(PROD, p, writer)("notification", ADDRESS, {}, { key: "SYNC_FAILED", recipientUserId: "u", attempt: 3, terminalOnError: true });
    check("error on the declared last attempt → DEAD, attempt recorded", rows[0].status === "DEAD" && rows[0].attempt === 3 && rows[0].definitionKey === "SYNC_FAILED", rows[0]);
  }
  {
    const { rows, writer } = sink();
    const p = provider({ status: "sent", provider: "resend", id: "x" });
    await sender(PROD, p, writer)("password-reset", ADDRESS, { resetUrl: "javascript:alert(1)" }, { key: "PASSWORD_RESET_LINK_SENT", recipientUserId: "u" });
    check("render refusal → FAILED RENDER, provider never called", rows[0].status === "FAILED" && rows[0].errorCode === "RENDER" && p.sent.length === 0, rows[0]);
  }
  {
    const { rows, writer } = sink();
    await sender(PROD, provider({ status: "error", provider: "resend", error: "Resend send timed out after 10000 ms — delivery unknown." }), writer)("platform-alert", "ops@example.invalid", {}, { key: "PLATFORM_ALERT", recipientUserId: null });
    check("timeout → FAILED TIMEOUT (whatever the render outcome, one row)", rows.length === 1 && rows[0].status === "FAILED" && (rows[0].errorCode === "TIMEOUT" || rows[0].errorCode === "RENDER"), rows[0]);
    const row = emailLedgerRow({ template: "platform-alert", to: "ops@example.invalid", result: { status: "error", provider: "resend", error: "Resend send timed out after 10000 ms — delivery unknown." }, ctx: { key: "PLATFORM_ALERT", recipientUserId: null }, env: PROD, now: NOW });
    check("…the timeout text classifies as TIMEOUT; NO_TRANSPORT for a missing key",
      row.errorCode === "TIMEOUT" && emailLedgerRow({ template: "platform-alert", to: "a@b.c", result: { status: "error", provider: "resend", error: "RESEND_API_KEY is not set — cannot send via Resend." }, ctx: undefined, env: PROD, now: NOW }).errorCode === "NO_TRANSPORT");
    check("an operator-inbox leg records channel OPERATOR_EMAIL", row.channel === "OPERATOR_EMAIL");
  }
  {
    const { rows, writer } = sink();
    const s = sender(PROD, provider({ status: "sent", provider: "resend", id: "x" }), writer);
    await s("beta-invite", ADDRESS, { inviteUrl: SECRET_URL, issuedAt: NOW, expiresAt: NOW, origin: "request" });
    await s("smoke", ADDRESS, { note: "x" });
    await s("security-alert", ADDRESS, { title: "t", message: "m" }, { key: "NOT_A_KEY", recipientUserId: null });
    check("no context: the single owning leg's key (beta-invite → BETA_INVITATION_ISSUED); smoke and an unknown key → UNCATALOGUED",
      rows.map((r) => r.definitionKey).join() === `BETA_INVITATION_ISSUED,${UNCATALOGUED_KEY},${UNCATALOGUED_KEY}`, rows.map((r) => r.definitionKey));
  }
}

async function messageKeys(): Promise<void> {
  console.log("1b. messageKey: one message across retries (contract v1.0.2)");
  const { rows, writer } = sink();
  const s = sender(PROD, provider({ status: "error", provider: "resend", error: "x" }), writer);
  await s("security-alert", ADDRESS, { title: "t", message: "m" }, { key: "PASSWORD_CHANGED", recipientUserId: "u" });
  await s("security-alert", ADDRESS, { title: "t", message: "m" }, { key: "PASSWORD_CHANGED", recipientUserId: "u" });
  check("two direct sends → two messages (a generated send id each)", rows[0].messageKey !== rows[1].messageKey && /^[0-9a-f-]{36}$/.test(rows[0].messageKey));
  await s("notification", ADDRESS, {}, { key: "SYNC_FAILED", recipientUserId: "u", messageKey: "notif_1", notificationId: "notif_1", attempt: 1 });
  await s("notification", ADDRESS, {}, { key: "SYNC_FAILED", recipientUserId: "u", messageKey: "notif_1", notificationId: "notif_1", attempt: 2 });
  check("retries of a notification email share its messageKey (= the Notification id) with increasing attempt",
    rows[2].messageKey === "notif_1" && rows[3].messageKey === "notif_1" && rows[2].attempt === 1 && rows[3].attempt === 2 && rows[3].notificationId === "notif_1");
  const bogus = emailLedgerRow({ template: "smoke", to: "a@b.c", result: { status: "captured", provider: "capture" }, ctx: { key: "X", recipientUserId: null, messageKey: "has space; drop" }, env: PROD, now: NOW });
  check("a caller messageKey that is not an opaque id is replaced by a generated one", /^[0-9a-f-]{36}$/.test(bogus.messageKey));
  const skipped = emailLedgerRow({ template: "notification", to: "", result: { status: "skipped", provider: "email" }, ctx: { key: "SYNC_FAILED", recipientUserId: "u" }, env: PROD, now: NOW });
  check("a skipped result is SUPPRESSED with the explicit reason NO_RECIPIENT (never a null reason)", skipped.status === "SUPPRESSED" && skipped.reason === "NO_RECIPIENT");

  // The retry job hands the notification id to the adapter, which passes it as the messageKey.
  const retry = readFileSync("jobs/retry-notifications.ts", "utf8");
  const adapter = readFileSync("lib/notifications/channels/email.ts", "utf8");
  check("retry job → adapter → sendEmail carries the Notification id as the messageKey",
    /notificationId: true,/.test(retry) && /\{ notificationId: row\.notificationId \}/.test(retry) && /messageKey: message\.notificationId/.test(adapter));
}

async function deferred(): Promise<void> {
  console.log("1c. after the response: the ledger write is deferred when a request scope exists");
  const { rows, writer } = sink();
  const tasks: Array<() => Promise<void>> = [];
  const s = createEmailSender({ env: PROD, provider: provider({ status: "sent", provider: "resend", id: "m" }), capture, ledger: writer, now: () => NOW, defer: async (t) => { tasks.push(t); } });
  const r = await s("security-alert", ADDRESS, { title: "t", message: "m" }, { key: "PASSWORD_CHANGED", recipientUserId: "u" });
  check("with a defer seam the send returns BEFORE the ledger write", r.status === "sent" && rows.length === 0 && tasks.length === 1);
  await tasks[0]();
  check("…and the deferred task writes the row", rows.length === 1 && rows[0].status === "ACCEPTED");
  const throwingDefer = createEmailSender({ env: PROD, provider: provider({ status: "sent", provider: "resend", id: "m" }), capture, ledger: writer, defer: async () => { throw new Error("no"); } });
  check("a throwing defer seam never reaches the caller", (await throwingDefer("security-alert", ADDRESS, { title: "t", message: "m" })).status === "sent");
  const { runAfterResponse } = await import("@/lib/notifications/delivery/defer");
  let ran = false;
  await runAfterResponse(async () => { ran = true; });
  check("outside a request scope (jobs, scripts, tests) runAfterResponse runs the task INLINE", ran);
  const send = readFileSync("lib/email/send.ts", "utf8");
  check("production sendEmail defers through runAfterResponse", /ledger: writeDeliveryRow,\s*defer: runAfterResponse,/.test(send));
}

async function privacy(): Promise<void> {
  console.log("2. no address, subject, body, link or token on the ledger");
  const { rows, writer } = sink();
  const s = sender(PROD, provider({ status: "sent", provider: "resend", id: "x" }), writer);
  await s("password-reset", ADDRESS, { resetUrl: SECRET_URL }, { key: "PASSWORD_RESET_LINK_SENT", recipientUserId: "u" });
  await s("beta-request", "inbox@example.invalid", { applicantEmail: ADDRESS, note: "a private note", queueUrl: SECRET_URL }, { key: "BETA_REQUEST_RECEIVED", recipientUserId: null });
  await s("security-alert", ADDRESS, { title: "Your password was changed", message: "A secret message body" }, { key: "ACCOUNT_DELETED", recipientUserId: null, hashRecipient: false });
  const text = JSON.stringify(rows).toLowerCase();
  for (const needle of [ADDRESS.toLowerCase(), "person.private", "example.invalid", "token=", "0123456789abcdef", "reset your", "a private note", "secret message", "your password was changed", "subject", "body", "html"]) {
    check(`no row carries ${JSON.stringify(needle)}`, !text.includes(needle));
  }
  const columns = new Set(rows.flatMap((r) => Object.keys(r)));
  check("the row has exactly the ledger columns — no address/subject/body/open/click field",
    [...columns].sort().join() === "acceptedAt,attempt,channel,definitionKey,definitionVersion,environment,errorCode,messageKey,notificationId,provider,providerMessageId,reason,recipientHash,recipientUserId,status,templateVersion", [...columns]);
  const inbox = rows[1];
  const expected = createHmac("sha256", SALT).update("inbox@example.invalid").digest("hex");
  check("no userId (an operator inbox) → recipientHash = HMAC-SHA256(salt, normalised address), 64 hex", inbox.recipientUserId === null && inbox.recipientHash === expected && /^[0-9a-f]{64}$/.test(inbox.recipientHash!));
  check("…case/space-insensitive, and never an unsalted SHA-256", recipientHash(" INBOX@example.invalid ", PROD) === expected && recipientHash("inbox@example.invalid", { ...PROD, COMMS_RECIPIENT_HASH_SALT: "" }) === null);
  check("the post-purge goodbye stores neither userId nor hash", rows[2].recipientUserId === null && rows[2].recipientHash === null);
  check("every row written during this file is free of the test address", allWritten.every((w) => !w.toLowerCase().includes("person.private")));
}

async function nonBlocking(): Promise<void> {
  console.log("3. a ledger failure never blocks or changes the send");
  {
    const logs: string[] = [];
    const p = provider({ status: "sent", provider: "resend", id: "msg_9" });
    const failing: LedgerWriter = async () => { throw Object.assign(new Error(`insert failed for ${ADDRESS}`), { code: "P2021" }); };
    const r = await sender(PROD, p, failing, logs)("password-reset", ADDRESS, { resetUrl: SECRET_URL }, { key: "PASSWORD_RESET_LINK_SENT", recipientUserId: "u" });
    check("writer throws → the EmailResult is returned unchanged (sent, id) and the provider was called once",
      r.status === "sent" && r.id === "msg_9" && p.sent.length === 1);
    check("…one redacted log line: key + channel + status + error class/code, never the message or address",
      logs.length === 1 && /key=PASSWORD_RESET_LINK_SENT channel=EMAIL status=ACCEPTED error=Error\/P2021/.test(logs[0]) && !logs[0].includes("@") && !logs[0].includes("insert failed"), logs);
  }
  {
    const logs: string[] = [];
    const hang: LedgerWriter = () => new Promise(() => undefined);
    const t0 = Date.now();
    const r = await sender(PROD, provider({ status: "sent", provider: "resend", id: "m" }), hang, logs)("security-alert", ADDRESS, { title: "t", message: "m" }, { key: "PASSWORD_CHANGED", recipientUserId: "u" });
    const took = Date.now() - t0;
    check(`writer hangs → the send returns after ≈ LEDGER_WRITE_TIMEOUT_MS (${LEDGER_WRITE_TIMEOUT_MS} ms), not never`,
      r.status === "sent" && took >= LEDGER_WRITE_TIMEOUT_MS - 50 && took < LEDGER_WRITE_TIMEOUT_MS + 1500 && logs.some((l) => /timed out/.test(l)), { took, logs });
  }
  {
    const ok = await recordDelivery(async () => { throw "not even an Error"; }, emailLedgerRow({ template: "smoke", to: "a@b.c", result: { status: "captured", provider: "capture" }, ctx: undefined, env: PROD, now: NOW }), { log: () => undefined });
    check("recordDelivery never throws (a thrown string is a false, not an exception)", ok === false);
  }
}

// ── createNotification: in-app outcomes ───────────────────────────────────────

function notificationWorld(opts: { overrides?: PreferenceOverride[]; email?: string | null; failInsert?: boolean; failPrefs?: boolean; failLookup?: boolean } = {}) {
  const notifications: Array<{ id: string; userId: string; dedupeKey: string | null; archivedAt: Date | null }> = [];
  let n = 0;
  const client: NotificationWriteClient = {
    user: { async findUnique() { if (opts.failLookup) throw new Error("lookup failed"); return opts.email === null ? null : { email: opts.email ?? ADDRESS }; } },
    notificationDelivery: { async create() { return { id: "d1" }; } },
    notification: {
      async create({ data }) {
        if (opts.failInsert) throw new Error("db down");
        if (data.dedupeKey !== null && notifications.some((r) => r.userId === data.userId && r.dedupeKey === data.dedupeKey)) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        const row = { id: `n${++n}`, userId: data.userId, dedupeKey: data.dedupeKey, archivedAt: null };
        notifications.push(row);
        return { id: row.id };
      },
      async findUnique({ where }) {
        return notifications.find((r) => r.userId === where.userId_dedupeKey.userId && r.dedupeKey === where.userId_dedupeKey.dedupeKey) ?? null;
      },
      async update() { return { id: "x" }; },
    },
  };
  const prefClient = { notificationPreference: { async findMany() { if (opts.failPrefs) throw new Error("prefs down"); return opts.overrides ?? []; } } } as unknown as PreferenceClient;
  const delivered: ChannelMessage[] = [];
  const emailAdapter: ChannelAdapter = { channel: "EMAIL", name: "email", async deliver(m) { delivered.push(m); return m.email ? { status: "sent", provider: "resend", id: "m" } : { status: "skipped", provider: "email" }; } };
  const { rows, writer } = sink();
  return { client, prefClient, emailAdapter, rows, writer, delivered };
}

const SYNC = { type: "SYNC_FAILED" as const, userId: "user_7", data: { plaidItemId: "item_1", institutionName: "Bank", connectionState: "ERROR" } };

async function inApp(): Promise<void> {
  console.log("4. createNotification records the in-app outcome");
  {
    const w = notificationWorld();
    const r = await createNotification(SYNC, { client: w.client, prefClient: w.prefClient, emailAdapter: w.emailAdapter, ledger: w.writer });
    check("created → one IN_APP ACCEPTED row (provider in-app, notificationId, recipient userId)",
      r.status === "created" && w.rows.length === 1 && w.rows[0].channel === "IN_APP" && w.rows[0].status === "ACCEPTED"
      && w.rows[0].provider === "in-app" && w.rows[0].notificationId === r.id && w.rows[0].recipientUserId === "user_7" && w.rows[0].definitionKey === "SYNC_FAILED", w.rows);
    check("…the email leg went to the adapter (whose sendEmail writes its own row) with the ledger context", w.delivered.length === 1 && w.delivered[0].type === "SYNC_FAILED");
    const again = await createNotification(SYNC, { client: w.client, prefClient: w.prefClient, emailAdapter: w.emailAdapter, ledger: w.writer });
    check("dedupe (open holder) → IN_APP SUPPRESSED DEDUPE_OPEN + EMAIL SUPPRESSED DEDUPE_OPEN; no second email",
      again.status === "suppressed" && w.rows.slice(1).map((x) => `${x.channel}:${x.status}:${x.reason}`).join() === "IN_APP:SUPPRESSED:DEDUPE_OPEN,EMAIL:SUPPRESSED:DEDUPE_OPEN" && w.delivered.length === 1, w.rows);
  }
  {
    const w = notificationWorld({ overrides: [{ category: "FINANCIAL", channel: "IN_APP", enabled: false }] });
    const r = await createNotification(SYNC, { client: w.client, prefClient: w.prefClient, emailAdapter: w.emailAdapter, ledger: w.writer });
    check("IN_APP off → skipped; IN_APP SUPPRESSED PREFERENCE_OFF and the coupled EMAIL SUPPRESSED PREFERENCE_OFF (the email is lost too)",
      r.status === "skipped" && w.rows.map((x) => `${x.channel}:${x.status}:${x.reason}`).join() === "IN_APP:SUPPRESSED:PREFERENCE_OFF,EMAIL:SUPPRESSED:PREFERENCE_OFF" && w.delivered.length === 0, w.rows);
  }
  {
    const w = notificationWorld({ overrides: [{ category: "FINANCIAL", channel: "EMAIL", enabled: false }] });
    const r = await createNotification(SYNC, { client: w.client, prefClient: w.prefClient, emailAdapter: w.emailAdapter, ledger: w.writer });
    check("EMAIL off → IN_APP ACCEPTED + EMAIL SUPPRESSED PREFERENCE_OFF; nothing sent",
      r.status === "created" && w.rows.map((x) => `${x.channel}:${x.status}:${x.reason}`).join() === "IN_APP:ACCEPTED:null,EMAIL:SUPPRESSED:PREFERENCE_OFF" && w.delivered.length === 0, w.rows);
  }
  {
    const w = notificationWorld({ email: null });
    await createNotification(SYNC, { client: w.client, prefClient: w.prefClient, emailAdapter: w.emailAdapter, ledger: w.writer });
    check("no recipient address → EMAIL SUPPRESSED NO_RECIPIENT (the adapter skipped before sendEmail)",
      w.rows.some((x) => x.channel === "EMAIL" && x.status === "SUPPRESSED" && x.reason === "NO_RECIPIENT"), w.rows);
  }
  {
    const w = notificationWorld({ failPrefs: true });
    const r = await createNotification(SYNC, { client: w.client, prefClient: w.prefClient, emailAdapter: w.emailAdapter, ledger: w.writer });
    check("preference read fails → error; IN_APP FAILED PREFERENCE_READ and the lost EMAIL leg FAILED PREFERENCE_READ",
      r.status === "error" && w.rows.map((x) => `${x.channel}:${x.status}:${x.errorCode}`).join() === "IN_APP:FAILED:PREFERENCE_READ,EMAIL:FAILED:PREFERENCE_READ" && w.delivered.length === 0, w.rows);
  }
  {
    const w = notificationWorld({ failLookup: true });
    const r = await createNotification(SYNC, { client: w.client, prefClient: w.prefClient, emailAdapter: w.emailAdapter, ledger: w.writer });
    check("recipient lookup fails → created; EMAIL FAILED RECIPIENT_LOOKUP (with the notification as its message); no send",
      r.status === "created" && w.rows.some((x) => x.channel === "EMAIL" && x.status === "FAILED" && x.errorCode === "RECIPIENT_LOOKUP" && x.messageKey === r.id) && w.delivered.length === 0, w.rows);
  }
  {
    const w = notificationWorld();
    const r = await createNotification(SYNC, { client: w.client, prefClient: w.prefClient, emailAdapter: w.emailAdapter, ledger: w.writer });
    check("the email leg reaches the adapter with the Notification id (its messageKey); the in-app row's messageKey is that id too",
      w.delivered[0]?.notificationId === r.id && w.rows[0].messageKey === r.id);
  }
  {
    const w = notificationWorld({ failInsert: true });
    const r = await createNotification(SYNC, { client: w.client, prefClient: w.prefClient, emailAdapter: w.emailAdapter, ledger: w.writer });
    check("insert failure → error result, IN_APP FAILED STORE", r.status === "error" && w.rows.length === 1 && w.rows[0].status === "FAILED" && w.rows[0].errorCode === "STORE", w.rows);
  }
  {
    const w = notificationWorld();
    const r = await createNotification(SYNC, { client: w.client, prefClient: w.prefClient, emailAdapter: w.emailAdapter, ledger: async () => { throw new Error("ledger down"); } });
    check("a failing in-app ledger write never changes the result (created)", r.status === "created" && w.delivered.length === 1);
  }
  {
    const w = notificationWorld();
    const r = await createNotification({ ...SYNC, data: { ...SYNC.data, plaidItemId: "item_2" } }, { client: w.client, prefClient: w.prefClient, emailAdapter: w.emailAdapter });
    check("an injected client WITHOUT a ledger delegate records nothing (never falls through to a real DB)", r.status === "created" && w.rows.length === 0);
  }
}

async function productionWriter(): Promise<void> {
  console.log("5. the production writer's skips");
  const base = emailLedgerRow({ template: "security-alert", to: ADDRESS, result: { status: "captured", provider: "none", reason: "ENVIRONMENT_GUARD" }, ctx: { key: "PASSWORD_CHANGED", recipientUserId: "u" }, env: PREVIEW, now: NOW });
  check("NODE_ENV=test → never written", skipProductionWrite(base, "test") === true);
  check("the in-memory capture transport (provider capture) → not a delivery, not written", skipProductionWrite({ ...base, provider: "capture" }, "production") === true);
  check("the guard's capture (provider none) → written", skipProductionWrite(base, "production") === false);
}

async function main(): Promise<void> {
  await outcomes();
  await messageKeys();
  await deferred();
  await privacy();
  await nonBlocking();
  await inApp();
  await productionWriter();
  if (failures > 0) { console.error(`\n${failures} delivery-ledger check(s) failed`); process.exit(1); }
  console.log("\nAll delivery-ledger recording checks passed.");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
