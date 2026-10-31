/**
 * lib/notifications/automations/preflip.test.ts  (Comms Center B2 — PRE-FLIP residuals R1–R4)
 *
 * Session 2's independent re-review of #190 left these before AUTOMATION_ACTIVATION_ENABLED may be
 * flipped. The REAL engine over the in-memory Prisma fake, fake transports — no database, no
 * network, no real send. Each check pins a BEHAVIOUR; a mutation of its guard fails here:
 *
 *   R1  at send, a SPACE_ROLE recipient must still hold one of the resolver's roles (a demoted admin
 *       gets no "X joined"), and an EVENT_ACTOR_USER recipient must still be a member (a removed
 *       inviter gets nothing) ⇒ CANCELLED / OBSOLETE
 *   R2  the frequency cap counts EVERY automation of the same definition (SENT items + pending claims)
 *   R3  IN_APP: killed after createNotification with NO ledger row (it is deferred) ⇒ the lease
 *       recovery finds the bell (auditLogId = the fact) and marks the item SENT — no second bell
 *   R4  EMAIL: a retry refused with Resend 409 `invalid_idempotent_request` ⇒ SENT, flagged
 *       uncertain — never DEAD, never re-sent
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/notifications/automations/preflip.test.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- assertions read loosely-typed fake rows */

import "@/lib/test-support/route-env";
import { readFileSync } from "node:fs";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import type { EmailMessage, EmailProvider } from "@/lib/email/types";
import type { ResendLikeClient } from "@/lib/email/providers/resend";

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
const DAY = 24 * 60 * MIN;

async function main(): Promise<void> {
  await installFakePrisma(fake);
  const { systemDb } = await import("@/lib/db");
  const E = await import("./engine");
  const T = await import("./types");
  const { createNotification } = await import("@/lib/notifications/create");
  const { createEmailSender } = await import("@/lib/email/send");
  const { createResendAdapter } = await import("@/lib/email/providers/resend");
  const { PendingSends } = await import("@/lib/notifications/delivery/storm");
  const { judgeGlobalCostFreeze } = await import("@/lib/platform/cost-freeze.core");
  const { getCatalogDefinition } = await import("@/lib/notifications/catalog/definitions");
  const db = systemDb as any;

  let clock = T0;
  const ledger = async (row: any) => { await db.commsDelivery.createMany({ data: [{ ...row, createdAt: clock }] }); };
  const blindLedger = async () => {};
  const okProvider: EmailProvider = { name: "resend", send: async () => ({ status: "sent", id: "re_ok", provider: "resend" }) };
  const capture: EmailProvider = { name: "capture", send: async (m: EmailMessage) => ({ status: "captured", provider: "capture", id: m.to }) };
  const mkSend = (provider: EmailProvider, l: (row: any) => Promise<void> = ledger) => createEmailSender({
    env: { VERCEL: "1", VERCEL_ENV: "production", RESEND_API_KEY: "re_test_not_real", NODE_ENV: "production" } as any,
    provider, capture, ledger: l, pending: new PendingSends(), now: () => clock, log: () => {},
  });
  const deps = (over: Record<string, unknown> = {}): any => ({
    db,
    freeze: async () => judgeGlobalCostFreeze(null),
    lifecycle: async (ids: readonly string[]) => new Map(ids.map((id) => [id, "ACTIVE"])),
    sendEmail: mkSend(okProvider),
    createNotification: (input: any, ctx: any) => createNotification(input, ctx),
    ledger,
    content: null,
    env: { VERCEL: "1", VERCEL_ENV: "production" },
    appBaseUrl: "https://app.test.invalid",
    now: () => clock,
    admission: async () => ({ admitted: true, reason: null }),
    activationEnabled: true,
    log: () => {},
    ...over,
  });
  const BUDGET = { maxAutomations: 50, maxFactsPerAutomation: 100, maxItems: 200, timeBudgetMs: 60_000 };
  const run = (d = deps()) => quiet(() => E.runAutomationEngine(d, BUDGET));

  const ACTOR = "u_actor";
  function user(id: string): void {
    fake.seed("User", { id, email: `${id}@example.invalid`, username: id, emailVerifiedAt: T0, createdAt: new Date(T0.getTime() - 100 * DAY) });
  }
  function reset(): void { fake.reset(); clock = T0; user(ACTOR); }
  function space(id: string): void { if (!fake.one("Space", { id })) fake.seed("Space", { id, name: `Space ${id}` }); }
  function member(spaceId: string, userId: string, role: string): void {
    space(spaceId);
    if (!fake.one("SpaceMember", { spaceId, userId })) fake.seed("SpaceMember", { spaceId, userId, role, status: "ACTIVE" });
  }
  function automation(extra: Record<string, unknown>): string {
    const def = getCatalogDefinition(String(extra.definitionKey ?? "MEMBER_ROLE_CHANGED"))!;
    const row = fake.seed("AutomationDefinition", {
      name: "a", triggerKey: "space.member.role_changed", definitionKey: "MEMBER_ROLE_CHANGED", definitionVersion: def.definitionVersion,
      customerFacing: true, channels: ["IN_APP"], conditions: [], recipient: { kind: "EVENT_SUBJECT_USER" },
      dedupeKeyTemplate: "K:{spaceId}:{recipientId}", frequencyCapMax: 10, frequencyCapHours: 1,
      retryPolicy: "STANDARD", maxRecipientsPerRun: 50, state: "ACTIVE", version: 2, activatedVersion: 1,
      activatedAt: new Date(T0.getTime() - 60 * MIN), triggerCursorAt: new Date(T0.getTime() - 60 * MIN), triggerCursorId: null,
      createdById: "op", updatedById: "op", ...extra,
    });
    return row.id as string;
  }
  let factN = 0;
  function roleChanged(target: string, at: Date, spaceId = "sp_1"): string {
    member(spaceId, target, "ADMIN");
    const id = `fact_${++factN}`;
    fake.seed("AuditLog", { id, action: "MEMBER_ROLE_CHANGED", userId: ACTOR, spaceId, createdAt: at, metadata: { targetUserId: target, oldRole: "MEMBER", newRole: "ADMIN" } });
    return id;
  }
  const items = (where: Record<string, unknown> = {}) => fake.rows("AutomationRunItem", where) as any[];
  const bells = (type: string) => fake.rows("Notification", { type }) as any[];

  // ── R1 ───────────────────────────────────────────────────────────────────
  console.log("R1. at send the recipient must still be one the resolver picks");
  for (const demote of [false, true]) {
    // "X joined" → the Space's OWNER / ADMIN (SPACE_ROLE), 30-minute delay.
    reset(); user("u_admin"); user("u_new");
    member("sp_j", "u_admin", "ADMIN"); member("sp_j", "u_new", "MEMBER");
    automation({ triggerKey: "space.member.joined", definitionKey: "SPACE_INVITE_ACCEPTED", recipient: { kind: "SPACE_ROLE", roles: ["OWNER", "ADMIN"] }, delayMinutes: 30 });
    fake.seed("AuditLog", { action: "MEMBER_JOINED", userId: "u_new", spaceId: "sp_j", createdAt: new Date(T0.getTime() - 2 * MIN), metadata: { userId: "u_new" } });
    await run();
    const scheduled = items().length === 1 && items()[0].recipientUserId === "u_admin" && items()[0].status === "SCHEDULED";
    if (demote) fake.one("SpaceMember", { spaceId: "sp_j", userId: "u_admin" })!.role = "MEMBER";
    clock = new Date(T0.getTime() + 31 * MIN);
    await run();
    const it = items()[0];
    if (demote) {
      check("SPACE_ROLE: the admin (still an ACTIVE member) was DEMOTED to MEMBER during the delay ⇒ CANCELLED / OBSOLETE, no \"X joined\" bell",
        scheduled && it.status === "CANCELLED" && it.reason === "OBSOLETE" && bells("SPACE_INVITE_ACCEPTED").length === 0, it && [it.status, it.reason]);
    } else {
      check("SPACE_ROLE control: the admin is still ADMIN ⇒ SENT (the recheck does not over-cancel)",
        scheduled && it.status === "SENT" && bells("SPACE_INVITE_ACCEPTED").length === 1, it && [it.status, it.reason]);
    }
  }
  for (const removeInviter of [false, true]) {
    // "your invite was sent" → the inviter (EVENT_ACTOR_USER), 30-minute delay.
    reset(); user("u9"); member("sp_i", ACTOR, "ADMIN");
    automation({ triggerKey: "space.member.invited", definitionKey: "SPACE_INVITE_RECEIVED", recipient: { kind: "EVENT_ACTOR_USER" }, dedupeKeyTemplate: "I:{recipientId}", delayMinutes: 30 });
    fake.seed("SpaceInvite", { spaceId: "sp_i", invitedUserId: "u9", invitedById: ACTOR, status: "PENDING", expiresAt: null });
    fake.seed("AuditLog", { action: "MEMBER_INVITED", userId: ACTOR, spaceId: "sp_i", createdAt: new Date(T0.getTime() - 2 * MIN), metadata: { invitedUserId: "u9", role: "MEMBER" } });
    await run();
    const scheduled = items().length === 1 && items()[0].recipientUserId === ACTOR && items()[0].status === "SCHEDULED";
    if (removeInviter) fake.one("SpaceMember", { spaceId: "sp_i", userId: ACTOR })!.status = "REMOVED";
    clock = new Date(T0.getTime() + 31 * MIN);
    await run();
    const it = items()[0];
    if (removeInviter) {
      check("EVENT_ACTOR_USER: the inviter was REMOVED from the Space during the delay (invite still PENDING) ⇒ CANCELLED / OBSOLETE",
        scheduled && it.status === "CANCELLED" && it.reason === "OBSOLETE" && bells("SPACE_INVITE_RECEIVED").length === 0, it && [it.status, it.reason]);
    } else {
      check("EVENT_ACTOR_USER control: the inviter is still a member ⇒ SENT",
        scheduled && it.status === "SENT" && bells("SPACE_INVITE_RECEIVED").length === 1, it && [it.status, it.reason]);
    }
  }
  {
    // The pure predicate, both kinds, direct.
    reset(); member("sp_p", "u_a", "ADMIN"); member("sp_p", "u_m", "MEMBER");
    const fact = { triggerKey: "space.member.joined", ref: "f", spaceId: "sp_p", subjectUserId: "u_m", actorUserId: "u_a", occurredAt: T0, payload: {} } as any;
    const role = { kind: "SPACE_ROLE", roles: ["OWNER", "ADMIN"] } as any;
    check("recipientStillResolves: SPACE_ROLE admits the ADMIN, refuses the MEMBER and a non-member",
      (await E.recipientStillResolves(db, role, fact, "u_a")) && !(await E.recipientStillResolves(db, role, fact, "u_m")) && !(await E.recipientStillResolves(db, role, fact, "u_x")));
    check("…EVENT_ACTOR_USER admits only the actor while a member; EVENT_SUBJECT_USER only the subject",
      (await E.recipientStillResolves(db, { kind: "EVENT_ACTOR_USER" } as any, fact, "u_a")) && !(await E.recipientStillResolves(db, { kind: "EVENT_ACTOR_USER" } as any, fact, "u_m"))
      && (await E.recipientStillResolves(db, { kind: "EVENT_SUBJECT_USER" } as any, fact, "u_m")) && !(await E.recipientStillResolves(db, { kind: "EVENT_SUBJECT_USER" } as any, fact, "u_a")));
  }

  // ── R2 ───────────────────────────────────────────────────────────────────
  console.log("R2. the frequency cap spans every automation of the same definition");
  {
    reset(); user("u1");
    automation({ frequencyCapMax: 1, frequencyCapHours: 24 });
    automation({ frequencyCapMax: 1, frequencyCapHours: 24 });
    roleChanged("u1", new Date(T0.getTime() - 5 * MIN));
    await run(deps({ ledger: blindLedger }));
    check("two ACTIVE automations on MEMBER_ROLE_CHANGED, one fact, cap 1 / 24 h, ledger blind, ONE pass ⇒ ONE bell; the second claim is SUPPRESSED / FREQUENCY_CAP",
      bells("MEMBER_ROLE_CHANGED").length === 1 && items({ status: "SENT" }).length === 1 && items({ status: "SUPPRESSED", reason: "FREQUENCY_CAP" }).length === 1,
      items().map((i) => [i.automationId, i.status, i.reason]));
  }
  {
    reset(); user("u1");
    automation({ frequencyCapMax: 1, frequencyCapHours: 24 });
    roleChanged("u1", new Date(T0.getTime() - 5 * MIN));
    await run(deps({ ledger: blindLedger }));
    // A second automation, created later, whose cursor is behind the fact (it reads the same fact on its first scan).
    const b = automation({ frequencyCapMax: 1, frequencyCapHours: 24, activatedAt: new Date(T0.getTime() - 60 * MIN), triggerCursorAt: new Date(T0.getTime() - 60 * MIN) });
    (fake.one("AutomationDefinition", { id: items()[0].automationId }) as any).state = "PAUSED"; // the first sent, then was paused
    clock = new Date(T0.getTime() + 3 * MIN);
    await run(deps({ ledger: blindLedger }));
    check("a later pass, a SIBLING's SENT item (sibling since PAUSED, no ledger row anywhere) holds the cap for the new automation",
      bells("MEMBER_ROLE_CHANGED").length === 1 && fake.rows("CommsDelivery", { status: "ACCEPTED" }).length === 0 && items({ automationId: b, reason: "FREQUENCY_CAP" }).length === 1,
      items().map((i) => [i.automationId, i.status, i.reason]));
  }
  {
    reset(); user("u1");
    automation({ frequencyCapMax: 1, frequencyCapHours: 24 });
    automation({ definitionKey: "MEMBER_REMOVED", triggerKey: "space.member.role_changed", frequencyCapMax: 1, frequencyCapHours: 24 });
    roleChanged("u1", new Date(T0.getTime() - 5 * MIN));
    await run(deps({ ledger: blindLedger }));
    check("control: an automation of a DIFFERENT definition is not a sibling (its claim is not capped by the other's)",
      items().length === 2 && items({ reason: "FREQUENCY_CAP" }).length === 0, items().map((i) => [i.status, i.reason]));
  }

  // ── R3 ───────────────────────────────────────────────────────────────────
  console.log("R3. IN_APP: killed after createNotification, before the deferred ledger row");
  for (const killAfter of [true, false]) {
    reset(); user("u1"); automation({}); const ref = roleChanged("u1", new Date(T0.getTime() - 5 * MIN));
    // The production in-app ledger row is written after the response: a kill leaves none.
    const killed = async (input: any, ctx: any) => {
      if (killAfter) await createNotification(input, { ...ctx, ledger: blindLedger });
      throw new Error("function killed at its limit");
    };
    await run(deps({ createNotification: killed, ledger: blindLedger }));
    const id = items()[0].id;
    const setup = items()[0].status === "SENDING" && fake.rows("CommsDelivery", { automationRunItemId: id }).length === 0 && bells("MEMBER_ROLE_CHANGED").length === (killAfter ? 1 : 0);
    clock = new Date(T0.getTime() + 6 * MIN);
    const s = await run();
    if (killAfter) {
      check("killed AFTER createNotification (bell written with auditLogId = the fact, NO ledger row) ⇒ the lease recovery marks it SENT (recovered 1); still ONE bell",
        setup && bells("MEMBER_ROLE_CHANGED").length === 1 && bells("MEMBER_ROLE_CHANGED")[0].auditLogId === ref && items()[0].status === "SENT"
        && items()[0].lastDeliveryStatus === "ACCEPTED" && s.recovered === 1, { setup, bells: bells("MEMBER_ROLE_CHANGED").length, it: items()[0].status, s });
      clock = new Date(T0.getTime() + 60 * MIN); await run();
      check("…and no later pass adds a bell", bells("MEMBER_ROLE_CHANGED").length === 1);
    } else {
      check("control: killed BEFORE createNotification (no bell) ⇒ back to SCHEDULED and delivered once (recovered 0)",
        setup && bells("MEMBER_ROLE_CHANGED").length === 1 && items()[0].status === "SENT" && s.recovered === 0, { setup, s });
    }
  }
  {
    reset(); user("u1"); automation({}); roleChanged("u1", new Date(T0.getTime() - 5 * MIN));
    await run(deps({ createNotification: async () => { throw new Error("killed"); }, ledger: blindLedger }));
    // An unrelated bell of the same type for the same user (EV-1: auditLogId null; another fact) does not count as this item's.
    fake.seed("Notification", { userId: "u1", spaceId: "sp_1", type: "MEMBER_ROLE_CHANGED", category: "SPACES", title: "x", auditLogId: "some_other_fact", createdAt: T0 });
    clock = new Date(T0.getTime() + 6 * MIN);
    const s = await run();
    check("control: a bell linked to ANOTHER fact is not this item's ⇒ not recovered, delivered", s.recovered === 0 && items()[0].status === "SENT" && bells("MEMBER_ROLE_CHANGED").length === 2, s);
  }

  // ── R4 ───────────────────────────────────────────────────────────────────
  console.log("R4. EMAIL: a retry refused as an idempotency conflict is SENT (uncertain), never DEAD");
  {
    const MSG = { to: "a@example.invalid", from: "FM <x@example.invalid>", subject: "s", text: "t" };
    const conflict: ResendLikeClient = { emails: { send: async () => ({ data: null, error: { name: "invalid_idempotent_request", statusCode: 409, message: "Same idempotency key used with a different request payload" } }) } };
    const other: ResendLikeClient = { emails: { send: async () => ({ data: null, error: { name: "validation_error", statusCode: 422, message: "bad" } }) } };
    const withKey = await createResendAdapter(() => conflict).send({ ...MSG, idempotencyKey: "item_1" });
    const noKey = await createResendAdapter(() => conflict).send(MSG);
    const notIt = await createResendAdapter(() => other).send({ ...MSG, idempotencyKey: "item_1" });
    check("adapter: 409 invalid_idempotent_request WITH a key ⇒ { status: sent, uncertain: IDEMPOTENCY_CONFLICT }, no id",
      withKey.status === "sent" && withKey.uncertain === "IDEMPOTENCY_CONFLICT" && withKey.id === undefined, withKey);
    check("…the same error with NO key, or any other error, stays an error", noKey.status === "error" && notIt.status === "error" && !noKey.uncertain && !notIt.uncertain, { noKey, notIt });
  }
  {
    reset(); user("u1");
    fake.seed("NotificationPreference", { userId: "u1", category: "SPACES", channel: "EMAIL", enabled: true });
    automation({ channels: ["EMAIL"] }); roleChanged("u1", new Date(T0.getTime() - 5 * MIN));
    // The real adapter over a fake Resend: attempt 1 is accepted but never answers in time (timeout);
    // the retry's content changed, so Resend refuses the reused key with 409.
    const keys: (string | undefined)[] = [];
    const client: ResendLikeClient = { emails: { send: (_p, o) => {
      keys.push(o?.idempotencyKey);
      if (keys.length === 1) return new Promise(() => {});
      return Promise.resolve({ data: null, error: { name: "invalid_idempotent_request", statusCode: 409, message: "different payload" } });
    } } };
    const send = mkSend(createResendAdapter(() => client, { timeoutMs: 20 }));
    await run(deps({ sendEmail: send }));
    const first = items()[0];
    check("setup: attempt 1 timed out ⇒ FAILED awaiting retry", first.status === "FAILED" && first.attempt === 1, [first.status, first.attempt]);
    clock = new Date(T0.getTime() + 16 * MIN);
    const s = await run(deps({ sendEmail: send }));
    const it = items()[0];
    check("the retry (same Idempotency-Key = the item id) answered 409 invalid_idempotent_request ⇒ SENT, lastDeliveryStatus ACCEPTED, reason flags it uncertain",
      it.status === "SENT" && it.lastDeliveryStatus === "ACCEPTED" && it.reason === E.UNCERTAIN_ACCEPTANCE && keys.length === 2 && keys.every((k) => k === it.id) && s.sent === 1,
      { it: [it.status, it.reason, it.lastDeliveryStatus], keys: keys.length, s });
    clock = new Date(T0.getTime() + 6 * 60 * MIN); await run(deps({ sendEmail: send }));
    check("…not DEAD, and never re-sent on later passes (2 provider calls in all)", items()[0].status === "SENT" && keys.length === 2, keys.length);
  }

  // ── Nit: the skip label ───────────────────────────────────────────────────
  {
    const { skipLabel } = await import("@/lib/jobs/skip-label");
    check("an ADMISSION_ skip is labelled \"Skipped (admission)\" — maintenance AND an unreadable control plane",
      skipLabel("ADMISSION_MAINTENANCE_MODE") === "Skipped (admission)" && skipLabel("ADMISSION_CONTROL_PLANE_UNREADABLE") === "Skipped (admission)");
  }

  // ── The gate ──────────────────────────────────────────────────────────────
  console.log("the activation gate stays closed");
  check("AUTOMATION_ACTIVATION_ENABLED is still the code constant false (flipping it is a separate owner-approved PR)",
    T.AUTOMATION_ACTIVATION_ENABLED === false && /export const AUTOMATION_ACTIVATION_ENABLED: boolean = false;/.test(readFileSync("lib/notifications/automations/types.ts", "utf8")));

  console.log(failures === 0 ? "\n✅ comms automations pre-flip R1–R4: all checks passed" : `\n❌ ${failures} check(s) failed`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
