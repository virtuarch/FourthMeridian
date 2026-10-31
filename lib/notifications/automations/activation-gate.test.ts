/**
 * lib/notifications/automations/activation-gate.test.ts  (Comms Center B2 — PREVIEW-ONLY ACTIVATION, owner approval 2026-11-01)
 *
 * The activation gate is `automationActivationEnabled(env)` (types.ts): open ONLY when
 * VERCEL_ENV === "preview" AND COMMS_AUTOMATIONS_PREVIEW_ENABLED === "true", read per call.
 * The REAL engine over the in-memory Prisma fake, the REAL email chokepoint (createEmailSender
 * with the real recipient guard) over a fake provider — no database, no network, no real send.
 *
 *   G1  the truth table (fail closed on every near miss); Production closed even with the flag
 *   G2  one source: the flag is read only by the resolver; every production call site passes process.env
 *   G3  the kill switch mid-pass: closed before the NEXT send (loop check) and between lease and transport
 *   G4  defence in depth: in Preview with the gate open, a non-allowlisted recipient is CAPTURED (the
 *       provider is never called), an allowlisted one is sent; no automation field can widen the list
 *   G5  with the gate OPEN, the other controls still gate: owner approval / dry run at activation,
 *       the Cost Freeze, admission
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/notifications/automations/activation-gate.test.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- assertions read loosely-typed fake rows */

import "@/lib/test-support/route-env";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import type { EmailMessage, EmailProvider } from "@/lib/email/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}
const quiet = async <T,>(f: () => Promise<T>): Promise<T> => {
  const { log, warn, info, error } = console; console.log = () => {}; console.warn = () => {}; console.info = () => {}; console.error = () => {};
  try { return await f(); } finally { console.log = log; console.warn = warn; console.info = info; console.error = error; }
};
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
function sources(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n.startsWith(".")) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n)) out.push(p);
  }
  return out;
}

const fake = new FakePrisma();
const T0 = new Date("2026-11-01T12:00:00.000Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

async function main(): Promise<void> {
  await installFakePrisma(fake);
  const { systemDb } = await import("@/lib/db");
  const E = await import("./engine");
  const T = await import("./types");
  const R = await import("./rules");
  const S = await import("./store");
  const { createNotification } = await import("@/lib/notifications/create");
  const { createEmailSender } = await import("@/lib/email/send");
  const { PendingSends } = await import("@/lib/notifications/delivery/storm");
  const { judgeGlobalCostFreeze } = await import("@/lib/platform/cost-freeze.core");
  const { getCatalogDefinition } = await import("@/lib/notifications/catalog/definitions");
  const db = systemDb as any;
  const DEF = getCatalogDefinition("MEMBER_ROLE_CHANGED")!;
  const gateOf = T.automationActivationEnabled;

  // ── G1 ───────────────────────────────────────────────────────────────────
  console.log("G1. the truth table — open ONLY on Preview with the exact flag");
  const table: Array<[string | undefined, string | undefined, boolean]> = [
    ["preview", "true", true],
    ["preview", undefined, false], ["preview", "", false], ["preview", "false", false],
    ["preview", "TRUE", false], ["preview", "True", false], ["preview", "1", false], ["preview", "yes", false],
    ["preview", " true", false], ["preview", "true ", false],
    ["production", "true", false], ["production", undefined, false],
    ["development", "true", false], [undefined, "true", false], ["", "true", false],
    ["Preview", "true", false], ["PREVIEW", "true", false], [" preview", "true", false], ["staging", "true", false],
  ];
  for (const [v, f, want] of table) {
    const env: Record<string, string> = {};
    if (v !== undefined) env.VERCEL_ENV = v;
    if (f !== undefined) env.COMMS_AUTOMATIONS_PREVIEW_ENABLED = f;
    check(`VERCEL_ENV=${JSON.stringify(v)} flag=${JSON.stringify(f)} ⇒ ${want}`, gateOf(env) === want);
  }
  check("Production is closed whatever else the environment says (flag set, VERCEL=1, NODE_ENV=production, extra keys)",
    gateOf({ VERCEL_ENV: "production", COMMS_AUTOMATIONS_PREVIEW_ENABLED: "true", VERCEL: "1", NODE_ENV: "production", COMMS_AUTOMATIONS_PRODUCTION_ENABLED: "true" } as any) === false);
  check("an empty environment is closed", gateOf({}) === false);

  // ── G2 ───────────────────────────────────────────────────────────────────
  console.log("G2. one source");
  {
    const types = strip(readFileSync("lib/notifications/automations/types.ts", "utf8"));
    const body = /export function automationActivationEnabled\(env: AutomationActivationEnv\): boolean \{([\s\S]*?)\n\}/.exec(types)?.[1]?.trim();
    check("the resolver body is exactly the two exact-string comparisons", body === 'return env.VERCEL_ENV === "preview" && env.COMMS_AUTOMATIONS_PREVIEW_ENABLED === "true";', body);
    const files = [...sources("lib"), ...sources("app"), ...sources("jobs"), ...sources("components")];
    const readers = files.filter((f) => /COMMS_AUTOMATIONS_PREVIEW_ENABLED/.test(strip(readFileSync(f, "utf8"))));
    check("the flag is read ONLY by the resolver (types.ts) — no second path to true", readers.join() === "lib/notifications/automations/types.ts", readers);
    const old = files.filter((f) => /AUTOMATION_ACTIVATION_ENABLED/.test(readFileSync(f, "utf8")));
    check("no source still names the old constant AUTOMATION_ACTIVATION_ENABLED", old.length === 0, old);
    const calls = files.flatMap((f) => [...strip(readFileSync(f, "utf8")).matchAll(/automationActivationEnabled\(([^)]*)\)/g)].map((m) => `${f}:${m[1]}`))
      .filter((c) => !c.startsWith("lib/notifications/automations/types.ts:env: AutomationActivationEnv"));
    check("every production call site passes process.env (read per call)", calls.length >= 5 && calls.every((c) => c.endsWith(":process.env")), calls);
    const hard = files.filter((f) => /activationEnabled\s*(:|=|\?\?)\s*(true|\(\)\s*=>\s*true)\b/.test(strip(readFileSync(f, "utf8"))));
    check("no production source wires a hard true into an activationEnabled port", hard.length === 0, hard);
    for (const [f, re] of [
      ["lib/notifications/automations/deps.ts", /activationEnabled: \(\) => automationActivationEnabled\(process\.env\)/],
      ["lib/notifications/automations/engine-deps.ts", /activationEnabled: \(\) => automationActivationEnabled\(process\.env\)/],
      ["lib/notifications/automations/http.ts", /const gate = kind === "ACTIVATE" \? svc\.activationEnabled\(\) : true;\s*if \(!gate\)/],
      ["lib/notifications/automations/store.ts", /input\.activationEnabled === false \|\| !automationActivationEnabled\(process\.env\)/],
      ["lib/notifications/content/http.ts", /activationEnabled: boolean = automationActivationEnabled\(process\.env\)/],
    ] as const) check(`${f} reads the resolver`, re.test(strip(readFileSync(f, "utf8"))));
    const http = strip(readFileSync("lib/notifications/automations/http.ts", "utf8"));
    check("the route decides the gate BEFORE reading the automation (409 before any read)",
      http.indexOf('svc.activationEnabled()') < http.indexOf("const row = await svc.store.readAutomation(id);", http.indexOf("export async function transitionHandler")));
  }
  {
    // The store refuses on its own even when a caller claims the gate is open (defence in depth).
    const saved = { v: process.env.VERCEL_ENV, f: process.env.COMMS_AUTOMATIONS_PREVIEW_ENABLED };
    delete process.env.VERCEL_ENV; delete process.env.COMMS_AUTOMATIONS_PREVIEW_ENABLED;
    const r = await S.activate({ id: "x", expectedVersion: 1, actor: { userId: "op", via: "PLATFORM_GRANT" }, reason: { code: "DOGFOOD" } as any, now: T0, activationEnabled: true }, db);
    check("store.activate with activationEnabled: true but the env closed ⇒ refused ACTIVATION_DISABLED_PENDING_HARDENING", !r.ok && (r as any).code === T.ACTIVATION_DISABLED_REASON, r);
    if (saved.v !== undefined) process.env.VERCEL_ENV = saved.v;
    if (saved.f !== undefined) process.env.COMMS_AUTOMATIONS_PREVIEW_ENABLED = saved.f;
  }

  // ── The world (engine) ─────────────────────────────────────────────────────
  let clock = T0;
  const ledger = async (row: any) => { await db.commsDelivery.createMany({ data: [{ ...row, createdAt: clock }] }); };
  const calls: EmailMessage[] = [];
  const provider: EmailProvider = { name: "resend", send: async (m) => { calls.push(m); return { status: "sent", id: `re_${calls.length}`, provider: "resend" }; } };
  const capture: EmailProvider = { name: "capture", send: async (m) => ({ status: "captured", provider: "capture", id: m.to }) };
  /** The REAL chokepoint on Vercel Preview: the recipient guard admits only EMAIL_NONPROD_ALLOWLIST. */
  const previewEnv = { VERCEL: "1", VERCEL_ENV: "preview", RESEND_API_KEY: "re_test_not_real", NODE_ENV: "production", EMAIL_NONPROD_ALLOWLIST: "allowed@example.invalid" };
  const previewSend = createEmailSender({ env: previewEnv as any, provider, capture, ledger, pending: new PendingSends(), now: () => clock, log: () => {} });
  let open = true;
  let freeze = judgeGlobalCostFreeze(null);
  let admitted = true;
  const deps = (over: Record<string, unknown> = {}): any => ({
    db,
    freeze: async () => freeze,
    lifecycle: async (ids: readonly string[]) => new Map(ids.map((id) => [id, "ACTIVE"])),
    sendEmail: previewSend,
    createNotification: (input: any, ctx: any) => createNotification(input, ctx),
    ledger,
    content: null,
    env: { VERCEL: "1", VERCEL_ENV: "preview" },
    appBaseUrl: "https://preview-app.test.invalid",
    now: () => clock,
    admission: async () => ({ admitted, reason: admitted ? null : "MAINTENANCE_MODE" }),
    // Production-shaped: a FUNCTION, re-read by the engine (here a variable instead of process.env).
    activationEnabled: () => open,
    log: () => {},
    ...over,
  });
  const BUDGET = { maxAutomations: 50, maxFactsPerAutomation: 100, maxItems: 200, timeBudgetMs: 60_000 };
  const run = (d = deps()) => quiet(() => E.runAutomationEngine(d, BUDGET));
  const ACTOR = "u_actor";
  const user = (id: string, email = `${id}@example.invalid`) =>
    fake.seed("User", { id, email, username: id, emailVerifiedAt: T0, createdAt: new Date(T0.getTime() - 100 * DAY) });
  function reset(): void {
    fake.reset(); clock = T0; calls.length = 0; open = true; freeze = judgeGlobalCostFreeze(null); admitted = true;
    user(ACTOR);
  }
  function automation(extra: Record<string, unknown> = {}): string {
    return fake.seed("AutomationDefinition", {
      name: "a", triggerKey: "space.member.role_changed", definitionKey: "MEMBER_ROLE_CHANGED", definitionVersion: DEF.definitionVersion,
      customerFacing: true, channels: ["IN_APP"], conditions: [], recipient: { kind: "EVENT_SUBJECT_USER" },
      dedupeKeyTemplate: "K:{spaceId}:{recipientId}", frequencyCapMax: 10, frequencyCapHours: 1,
      retryPolicy: "STANDARD", maxRecipientsPerRun: 50, state: "ACTIVE", version: 2, activatedVersion: 1,
      activatedAt: new Date(T0.getTime() - 60 * MIN), triggerCursorAt: new Date(T0.getTime() - 60 * MIN), triggerCursorId: null,
      createdById: "op", updatedById: "op", ...extra,
    }).id as string;
  }
  let factN = 0;
  function roleChanged(target: string, at: Date, spaceId = "sp_1"): void {
    if (!fake.one("Space", { id: spaceId })) fake.seed("Space", { id: spaceId, name: `Space ${spaceId}` });
    if (!fake.one("SpaceMember", { spaceId, userId: target })) fake.seed("SpaceMember", { spaceId, userId: target, role: "ADMIN", status: "ACTIVE" });
    fake.seed("AuditLog", { id: `fact_${++factN}`, action: "MEMBER_ROLE_CHANGED", userId: ACTOR, spaceId, createdAt: at, metadata: { targetUserId: target, oldRole: "MEMBER", newRole: "ADMIN" } });
  }
  const emailOn = (id: string) => fake.seed("NotificationPreference", { userId: id, category: "SPACES", channel: "EMAIL", enabled: true });
  const items = (where: Record<string, unknown> = {}) => fake.rows("AutomationRunItem", where) as any[];
  const bells = () => fake.rows("Notification", { type: "MEMBER_ROLE_CHANGED" }) as any[];

  // ── G3 ───────────────────────────────────────────────────────────────────
  console.log("G3. the kill switch stops a pass before its NEXT send");
  {
    reset(); user("u1"); user("u2"); automation();
    roleChanged("u1", new Date(T0.getTime() - 5 * MIN)); roleChanged("u2", new Date(T0.getTime() - 4 * MIN));
    // The switch is unset right after the FIRST bell is created (mid-pass). Leases are counted: the loop's
    // own check must stop the second item BEFORE it is leased (not only the last check before the transport).
    let leases = 0;
    const counting = new Proxy(db, { get(t: any, p: string | symbol) {
      const v = t[p];
      if (p !== "automationRunItem") return v;
      return new Proxy(v, { get(d: any, q: string | symbol) {
        const f = d[q];
        if (q === "updateMany") return async (args: any) => { if (args?.data?.status === "SENDING") leases++; return f.call(d, args); };
        return typeof f === "function" ? f.bind(d) : f;
      } });
    } });
    const s = await run(deps({ db: counting, createNotification: async (input: any, ctx: any) => { const r = await createNotification(input, ctx); open = false; return r; } }));
    const held = items().find((i) => i.status !== "SENT");
    check("two items due, the switch is unset after the first send ⇒ ONE bell; the second is NOT leased (SCHEDULED, attempt 0); the pass is SKIPPED / ACTIVATION_DISABLED_PENDING_HARDENING",
      bells().length === 1 && items({ status: "SENT" }).length === 1 && held?.status === "SCHEDULED" && held?.attempt === 0 && leases === 1
      && s.outcome === "SKIPPED" && s.skipReason === T.ACTIVATION_DISABLED_REASON, { s, leases, items: items().map((i) => [i.status, i.attempt]) });
    open = true; clock = new Date(T0.getTime() + 2 * MIN);
    await run();
    check("…switched back on, the held item is delivered on the next pass (nothing was lost or cancelled)", bells().length === 2 && items({ status: "SENT" }).length === 2);
  }
  {
    reset(); user("u1"); automation(); roleChanged("u1", new Date(T0.getTime() - 5 * MIN));
    // The switch is unset at the moment the item is LEASED (after the loop's check): the last check before the transport holds it.
    const proxied = new Proxy(db, { get(t: any, p: string | symbol) {
      const v = t[p];
      if (p !== "automationRunItem") return v;
      return new Proxy(v, { get(d: any, q: string | symbol) {
        const f = d[q];
        if (q === "updateMany") return async (args: any) => { const r = await f.call(d, args); if (args?.data?.status === "SENDING") open = false; return r; };
        return typeof f === "function" ? f.bind(d) : f;
      } });
    } });
    let transport = 0;
    const s = await run(deps({ db: proxied, createNotification: async (input: any, ctx: any) => { transport++; return createNotification(input, ctx); } }));
    const it = items()[0];
    check("unset between the lease and the transport ⇒ the transport is never called, the lease is given back exactly (SCHEDULED, attempt 0, no lease), SKIPPED",
      transport === 0 && bells().length === 0 && it?.status === "SCHEDULED" && it?.attempt === 0 && it?.leaseUntil === null && s.outcome === "SKIPPED", { transport, it: it && [it.status, it.attempt, it.leaseUntil], s });
  }
  {
    reset(); user("u1"); automation(); roleChanged("u1", new Date(T0.getTime() - 5 * MIN));
    open = false;
    const s = await run();
    check("closed at the start of the pass (an ACTIVE row exists) ⇒ SKIPPED, nothing claimed or sent", s.outcome === "SKIPPED" && items().length === 0 && bells().length === 0, s);
    const thrower = await run(deps({ activationEnabled: () => { throw new Error("env read failed"); } }));
    check("a gate port that THROWS is closed (fail closed)", thrower.outcome === "SKIPPED" && items().length === 0, thrower);
  }

  // ── G4 ───────────────────────────────────────────────────────────────────
  console.log("G4. defence in depth: the recipient guard still decides every automation email");
  {
    reset();
    user("u_ok", "allowed@example.invalid"); user("u_no", "someone@example.invalid"); emailOn("u_ok"); emailOn("u_no");
    automation({ channels: ["EMAIL"] });
    roleChanged("u_ok", new Date(T0.getTime() - 5 * MIN)); roleChanged("u_no", new Date(T0.getTime() - 4 * MIN));
    await run();
    const ok = items({ recipientUserId: "u_ok" })[0];
    const no = items({ recipientUserId: "u_no" })[0];
    const okRow = fake.rows("CommsDelivery", { automationRunItemId: ok?.id }) as any[];
    const noRow = fake.rows("CommsDelivery", { automationRunItemId: no?.id }) as any[];
    check("Preview, gate OPEN: the allowlisted recipient reaches the provider ONCE (ledger ACCEPTED, item SENT / ACCEPTED)",
      calls.length === 1 && calls[0].to === "allowed@example.invalid" && ok?.status === "SENT" && ok?.lastDeliveryStatus === "ACCEPTED" && okRow.some((r) => r.status === "ACCEPTED"),
      { calls: calls.map((c) => c.to), ok: ok && [ok.status, ok.lastDeliveryStatus], okRow: okRow.map((r) => r.status) });
    check("…the NON-allowlisted recipient is CAPTURED by the guard (ENVIRONMENT_GUARD): the provider is never called for them",
      !calls.some((c) => c.to === "someone@example.invalid") && no?.lastDeliveryStatus === "CAPTURED" && noRow.some((r) => r.status === "CAPTURED" && r.reason === "ENVIRONMENT_GUARD"),
      { no: no && [no.status, no.lastDeliveryStatus], noRow: noRow.map((r) => [r.status, r.reason]) });
  }
  {
    const base = { name: "x", recipient: { kind: "EVENT_SUBJECT_USER" } };
    const widen = ["to", "addresses", "recipients", "allowlist", "emailAllowlist", "EMAIL_NONPROD_ALLOWLIST", "cc", "bcc", "replyTo", "recipientEmail"];
    const refused = widen.filter((k) => !R.validateAutomationInput({ ...base, [k]: ["someone@example.invalid"] }, { def: DEF, trigger: "space.member.role_changed" }).ok);
    check("no automation field can name or widen a recipient address (every such field is refused at write)", refused.length === widen.length, widen.filter((k) => !refused.includes(k)));
    const byEmail = R.validateAutomationInput({ ...base, recipient: { kind: "EMAIL_ADDRESS", email: "someone@example.invalid" } }, { def: DEF, trigger: "space.member.role_changed" });
    check("…nor a recipient resolver by address", !byEmail.ok, byEmail);
    const eng = strip(readFileSync("lib/notifications/automations/engine.ts", "utf8"));
    check("the engine's ONLY email path is deps.sendEmail to the account's own address, with no allowlist / guard knob",
      (eng.match(/deps\.sendEmail\(/g) ?? []).length === 1 && /deps\.sendEmail\("notification", email, /.test(eng) && /const email = users\.get\(item\.recipientUserId\)\?\.email \?\? null;/.test(eng)
      && !/EMAIL_NONPROD_ALLOWLIST|decideRecipient|provider\.send|resendAdapter/.test(eng));
    const send = strip(readFileSync("lib/email/send.ts", "utf8"));
    check("…and the chokepoint applies the guard before ANY real provider call (no automation exemption)",
      /const decision = decideRecipient\(to, env\);\s*if \(!decision\.deliver\)/.test(send) && !/automationRunItemId[^\n]*decideRecipient|idempotencyKey[^\n]*deliver/.test(send));
  }

  // ── G5 ───────────────────────────────────────────────────────────────────
  console.log("G5. with the gate OPEN, every other control still gates");
  {
    reset(); user("u1"); automation(); roleChanged("u1", new Date(T0.getTime() - 5 * MIN));
    freeze = judgeGlobalCostFreeze("true");
    const s = await run();
    check("Cost Freeze ON ⇒ SKIPPED / BILLABLE_*, nothing sent (fail closed)", s.outcome === "SKIPPED" && /^BILLABLE_/.test(s.skipReason ?? "") && bells().length === 0, s);
    freeze = judgeGlobalCostFreeze(null); admitted = false;
    const a = await run();
    check("admission denied (maintenance) ⇒ SKIPPED / ADMISSION_*, nothing sent", a.outcome === "SKIPPED" && /^ADMISSION_/.test(a.skipReason ?? "") && bells().length === 0, a);
  }
  {
    reset();
    const saved = { v: process.env.VERCEL_ENV, f: process.env.COMMS_AUTOMATIONS_PREVIEW_ENABLED };
    process.env.VERCEL_ENV = "preview"; process.env.COMMS_AUTOMATIONS_PREVIEW_ENABLED = "true";
    try {
      const id = automation({ state: "DRAFT", version: 1, activatedVersion: null, ownerApprovedVersion: null, ownerApprovedDefinitionVersion: null, lastDryRunId: null });
      const actor = { userId: "op_control", via: "PLATFORM_GRANT" as const };
      const r = await S.activate({ id, expectedVersion: 1, actor, reason: { code: "DOGFOOD" } as any, now: T0 }, db);
      check("gate OPEN (Preview + flag) but no owner approval ⇒ refused OWNER_APPROVAL_REQUIRED (DRY_RUN_REQUIRED among the blockers), still DRAFT, no activation audit",
        !r.ok && (r as any).code === "OWNER_APPROVAL_REQUIRED" && (r as any).blockers?.includes("DRY_RUN_REQUIRED") && fake.one("AutomationDefinition", { id })!.state === "DRAFT"
        && fake.rows("AuditLog", { action: "COMMS_AUTOMATION_ACTIVATED" }).length === 0, r);
      fake.one("AutomationDefinition", { id })!.ownerApprovedVersion = 1;
      fake.one("AutomationDefinition", { id })!.ownerApprovedDefinitionVersion = DEF.definitionVersion;
      const r2 = await S.activate({ id, expectedVersion: 1, actor, reason: { code: "DOGFOOD" } as any, now: T0 }, db);
      check("…approved but never dry-run ⇒ DRY_RUN_REQUIRED", !r2.ok && (r2 as any).code === "DRY_RUN_REQUIRED", r2);
      const r3 = await S.activate({ id, expectedVersion: 7, actor, reason: { code: "DOGFOOD" } as any, now: T0 }, db);
      check("…a stale version ⇒ CONFLICT (approval and activation are bound to the exact version)", !r3.ok && (r3 as any).code === "CONFLICT", r3);
    } finally {
      if (saved.v === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = saved.v;
      if (saved.f === undefined) delete process.env.COMMS_AUTOMATIONS_PREVIEW_ENABLED; else process.env.COMMS_AUTOMATIONS_PREVIEW_ENABLED = saved.f;
    }
  }

  console.log(failures === 0 ? "\n✅ comms automations activation gate (Preview only): all checks passed" : `\n❌ ${failures} check(s) failed`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
