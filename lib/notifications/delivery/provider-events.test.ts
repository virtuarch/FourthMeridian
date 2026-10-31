/**
 * lib/notifications/delivery/provider-events.test.ts  (Comms Center Phase C)
 *
 * The Resend delivery webhook, behaviourally: svix verification, the inert
 * (unconfigured) state, idempotency, forward-only reconciliation onto the
 * append-only ledger, opens/clicks dropped, unknown ids unmatched, no PII
 * stored, the health builder and analytics' measured.delivered. No database,
 * no network: an in-memory store with a UNIQUE svix id.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/notifications/delivery/provider-events.test.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  buildWebhookHealth,
  decideReconciliation,
  currentRow,
  DuplicateProviderEvent,
  handleResendWebhook,
  isExpectedUnmatchable,
  MEASURING_EVENT_WHERE,
  UNMATCHED_GRACE_MS,
  MAX_WEBHOOK_BODY_BYTES,
  type LedgerRowRead,
  type ProviderEventInsert,
  type ProviderEventStore,
  type ResendWebhookDeps,
  type ResendWebhookRequest,
} from "@/lib/notifications/delivery/provider-events";
import { svixKey, svixSign, verifySvix, type SvixRejection } from "@/lib/notifications/delivery/svix";
import { finalAttempts } from "@/lib/notifications/delivery/rollup";
import { buildDeliveryAnalytics, type DeliveryReadSource } from "@/lib/notifications/delivery/analytics";
import type { CommsDeliveryRow } from "@/lib/notifications/delivery/types";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`); }
}

const KEY_BYTES = randomBytes(24);
const SECRET = `whsec_${KEY_BYTES.toString("base64")}`;
const OTHER_SECRET = `whsec_${randomBytes(24).toString("base64")}`;
const NOW = new Date("2026-10-31T12:00:00Z");
const NOW_S = String(Math.floor(NOW.getTime() / 1000));
const EMAIL = "customer.person@example.com";
const SUBJECT = "Your secret subject line";

/** An event instant older than the F2 grace window (an id genuinely unknown here is stored UNMATCHED). */
const OLD_EVENT_AT = "2026-10-31T11:40:00.000Z";

function body(type: string, emailId = "msg-resend-1", extra: Record<string, unknown> = {}, createdAt = "2026-10-31T11:59:30.000Z"): string {
  return JSON.stringify({
    type,
    created_at: createdAt,
    data: { email_id: emailId, to: [EMAIL], from: "Fourth Meridian <noreply@fourthmeridian.com>", subject: SUBJECT, created_at: "2026-10-31T11:58:00.000Z", ...extra },
  });
}

function signed(raw: string, opts: { id?: string; ts?: string; secret?: string; sigHeader?: (good: string) => string } = {}): ResendWebhookRequest {
  const id = opts.id ?? `msg_${randomBytes(6).toString("hex")}`;
  const ts = opts.ts ?? NOW_S;
  const good = svixSign(svixKey(opts.secret ?? SECRET)!, id, ts, raw);
  return { rawBody: raw, headers: { id, timestamp: ts, signature: opts.sigHeader ? opts.sigHeader(good) : `v1,${good}` } };
}

/**
 * An in-memory store with TRANSACTION semantics close to Postgres READ COMMITTED: each
 * transaction stages its writes and applies them at commit; reads see committed rows only;
 * an appended row's createdAt is the transaction's START (Postgres now()); lockMessage is a
 * per-key mutex held to commit (pg_advisory_xact_lock); a repeated svix id throws
 * DuplicateProviderEvent and rolls the transaction back.
 */
function memStore(seed: LedgerRowRead[] = [], opts: { beforeCommit?: (types: string[]) => Promise<void> } = {}) {
  const ledger = [...seed];
  const events = new Map<string, ProviderEventInsert>();
  const locks = new Map<string, Promise<void>>();
  let clock = 0;
  const calls = { find: 0, commit: 0, locks: 0 };
  const store: ProviderEventStore = {
    async transaction(fn) {
      calls.commit++;
      const startedAt = new Date(NOW.getTime() + ++clock * 1000);
      const staged: { events: ProviderEventInsert[]; rows: CommsDeliveryRow[] } = { events: [], rows: [] };
      const releases: Array<() => void> = [];
      try {
        const out = await fn({
          async findMessageRows(pmid) {
            calls.find++;
            await new Promise((r) => setImmediate(r));
            const hit = ledger.filter((r) => r.providerMessageId === pmid).sort((a, b) => b.attempt - a.attempt)[0];
            return hit ? ledger.filter((r) => r.channel === hit.channel && r.messageKey === hit.messageKey) : [];
          },
          async lockMessage(key) {
            calls.locks++;
            const prior = locks.get(key) ?? Promise.resolve();
            let release!: () => void;
            const mine = new Promise<void>((r) => { release = r; });
            locks.set(key, prior.then(() => mine));
            releases.push(release);
            await prior;
          },
          async insertEvent(event) {
            if (events.has(event.providerEventId) || staged.events.some((e) => e.providerEventId === event.providerEventId)) throw new DuplicateProviderEvent();
            staged.events.push(event);
          },
          async appendLedgerRow(row) { staged.rows.push(row); },
        });
        await opts.beforeCommit?.(staged.events.map((e) => e.type));
        // A concurrent duplicate that committed first wins (the UNIQUE index at commit).
        for (const e of staged.events) if (events.has(e.providerEventId)) throw new DuplicateProviderEvent();
        for (const e of staged.events) events.set(e.providerEventId, e);
        for (const r of staged.rows) ledger.push({ ...r, id: `row-${ledger.length + 1}`, createdAt: startedAt });
        return out;
      } finally {
        for (const r of releases) r();
      }
    },
  };
  return { store, ledger, events, calls };
}

function acceptedRow(over: Partial<LedgerRowRead> = {}): LedgerRowRead {
  return {
    id: "row-accepted", createdAt: new Date("2026-10-31T11:58:00Z"),
    messageKey: "notif-1", definitionKey: "SPACE_INVITE_RECEIVED", definitionVersion: 1, templateVersion: 2,
    channel: "EMAIL", status: "ACCEPTED", reason: null, provider: "resend", providerMessageId: "msg-resend-1",
    attempt: 1, errorCode: null, recipientUserId: "user-1", recipientHash: null, notificationId: "notif-1",
    environment: "production", acceptedAt: new Date("2026-10-31T11:58:00Z"), mode: "LIVE", contentVersionId: null,
    automationRunItemId: null, deliveredAt: null,
    ...over,
  };
}

function deps(store: ProviderEventStore, over: Partial<ResendWebhookDeps> = {}) {
  const rejections: SvixRejection[] = [];
  const lines: string[] = [];
  const d: ResendWebhookDeps = {
    secret: SECRET,
    now: () => NOW,
    store,
    recordRejection: (r) => rejections.push(r),
    log: { log: (l: string) => lines.push(l), warn: (l: string) => lines.push(l) },
    ...over,
  };
  return { d, rejections, lines };
}

const finalStatus = (ledger: LedgerRowRead[]) => {
  const f = finalAttempts(ledger.map((r) => ({ ...r, reason: r.reason })), ledger);
  return f.map((r) => r.status).join();
};

async function main() {
  console.log("svix verification");
  {
    const s = memStore([acceptedRow()]);
    const { d, rejections } = deps(s.store);
    const r = await handleResendWebhook(signed(body("email.delivered")), d);
    check("a valid signature is accepted (200, handled, APPLIED)", r.status === 200 && r.body.handled === true && r.body.outcome === "APPLIED", r);
    check("…and no rejection is counted", rejections.length === 0);
  }
  {
    const cases: Array<[string, ReturnType<typeof signed>, SvixRejection]> = [];
    const raw = body("email.delivered");
    cases.push(["wrong secret", signed(raw, { secret: OTHER_SECRET }), "SIGNATURE_MISMATCH"]);
    const tampered = signed(raw);
    cases.push(["tampered body", { ...tampered, rawBody: raw.replace("msg-resend-1", "msg-resend-2") }, "SIGNATURE_MISMATCH"]);
    const t2 = signed(raw);
    cases.push(["missing svix-id", { ...t2, headers: { ...t2.headers, id: null } }, "MISSING_HEADERS"]);
    cases.push(["missing svix-timestamp", { ...t2, headers: { ...t2.headers, timestamp: null } }, "MISSING_HEADERS"]);
    cases.push(["missing svix-signature", { ...t2, headers: { ...t2.headers, signature: null } }, "MISSING_HEADERS"]);
    cases.push(["timestamp 5 min + 1 s old (replay)", signed(raw, { ts: String(Number(NOW_S) - 301) }), "TIMESTAMP_TOO_OLD"]);
    cases.push(["timestamp 5 min + 1 s in the future", signed(raw, { ts: String(Number(NOW_S) + 301) }), "TIMESTAMP_TOO_NEW"]);
    cases.push(["non-numeric timestamp", { ...t2, headers: { ...t2.headers, timestamp: "2026-10-31T12:00:00Z" } }, "BAD_TIMESTAMP"]);
    cases.push(["only a v2 signature entry", signed(raw, { sigHeader: (g) => `v2,${g}` }), "NO_V1_SIGNATURE"]);
    // The old timestamp is re-signed with the RIGHT secret: a valid signature does not rescue a replay.
    for (const [name, req, reason] of cases) {
      const s = memStore([acceptedRow()]);
      const { d, rejections } = deps(s.store);
      const r = await handleResendWebhook(req, d);
      check(`${name}: 401, reason ${reason}, nothing read or stored`,
        r.status === 401 && rejections.join() === reason && s.calls.find === 0 && s.calls.commit === 0 && s.events.size === 0 && s.ledger.length === 1,
        { status: r.status, rejections, calls: s.calls });
    }
    const edge = verifySvix({ key: svixKey(SECRET)!, headers: signed(raw, { ts: String(Number(NOW_S) - 300) }).headers, rawBody: raw, now: NOW });
    check("exactly 5 min old is still inside the tolerance", edge.ok);
  }
  {
    const raw = body("email.delivered");
    const s = memStore([acceptedRow()]);
    const { d } = deps(s.store);
    const bogus = Buffer.from("x".repeat(32)).toString("base64");
    const r = await handleResendWebhook(signed(raw, { sigHeader: (g) => `v1,${bogus} v2,${g} v1,${g}` }), d);
    check("multiple signatures: a later matching v1 entry verifies (rotation), v2 entries ignored", r.status === 200 && r.body.handled === true, r);
    const r2 = await handleResendWebhook(signed(raw, { sigHeader: () => `v1,${bogus} v1,${Buffer.from("y".repeat(32)).toString("base64")}` }), deps(memStore().store).d);
    check("multiple signatures, none matching: 401", r2.status === 401);
  }

  console.log("\ninert until configured");
  for (const [label, secret] of [["unset", undefined], ["empty", ""], ["not base64", "whsec_***not-base64***"], ["bare prefix", "whsec_"]] as const) {
    const s = memStore([acceptedRow()]);
    const { d, rejections } = deps(s.store, { secret });
    const r = await handleResendWebhook(signed(body("email.delivered")), d);
    check(`secret ${label}: 503 UNAVAILABLE, nothing verified, read, stored or counted`,
      r.status === 503 && r.body.code === "UNAVAILABLE" && s.calls.find === 0 && s.calls.commit === 0 && rejections.length === 0 && s.ledger.length === 1, r);
  }

  console.log("\nbounded input");
  {
    const s = memStore([acceptedRow()]);
    const big = body("email.delivered", "msg-resend-1", { pad: "z".repeat(MAX_WEBHOOK_BODY_BYTES) });
    const r = await handleResendWebhook(signed(big), deps(s.store).d);
    check("a body over the cap is 413 and nothing is verified or stored", r.status === 413 && s.calls.commit === 0, r.status);
    const bad = signed("{not json");
    const r2 = await handleResendWebhook(bad, deps(memStore().store).d);
    check("a verified but unparseable body is 400, nothing stored", r2.status === 400);
  }

  console.log("\nidempotency (svix-id)");
  {
    const s = memStore([acceptedRow()]);
    const { d } = deps(s.store);
    const req = signed(body("email.delivered"), { id: "msg_dup_1" });
    const a = await handleResendWebhook(req, d);
    const b = await handleResendWebhook(req, d);
    check("the same svix-id twice: the second is 200 duplicate, no second event, no second ledger row",
      a.body.handled === true && b.status === 200 && b.body.duplicate === true && s.events.size === 1 && s.ledger.length === 2, { a: a.body, b: b.body, n: s.ledger.length });
    const c = await handleResendWebhook(signed(body("email.bounced"), { id: "msg_dup_1" }), d);
    check("…even with a different (re-signed) body under the same svix-id: no-op", c.body.duplicate === true && s.ledger.length === 2);
  }

  console.log("\nreconciliation onto the append-only ledger");
  for (const [type, status] of [["email.delivered", "DELIVERED"], ["email.bounced", "BOUNCED"], ["email.complained", "COMPLAINED"]] as const) {
    const s = memStore([acceptedRow()]);
    const r = await handleResendWebhook(signed(body(type)), deps(s.store).d);
    const added = s.ledger[1];
    check(`${type}: one row APPENDED (the accepted row untouched) with status ${status}, same messageKey + attempt`,
      r.body.outcome === "APPLIED" && s.ledger.length === 2 && s.ledger[0].status === "ACCEPTED" && added?.status === status
        && added.messageKey === "notif-1" && added.attempt === 1 && added.channel === "EMAIL" && added.providerMessageId === "msg-resend-1",
      added);
    check(`${type}: the appended row is the message's FINAL row (read/rollup order) — counted once, as ${status}`, finalStatus(s.ledger) === status, finalStatus(s.ledger));
    check(`${type}: the event row matched the accepted row`, s.events.size === 1 && [...s.events.values()][0].deliveryId === "row-accepted" && [...s.events.values()][0].messageKey === "notif-1");
    if (status === "DELIVERED") check("delivered: deliveredAt = the provider's event instant", added?.deliveredAt?.toISOString() === "2026-10-31T11:59:30.000Z", added?.deliveredAt);
    else check(`${type}: deliveredAt not invented`, added?.deliveredAt === null);
  }
  {
    const s = memStore([acceptedRow()]);
    const r = await handleResendWebhook(signed(body("email.delivery_delayed")), deps(s.store).d);
    check("delivery_delayed: a NOTE on the event row only — no ledger row, status stays ACCEPTED",
      r.body.outcome === "NOTE" && s.ledger.length === 1 && s.events.size === 1 && finalStatus(s.ledger) === "ACCEPTED");
  }
  {
    const s = memStore([acceptedRow({ mode: "TEST", automationRunItemId: "item-9", contentVersionId: "ver-3" })]);
    await handleResendWebhook(signed(body("email.delivered")), deps(s.store).d);
    check("the appended row carries the message's mode / automation item / content version", s.ledger[1]?.mode === "TEST" && s.ledger[1]?.automationRunItemId === "item-9" && s.ledger[1]?.contentVersionId === "ver-3");
  }

  console.log("\nopens and clicks are never tracked");
  for (const type of ["email.opened", "email.clicked"]) {
    const s = memStore([acceptedRow()]);
    const { d, lines } = deps(s.store);
    const r = await handleResendWebhook(signed(body(type, "msg-resend-1", { click: { link: "https://x.test/?t=1" } })), d);
    check(`${type}: 200 acknowledged, NOTHING read or stored, no log line`, r.status === 200 && r.body.handled === false && s.calls.find === 0 && s.calls.commit === 0 && s.events.size === 0 && s.ledger.length === 1 && lines.length === 0, { r: r.body, calls: s.calls, lines });
  }
  for (const type of ["email.sent", "email.scheduled", "contact.created", ""]) {
    const s = memStore([acceptedRow()]);
    const r = await handleResendWebhook(signed(body(type)), deps(s.store).d);
    check(`unhandled type "${type}": acknowledged, nothing stored`, r.status === 200 && s.calls.commit === 0);
  }
  {
    const src = readFileSync(join(process.cwd(), "lib/notifications/delivery/provider-events.ts"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    check("source: no handled type, status or column mentions opened/clicked", !/"email\.(opened|clicked)"\s*:/.test(src) && !/OPENED|CLICKED/.test(src));
  }

  console.log("\nunknown message ids");
  {
    const s = memStore([acceptedRow()]);
    const r = await handleResendWebhook(signed(body("email.delivered", "msg-never-sent", {}, OLD_EVENT_AT)), deps(s.store).d);
    const ev = [...s.events.values()][0];
    check("an unknown provider id: stored UNMATCHED, deliveryId/messageKey null, NO ledger row created",
      r.body.outcome === "UNMATCHED" && ev?.deliveryId === null && ev?.messageKey === null && s.ledger.length === 1, { r: r.body, ev });
    const r2 = await handleResendWebhook(signed(body("email.delivered", "../../etc")), deps(s.store).d);
    check("a malformed provider id: acknowledged, nothing stored", r2.body.handled === false && s.events.size === 1);
  }

  console.log("\nforward only");
  {
    const seq = async (types: string[]) => {
      const s = memStore([acceptedRow()]);
      const outs: string[] = [];
      for (const t of types) outs.push(String((await handleResendWebhook(signed(body(t)), deps(s.store).d)).body.outcome));
      return { outs, final: finalStatus(s.ledger), rows: s.ledger.length };
    };
    const a = await seq(["email.bounced", "email.delivered"]);
    check("a LATE delivered never overwrites BOUNCED (NO_CHANGE; final stays BOUNCED)", a.outs.join() === "APPLIED,NO_CHANGE" && a.final === "BOUNCED" && a.rows === 2, a);
    const b = await seq(["email.delivered", "email.delivery_delayed"]);
    check("a late delivery_delayed does not downgrade DELIVERED", b.outs.join() === "APPLIED,NOTE" && b.final === "DELIVERED" && b.rows === 2, b);
    const c = await seq(["email.delivered", "email.delivered"]);
    check("a second delivered (new svix id) is NO_CHANGE — one DELIVERED row", c.outs.join() === "APPLIED,NO_CHANGE" && c.rows === 2, c);
    const e = await seq(["email.delivered", "email.complained"]);
    check("delivered → complained moves forward (COMPLAINED final)", e.outs.join() === "APPLIED,APPLIED" && e.final === "COMPLAINED", e);
    const f = await seq(["email.complained", "email.bounced", "email.delivered"]);
    check("after COMPLAINED nothing moves it", f.outs.join() === "APPLIED,NO_CHANGE,NO_CHANGE" && f.final === "COMPLAINED", f);
    const s = memStore([acceptedRow()]);
    await handleResendWebhook(signed(body("email.delivered")), deps(s.store).d);
    await handleResendWebhook(signed(body("email.complained")), deps(s.store).d);
    check("COMPLAINED after DELIVERED carries the earlier deliveredAt forward", s.ledger[2]?.deliveredAt?.toISOString() === "2026-10-31T11:59:30.000Z");
  }
  {
    const superseded = [acceptedRow(), acceptedRow({ id: "row-2", attempt: 2, status: "FAILED", providerMessageId: null, acceptedAt: null, createdAt: new Date("2026-10-31T11:59:00Z") })];
    const r = decideReconciliation({ type: "delivered", providerMessageId: "msg-resend-1", occurredAt: NOW }, superseded);
    check("an event for an attempt a later attempt superseded is NO_CHANGE", r.outcome === "NO_CHANGE" && r.append === null, r);
    const reSent = [acceptedRow(), acceptedRow({ id: "row-2", attempt: 2, providerMessageId: "msg-resend-2", createdAt: new Date("2026-10-31T11:59:00Z") })];
    const r2 = decideReconciliation({ type: "delivered", providerMessageId: "msg-resend-1", occurredAt: NOW }, reSent);
    check("…including a later ACCEPTED attempt under another provider id (the old id's event moves nothing)", r2.outcome === "NO_CHANGE" && r2.append === null, r2);
    const failed = [acceptedRow({ status: "CAPTURED" })];
    check("a status an event may not move (CAPTURED) is NO_CHANGE", decideReconciliation({ type: "delivered", providerMessageId: "msg-resend-1", occurredAt: NOW }, failed).outcome === "NO_CHANGE");
  }

  console.log("\nno PII stored");
  {
    const s = memStore([acceptedRow({ recipientUserId: null, recipientHash: "hmac-already-on-ledger" })]);
    await handleResendWebhook(signed(body("email.bounced", "msg-resend-1", { bounce: { message: `550 ${EMAIL} does not exist`, type: "Permanent", subType: "General" } })), deps(s.store).d);
    await handleResendWebhook(signed(body("email.delivered", "msg-unknown-2", {}, OLD_EVENT_AT)), deps(s.store).d);
    const blob = JSON.stringify({ events: [...s.events.values()], ledger: s.ledger });
    check("no recipient address, subject, from or bounce text anywhere in what was stored",
      !blob.includes(EMAIL) && !blob.includes("customer.person") && !blob.includes(SUBJECT) && !blob.includes("noreply@") && !blob.includes("does not exist") && !blob.includes("Permanent"));
    const keys = [...new Set([...s.events.values()].flatMap((e) => Object.keys(e)))].sort().join();
    check("the event row holds exactly the closed field set", keys === "deliveryId,messageKey,occurredAt,outcome,provider,providerEventId,providerMessageId,type", keys);
    check("the appended row's recipient is only what the ledger already held", s.ledger[1]?.recipientHash === "hmac-already-on-ledger" && s.ledger[1]?.recipientUserId === null);
    const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
    const model = /model CommsProviderEvent \{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? "";
    const cols = [...model.matchAll(/^\s+(\w+)\s+\w/gm)].map((m) => m[1]).sort().join();
    check("the CommsProviderEvent model has no payload / address / subject column",
      cols === "deliveryId,id,messageKey,occurredAt,outcome,provider,providerEventId,providerMessageId,receivedAt,type", cols);
  }

  console.log("\nthe route adapter (static)");
  {
    const route = readFileSync(join(process.cwd(), "app/api/webhooks/resend/route.ts"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    check("reads the RAW body through the capped streaming reader and never req.json() / req.text()",
      /readBodyCapped\(req\.body, MAX_WEBHOOK_BODY_BYTES\)/.test(route) && !/req\.json\(\)/.test(route) && !/req\.text\(\)/.test(route));
    check("inert check precedes the rate limiter, which precedes the body read",
      route.indexOf("webhookConfigured(secret)") > -1 && route.indexOf("webhookConfigured(secret)") < route.indexOf("limitByIp(") && route.indexOf("limitByIp(") < route.indexOf("readBodyCapped("));
    check("a Content-Length over the cap is refused before the body is read", route.indexOf("MAX_WEBHOOK_BODY_BYTES") > -1 && route.indexOf("MAX_WEBHOOK_BODY_BYTES") < route.indexOf("readBodyCapped("));
    check("F6: no // PUBLIC: annotation — the census credits the receiver itself", !/\/\/\s*PUBLIC:/.test(readFileSync(join(process.cwd(), "app/api/webhooks/resend/route.ts"), "utf8")) && /handleResendWebhook\(/.test(route));
    check("an over-cap streamed body is a 413", /if \(!body\.ok\)[\s\S]{0,160}status: 413/.test(route));
    check("the secret is read from RESEND_WEBHOOK_SECRET and never put in a response or log", /process\.env\.RESEND_WEBHOOK_SECRET/.test(route) && !/console\./.test(route));
  }

  console.log("\nhealth (read-only)");
  {
    const h = buildWebhookHealth({
      lastReceivedAt: new Date("2026-10-31T11:00:00Z"),
      byTypeOutcome: [{ type: "delivered", outcome: "APPLIED", count: 5 }, { type: "delivered", outcome: "UNMATCHED", count: 2 }, { type: "bounced", outcome: "APPLIED", count: 1 }, { type: "delivery_delayed", outcome: "NOTE", count: 3 }],
      rejections: [{ metric: "signature:SIGNATURE_MISMATCH", count: 4 }, { metric: "signature:TIMESTAMP_TOO_OLD", count: 1 }],
      acceptedWithoutEvent: 7,
    }, true, 7);
    check("counts by type (all four keys), unmatched, last event, rejections by reason",
      JSON.stringify(h.countsByType) === JSON.stringify({ delivered: 7, bounced: 1, complained: 0, delivery_delayed: 3 })
        && h.unmatched === 2 && h.lastVerifiedEventAt === "2026-10-31T11:00:00.000Z"
        && h.signatureFailures.total === 5 && h.signatureFailures.byReason.SIGNATURE_MISMATCH === 4 && h.acceptedWithoutEvent72h === 7, h);
    const off = buildWebhookHealth({ lastReceivedAt: null, byTypeOutcome: [], rejections: [], acceptedWithoutEvent: 9 }, false, 7);
    check("unconfigured: configured false, no stale-ACCEPTED claim", off.configured === false && off.acceptedWithoutEvent72h === null && off.lastVerifiedEventAt === null);
    check("health carries no opens/clicks keys", !/open|click/i.test(JSON.stringify(h)));
  }

  console.log("\nN-b: UNCERTAIN_ACCEPTANCE rows are expected-unmatchable");
  {
    // An idempotency-conflict send: ACCEPTED, provider resend, NO provider id (lib/email/providers/resend.ts R4).
    const uncertain = acceptedRow({ id: "row-u", messageKey: "item-u", providerMessageId: null });
    check("an ACCEPTED resend row with no provider id is expected-unmatchable; one with an id is not",
      isExpectedUnmatchable(uncertain) && !isExpectedUnmatchable(acceptedRow()) && !isExpectedUnmatchable({ ...uncertain, status: "FAILED" }));
    const s = memStore([uncertain]);
    const r = await handleResendWebhook(signed(body("email.delivered", "msg-other", {}, OLD_EVENT_AT)), deps(s.store).d);
    check("an event never matches it (UNMATCHED for the event's own id; the uncertain row is untouched)",
      r.body.outcome === "UNMATCHED" && s.ledger.length === 1 && s.ledger[0].status === "ACCEPTED");
    const h = buildWebhookHealth({ lastReceivedAt: null, byTypeOutcome: [], rejections: [], acceptedWithoutEvent: 4, acceptedUncertain: 2 }, true, 7);
    check("health counts them APART: awaiting confirmation 4 (matchable only), accepted-uncertain 2",
      h.acceptedWithoutEvent72h === 4 && h.acceptedUncertain72h === 2, h);
    const off = buildWebhookHealth({ lastReceivedAt: null, byTypeOutcome: [], rejections: [], acceptedWithoutEvent: 4, acceptedUncertain: 2 }, false, 7);
    check("unconfigured: neither count is claimed", off.acceptedWithoutEvent72h === null && off.acceptedUncertain72h === null);
    const sql = readFileSync(join(process.cwd(), "lib/notifications/delivery/provider-event-store.ts"), "utf8");
    check("the store's awaiting count requires a provider id; the uncertain count is the no-id ACCEPTED rows",
      /"status" = 'ACCEPTED' AND "providerMessageId" IS NOT NULL\)\)::int AS n/.test(sql) && /"status" = 'ACCEPTED' AND "providerMessageId" IS NULL\)\)::int AS u/.test(sql));
  }

  console.log("\nanalytics: delivered vs accepted (v1.2)");
  {
    const src = (exists: boolean): DeliveryReadSource => ({
      ledgerSince: async () => "2026-10-25",
      counts: async () => [
        { day: "2026-10-31", definitionKey: "SPACE_INVITE_RECEIVED", channel: "EMAIL", status: "ACCEPTED", reason: "", count: 3 },
        { day: "2026-10-31", definitionKey: "SPACE_INVITE_RECEIVED", channel: "EMAIL", status: "DELIVERED", reason: "", count: 2 },
      ],
      verifiedEventExists: async () => exists,
    });
    const run = (exists: boolean, secret: string | undefined) => buildDeliveryAnalytics({ source: src(exists), window: "7d", filters: { channel: null, status: null, template: null }, now: NOW, env: { RESEND_WEBHOOK_SECRET: secret } });
    const a = await run(true, undefined);
    const b = await run(false, SECRET);
    const c = await run(true, SECRET);
    check("secret unset: measured.delivered false, no delivered series", a.measured.delivered === false && !("delivered" in a.series));
    check("secret set, no verified event yet: still false", b.measured.delivered === false && !("delivered" in b.series));
    check("secret set AND a verified event: true; opens/clicks stay false", c.measured.delivered === true && c.measured.opens === false && c.measured.clicks === false);
    check("…with the optional delivered/bounced/complained series (C2-dense)", c.series.delivered?.days.length === 7 && c.series.delivered.days[6].count === 2 && c.series.bounced?.days[6].count === 0 && c.series.complained !== undefined);
    check("the six C4 series are always present; ACCEPTED and DELIVERED counted apart",
      ["accepted", "failed", "dead", "suppressed", "captured", "cancelled"].every((k) => k in a.series) && c.totals?.ACCEPTED === 3 && c.totals?.DELIVERED === 2);
    const noProbe = await buildDeliveryAnalytics({ source: { ledgerSince: async () => null, counts: async () => [] }, window: "7d", filters: { channel: null, status: null, template: null }, now: NOW, env: { RESEND_WEBHOOK_SECRET: SECRET } });
    check("a source without the probe never claims delivered", noProbe.measured.delivered === false);
  }

  console.log("\nREVIEW F1: concurrent events of one message are serialised");
  {
    // bounced starts FIRST and holds its commit; delivered starts second while bounced is in flight.
    let releaseBounced!: () => void;
    const bouncedHeld = new Promise<void>((r) => { releaseBounced = r; });
    const s = memStore([acceptedRow()], { beforeCommit: async (types) => { if (types.includes("bounced")) await bouncedHeld; } });
    const pBounced = handleResendWebhook(signed(body("email.bounced")), deps(s.store).d);
    await new Promise((r) => setTimeout(r, 5));
    const pDelivered = handleResendWebhook(signed(body("email.delivered")), deps(s.store).d);
    await new Promise((r) => setTimeout(r, 5));
    releaseBounced();
    const [b, d] = await Promise.all([pBounced, pDelivered]);
    const appended = s.ledger.slice(1).map((r) => r.status);
    check("two parallel commits: bounced APPLIED, the late delivered re-reads under the lock and is NO_CHANGE",
      b.body.outcome === "APPLIED" && d.body.outcome === "NO_CHANGE", { b: b.body, d: d.body });
    check("exactly one forward row was appended (BOUNCED) — no DELIVERED written after it", appended.join() === "BOUNCED", appended);
    check("the final status is BOUNCED (rank-aware read)", currentRow(s.ledger)?.status === "BOUNCED");
    const newest = [...s.ledger].sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime() || (y.id > x.id ? 1 : -1))[0];
    check("…and by plain newest-row order too (no reliance on the rank tie-break)", newest.status === "BOUNCED", newest.status);
    check("the message lock was taken by both transactions", s.calls.locks === 2, s.calls);
  }
  {
    // Rank-aware defence: same attempt, BOUNCED older and DELIVERED newer (a pre-fix race result).
    const raced = [acceptedRow(), acceptedRow({ id: "row-b", status: "BOUNCED", createdAt: new Date("2026-10-31T11:59:00Z") }), acceptedRow({ id: "row-d", status: "DELIVERED", createdAt: new Date("2026-10-31T11:59:30Z") })];
    check("currentRow ranks within an attempt: BOUNCED beats a newer DELIVERED", currentRow(raced)?.id === "row-b");
    check("finalAttempts (rollup) is rank-aware too", finalAttempts(raced, raced).map((r) => r.id).join() === "row-b");
    const r = decideReconciliation({ type: "delivered", providerMessageId: "msg-resend-1", occurredAt: NOW }, raced);
    check("a further delivered against that history is NO_CHANGE (current = BOUNCED)", r.outcome === "NO_CHANGE");
    const b2 = decideReconciliation({ type: "bounced", providerMessageId: "msg-resend-1", occurredAt: NOW }, raced);
    check("a repeated bounced against that history is NO_CHANGE (the decision reads BOUNCED, not the newer DELIVERED)", b2.outcome === "NO_CHANGE", b2);
    const c = decideReconciliation({ type: "complained", providerMessageId: "msg-resend-1", occurredAt: NOW }, raced);
    check("complained still moves forward from BOUNCED", c.outcome === "APPLIED" && c.append?.status === "COMPLAINED");
    const sql = readFileSync(join(process.cwd(), "lib/notifications/delivery/read-store.ts"), "utf8");
    check("the analytics read orders rank before createdAt within an attempt",
      /"attempt" DESC,[\s\S]{0,200}CASE "status" WHEN 'COMPLAINED' THEN 3 WHEN 'BOUNCED' THEN 2 WHEN 'DELIVERED' THEN 1 ELSE 0 END DESC,[\s\S]{0,40}"createdAt" DESC/.test(sql));
    const store = readFileSync(join(process.cwd(), "lib/notifications/delivery/provider-event-store.ts"), "utf8");
    check("the production lock is a transaction-scoped advisory lock on hashtext(key)", /pg_advisory_xact_lock\(hashtext\(\$\{key\}\)\)/.test(store) && !/pg_advisory_lock\(/.test(store));
  }

  console.log("\nREVIEW F2: an event that beats its ledger row is retried, not lost");
  {
    const s = memStore([]);
    const req = signed(body("email.delivered", "msg-late-row"), { id: "msg_early_1" });
    const r = await handleResendWebhook(req, deps(s.store).d);
    check("no ledger row yet and the event is young: 409 RETRY, NOTHING stored (svix id not consumed)",
      r.status === 409 && r.body.code === "RETRY" && s.events.size === 0 && s.ledger.length === 0, { r: r.body, n: s.events.size });
    // The send's after-response ledger write lands; svix redelivers the SAME svix id.
    s.ledger.push(acceptedRow({ providerMessageId: "msg-late-row", messageKey: "notif-late" }));
    const again = await handleResendWebhook(req, deps(s.store).d);
    check("the redelivery (same svix id) now matches and APPLIES — the message reaches DELIVERED",
      again.status === 200 && again.body.outcome === "APPLIED" && currentRow(s.ledger)?.status === "DELIVERED", again.body);
    const old = await handleResendWebhook(signed(body("email.delivered", "msg-elsewhere", {}, OLD_EVENT_AT)), deps(s.store).d);
    check("an unknown id OLDER than the grace window is stored UNMATCHED (bounded: retries stop)", old.status === 200 && old.body.outcome === "UNMATCHED");
    const edge = new Date(NOW.getTime() - UNMATCHED_GRACE_MS + 1000).toISOString();
    const young = await handleResendWebhook(signed(body("email.bounced", "msg-elsewhere-2", {}, edge)), deps(s.store).d);
    check("…one just inside the window is still a 409", young.status === 409);
    check("the grace is keyed on the event's created_at, not the per-attempt svix timestamp",
      /now\.getTime\(\) - parsed\.occurredAt\.getTime\(\) < UNMATCHED_GRACE_MS/.test(readFileSync(join(process.cwd(), "lib/notifications/delivery/provider-events.ts"), "utf8")));
  }

  console.log("\nREVIEW F3: measured.delivered ignores UNMATCHED events");
  {
    const matches = (row: { outcome: string }) => row.outcome !== MEASURING_EVENT_WHERE.outcome.not;
    check("the measuring predicate excludes UNMATCHED and keeps APPLIED / NO_CHANGE / NOTE",
      !matches({ outcome: "UNMATCHED" }) && ["APPLIED", "NO_CHANGE", "NOTE"].every((o) => matches({ outcome: o })));
    const rs = readFileSync(join(process.cwd(), "lib/notifications/delivery/read-store.ts"), "utf8");
    check("read-store's probe applies it", /commsProviderEvent\.findFirst\(\{ where: MEASURING_EVENT_WHERE/.test(rs));
  }

  console.log("\nanalytics: accepted-uncertain (optional, additive)");
  {
    const seen: Array<{ from: string; to: string; channel: string | null; key: string | null }> = [];
    const src = (since: string | null, withCount = true): DeliveryReadSource => ({
      ledgerSince: async () => since,
      counts: async () => [{ day: "2026-10-31", definitionKey: "SPACE_INVITE_RECEIVED", channel: "EMAIL", status: "ACCEPTED", reason: "", count: 5 }],
      ...(withCount ? { acceptedUncertainCount: async (q: { from: string; to: string; channel: string | null; key: string | null }) => { seen.push(q); return 2; } } : {}),
    });
    const run = (s: DeliveryReadSource, filters: { channel: null | "EMAIL"; status: null | "ACCEPTED" | "FAILED"; template: string | null } = { channel: null, status: null, template: null }) =>
      buildDeliveryAnalytics({ source: s, window: "7d", filters, now: NOW, env: {} });
    const a = await run(src("2026-10-28"));
    check("present as a number, a SUBSET of ACCEPTED (totals unchanged)", a.acceptedUncertain === 2 && a.totals?.ACCEPTED === 5, { u: a.acceptedUncertain, t: a.totals?.ACCEPTED });
    check("scoped to the OBSERVED window: asked from ledgerSince (inside the window) to today", seen[0]?.from === "2026-10-28" && seen[0]?.to === "2026-10-31", seen[0]);
    await run(src("2026-10-01"));
    check("…and from the window start when the ledger is older", seen[1]?.from === "2026-10-25", seen[1]);
    await run(src("2026-10-01"), { channel: "EMAIL", status: "ACCEPTED", template: "SPACE_INVITE_RECEIVED" });
    check("the channel / template filters are passed through", seen[2]?.channel === "EMAIL" && seen[2]?.key === "SPACE_INVITE_RECEIVED");
    const f = await run(src("2026-10-01"), { channel: null, status: "FAILED", template: null });
    check("a status filter other than ACCEPTED ⇒ 0, without a query", f.acceptedUncertain === 0 && seen.length === 3);
    const none = await run(src(null));
    check("nothing observed ⇒ null (like totals)", none.acceptedUncertain === null && none.totals === null);
    const absent = await run(src("2026-10-28", false));
    check("a source that cannot count it ⇒ the key is ABSENT (existing shape unchanged)", !("acceptedUncertain" in absent));
    const rs = readFileSync(join(process.cwd(), "lib/notifications/delivery/read-store.ts"), "utf8");
    check("the store counts final-ACCEPTED, LIVE, resend, NULL provider id messages only",
      /async acceptedUncertainCount\(q\)[\s\S]{0,1400}"mode" = 'LIVE'[\s\S]{0,900}WHERE "status" = 'ACCEPTED' AND "provider" = 'resend' AND "providerMessageId" IS NULL/.test(rs));
  }

  // Type-level: the appended row is a CommsDeliveryRow the production writer accepts.
  const _typecheck: CommsDeliveryRow | null = decideReconciliation({ type: "delivered", providerMessageId: "msg-resend-1", occurredAt: NOW }, [acceptedRow()]).append;
  void _typecheck;

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall provider-event checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
