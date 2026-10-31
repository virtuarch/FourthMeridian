/**
 * lib/notifications/automations/engine.test.ts  (Comms Center B2 — the execution engine)
 *
 * The REAL engine over the in-memory Prisma fake (the real schema), with fake
 * transports — no database, no network, no real send:
 *   1. the §6.5 lifecycle matrix, per consent class × origin × channel × state (incl. UNKNOWN);
 *   2. per-recipient lifecycle in the engine; a Beta-GROUP freeze is per-recipient;
 *   3. the GLOBAL Cost Freeze (ON / INVALID / UNAVAILABLE) HALTS: SKIPPED, scheduled items
 *      CANCELLED / PROVIDER_FREEZE, zero sends; MISSING / OFF do not;
 *   4. a delay re-evaluates immediately before the send;
 *   5. dedupe + idempotency: a replayed fact / a re-run / a concurrent pass sends nothing twice;
 *   6. the 5/hour storm limit holds automation email (SUPPRESSED, never retried);
 *   7. loop prevention: the engine's own sends are never trigger facts;
 *   8. no broadcast: over maxRecipientsPerRun ⇒ HALTED + auto-pause, nothing sent;
 *   9. bounded + resumable: budgets defer, a crashed lease resumes, retry → DEAD;
 *  10. the executor job: registered (A7), SKIPPED ⇒ job health skipped ⇒ overview DEGRADED, wake budget;
 *  11. the ACTIVATION HARD GATE blocks the engine (no writes, no sends, a clear skip reason).
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/notifications/automations/engine.test.ts
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
  const { log, warn, info } = console; console.log = () => {}; console.warn = () => {}; console.info = () => {};
  try { return await f(); } finally { console.log = log; console.warn = warn; console.info = info; }
};

const fake = new FakePrisma();
const T0 = new Date("2026-10-31T12:00:00.000Z");
const MIN = 60_000;

async function main(): Promise<void> {
  await installFakePrisma(fake);
  const { systemDb } = await import("@/lib/db");
  const E = await import("./engine");
  const R = await import("./rules");
  const F = await import("./facts");
  const { createNotification } = await import("@/lib/notifications/create");
  const { createEmailSender } = await import("@/lib/email/send");
  const { PendingSends } = await import("@/lib/notifications/delivery/storm");
  const { judgeGlobalCostFreeze } = await import("@/lib/platform/cost-freeze.core");
  const { skippedOutcomeOf } = await import("@/lib/jobs/health");
  const { commsAutomations } = await import("@/jobs/comms-automations");
  const { SCHEDULED_JOBS } = await import("@/lib/jobs/registry");
  const { SCHEDULED_JOB_FACTS } = await import("@/lib/jobs/registry.core");
  const { classifyJobHealth } = await import("@/lib/jobs/health");
  const { deriveJobs } = await import("@/lib/platform/ops/overview-core");
  const { skipLabel } = await import("@/lib/jobs/skip-label");
  const { decideJobDue, CONTINUATION_DELAY_MS } = await import("@/lib/jobs/cadence-policy.core");
  const T = await import("./types");
  const db = systemDb as any;

  // ── The world ─────────────────────────────────────────────────────────────
  let clock = T0;
  let freeze: GlobalCostFreezeVerdict = judgeGlobalCostFreeze(null);
  let states: Record<string, UserLifecycleState> = {};
  let lifecycleReads = 0;
  const sent: EmailMessage[] = [];
  let providerAnswer: () => EmailResult = () => ({ status: "sent", id: `re_${sent.length}`, provider: "resend" });
  const provider = { name: "resend", send: async (m: EmailMessage) => { sent.push(m); return providerAnswer(); } };
  const capture = { name: "capture", send: async (m: EmailMessage) => { sent.push(m); return { status: "captured" as const, provider: "capture" }; } };
  const ledger = async (row: any) => { await db.commsDelivery.createMany({ data: [{ ...row, createdAt: clock }] }); };
  const stormCounter = async (q: any) => db.commsDelivery.count({ where: { channel: "EMAIL", status: "ACCEPTED", definitionKey: { in: [...q.keys] }, createdAt: { gte: q.since }, recipientUserId: q.recipientUserId ?? "-" } });
  const mkSend = () => createEmailSender({
    env: { VERCEL: "1", VERCEL_ENV: "production", RESEND_API_KEY: "re_test_not_real", NODE_ENV: "production" } as any,
    provider, capture, ledger, storm: stormCounter, pending: new PendingSends(), now: () => clock, log: () => {},
  });
  const deps = (): any => ({
    db,
    freeze: async () => freeze,
    lifecycle: async (ids: readonly string[]) => { if (ids.length) lifecycleReads++; return new Map(ids.map((id) => [id, states[id] ?? "ACTIVE"])); },
    sendEmail: mkSend(),
    createNotification: (input: any, ctx: any) => createNotification(input, ctx),
    ledger,
    content: null,
    env: { VERCEL: "1", VERCEL_ENV: "production" },
    appBaseUrl: "https://app.test.invalid",
    now: () => clock,
    admission: async () => ({ admitted: true, reason: null }),
    // These scenarios exercise the post-hardening engine; section 11 pins the hard gate itself.
    activationEnabled: true,
  });
  const BUDGET = { maxAutomations: 50, maxFactsPerAutomation: 100, maxItems: 200, timeBudgetMs: 60_000 };

  const ACTOR = "u_actor";
  function reset(): void {
    fake.reset();
    clock = T0; freeze = judgeGlobalCostFreeze(null); states = {}; sent.length = 0; lifecycleReads = 0;
    providerAnswer = () => ({ status: "sent", id: `re_${sent.length}`, provider: "resend" });
    fake.seed("User", { id: ACTOR, email: "actor@example.invalid", username: "actor", emailVerifiedAt: T0, createdAt: new Date(T0.getTime() - 400 * 86_400_000) });
  }
  function user(id: string, extra: Record<string, unknown> = {}): void {
    fake.seed("User", { id, email: `${id}@example.invalid`, username: id, emailVerifiedAt: T0, createdAt: new Date(T0.getTime() - 100 * 86_400_000), ...extra });
  }
  function emailOn(id: string): void { fake.seed("NotificationPreference", { userId: id, category: "SPACES", channel: "EMAIL", enabled: true }); }
  let factN = 0;
  /** The Space and the target's ACTIVE membership at the new role (the A3 at-send predicate reads them). */
  function space(spaceId: string): void { if (!fake.one("Space", { id: spaceId })) fake.seed("Space", { id: spaceId, name: `Space ${spaceId}` }); }
  function member(spaceId: string, userId: string, role = "ADMIN"): void {
    space(spaceId);
    if (!fake.one("SpaceMember", { spaceId, userId })) fake.seed("SpaceMember", { spaceId, userId, role, status: "ACTIVE" });
  }
  function roleChanged(target: string, at: Date, spaceId = "sp_1"): string {
    member(spaceId, target, "ADMIN");
    const id = `fact_${++factN}`;
    fake.seed("AuditLog", { id, action: "MEMBER_ROLE_CHANGED", userId: ACTOR, spaceId, createdAt: at,
      metadata: { targetUserId: target, targetName: "Real Name Never Copied", oldRole: "MEMBER", newRole: "ADMIN" } });
    return id;
  }
  function automation(extra: Record<string, unknown> = {}): string {
    const row = fake.seed("AutomationDefinition", {
      name: "Role changed", triggerKey: "space.member.role_changed", definitionKey: "MEMBER_ROLE_CHANGED", definitionVersion: 1,
      customerFacing: true, channels: ["IN_APP"], conditions: [], recipient: { kind: "EVENT_SUBJECT_USER" },
      dedupeKeyTemplate: "MEMBER_ROLE_CHANGED:{spaceId}:{recipientId}", frequencyCapMax: 10, frequencyCapHours: 1,
      retryPolicy: "STANDARD", maxRecipientsPerRun: 50, state: "ACTIVE", version: 2, activatedVersion: 1,
      activatedAt: new Date(T0.getTime() - 60 * MIN), triggerCursorAt: new Date(T0.getTime() - 60 * MIN), triggerCursorId: null,
      createdById: "op", updatedById: "op", ...extra,
    });
    return row.id as string;
  }
  const items = (where: Record<string, unknown> = {}) => fake.rows("AutomationRunItem", where);
  const bells = () => fake.rows("Notification", { type: "MEMBER_ROLE_CHANGED" });
  const ledgerRows = (where: Record<string, unknown> = {}) => fake.rows("CommsDelivery", where);
  const run = (d = deps(), b = BUDGET) => quiet(() => E.runAutomationEngine(d, b));

  // The catalog definition the engine resolves (customer-facing AWARENESS).
  const { getCatalogDefinition } = await import("@/lib/notifications/catalog/definitions");
  const DEF = getCatalogDefinition("MEMBER_ROLE_CHANGED")!;
  const AUTO_DEF_VERSION = DEF.definitionVersion;

  // ── 1. The §6.5 matrix (pure) ─────────────────────────────────────────────
  console.log("1. the lifecycle matrix (owner rule, v1.1 §6.5) — every class × origin × channel × state");
  {
    const STATES: UserLifecycleState[] = ["ACTIVE", "PAUSED", "ENDED", "COST_FREEZE", "UNKNOWN"];
    const row = (consentClass: any, origin: any, channel: any, serviceOwnData: boolean) => STATES.map((s) => (R.lifecycleAllows({ consentClass, origin, channel, serviceOwnData }, s) ? "S" : "B")).join("");
    const cases: Array<[string, string, string]> = [
      ["SECURITY_CRITICAL any origin", row("SECURITY_CRITICAL", "AUTOMATION", "EMAIL", false) + row("SECURITY_CRITICAL", "DIRECT", "EMAIL", false), "SSSSSSSSSS"],
      ["CEREMONY any origin", row("CEREMONY", "DIRECT", "EMAIL", false) + row("CEREMONY", "AUTOMATION", "IN_APP", false), "SSSSSSSSSS"],
      ["SERVICE own data — registry, direct AND automation", row("SERVICE", "REGISTRY", "EMAIL", true) + row("SERVICE", "DIRECT", "EMAIL", true) + row("SERVICE", "AUTOMATION", "EMAIL", true), "SSSSSSSSSSSSSSS"],
      ["AWARENESS via automation, IN_APP", row("AWARENESS", "AUTOMATION", "IN_APP", false), "SBBBB"],
      ["AWARENESS via automation, EMAIL", row("AWARENESS", "AUTOMATION", "EMAIL", false), "SBBBB"],
      ["AWARENESS registry EMAIL leg", row("AWARENESS", "REGISTRY", "EMAIL", false), "SBBBB"],
      ["AWARENESS direct EMAIL", row("AWARENESS", "DIRECT", "EMAIL", false), "SBBBB"],
      ["AWARENESS registry IN_APP bell (O-17)", row("AWARENESS", "REGISTRY", "IN_APP", false), "SSSSS"],
      ["SERVICE NOT own data via automation (treated as AWARENESS)", row("SERVICE", "AUTOMATION", "IN_APP", false), "SBBBB"],
      ["MARKETING (any)", row("MARKETING", "REGISTRY", "IN_APP", false), "SBBBB"],
      ["OPERATOR — not evaluated", row("OPERATOR", "AUTOMATION", "EMAIL", false), "SSSSS"],
    ];
    for (const [name, got, want] of cases) check(`${name}: ${want}`, got === want, got);
    check("SERVICE-own-data needs all three: SERVICE ∧ ACCOUNT_HOLDER ∧ EVENT_SUBJECT_USER",
      R.isServiceOwnData({ consentClass: "SERVICE", audience: "ACCOUNT_HOLDER" }, { kind: "EVENT_SUBJECT_USER" })
      && !R.isServiceOwnData({ consentClass: "SERVICE", audience: "ACCOUNT_HOLDER" }, { kind: "SPACE_ROLE", roles: ["OWNER"] })
      && !R.isServiceOwnData({ consentClass: "SERVICE", audience: "SPACE_MEMBER" }, { kind: "EVENT_SUBJECT_USER" })
      && !R.isServiceOwnData({ consentClass: "AWARENESS", audience: "ACCOUNT_HOLDER" }, { kind: "EVENT_SUBJECT_USER" }));
  }

  // ── 2. Lifecycle in the engine; a group freeze is per-recipient ────────────
  console.log("2. per-recipient lifecycle in the engine (one batch read); a Beta-GROUP freeze suppresses only its recipients");
  for (const state of ["PAUSED", "ENDED", "COST_FREEZE", "UNKNOWN"] as const) {
    reset();
    user("u_ok"); user("u_x");
    automation();
    roleChanged("u_ok", new Date(T0.getTime() - 10 * MIN));
    roleChanged("u_x", new Date(T0.getTime() - 9 * MIN));
    states = { u_x: state };
    const s = await run();
    const x = items({ recipientUserId: "u_x" })[0] as any;
    check(`${state}: that recipient SUPPRESSED / BETA_LIFECYCLE with a ledger row, the other ACTIVE recipient is SENT, the run continues`,
      x?.status === "SUPPRESSED" && x.reason === "BETA_LIFECYCLE" && (items({ recipientUserId: "u_ok" })[0] as any)?.status === "SENT"
      && bells().length === 1 && (bells()[0] as any).userId === "u_ok" && s.outcome === "COMPLETE"
      && ledgerRows({ messageKey: x.id, status: "SUPPRESSED", reason: "BETA_LIFECYCLE" }).length === 1, { s, x });
  }
  {
    reset(); user("a"); user("b"); user("c"); automation();
    for (const u of ["a", "b", "c"]) roleChanged(u, new Date(T0.getTime() - 5 * MIN));
    states = { b: "COST_FREEZE" };
    lifecycleReads = 0;
    await run();
    check("a GROUP cost freeze (COST_FREEZE for one recipient) halts nothing: the others are sent, its own item is BETA_LIFECYCLE",
      bells().length === 2 && (items({ recipientUserId: "b" })[0] as any).reason === "BETA_LIFECYCLE" && fake.rows("AutomationRun", { status: "HALTED" }).length === 0);
    check("lifecycle is read ONCE per send batch (per fact at ingest, once for the whole delivery batch)", lifecycleReads === 3 + 1, lifecycleReads);
  }

  // ── 3. The GLOBAL freeze halts ────────────────────────────────────────────
  console.log("3. the GLOBAL Cost Freeze (readGlobalCostFreeze) halts live runs — SKIPPED, nothing sent");
  for (const [label, verdict] of [["ON", judgeGlobalCostFreeze("true")], ["INVALID", judgeGlobalCostFreeze("yes")], ["UNAVAILABLE", judgeGlobalCostFreeze(null, true)]] as const) {
    reset(); user("u1"); user("u2");
    automation({ delayMinutes: 30 });
    roleChanged("u1", new Date(T0.getTime() - 5 * MIN));
    await run(); // u1 SCHEDULED (delay)
    fake.seed("AutomationRun", { automationId: "x", automationVersion: 1, mode: "LIVE", triggerKey: "space.member.role_changed", status: "RUNNING", counts: {} });
    roleChanged("u2", new Date(T0.getTime() - 4 * MIN));
    freeze = verdict;
    clock = new Date(T0.getTime() + 60 * MIN);
    const before = { bells: bells().length, sent: sent.length };
    const s = await run();
    check(`${label}: outcome SKIPPED / ${s.skipReason}; the scheduled item CANCELLED / PROVIDER_FREEZE (+ ledger row); the RUNNING run HALTED; no new fact ingested; nothing sent`,
      s.outcome === "SKIPPED" && /^BILLABLE_(COST_FREEZE|POLICY_UNAVAILABLE)$/.test(s.skipReason ?? "")
      && (items({ recipientUserId: "u1" })[0] as any).status === "CANCELLED" && (items({ recipientUserId: "u1" })[0] as any).reason === "PROVIDER_FREEZE"
      && ledgerRows({ status: "CANCELLED", reason: "PROVIDER_FREEZE" }).length === 1
      && fake.rows("AutomationRun", { status: "HALTED", haltReason: "PROVIDER_FREEZE" }).length >= 1
      && items({ recipientUserId: "u2" }).length === 0 && bells().length === before.bells && sent.length === before.sent, s);
  }
  for (const [label, verdict] of [["MISSING", judgeGlobalCostFreeze(null)], ["OFF", judgeGlobalCostFreeze("false")]] as const) {
    reset(); user("u1"); automation(); roleChanged("u1", new Date(T0.getTime() - 5 * MIN));
    freeze = verdict;
    const s = await run();
    check(`${label}: not frozen — the run proceeds and sends`, s.outcome === "COMPLETE" && bells().length === 1, s);
  }
  {
    reset(); user("u1"); automation({ delayMinutes: 10 }); roleChanged("u1", new Date(T0.getTime() - 1 * MIN));
    await run();
    // The freeze lands between ingest and the delayed send: the send-time re-check (uncached) cancels it.
    let calls = 0;
    const d = deps();
    d.freeze = async () => (++calls === 1 ? judgeGlobalCostFreeze(null) : judgeGlobalCostFreeze("true"));
    clock = new Date(T0.getTime() + 20 * MIN);
    await run(d);
    check("a freeze that lands mid-pass is caught by the send-time re-read (uncached): CANCELLED / PROVIDER_FREEZE, no send",
      (items()[0] as any).status === "CANCELLED" && (items()[0] as any).reason === "PROVIDER_FREEZE" && bells().length === 0);
  }

  // ── 4. Delay re-evaluates ─────────────────────────────────────────────────
  console.log("4. a delay re-evaluates IMMEDIATELY before the send");
  {
    reset(); user("u1"); automation({ delayMinutes: 30 }); roleChanged("u1", new Date(T0.getTime() - 1 * MIN));
    await run();
    const it = items()[0] as any;
    check("ingest: SCHEDULED at notBefore = fact + 30 min; nothing sent yet", it.status === "SCHEDULED" && new Date(it.notBefore).getTime() === T0.getTime() + 29 * MIN && bells().length === 0);
    clock = new Date(T0.getTime() + 10 * MIN);
    await run();
    check("before notBefore: still SCHEDULED, nothing sent", (items()[0] as any).status === "SCHEDULED" && bells().length === 0);
    states = { u1: "PAUSED" };
    clock = new Date(T0.getTime() + 31 * MIN);
    await run();
    check("the recipient was PAUSED during the delay ⇒ CANCELLED / BETA_LIFECYCLE at send time (+ ledger CANCELLED), no bell",
      (items()[0] as any).status === "CANCELLED" && (items()[0] as any).reason === "BETA_LIFECYCLE" && bells().length === 0
      && ledgerRows({ status: "CANCELLED", reason: "BETA_LIFECYCLE" }).length === 1);
  }
  {
    reset(); user("u1"); automation({ delayMinutes: 30, conditions: [{ op: "recipient.has_verified_email" }] });
    fake.one("User", { id: "u1" })!.emailVerifiedAt = null;
    roleChanged("u1", new Date(T0.getTime() - 1 * MIN));
    await run();
    check("a condition that fails at ingest ⇒ SUPPRESSED / ELIGIBILITY_FAILED (no schedule)", (items()[0] as any).reason === "ELIGIBILITY_FAILED");
    reset(); user("u1"); const id = automation({ delayMinutes: 30, conditions: [{ op: "recipient.has_verified_email" }] });
    roleChanged("u1", new Date(T0.getTime() - 1 * MIN));
    await run();
    fake.one("User", { id: "u1" })!.deactivatedAt = T0; // account restricted during the delay
    clock = new Date(T0.getTime() + 31 * MIN);
    await run();
    check("the account was deactivated during the delay ⇒ CANCELLED / ACCOUNT_RESTRICTED", (items()[0] as any).reason === "ACCOUNT_RESTRICTED" && bells().length === 0);
    reset(); user("u1"); const id2 = automation({ delayMinutes: 30 }); roleChanged("u1", new Date(T0.getTime() - 1 * MIN));
    await run();
    fake.one("AutomationDefinition", { id: id2 })!.state = "PAUSED";
    clock = new Date(T0.getTime() + 31 * MIN);
    await run();
    check("the automation was paused during the delay ⇒ CANCELLED / AUTOMATION_PAUSED", (items()[0] as any).reason === "AUTOMATION_PAUSED" && bells().length === 0);
    reset(); user("u1"); const id3 = automation({ delayMinutes: 30 }); roleChanged("u1", new Date(T0.getTime() - 1 * MIN));
    await run();
    const a3 = fake.one("AutomationDefinition", { id: id3 })!; a3.activatedVersion = 9; // re-activated at another version
    clock = new Date(T0.getTime() + 31 * MIN);
    await run();
    check("re-activated at a DIFFERENT version during the delay ⇒ CANCELLED (an old item never sends under a new rule)", (items()[0] as any).status === "CANCELLED");
    void id;
  }

  // ── 5. Dedupe + idempotency ───────────────────────────────────────────────
  console.log("5. dedupe + idempotency — nothing is sent twice");
  {
    reset(); user("u1"); const id = automation(); roleChanged("u1", new Date(T0.getTime() - 5 * MIN));
    await run();
    const n = { items: items().length, bells: bells().length, runs: fake.rows("AutomationRun").length };
    await run(); await run();
    check("re-running the pass: no new run, no new item, no second bell", items().length === n.items && bells().length === n.bells && fake.rows("AutomationRun").length === n.runs && n.bells === 1);
    // Replay: the cursor is rewound (a duplicate wake that read stale state).
    const a = fake.one("AutomationDefinition", { id })!; a.triggerCursorAt = new Date(T0.getTime() - 60 * MIN); a.triggerCursorId = null;
    const s = await run();
    check("a REPLAYED fact (cursor rewound): the run is found by liveKey, zero claims, zero sends", s.claimed === 0 && items().length === n.items && bells().length === 1, s);
    // A RUNNING run left by a crash mid-ingest resumes: its existing claims are counted deduped.
    const r = fake.rows("AutomationRun")[0] as any; r.status = "RUNNING";
    a.triggerCursorAt = new Date(T0.getTime() - 60 * MIN);
    const s2 = await run();
    check("a crashed RUNNING run is resumed, its existing claim counted `deduped` (not suppressed), still one bell",
      s2.deduped === 1 && s2.claimed === 0 && bells().length === 1 && (fake.rows("AutomationRun")[0] as any).dedupedCount >= 1, s2);
    const keys = items().map((i: any) => i.idempotencyKey);
    check("the idempotency key is sha256(automation ‖ activatedVersion ‖ triggerRef ‖ recipient ‖ channel) and unique", keys.length === 1 && /^[0-9a-f]{64}$/.test(keys[0]));
  }
  {
    reset(); user("u1"); automation();
    roleChanged("u1", new Date(T0.getTime() - 5 * MIN), "sp_1");
    roleChanged("u1", new Date(T0.getTime() - 4 * MIN), "sp_1");
    await run();
    check("two facts with the SAME dedupe key (same Space, same recipient): one SENT, the second SUPPRESSED / DEDUPE_OPEN",
      items({ status: "SENT" }).length === 1 && items({ status: "SUPPRESSED", reason: "DEDUPE_OPEN" }).length === 1 && bells().length === 1);
  }
  {
    reset(); user("u1"); automation({ frequencyCapMax: 1, frequencyCapHours: 24, dedupeKeyTemplate: "MEMBER_ROLE_CHANGED:{spaceId}:{recipientId}" });
    roleChanged("u1", new Date(T0.getTime() - 5 * MIN), "sp_1");
    await run();
    // A later fact (after the first scan's bound: facts are read once they are FACT_SETTLE_MS old).
    roleChanged("u1", new Date(T0.getTime() + 1 * MIN), "sp_2");
    clock = new Date(T0.getTime() + 3 * MIN);
    await run();
    check("the frequency cap (1 per 24 h, per recipient per definition) suppresses the second message (FREQUENCY_CAP)", items({ reason: "FREQUENCY_CAP" }).length === 1 && bells().length === 1);
  }
  {
    reset(); user("u1"); automation(); roleChanged("u1", new Date(T0.getTime() - 5 * MIN));
    // Two passes at once: the lease (updateMany WHERE status) lets exactly one send.
    await Promise.all([run(), run()]);
    check("two CONCURRENT passes: one claim, one bell", items().length === 1 && bells().length === 1, { items: items().length, bells: bells().length });
  }

  // ── 6. The storm limit ────────────────────────────────────────────────────
  console.log("6. the per-recipient storm limit (5 accepted / rolling hour, #177) holds automation email");
  {
    reset(); user("u1"); emailOn("u1");
    automation({ channels: ["EMAIL"], frequencyCapMax: 10 });
    for (let i = 0; i < 5; i++) fake.seed("CommsDelivery", { messageKey: `prev${i}`, definitionKey: "SYNC_FAILED", definitionVersion: 1, channel: "EMAIL", status: "ACCEPTED", attempt: 1, recipientUserId: "u1", environment: "production", createdAt: new Date(T0.getTime() - 10 * MIN) });
    roleChanged("u1", new Date(T0.getTime() - 2 * MIN));
    await run();
    const it = items()[0] as any;
    check("the 6th email in the hour is SUPPRESSED / RATE_LIMITED, the provider is never called", it.status === "SUPPRESSED" && it.reason === "RATE_LIMITED" && sent.length === 0, it);
    clock = new Date(T0.getTime() + 30 * MIN);
    await run();
    check("…and it is NEVER retried (not FAILED, no nextAttemptAt, still no send)", (items()[0] as any).status === "SUPPRESSED" && (items()[0] as any).nextAttemptAt === null && sent.length === 0);
    reset(); user("u2"); emailOn("u2"); automation({ channels: ["EMAIL"] }); roleChanged("u2", new Date(T0.getTime() - 2 * MIN));
    await run();
    check("under the limit: the email goes to the RECIPIENT's address, with the item as messageKey + automationRunItemId on the ledger row",
      sent.length === 1 && sent[0].to === "u2@example.invalid" && ledgerRows({ status: "ACCEPTED", channel: "EMAIL", automationRunItemId: (items()[0] as any).id, messageKey: (items()[0] as any).id }).length === 1);
    reset(); user("u3"); automation({ channels: ["EMAIL"] }); roleChanged("u3", new Date(T0.getTime() - 2 * MIN));
    await run();
    check("the category EMAIL preference applies (SPACES email is off by default) ⇒ SUPPRESSED / PREFERENCE_OFF", (items()[0] as any).reason === "PREFERENCE_OFF" && sent.length === 0);
  }

  // ── 7. Loop prevention ────────────────────────────────────────────────────
  console.log("7. loop prevention — an automation's own sends can never trigger it");
  {
    reset(); user("u1"); emailOn("u1");
    const id = automation({ channels: ["IN_APP", "EMAIL"] });
    roleChanged("u1", new Date(T0.getTime() - 5 * MIN));
    const auditBefore = fake.rows("AuditLog").length;
    await run();
    check("the engine's sends wrote NO AuditLog row (so no new fact exists)", fake.rows("AuditLog").length === auditBefore && bells().length === 1 && sent.length === 1);
    // Plant comms-originated audit rows (an operator test send, a delivery) that look like facts by time.
    fake.seed("AuditLog", { action: "COMMS_TEST_SEND", userId: "u1", createdAt: new Date(T0.getTime() + MIN), metadata: { targetUserId: "u1" } });
    fake.seed("AuditLog", { action: "COMMS_AUTOMATION_ACTIVATED", userId: "u1", createdAt: new Date(T0.getTime() + MIN), metadata: { targetUserId: "u1" } });
    clock = new Date(T0.getTime() + 5 * MIN);
    for (let i = 0; i < 3; i++) await run();
    check("re-running after its own sends + comms audit rows: still exactly one run, no cascade", fake.rows("AutomationRun", { automationId: id }).length === 1 && bells().length === 1 && sent.length === 1);
    let threw = false;
    try { F.assertNotCommsAction({ "space.member.joined": { action: "COMMS_TEST_SEND", subjectField: "userId" } } as any); } catch { threw = true; }
    let threw2 = false;
    try { F.assertNotCommsAction({ "space.member.joined": { action: "NOTIFICATION_SENT", subjectField: "userId" } } as any); } catch { threw2 = true; }
    check("a fact source on a comms / notification action is REFUSED at module load", threw && threw2);
    check("every fact source is a domain action (no COMMS_ / NOTIFICATION / EMAIL_ prefix), and the trigger catalog has no comms trigger",
      Object.values(F.FACT_SOURCES).every((s) => !/^(COMMS_|NOTIFICATION|EMAIL_)/.test(s!.action)));
    check("a fact's payload carries catalog fields only — never the PII name in the audit metadata",
      JSON.stringify(F.toFact("space.member.role_changed", { id: "f", action: "MEMBER_ROLE_CHANGED", userId: "a", spaceId: "s", createdAt: T0, metadata: { targetUserId: "t", targetName: "Real Name", oldRole: "MEMBER", newRole: "ADMIN" } })).indexOf("Real Name") === -1);
  }

  // ── 8. No broadcast ───────────────────────────────────────────────────────
  console.log("8. no broadcast — over maxRecipientsPerRun the run HALTS and the automation auto-pauses");
  {
    reset();
    for (let i = 0; i < 4; i++) { user(`m${i}`); fake.seed("SpaceMember", { spaceId: "sp_9", userId: `m${i}`, role: "ADMIN", status: "ACTIVE" }); }
    const id = automation({ triggerKey: "space.member.joined", definitionKey: "SPACE_INVITE_ACCEPTED", recipient: { kind: "SPACE_ROLE", roles: ["OWNER", "ADMIN"] }, maxRecipientsPerRun: 3, dedupeKeyTemplate: "J:{recipientId}" });
    fake.seed("AuditLog", { action: "MEMBER_JOINED", userId: "m0", spaceId: "sp_9", createdAt: new Date(T0.getTime() - MIN), metadata: { userId: "m0", role: "MEMBER" } });
    const s = await run();
    const a = fake.one("AutomationDefinition", { id }) as any;
    check("4 Space admins > cap 3: run HALTED / STORM_BREAKER, automation PAUSED (STORM_BREAKER), zero items, zero sends",
      fake.rows("AutomationRun", { status: "HALTED", haltReason: "STORM_BREAKER" }).length === 1 && a.state === "PAUSED" && a.autoPausedReason === "STORM_BREAKER"
      && items().length === 0 && fake.rows("Notification").length === 0 && s.autoPaused === 1, s);
    check("the ceiling is 500 and the default 50 (v1.1 §6.7)", R.validateAutomationInput({ name: "x", recipient: { kind: "EVENT_SUBJECT_USER" }, maxRecipientsPerRun: 501 }, { def: DEF, trigger: "space.member.role_changed" }).ok === false
      && (R.validateAutomationInput({ name: "x", recipient: { kind: "EVENT_SUBJECT_USER" } }, { def: DEF, trigger: "space.member.role_changed" }) as any).value.maxRecipientsPerRun === 50);
    check("staff / inbox resolvers (the only fan-out kinds) are refused on write",
      !R.validateAutomationInput({ name: "x", recipient: { kind: "PLATFORM_AREA_STAFF", area: "PLATFORM_OPS", includeSystemAdmin: true } }, { def: DEF, trigger: "space.member.role_changed" }).ok
      && !R.validateAutomationInput({ name: "x", recipient: { kind: "OPERATOR_INBOX", env: "PLATFORM_ALERTS_EMAIL" } }, { def: DEF, trigger: "space.member.role_changed" }).ok);
    reset();
    // N1 — the breaker counts the engine's OWN SENT items (written inline), not the deferred ledger.
    const prior = fake.seed("AutomationRun", { automationId: "old", automationVersion: 1, mode: "LIVE", triggerKey: "space.member.role_changed", status: "SUCCEEDED", counts: {} });
    for (let i = 0; i < 201; i++) fake.seed("AutomationRunItem", { runId: prior.id, automationId: "old", automationVersion: 1, channel: "IN_APP", recipientUserId: `r${i}`, idempotencyKey: `k${i}`, status: "SENT", lastDeliveryStatus: "ACCEPTED", notBefore: T0, attempt: 1, updatedAt: new Date(T0.getTime() - 30 * MIN) });
    const a1 = automation(); const a2 = automation();
    const s2 = await run();
    check("the GLOBAL breaker (> 200 accepted automation sends / 60 min) auto-pauses EVERY automation (STORM_BREAKER)",
      [a1, a2].every((x) => (fake.one("AutomationDefinition", { id: x }) as any).state === "PAUSED" && (fake.one("AutomationDefinition", { id: x }) as any).autoPausedReason === "STORM_BREAKER") && s2.autoPaused === 2, s2);
  }

  // ── 9. Bounded + resumable ────────────────────────────────────────────────
  console.log("9. bounded + resumable");
  {
    reset(); for (const u of ["b1", "b2", "b3"]) { user(u); }
    automation();
    for (const [i, u] of ["b1", "b2", "b3"].entries()) roleChanged(u, new Date(T0.getTime() - (10 - i) * MIN));
    const s1 = await run(deps(), { ...BUDGET, maxFactsPerAutomation: 2, maxItems: 1 });
    check("budget (2 facts, 1 delivery): 2 facts ingested, 1 sent, deferred > 0, PARTIAL", s1.facts === 2 && s1.sent === 1 && s1.deferred > 0 && s1.outcome === "PARTIAL", s1);
    const s2 = await run(deps(), { ...BUDGET, maxFactsPerAutomation: 2, maxItems: 1 });
    const s3 = await run(deps(), { ...BUDGET, maxFactsPerAutomation: 2, maxItems: 1 });
    await run();
    check("…resumed from the cursor over later passes: all three sent exactly once", bells().length === 3 && new Set(bells().map((b: any) => b.userId)).size === 3 && s2.facts + s3.facts === 1, { s2, s3 });
  }
  {
    reset(); user("u1"); automation(); roleChanged("u1", new Date(T0.getTime() - 5 * MIN));
    const d = deps();
    await quiet(() => E.runAutomationEngine({ ...d, createNotification: async () => { throw new Error("crash mid-send"); } }, BUDGET)).catch(() => undefined);
    const it = items()[0] as any;
    check("a crash mid-send leaves the item SENDING under a lease", it.status === "SENDING" && it.leaseUntil !== null);
    await run();
    check("before the lease expires a second pass does NOT send it", (items()[0] as any).status === "SENDING" && bells().length === 0);
    clock = new Date(T0.getTime() + 6 * MIN);
    await run();
    check("after the lease expires it returns to SCHEDULED and is sent ONCE", (items()[0] as any).status === "SENT" && bells().length === 1);
  }
  {
    reset(); user("u1"); emailOn("u1"); automation({ channels: ["EMAIL"] }); roleChanged("u1", new Date(T0.getTime() - 5 * MIN));
    providerAnswer = () => ({ status: "error", provider: "resend", error: "provider 500" });
    await run();
    const a1 = items()[0] as any;
    check("STANDARD retry: attempt 1 fails ⇒ FAILED, next attempt at +15 min", a1.status === "FAILED" && a1.attempt === 1 && new Date(a1.nextAttemptAt).getTime() === T0.getTime() + 15 * MIN);
    clock = new Date(T0.getTime() + 16 * MIN); await run();
    const a2 = items()[0] as any;
    check("attempt 2 fails ⇒ FAILED, next at +4 h", a2.status === "FAILED" && a2.attempt === 2 && new Date(a2.nextAttemptAt).getTime() === clock.getTime() + 240 * MIN);
    clock = new Date(clock.getTime() + 241 * MIN); await run();
    const a3 = items()[0] as any;
    check("attempt 3 fails ⇒ DEAD (terminal), the ledger row for it is DEAD", a3.status === "DEAD" && a3.attempt === 3 && ledgerRows({ status: "DEAD", messageKey: a3.id, attempt: 3 }).length === 1);
    clock = new Date(clock.getTime() + 600 * MIN); await run();
    check("a DEAD item is never attempted again", sent.length === 3);
  }
  {
    reset(); user("u1");
    const id = automation({ definitionVersion: AUTO_DEF_VERSION + 1 });
    roleChanged("u1", new Date(T0.getTime() - MIN));
    await run();
    check("a definition whose code version moved auto-pauses the automation (DEFINITION_CHANGED), nothing sent",
      (fake.one("AutomationDefinition", { id }) as any).autoPausedReason === "DEFINITION_CHANGED" && bells().length === 0);
    reset(); user("u1");
    const id2 = automation({ triggerKey: "plaid.item.sync_failed", definitionKey: "SYNC_FAILED" });
    await run();
    check("an automation whose trigger has no engine fact source auto-pauses (TRIGGER_RETIRED) rather than idling as ACTIVE",
      (fake.one("AutomationDefinition", { id: id2 }) as any).autoPausedReason === "TRIGGER_RETIRED");
  }

  // ── 10. The executor job + wake ───────────────────────────────────────────
  console.log("10. the executor: the job runner's SKIPPED semantics; the wake is quiet when idle");
  {
    reset(); user("u1"); automation(); roleChanged("u1", new Date(T0.getTime() - MIN));
    freeze = judgeGlobalCostFreeze("true");
    const r = await quiet(() => commsAutomations(deps()));
    check("under the global freeze the job summary is { outcome: SKIPPED, skipReason: BILLABLE_COST_FREEZE } and nothing was sent",
      r.outcome === "SKIPPED" && r.skipReason === "BILLABLE_COST_FREEZE" && bells().length === 0, r);
    check("…which job health reads as a skip (skippedOutcomeOf), not a success", skippedOutcomeOf(r) === "BILLABLE_COST_FREEZE");
    freeze = judgeGlobalCostFreeze(null);
    const ok = await quiet(() => commsAutomations(deps()));
    check("unfrozen: COMPLETE and sent", ok.outcome === "COMPLETE" && bells().length === 1);
  }
  {
    const facts = SCHEDULED_JOB_FACTS.find((j) => j.name === "comms-automations");
    check("A7 — comms-automations is a REGISTERED job (SCHEDULED_JOBS, hourly anchor, self-continuing) with a body",
      !!facts && facts.selfContinues === true && SCHEDULED_JOBS.some((j) => j.name === "comms-automations" && typeof j.run === "function"));
    const skipped = classifyJobHealth(facts as any, [{ startedAt: T0, status: "succeeded", completedAt: T0, summary: { outcome: "SKIPPED", skipReason: "BILLABLE_COST_FREEZE" } }], T0);
    check("job health classifies a SKIPPED comms-automations run as `skipped`…", skipped.status === "skipped", skipped.status);
    check("…and the ops overview shows the jobs domain DEGRADED", deriveJobs({ healthy: 0, running: 0, overdue: 0, failing: 0, dead: 0, neverRan: 0, skipped: 1 }, null, T0).state === "DEGRADED");
    check("the activation-hold skip has its own label (not \"plan restriction\")", skipLabel(T.ACTIVATION_DISABLED_REASON) === "Skipped (activation disabled)");
    const due = decideJobDue(facts as any, { hours: 1 }, { lastStartedAt: T0, lastStatus: "succeeded", lastSummary: { outcome: "COMPLETE", deferred: 1 } } as any, new Date(T0.getTime() + CONTINUATION_DELAY_MS));
    check("a pass that reports deferred > 0 is due again ~15 min later (self-continuation)", due.due === true, due);
  }
  {
    reset(); user("u1"); automation(); roleChanged("u1", new Date(T0.getTime() - MIN));
    const r = await quiet(() => commsAutomations(deps(), { budgetStartedAtMs: T0.getTime() }));
    check("the job's budget is min(120 s, 270 s − elapsed): a fresh wake grants 120 s", r.budgetMs === 120_000, r.budgetMs);
    check("with an ACTIVE automation the job reports deferred > 0 (keeps the 15-min cadence)", r.deferred > 0 && bells().length === 1, r);
    const late = await quiet(() => commsAutomations(deps(), { budgetStartedAtMs: T0.getTime() - 200_000 }));
    check("after 200 s of other jobs the budget is 70 s", late.budgetMs === 70_000, late.budgetMs);
    const before = fake.rows("AutomationRun").length;
    const none = await quiet(() => commsAutomations(deps(), { budgetStartedAtMs: T0.getTime() - 265_000 }));
    check("under 10 s left ⇒ nothing done, deferred (no run, no item)", none.deferred === 1 && none.sent === 0 && fake.rows("AutomationRun").length === before, none);
    reset();
    const idle = await quiet(() => commsAutomations(deps(), { budgetStartedAtMs: T0.getTime() }));
    check("idle (nothing ACTIVE, nothing pending) ⇒ COMPLETE, deferred 0 (hourly), nothing written", idle.outcome === "COMPLETE" && idle.deferred === 0 && fake.rows("AutomationRun").length === 0, idle);
  }

  // ── 11. The ACTIVATION HARD GATE blocks the engine ────────────────────────
  console.log("11. the activation gate (closed: not Preview, or the switch off) blocks the ENGINE");
  {
    check("the gate is the env resolver (Preview + exact \"true\"); Production is closed even with the flag; no PlatformSetting reaches it",
      T.automationActivationEnabled({ VERCEL_ENV: "production", COMMS_AUTOMATIONS_PREVIEW_ENABLED: "true" }) === false
    && T.automationActivationEnabled({ VERCEL_ENV: "preview", COMMS_AUTOMATIONS_PREVIEW_ENABLED: "true" }) === true
    && !/AUTOMATION_ACTIVATION_ENABLED/.test(readFileSync("lib/notifications/automations/types.ts", "utf8"))
      && !/PlatformSetting|platformSetting/.test(readFileSync("lib/notifications/automations/types.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "")));
    reset(); user("u1"); user("u2");
    automation({ delayMinutes: 10 });
    roleChanged("u1", new Date(T0.getTime() - 5 * MIN));
    await run(); // ingested while the gate was open in this test world: one SCHEDULED item
    roleChanged("u2", new Date(T0.getTime() - 4 * MIN));
    clock = new Date(T0.getTime() + 30 * MIN);
    const snapshot = () => JSON.stringify(["AutomationDefinition", "AutomationRun", "AutomationRunItem", "CommsDelivery", "Notification"].map((m) => fake.rows(m)));
    const before = snapshot();
    // No activationEnabled port ⇒ the resolver over process.env (VERCEL_ENV / the flag unset in tests) ⇒ closed.
    const { activationEnabled: _open, ...closed } = deps();
    void _open;
    const s = await quiet(() => E.runAutomationEngine(closed, BUDGET));
    check("an ACTIVE row exists anyway ⇒ SKIPPED / ACTIVATION_DISABLED_PENDING_HARDENING, ZERO writes (no run, item, ledger or bell change) and ZERO sends",
      s.outcome === "SKIPPED" && s.skipReason === T.ACTIVATION_DISABLED_REASON && snapshot() === before && sent.length === 0 && bells().length === 0, s);
    const job = await quiet(() => commsAutomations(closed, { budgetStartedAtMs: clock.getTime() }));
    check("…the job reports the same skip (job health: skipped), with no self-continuation", job.outcome === "SKIPPED" && job.skipReason === T.ACTIVATION_DISABLED_REASON && job.deferred === 0 && snapshot() === before);
    reset();
    const idle = await quiet(() => E.runAutomationEngine(closed, BUDGET));
    check("gate closed and nothing ACTIVE ⇒ COMPLETE (no skip noise), but the summary SAYS the engine is off (note ACTIVATION_DISABLED)",
      idle.outcome === "COMPLETE" && idle.skipReason === undefined && idle.note === "ACTIVATION_DISABLED", idle);
  }

  console.log(failures === 0 ? "\n✅ comms automations engine: all checks passed" : `\n❌ ${failures} check(s) failed`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
