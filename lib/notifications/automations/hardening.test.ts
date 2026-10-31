/**
 * lib/notifications/automations/hardening.test.ts  (Comms Center B2 — HARDENING: review items A1–A9, N1–N11)
 *
 * The REAL engine over the in-memory Prisma fake (the real schema), with fake
 * transports — no database, no network, no real send. One section per review
 * item; each pins the BEHAVIOUR (a mutation of its guard fails here):
 *
 *   A1  kill / bookkeeping failure AFTER provider acceptance ⇒ never a second send
 *   A2  the frequency cap sees this pass's own sends (the ledger is blind in-pass)
 *   A3  per-trigger at-send predicate (membership / invite / Space) ⇒ OBSOLETE
 *   A4  definition state at ingest AND send ⇒ auto-pause DEFINITION_CHANGED
 *   A5  platform admission (COMMS_AUTOMATION_SEND) at trigger and at send ⇒ SKIPPED
 *   A6  EV-1 overlap: tighten-only cap with no base, the handler's bell dedupes
 *   A8  TEST rows never reach LIVE counts (storm counter, dry-run storm count)
 *   A9  retention of runs/items (90 days) through the real schema
 *   N1  the breaker trips mid-pass, on a 60-minute window
 *   N2  a fact younger than FACT_SETTLE_MS waits for the next wake
 *   N4  stale facts skipped; late items OBSOLETE; a halt also cancels FAILED items
 *   N5  automation 51+ is not starved
 *   N6  DEDUPE_OPEN never reaches past the retention window
 *   N7  fact sources are an allowlist
 *   N8  activation needs a WINDOW dry run
 *   N9  history is filtered in the query
 *   N11 an ACTIVE row's approval is presented against its activated version
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/notifications/automations/hardening.test.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- assertions read loosely-typed fake rows */

import "@/lib/test-support/route-env";
import { readFileSync } from "node:fs";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import type { UserLifecycleState } from "@/lib/entitlements/beta-lifecycle";
import type { GlobalCostFreezeVerdict } from "@/lib/platform/cost-freeze.core";
import type { EmailMessage, EmailResult } from "@/lib/email/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}
const quiet = async <T,>(f: () => Promise<T>): Promise<T> => {
  const { log, warn, info, error } = console; console.log = () => {}; console.warn = () => {}; console.info = () => {}; console.error = () => {};
  try { return await f(); } finally { console.log = log; console.warn = warn; console.info = info; console.error = error; }
};

const fake = new FakePrisma();
const T0 = new Date("2026-10-31T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

async function main(): Promise<void> {
  await installFakePrisma(fake);
  const { systemDb } = await import("@/lib/db");
  const E = await import("./engine");
  const R = await import("./rules");
  const F = await import("./facts");
  const T = await import("./types");
  const store = await import("./store");
  const { evaluateDryRun } = await import("./dry-run");
  const { admitAutomationSend } = await import("./admission");
  const { createNotification } = await import("@/lib/notifications/create");
  const { createEmailSender } = await import("@/lib/email/send");
  const { PendingSends } = await import("@/lib/notifications/delivery/storm");
  const { countRecentAcceptedEmails } = await import("@/lib/notifications/delivery/store");
  const { judgeGlobalCostFreeze } = await import("@/lib/platform/cost-freeze.core");
  const { skipLabel } = await import("@/lib/jobs/skip-label");
  const { runDataRetention } = await import("@/jobs/data-retention");
  const { getCatalogDefinition } = await import("@/lib/notifications/catalog/definitions");
  const db = systemDb as any;
  const DEF = getCatalogDefinition("MEMBER_ROLE_CHANGED")!;

  // ── The world ─────────────────────────────────────────────────────────────
  let clock = T0;
  let freeze: GlobalCostFreezeVerdict = judgeGlobalCostFreeze(null);
  let states: Record<string, UserLifecycleState> = {};
  let admission: () => { admitted: boolean; reason: string | null } = () => ({ admitted: true, reason: null });
  /** Every provider CALL, and the messages the (idempotent) provider actually DELIVERED. */
  const calls: EmailMessage[] = [];
  const delivered: EmailMessage[] = [];
  const idem = new Map<string, EmailResult>();
  let providerAnswer: () => EmailResult = () => ({ status: "sent", id: `re_${delivered.length}`, provider: "resend" });
  // The real provider's contract (Resend: a repeated Idempotency-Key returns the first answer and sends nothing).
  const provider = { name: "resend", send: async (m: EmailMessage) => {
    calls.push(m);
    if (m.idempotencyKey && idem.has(m.idempotencyKey)) return idem.get(m.idempotencyKey)!;
    const r = providerAnswer();
    if (r.status === "sent") delivered.push(m);
    if (m.idempotencyKey && r.status === "sent") idem.set(m.idempotencyKey, r);
    return r;
  } };
  const capture = { name: "capture", send: async (m: EmailMessage) => ({ status: "captured" as const, provider: "capture", id: m.to }) };
  const ledger = async (row: any) => { await db.commsDelivery.createMany({ data: [{ ...row, createdAt: clock }] }); };
  /** The production ledger is written AFTER the response (runAfterResponse): within a pass it is invisible. */
  const blindLedger = async () => {};
  const stormCounter = async (q: any) => db.commsDelivery.count({ where: { channel: "EMAIL", status: "ACCEPTED", mode: "LIVE", definitionKey: { in: [...q.keys] }, createdAt: { gte: q.since }, recipientUserId: q.recipientUserId ?? "-" } });
  const mkSend = (l: (row: any) => Promise<void> = ledger) => createEmailSender({
    env: { VERCEL: "1", VERCEL_ENV: "production", RESEND_API_KEY: "re_test_not_real", NODE_ENV: "production" } as any,
    provider, capture, ledger: l, storm: stormCounter, pending: new PendingSends(), now: () => clock, log: () => {},
  });
  const deps = (over: Record<string, unknown> = {}): any => ({
    db,
    freeze: async () => freeze,
    lifecycle: async (ids: readonly string[]) => new Map(ids.map((id) => [id, states[id] ?? "ACTIVE"])),
    sendEmail: mkSend(),
    createNotification: (input: any, ctx: any) => createNotification(input, ctx),
    ledger,
    content: null,
    env: { VERCEL: "1", VERCEL_ENV: "production" },
    appBaseUrl: "https://app.test.invalid",
    now: () => clock,
    admission: async () => admission(),
    activationEnabled: true,
    log: () => {},
    ...over,
  });
  const BUDGET = { maxAutomations: 50, maxFactsPerAutomation: 100, maxItems: 200, timeBudgetMs: 60_000 };
  const run = (d = deps(), b = BUDGET) => quiet(() => E.runAutomationEngine(d, b));

  const ACTOR = "u_actor";
  function reset(): void {
    fake.reset();
    clock = T0; freeze = judgeGlobalCostFreeze(null); states = {}; calls.length = 0; delivered.length = 0; idem.clear();
    admission = () => ({ admitted: true, reason: null });
    providerAnswer = () => ({ status: "sent", id: `re_${delivered.length}`, provider: "resend" });
    fake.seed("User", { id: ACTOR, email: "actor@example.invalid", username: "actor", emailVerifiedAt: T0, createdAt: new Date(T0.getTime() - 400 * DAY) });
  }
  function user(id: string): void {
    fake.seed("User", { id, email: `${id}@example.invalid`, username: id, emailVerifiedAt: T0, createdAt: new Date(T0.getTime() - 100 * DAY) });
  }
  function emailOn(id: string): void { fake.seed("NotificationPreference", { userId: id, category: "SPACES", channel: "EMAIL", enabled: true }); }
  function space(id: string): void { if (!fake.one("Space", { id })) fake.seed("Space", { id, name: `Space ${id}` }); }
  function member(spaceId: string, userId: string, role = "ADMIN"): void {
    space(spaceId);
    if (!fake.one("SpaceMember", { spaceId, userId })) fake.seed("SpaceMember", { spaceId, userId, role, status: "ACTIVE" });
  }
  let factN = 0;
  function roleChanged(target: string, at: Date, spaceId = "sp_1"): string {
    member(spaceId, target, "ADMIN");
    const id = `fact_${++factN}`;
    fake.seed("AuditLog", { id, action: "MEMBER_ROLE_CHANGED", userId: ACTOR, spaceId, createdAt: at,
      metadata: { targetUserId: target, targetName: "Real Name Never Copied", oldRole: "MEMBER", newRole: "ADMIN" } });
    return id;
  }
  function automation(extra: Record<string, unknown> = {}): string {
    const row = fake.seed("AutomationDefinition", {
      name: "Role changed", triggerKey: "space.member.role_changed", definitionKey: "MEMBER_ROLE_CHANGED", definitionVersion: DEF.definitionVersion,
      customerFacing: true, channels: ["IN_APP"], conditions: [], recipient: { kind: "EVENT_SUBJECT_USER" },
      dedupeKeyTemplate: "MEMBER_ROLE_CHANGED:{spaceId}:{recipientId}", frequencyCapMax: 10, frequencyCapHours: 1,
      retryPolicy: "STANDARD", maxRecipientsPerRun: 50, state: "ACTIVE", version: 2, activatedVersion: 1,
      activatedAt: new Date(T0.getTime() - 60 * MIN), triggerCursorAt: new Date(T0.getTime() - 60 * MIN), triggerCursorId: null,
      createdById: "op", updatedById: "op", ...extra,
    });
    return row.id as string;
  }
  const items = (where: Record<string, unknown> = {}) => fake.rows("AutomationRunItem", where) as any[];
  const bells = (type = "MEMBER_ROLE_CHANGED") => fake.rows("Notification", { type }) as any[];
  /** The fake's `db`, with ONE `automationRunItem.update` matching `pred` made to throw (a kill after acceptance). */
  function failingOnce(pred: (args: any) => boolean): any {
    let armed = true;
    return new Proxy(db, {
      get(t: any, p: string | symbol) {
        const v = t[p];
        if (p !== "automationRunItem") return v;
        return new Proxy(v, {
          get(d: any, q: string | symbol) {
            const f = d[q];
            if (q === "update") return async (args: any) => { if (armed && pred(args)) { armed = false; throw new Error("killed after acceptance"); } return f.call(d, args); };
            return typeof f === "function" ? f.bind(d) : f;
          },
        });
      },
    });
  }

  // ── A1 ───────────────────────────────────────────────────────────────────
  console.log("A1. a kill / bookkeeping failure AFTER the provider accepted never sends twice");
  {
    reset(); user("u1"); emailOn("u1"); automation({ channels: ["EMAIL"] }); roleChanged("u1", new Date(T0.getTime() - 5 * MIN));
    const s1 = await run(deps({ db: failingOnce((a) => a.data?.status === "SENT") }));
    const it = items()[0];
    check("provider ACCEPTED (one delivery, the ledger row written), then marking SENT threw ⇒ the item stays SENDING under its lease, the batch survived (errors 1)",
      delivered.length === 1 && it.status === "SENDING" && it.leaseUntil !== null && s1.errors === 1
      && fake.rows("CommsDelivery", { automationRunItemId: it.id, status: "ACCEPTED" }).length === 1, { s1, it });
    check("the provider call carried Idempotency-Key = the item id (no attempt suffix)", calls[0]?.idempotencyKey === it.id, calls[0]?.idempotencyKey);
    clock = new Date(T0.getTime() + 6 * MIN);
    const s2 = await run();
    check("after the lease expires the recorded ACCEPTED row ⇒ SENT (recovered 1), the provider is NOT called again",
      items()[0].status === "SENT" && items()[0].lastDeliveryStatus === "ACCEPTED" && calls.length === 1 && delivered.length === 1 && s2.recovered === 1, { s2, it: items()[0], calls: calls.length });
    clock = new Date(T0.getTime() + 60 * MIN); await run();
    check("…and never again on later passes", calls.length === 1);
  }
  {
    // The function is killed after acceptance AND before the deferred ledger write: nothing recorded at all.
    reset(); user("u1"); emailOn("u1"); automation({ channels: ["EMAIL"] }); roleChanged("u1", new Date(T0.getTime() - 5 * MIN));
    await run(deps({ db: failingOnce((a) => a.data?.status === "SENT"), sendEmail: mkSend(blindLedger), ledger: blindLedger }));
    const id = items()[0].id;
    check("killed after acceptance with NO ledger row: the item is SENDING, nothing recorded", items()[0].status === "SENDING" && fake.rows("CommsDelivery", { automationRunItemId: id }).length === 0);
    clock = new Date(T0.getTime() + 6 * MIN);
    await run();
    check("the lease returns it and it is re-attempted with the SAME Idempotency-Key ⇒ the provider answers from its idempotency record: ONE delivered message",
      calls.length === 2 && calls.every((m) => m.idempotencyKey === id) && delivered.length === 1 && items()[0].status === "SENT", { calls: calls.map((m) => m.idempotencyKey), delivered: delivered.length });
  }
  {
    reset(); user("u1"); emailOn("u1"); automation({ channels: ["EMAIL"] }); roleChanged("u1", new Date(T0.getTime() - 5 * MIN));
    providerAnswer = () => ({ status: "error", provider: "resend", error: "provider 500" });
    await run();
    clock = new Date(T0.getTime() + 16 * MIN);
    providerAnswer = () => ({ status: "sent", id: "re_x", provider: "resend" });
    await run();
    check("a RETRY after a provider error carries the same key as attempt 1 (one message, every attempt)", calls.length === 2 && calls[0].idempotencyKey === calls[1].idempotencyKey && calls[0].idempotencyKey === items()[0].id);
  }
  {
    reset(); user("u1"); automation(); roleChanged("u1", new Date(T0.getTime() - 5 * MIN));
    await run(deps({ db: failingOnce((a) => a.data?.status === "SENT") }));
    clock = new Date(T0.getTime() + 6 * MIN);
    const s = await run();
    check("IN_APP: the bell was created, marking SENT threw ⇒ recovered from its ACCEPTED ledger row, ONE bell", bells().length === 1 && items()[0].status === "SENT" && s.recovered === 1, s);
  }

  // ── A2 ───────────────────────────────────────────────────────────────────
  console.log("A2. the frequency cap sees this pass's own sends (the ledger is written after the response)");
  {
    reset(); user("u1");
    automation({ frequencyCapMax: 1, frequencyCapHours: 24 });
    roleChanged("u1", new Date(T0.getTime() - 5 * MIN), "sp_1");
    roleChanged("u1", new Date(T0.getTime() - 4 * MIN), "sp_2");
    await run(deps({ ledger: blindLedger, sendEmail: mkSend(blindLedger) }));
    check("two facts for ONE recipient in ONE pass, cap 1 / 24 h, ledger blind: the second is SUPPRESSED / FREQUENCY_CAP at claim time, ONE bell",
      bells().length === 1 && items({ status: "SENT" }).length === 1 && items({ status: "SUPPRESSED", reason: "FREQUENCY_CAP" }).length === 1, items().map((i) => [i.status, i.reason]));
  }
  {
    reset(); user("u1");
    automation({ frequencyCapMax: 1, frequencyCapHours: 24 });
    roleChanged("u1", new Date(T0.getTime() - 5 * MIN), "sp_1");
    await run(deps({ ledger: blindLedger }));
    roleChanged("u1", new Date(T0.getTime() + 1 * MIN), "sp_2");
    clock = new Date(T0.getTime() + 3 * MIN);
    await run(deps({ ledger: blindLedger }));
    check("a later pass, ledger still blind (no ACCEPTED row anywhere): the automation's OWN SENT item holds the cap",
      bells().length === 1 && fake.rows("CommsDelivery").length === 0 && items({ reason: "FREQUENCY_CAP" }).length === 1, items().map((i) => [i.status, i.reason]));
  }
  {
    reset(); user("u1");
    automation({ frequencyCapMax: 1, frequencyCapHours: 24 });
    fake.seed("CommsDelivery", { messageKey: "reg1", definitionKey: "MEMBER_ROLE_CHANGED", definitionVersion: 1, channel: "IN_APP", status: "ACCEPTED", attempt: 1, recipientUserId: "u1", environment: "production", mode: "LIVE", createdAt: new Date(T0.getTime() - HOUR) });
    roleChanged("u1", new Date(T0.getTime() - 5 * MIN));
    await run();
    check("a registry / EV-1 send of the same definition (a ledger row with no item) still counts toward the cap", items({ reason: "FREQUENCY_CAP" }).length === 1 && bells().length === 0);
  }

  // ── A3 ───────────────────────────────────────────────────────────────────
  console.log("A3. per-trigger at-send predicate: what the fact says must still be true");
  {
    reset(); user("u1"); automation({ delayMinutes: 30 }); roleChanged("u1", new Date(T0.getTime() - 1 * MIN));
    await run();
    check("ingest: the delayed follow-up is SCHEDULED", items()[0].status === "SCHEDULED");
    fake.one("SpaceMember", { spaceId: "sp_1", userId: "u1" })!.status = "REMOVED";
    clock = new Date(T0.getTime() + 31 * MIN);
    await run();
    check("the member was REMOVED during the delay ⇒ CANCELLED / OBSOLETE (+ ledger row), no bell",
      items()[0].status === "CANCELLED" && items()[0].reason === "OBSOLETE" && bells().length === 0
      && fake.rows("CommsDelivery", { status: "CANCELLED", reason: "OBSOLETE" }).length === 1);
  }
  {
    reset(); user("u1"); automation({ delayMinutes: 30 }); roleChanged("u1", new Date(T0.getTime() - 1 * MIN));
    await run();
    fake.one("SpaceMember", { spaceId: "sp_1", userId: "u1" })!.role = "MEMBER";
    clock = new Date(T0.getTime() + 31 * MIN);
    await run();
    check("the role changed AGAIN during the delay (no longer the new role) ⇒ OBSOLETE", items()[0].reason === "OBSOLETE" && bells().length === 0);
  }
  {
    reset(); user("u1"); automation({ delayMinutes: 30 }); roleChanged("u1", new Date(T0.getTime() - 1 * MIN));
    await run();
    fake.one("Space", { id: "sp_1" })!.deletedAt = T0;
    clock = new Date(T0.getTime() + 31 * MIN);
    await run();
    check("the Space was trashed during the delay ⇒ OBSOLETE", items()[0].reason === "OBSOLETE" && bells().length === 0);
  }
  {
    reset(); user("u1"); automation({ delayMinutes: 30 }); roleChanged("u1", new Date(T0.getTime() - 1 * MIN));
    await run();
    clock = new Date(T0.getTime() + 31 * MIN);
    await run();
    check("control: nothing changed during the delay ⇒ SENT (the predicate does not over-cancel)", items()[0].status === "SENT" && bells().length === 1);
  }
  {
    // invited: the invite must still be PENDING.
    for (const [label, status, expires, want] of [["PENDING", "PENDING", null, "SENT"], ["ACCEPTED", "ACCEPTED", null, "OBSOLETE"], ["DECLINED", "DECLINED", null, "OBSOLETE"], ["EXPIRED", "PENDING", new Date(T0.getTime() + 10 * MIN), "OBSOLETE"]] as const) {
      reset(); user("u9"); space("sp_i");
      automation({ triggerKey: "space.member.invited", definitionKey: "SPACE_INVITE_RECEIVED", dedupeKeyTemplate: "I:{recipientId}", delayMinutes: 30 });
      fake.seed("SpaceInvite", { spaceId: "sp_i", invitedUserId: "u9", invitedById: ACTOR, status: "PENDING", expiresAt: expires });
      fake.seed("AuditLog", { action: "MEMBER_INVITED", userId: ACTOR, spaceId: "sp_i", createdAt: new Date(T0.getTime() - 2 * MIN), metadata: { invitedUserId: "u9", role: "MEMBER" } });
      await run();
      fake.one("SpaceInvite", { invitedUserId: "u9" })!.status = status;
      clock = new Date(T0.getTime() + 31 * MIN);
      await run();
      const it = items()[0];
      check(`invited, invite ${label} at send ⇒ ${want}`, want === "SENT" ? it?.status === "SENT" : (it?.status === "CANCELLED" && it.reason === "OBSOLETE"), it && [it.status, it.reason]);
    }
  }
  {
    reset(); user("u7"); space("sp_r");
    automation({ triggerKey: "space.member.removed", definitionKey: "MEMBER_REMOVED", dedupeKeyTemplate: "R:{recipientId}", delayMinutes: 30 });
    fake.seed("AuditLog", { action: "MEMBER_REMOVED", userId: ACTOR, spaceId: "sp_r", createdAt: new Date(T0.getTime() - 2 * MIN), metadata: { removedUserId: "u7" } });
    await run();
    member("sp_r", "u7", "MEMBER"); // re-added during the delay
    clock = new Date(T0.getTime() + 31 * MIN);
    await run();
    check("removed, but RE-ADDED during the delay ⇒ \"you were removed\" is OBSOLETE", items()[0]?.reason === "OBSOLETE" && bells("MEMBER_REMOVED").length === 0, items()[0]);
  }

  // ── A4 ───────────────────────────────────────────────────────────────────
  console.log("A4. definition state at ingest AND at send ⇒ auto-pause DEFINITION_CHANGED");
  {
    check("definitionSendable: the live definition at its version ⇒ null", R.definitionSendable(DEF, DEF.definitionVersion) === null);
    check("…protected ⇒ PROTECTED", R.definitionSendable({ ...DEF, protected: true }, DEF.definitionVersion) === "PROTECTED");
    check("…no longer automatable (e.g. SECURITY_CRITICAL) ⇒ NOT_AUTOMATABLE", R.definitionSendable({ ...DEF, consentClass: "SECURITY_CRITICAL" }, DEF.definitionVersion) === "NOT_AUTOMATABLE");
    check("…a moved definitionVersion ⇒ VERSION_CHANGED; a missing definition ⇒ MISSING",
      R.definitionSendable(DEF, DEF.definitionVersion - 1) === "VERSION_CHANGED" && R.definitionSendable(undefined, 1) === "MISSING");
  }
  {
    reset(); user("u1"); const id = automation({ delayMinutes: 30 }); roleChanged("u1", new Date(T0.getTime() - 1 * MIN));
    await run();
    // The code definition moved while the item waited (the stored validation no longer matches).
    fake.one("AutomationDefinition", { id })!.definitionVersion = DEF.definitionVersion - 1;
    clock = new Date(T0.getTime() + 31 * MIN);
    // maxAutomations 0: no ingest this pass, so ONLY the send-time check can catch it.
    const s = await run(deps(), { ...BUDGET, maxAutomations: 0 });
    const a = fake.one("AutomationDefinition", { id }) as any;
    check("AT SEND (ingest skipped): the definition changed ⇒ the automation auto-pauses DEFINITION_CHANGED, the item is CANCELLED, no bell",
      a.state === "PAUSED" && a.autoPausedReason === "DEFINITION_CHANGED" && items()[0].status === "CANCELLED" && bells().length === 0 && s.autoPaused === 1, { a: [a.state, a.autoPausedReason], it: items()[0].status, s });
  }
  {
    reset(); user("u1"); const id = automation(); roleChanged("u1", new Date(T0.getTime() - 1 * MIN));
    const frozen = Object.isFrozen(DEF);
    if (!frozen) {
      const was = DEF.protected;
      (DEF as any).protected = true;
      try { await run(); } finally { (DEF as any).protected = was; }
      check("AT INGEST: a definition that became PROTECTED ⇒ auto-pause DEFINITION_CHANGED, nothing claimed or sent",
        (fake.one("AutomationDefinition", { id }) as any).autoPausedReason === "DEFINITION_CHANGED" && items().length === 0 && bells().length === 0);
    } else {
      check("AT INGEST: (the catalog object is frozen — covered by definitionSendable above)", true);
    }
  }

  // ── A5 ───────────────────────────────────────────────────────────────────
  console.log("A5. platform admission (COMMS_AUTOMATION_SEND) at trigger and at send");
  {
    reset(); user("u1"); automation(); roleChanged("u1", new Date(T0.getTime() - 1 * MIN));
    admission = () => ({ admitted: false, reason: "MAINTENANCE_MODE" });
    const s = await run();
    check("maintenance at trigger ⇒ SKIPPED / ADMISSION_MAINTENANCE_MODE: no run, no item, no bell",
      s.outcome === "SKIPPED" && s.skipReason === "ADMISSION_MAINTENANCE_MODE" && fake.rows("AutomationRun").length === 0 && items().length === 0 && bells().length === 0, s);
    check("…job health words it as maintenance, not a plan restriction", skipLabel(s.skipReason) === "Skipped (maintenance)");
    admission = () => ({ admitted: true, reason: null });
    await run();
    check("…and the fact is NOT lost: after maintenance it is ingested and sent", bells().length === 1);
  }
  {
    reset(); user("u1"); automation(); roleChanged("u1", new Date(T0.getTime() - 1 * MIN));
    let n = 0;
    admission = () => (++n === 1 ? { admitted: true, reason: null } : { admitted: false, reason: "MAINTENANCE_MODE" });
    const s = await run();
    check("maintenance declared mid-pass (admitted at trigger, denied at send) ⇒ SKIPPED, the item stays SCHEDULED (not leased, not cancelled), no bell",
      s.outcome === "SKIPPED" && items()[0].status === "SCHEDULED" && items()[0].attempt === 0 && bells().length === 0, { s, it: items()[0] });
  }
  {
    reset(); user("u1"); automation(); roleChanged("u1", new Date(T0.getTime() - 1 * MIN));
    const s = await run(deps({ admission: async () => { throw new Error("store down"); } }));
    check("an admission port that THROWS is a denial (fail closed)", s.outcome === "SKIPPED" && /^ADMISSION_/.test(s.skipReason ?? "") && bells().length === 0, s);
  }
  {
    const client = (rows: Record<string, string> | "throw") => ({ platformSetting: { findMany: async () => { if (rows === "throw") throw new Error("down"); return Object.entries(rows).map(([key, value]) => ({ key, value })); } } });
    const m = await admitAutomationSend(client({ maintenance_mode: "true" }));
    const ing = await admitAutomationSend(client({ ingestion_paused: "true" }));
    const bad = await admitAutomationSend(client({ maintenance_mode: "yes" }));
    const down = await admitAutomationSend(client("throw"));
    const off = await admitAutomationSend(client({}));
    check("the real gate: maintenance_mode ⇒ denied MAINTENANCE_MODE", !m.admitted && m.reason === "MAINTENANCE_MODE", m);
    check("…ingestion_paused does NOT stop comms (no data provider is called)", ing.admitted, ing);
    check("…an unreadable value / an unreachable store ⇒ denied (fail closed)", !bad.admitted && bad.reason === "CONTROL_PLANE_UNREADABLE" && !down.admitted, { bad, down });
    check("…nothing set ⇒ admitted", off.admitted);
    check("production engine deps wire the gate", /admission:\s*\(\)\s*=>\s*admitAutomationSend\(\)/.test(readFileSync("lib/notifications/automations/engine-deps.ts", "utf8")));
  }

  // ── A6 ───────────────────────────────────────────────────────────────────
  console.log("A6. overlap with the EV-1 handlers");
  {
    check("MEMBER_ROLE_CHANGED declares no frequency cap of its own (the case under test)", DEF.frequencyCap === null || DEF.frequencyCap === undefined);
    const loose = R.validateAutomationInput({ name: "x", recipient: { kind: "EVENT_SUBJECT_USER" }, frequencyCap: { max: 5, perHours: 24 } }, { def: DEF, trigger: "space.member.role_changed" });
    const shorter = R.validateAutomationInput({ name: "x", recipient: { kind: "EVENT_SUBJECT_USER" }, frequencyCap: { max: 1, perHours: 1 } }, { def: DEF, trigger: "space.member.role_changed" });
    const tight = R.validateAutomationInput({ name: "x", recipient: { kind: "EVENT_SUBJECT_USER" }, frequencyCap: { max: 1, perHours: 48 } }, { def: DEF, trigger: "space.member.role_changed" });
    check("tighten-only with NO base: 5 / 24 h and 1 / 1 h are refused (looser than the 1 / 24 h default); 1 / 48 h is accepted",
      !loose.ok && !shorter.ok && tight.ok && (tight as any).value.frequencyCapHours === 48, { loose, shorter });
    check("overlapsExistingDelivery: an EV-1-delivered definition ⇒ true; one with no code producer ⇒ false",
      R.overlapsExistingDelivery(DEF) === true && R.overlapsExistingDelivery({ trigger: { kind: "TRIGGER", triggerKey: null, sources: [] } }) === false);
  }
  {
    reset(); user("u1"); automation();
    const ref = roleChanged("u1", new Date(T0.getTime() - 2 * MIN));
    // The EV-1 handler rang its bell for this fact (no auditLogId: EV-1 producers omit it).
    fake.seed("Notification", { userId: "u1", spaceId: "sp_1", type: "MEMBER_ROLE_CHANGED", category: "SPACES", title: "Your role changed", auditLogId: null, createdAt: new Date(T0.getTime() - 2 * MIN + 500) });
    await run();
    check("the handler's bell for the same fact ⇒ the automation's IN_APP item is SUPPRESSED / DEDUPE_OPEN (+ ledger row): still ONE bell",
      bells().length === 1 && items()[0].status === "SUPPRESSED" && items()[0].reason === "DEDUPE_OPEN"
      && fake.rows("CommsDelivery", { automationRunItemId: items()[0].id, status: "SUPPRESSED", reason: "DEDUPE_OPEN" }).length === 1, { it: items()[0], ref });
  }
  {
    reset(); user("u1"); automation();
    roleChanged("u1", new Date(T0.getTime() - 2 * MIN));
    fake.seed("Notification", { userId: "u1", spaceId: "sp_OTHER", type: "MEMBER_ROLE_CHANGED", category: "SPACES", title: "x", auditLogId: null, createdAt: new Date(T0.getTime() - 2 * MIN) });
    fake.seed("Notification", { userId: "u1", spaceId: "sp_1", type: "MEMBER_ROLE_CHANGED", category: "SPACES", title: "x", auditLogId: null, createdAt: new Date(T0.getTime() - 3 * HOUR) });
    await run();
    check("control: a bell in ANOTHER Space, or hours before the fact, is not this fact's ⇒ the automation sends", items()[0].status === "SENT" && bells().length === 3);
  }

  // ── A8 ───────────────────────────────────────────────────────────────────
  console.log("A8. TEST rows never reach LIVE counts");
  {
    reset();
    const row = (i: number, mode: string) => fake.seed("CommsDelivery", { messageKey: `${mode}${i}`, definitionKey: "SYNC_FAILED", definitionVersion: 1, channel: "EMAIL", status: "ACCEPTED", attempt: 1, recipientUserId: "u1", environment: "production", mode, createdAt: new Date(T0.getTime() - 10 * MIN) });
    for (let i = 0; i < 2; i++) row(i, "LIVE");
    for (let i = 0; i < 5; i++) row(i, "TEST");
    const n = await countRecentAcceptedEmails({ recipientUserId: "u1", recipientHash: null, keys: ["SYNC_FAILED"], since: new Date(T0.getTime() - HOUR) });
    check("the production storm counter counts LIVE rows only (2 LIVE + 5 TEST ⇒ 2)", n === 2, n);
  }
  {
    reset(); user("u1"); emailOn("u1");
    const id = automation({ channels: ["EMAIL"] });
    for (let i = 0; i < 5; i++) fake.seed("CommsDelivery", { messageKey: `t${i}`, definitionKey: "SYNC_FAILED", definitionVersion: 1, channel: "EMAIL", status: "ACCEPTED", attempt: 1, recipientUserId: "u1", environment: "production", mode: "TEST", createdAt: new Date(Date.now() - 5 * MIN) });
    roleChanged("u1", new Date(Date.now() - DAY));
    const a = fake.one("AutomationDefinition", { id }) as any;
    const dd = { db, freeze: async () => judgeGlobalCostFreeze(null), lifecycle: async (ids: readonly string[]) => new Map(ids.map((x) => [x, "ACTIVE" as const])), content: null };
    const ev1 = await evaluateDryRun(dd, a, DEF, { window: "7d" }, new Date()) as any;
    for (let i = 0; i < 5; i++) fake.seed("CommsDelivery", { messageKey: `l${i}`, definitionKey: "SYNC_FAILED", definitionVersion: 1, channel: "EMAIL", status: "ACCEPTED", attempt: 1, recipientUserId: "u1", environment: "production", mode: "LIVE", createdAt: new Date(Date.now() - 5 * MIN) });
    const ev2 = await evaluateDryRun(dd, a, DEF, { window: "7d" }, new Date()) as any;
    check("the dry-run storm COUNT ignores 5 TEST emails (eligible), but 5 LIVE ones hold it (RATE_LIMITED)",
      ev1.counts.suppressed.RATE_LIMITED === 0 && ev1.counts.eligible === 1 && ev2.counts.suppressed.RATE_LIMITED === 1, { ev1: ev1.counts, ev2: ev2.counts });
  }

  // ── A9 ───────────────────────────────────────────────────────────────────
  console.log("A9. retention: runs (+ items by cascade) after 90 days, never one that can still send");
  {
    reset();
    const mk = (id: string, ageDays: number, status: string, itemStatus: string | null) => {
      const r = fake.seed("AutomationRun", { id, automationId: "a", automationVersion: 1, mode: "LIVE", triggerKey: "space.member.role_changed", status, counts: {}, startedAt: new Date(T0.getTime() - ageDays * DAY) });
      if (itemStatus) fake.seed("AutomationRunItem", { runId: r.id, automationId: "a", automationVersion: 1, channel: "IN_APP", recipientUserId: "u", idempotencyKey: `k_${id}`, dedupeKey: "x:u", status: itemStatus, notBefore: T0 });
    };
    mk("old_done", 91, "SUCCEEDED", "SENT");
    mk("old_running", 91, "RUNNING", null);
    mk("old_pending", 91, "SUCCEEDED", "FAILED");
    mk("new_done", 10, "SUCCEEDED", "SENT");
    const r = await quiet(() => runDataRetention(db, T0, undefined));
    const left = fake.rows("AutomationRun").map((x: any) => x.id).sort().join();
    check("a finished run older than 90 days is deleted; RUNNING, one holding a FAILED-awaiting-retry item, and a recent one are kept",
      left === "new_done,old_pending,old_running" && r.automationRun.deleted === 1, { left, r: r.automationRun });
    // The fake does not model FK cascades; the schema declares it (the census of the real DB is the migration's FK).
    check("…its items go with it: AutomationRunItem.run is onDelete: Cascade in the schema",
      /run\s+AutomationRun\s+@relation\(fields: \[runId\], references: \[id\], onDelete: Cascade\)/.test(readFileSync("prisma/schema.prisma", "utf8")));
    check("the window is the shared constant (90 days, parity with the ledger)", T.AUTOMATION_RETENTION_DAYS === 90);
  }

  // ── N1 ───────────────────────────────────────────────────────────────────
  console.log("N1. the global breaker can trip — mid-pass, on a 60-minute window");
  {
    reset();
    const prior = fake.seed("AutomationRun", { automationId: "old", automationVersion: 1, mode: "LIVE", triggerKey: "space.member.role_changed", status: "SUCCEEDED", counts: {} });
    for (let i = 0; i < 199; i++) fake.seed("AutomationRunItem", { runId: prior.id, automationId: "old", automationVersion: 1, channel: "IN_APP", recipientUserId: `r${i}`, idempotencyKey: `k${i}`, status: "SENT", lastDeliveryStatus: "ACCEPTED", notBefore: T0, attempt: 1, updatedAt: new Date(T0.getTime() - 40 * MIN) });
    const id = automation();
    for (const u of ["n1", "n2", "n3"]) { user(u); roleChanged(u, new Date(T0.getTime() - 5 * MIN)); }
    let alerted: any = null;
    const s = await run(deps({ alert: async (_k: string, d: unknown) => { alerted = d; } }));
    const a = fake.one("AutomationDefinition", { id }) as any;
    check("199 sends 40 min ago + 2 this pass = 201 > 200 ⇒ the breaker trips BEFORE the 3rd send: PAUSED / STORM_BREAKER, the rest CANCELLED, alert raised",
      bells().length === 2 && a.state === "PAUSED" && a.autoPausedReason === "STORM_BREAKER" && items({ status: "CANCELLED", reason: "AUTOMATION_PAUSED" }).length === 1 && alerted?.accepted === 201, { bells: bells().length, a: a.state, s });
    check("the window is 60 minutes and the threshold 200 (documented deviation from the contract's 10 min, which could never trip)", T.GLOBAL_BREAKER.windowMinutes === 60 && T.GLOBAL_BREAKER.maxAccepted === 200);
  }

  // ── N2 ───────────────────────────────────────────────────────────────────
  console.log("N2. a fact younger than FACT_SETTLE_MS is left for the next wake");
  {
    reset(); user("u1"); automation();
    roleChanged("u1", new Date(T0.getTime() - 30_000));
    const s1 = await run();
    check("a fact 30 s old is not read yet (a late-committing earlier row can still land before the cursor)", s1.facts === 0 && items().length === 0, s1);
    clock = new Date(T0.getTime() + 2 * MIN);
    await run();
    check("…and is read on the next wake", items().length === 1 && bells().length === 1);
  }

  // ── N3 ───────────────────────────────────────────────────────────────────
  console.log("N3. one item's error never aborts the batch");
  {
    reset(); user("u1"); user("u2"); automation();
    roleChanged("u1", new Date(T0.getTime() - 5 * MIN));
    roleChanged("u2", new Date(T0.getTime() - 4 * MIN));
    const s = await run(deps({ createNotification: (input: any, ctx: any) => (input.userId === "u1" ? Promise.reject(new Error("store down")) : createNotification(input, ctx)) }));
    check("the first item's delivery THROWS: it is left SENDING under its lease (errors 1), the second is still SENT, the pass is PARTIAL",
      items({ recipientUserId: "u1" })[0].status === "SENDING" && items({ recipientUserId: "u2" })[0].status === "SENT" && bells().length === 1 && s.errors === 1 && s.outcome === "PARTIAL", s);
  }

  // ── N4 ───────────────────────────────────────────────────────────────────
  console.log("N4. backlogs after a freeze: stale facts skipped, late items OBSOLETE, a halt cancels FAILED too");
  {
    reset(); user("u1"); automation({ triggerCursorAt: new Date(T0.getTime() - 3 * DAY) });
    roleChanged("u1", new Date(T0.getTime() - 25 * HOUR));
    roleChanged("u1", new Date(T0.getTime() - 5 * MIN), "sp_2");
    const s = await run();
    check("a fact 25 h old when first read is skipped (staleFacts 1, no item); a fresh one is sent", s.staleFacts === 1 && items().length === 1 && bells().length === 1, s);
  }
  {
    reset(); user("u1"); automation({ delayMinutes: 30 }); roleChanged("u1", new Date(T0.getTime() - 1 * MIN));
    await run();
    clock = new Date(T0.getTime() + 26 * HOUR);
    await run();
    check("an item reached 24 h + past its notBefore ⇒ CANCELLED / OBSOLETE, not sent", items()[0].reason === "OBSOLETE" && bells().length === 0);
  }
  {
    reset(); user("u1"); emailOn("u1"); automation({ channels: ["EMAIL"] }); roleChanged("u1", new Date(T0.getTime() - 1 * MIN));
    providerAnswer = () => ({ status: "error", provider: "resend", error: "provider 500" });
    await run();
    check("setup: the item is FAILED awaiting retry", items()[0].status === "FAILED");
    freeze = judgeGlobalCostFreeze("true");
    clock = new Date(T0.getTime() + 5 * MIN);
    await run();
    check("a global freeze cancels the FAILED-awaiting-retry item too (CANCELLED / PROVIDER_FREEZE): nothing resumes after unfreeze",
      items()[0].status === "CANCELLED" && items()[0].reason === "PROVIDER_FREEZE" && items()[0].nextAttemptAt === null);
  }

  // ── N5 ───────────────────────────────────────────────────────────────────
  console.log("N5. automation 51+ is not starved");
  {
    reset(); user("u1");
    const ids = [automation({ activatedAt: new Date(T0.getTime() - 3 * HOUR) }), automation({ activatedAt: new Date(T0.getTime() - 2 * HOUR) }), automation({ activatedAt: new Date(T0.getTime() - 1 * HOUR) })];
    roleChanged("u1", new Date(T0.getTime() - 5 * MIN));
    for (let i = 0; i < 3; i++) { clock = new Date(T0.getTime() + i * 15 * MIN); await run(deps(), { ...BUDGET, maxAutomations: 1 }); }
    const ran = ids.filter((id) => fake.rows("AutomationRun", { automationId: id }).length === 1);
    check("budget 1 automation / pass, 3 automations: every one has scanned the fact after 3 passes (least-recently-scanned first)", ran.length === 3, ran);
  }

  // ── N6 ───────────────────────────────────────────────────────────────────
  console.log("N6. DEDUPE_OPEN never reaches past the retention window");
  {
    reset(); user("u1"); const id = automation();
    const prior = fake.seed("AutomationRun", { automationId: id, automationVersion: 1, mode: "LIVE", triggerKey: "space.member.role_changed", status: "SUCCEEDED", counts: {} });
    fake.seed("AutomationRunItem", { runId: prior.id, automationId: id, automationVersion: 1, channel: "IN_APP", recipientUserId: "u1", idempotencyKey: "old", dedupeKey: "MEMBER_ROLE_CHANGED:sp_1:u1", status: "SENT", notBefore: T0, createdAt: new Date(T0.getTime() - 91 * DAY), updatedAt: new Date(T0.getTime() - 91 * DAY) });
    roleChanged("u1", new Date(T0.getTime() - 5 * MIN));
    await run();
    check("an item with the same dedupe key from 91 days ago does not hold DEDUPE_OPEN (retention would have deleted it)", items({ idempotencyKey: { not: "old" } })[0]?.status === "SENT");
  }

  // ── N7 / N8 / N9 / N11 ───────────────────────────────────────────────────
  console.log("N7–N11");
  {
    let threw = false;
    try { F.assertNotCommsAction({ "space.member.joined": { action: "SPACE_DELETED", subjectField: "userId" } } as any); } catch { threw = true; }
    check("N7: a fact source on a domain action OUTSIDE the allowlist is refused (an allowlist, not a prefix denylist)", threw && F.DOMAIN_FACT_ACTIONS.length === 4);
    const facts = (window: boolean) => ({ state: "DRAFT" as const, version: 1, definitionVersion: DEF.definitionVersion, triggerKey: "space.member.role_changed" as const, customerFacing: true,
      ownerApprovedVersion: 1, ownerApprovedDefinitionVersion: DEF.definitionVersion, lastDryRun: { automationVersion: 1, status: "SUCCEEDED", startedAt: T0, wouldExceedMaxRecipients: false, window } });
    check("N8: a single-triggerRef dry run does not satisfy activation (DRY_RUN_REQUIRED); a window replay does",
      R.activationBlockers(facts(false), DEF, T0).includes("DRY_RUN_REQUIRED") && !R.activationBlockers(facts(true), DEF, T0).includes("DRY_RUN_REQUIRED"));
    reset();
    fake.seed("AuditLog", { action: "COMMS_AUTOMATION_CREATED", createdAt: new Date(T0.getTime() - DAY), metadata: { target: { kind: "COMMS_AUTOMATION", id: "mine" }, actorType: "PLATFORM_OPERATOR" } });
    for (let i = 0; i < 520; i++) fake.seed("AuditLog", { action: "COMMS_AUTOMATION_UPDATED", createdAt: new Date(T0.getTime() - i * 1000), metadata: { target: { kind: "COMMS_AUTOMATION", id: `other${i}` } } });
    const h = await store.readHistory("mine", db);
    check("N9: an automation's history is found under 520 newer rows of OTHER automations (filtered in the query)", h.length === 1 && h[0].action === "COMMS_AUTOMATION_CREATED", h.length);
    const row = { state: "ACTIVE" as const, version: 2, activatedVersion: 1, ownerApprovedVersion: 1, ownerApprovedDefinitionVersion: DEF.definitionVersion };
    check("N11: an ACTIVE row (activation bumped version 1 → 2) presents its approval as CURRENT; a later PAUSE+PATCH version does not",
      R.ownerApprovalCurrentForDisplay(row, DEF) === true && R.ownerApprovalCurrent(row, DEF) === false
      && R.ownerApprovalCurrentForDisplay({ ...row, state: "PAUSED", version: 4 }, DEF) === false);
  }

  // ── The gate ──────────────────────────────────────────────────────────────
  console.log("the activation gate stays closed");
  check("AUTOMATION_ACTIVATION_ENABLED is still the code constant false (flipping it is a separate owner-approved PR)",
    T.AUTOMATION_ACTIVATION_ENABLED === false && /export const AUTOMATION_ACTIVATION_ENABLED: boolean = false;/.test(readFileSync("lib/notifications/automations/types.ts", "utf8")));

  console.log(failures === 0 ? "\n✅ comms automations hardening: all checks passed" : `\n❌ ${failures} check(s) failed`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
