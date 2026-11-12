/**
 * lib/platform/ai/platform-ai-caps-admin.test.ts  (PLATFORM AI CAPS D5 PR4 — the SA-only write path)
 *
 * The service (lib/platform/ai/platform-ai-caps-admin.ts) and the REAL route
 * (app/api/admin/platform-ai-caps) against the in-memory Prisma fake. S2 09fa-4 + 09fb:
 *   1. distinct actions — a body naming another action's field is refused, nothing written;
 *   2. authority — a non-SA actor is refused FORBIDDEN + recordControlRefusal, no write,
 *      no success audit; through the route a grant holder gets 403;
 *   3. reason required on every write;
 *   4. SET_BLANKET — the descriptor max (20 / 100) refused at write (R4); clear = RESET;
 *      lowering the platform cap below overrides is ALLOWED with the COUNT (Q2);
 *   5. SET_OVERRIDE — target eligibility (C3); PLATFORM_CAP_NOT_SET / PLATFORM_CAP_INVALID (09fu Q3);
 *      expectedUpdatedAt required, stale ⇒ CONFLICT (09fu Q6); above the EFFECTIVE
 *      platform cap refused (Q2); 0..20 integers only; selfEdit iff actor == target (09fa);
 *      the audit detail shape with the PRIV-ref (C4); concurrency;
 *   6. RESET_OVERRIDE — deletes + audits; NOT_FOUND when there is nothing to reset;
 *   7. the GET read model — operators = SAs + ACTIVE grant holders, override + effective +
 *      fits-N-turns, INVALID override row ⇒ CAP_INVALID, no email;
 *   8. registration + static pins (audit lists, feed, widget label, classification, route).
 * The reservation side (override read, CAP_INVALID, 0, read error, PLATFORM_AI_ENABLED first)
 * is lib/platform/ai/platform-ai-spend.test.ts §4c.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/ai/platform-ai-caps-admin.test.ts
 */

import "@/lib/test-support/route-env";
/* eslint-disable @typescript-eslint/no-explicit-any -- audit metadata / response JSON are read loosely in assertions */
import { readFileSync } from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { invoke, request, makeChecker, signIn, freshCache } from "@/lib/test-support/route-harness";

const fake = new FakePrisma();
const t = makeChecker("platform-ai-caps-admin.test — D5 PR4: per-operator override + SA-only cap writes");
const ROOT = process.cwd();
const strip = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

async function main() {
  await installFakePrisma(fake);
  const { applyPlatformAiCapsAction, loadPlatformAiCapsReadModel, ACTION_FIELDS } = await import("./platform-ai-caps-admin");
  const { platformAiReserveUsd, platformAiTurnsThatFit, PLATFORM_AI_OPERATOR_CAP_CEILING_USD } = await import("./platform-ai-spend.core");
  const { opaqueUserRef } = await import("@/lib/platform/opaque-user-ref");
  const { AuditAction, OPERATOR_ACTION_FEED_ACTIONS } = await import("@/lib/audit-actions");
  const { REASON_REQUIRED_ACTIONS, buildOperatorActionData, OperatorActionValidationError } = await import("@/lib/audit");
  const { PLATFORM_OPS_FEED_RULES, SECURITY_ONLY_ACTIONS } = await import("@/lib/platform/activity/operator-feed-core");
  const { projectOperatorActionEvent } = await import("@/lib/platform/security/operator-actions-core");
  const { MUTATION_FAMILIES } = await import("@/lib/platform/capability-classification");
  const { todayUTCISO } = await import("@/lib/time/clock");
  const { GET, POST } = await import("@/app/api/admin/platform-ai-caps/route");
  type ControlRefusal = import("@/lib/platform/control-refusal").ControlRefusal;

  const MODEL = "gpt-4o-mini";
  const NOW = new Date();
  const reserve = platformAiReserveUsd(MODEL, todayUTCISO(NOW))!;
  const reason = { code: "TESTING", note: "D5 PR4 test" };
  const PROD = { operatorRaw: undefined, platformRaw: undefined, vercelEnv: "production" };
  const ENV = { operatorRaw: "20", platformRaw: "100", vercelEnv: "production" };
  const K = { per_operator: "platform_ai_daily_usd_per_operator", platform: "platform_ai_daily_usd_platform" } as const;

  let hash = "";
  let refusals: ControlRefusal[] = [];
  const world = async () => {
    fake.reset(); freshCache(); refusals = [];
    hash ||= await bcrypt.hash("pw", 4);
    const sa = fake.seed("User", { email: "root@example.test", username: "root", name: "Root", passwordHash: hash, emailVerifiedAt: new Date(), role: "SYSTEM_ADMIN", totpEnabled: true, totpSecret: "x" });
    const sa2 = fake.seed("User", { email: "sa2@example.test", username: "sa2", passwordHash: hash, emailVerifiedAt: new Date(), role: "SYSTEM_ADMIN", totpEnabled: true, totpSecret: "x" });
    const op = fake.seed("User", { email: "op@example.test", username: "op", passwordHash: hash, emailVerifiedAt: new Date(), totpEnabled: true, totpSecret: "x" });
    const revoked = fake.seed("User", { email: "gone@example.test", username: "gone", passwordHash: hash, emailVerifiedAt: new Date() });
    const customer = fake.seed("User", { email: "cust@example.test", username: "cust", passwordHash: hash, emailVerifiedAt: new Date() });
    const deadSa = fake.seed("User", { email: "dead@example.test", username: "deadsa", passwordHash: hash, emailVerifiedAt: new Date(), role: "SYSTEM_ADMIN", deactivatedAt: new Date() });
    fake.seed("PlatformGrant", { userId: op.id, area: "PLATFORM_OPS", level: "READ", status: "ACTIVE", grantedById: sa.id });
    fake.seed("PlatformGrant", { userId: revoked.id, area: "PLATFORM_OPS", level: "READ", status: "REVOKED", grantedById: sa.id, revokedAt: new Date() });
    return { sa: sa.id as string, sa2: sa2.id as string, op: op.id as string, revoked: revoked.id as string, customer: customer.id as string, deadSa: deadSa.id as string };
  };
  const deps = (capInputs: typeof ENV | typeof PROD = ENV) => ({ capInputs, now: NOW, recordRefusal: async (r: ControlRefusal) => { refusals.push(r); } });
  const actorOf = (id: string, role = "SYSTEM_ADMIN") => ({ id, role, ipAddress: "203.0.113.1", userAgent: "test" });
  const caps = () => fake.rows("PlatformAiOperatorCap");
  const settings = () => fake.rows("PlatformSetting");
  const audits = (action?: string) => fake.rows("AuditLog").filter((a) => !action || a.action === action);
  const meta = (a: Record<string, unknown>) => a.metadata as Record<string, any>;
  const setPlatform = (actor: string, valueUsd: number | null, expectedUpdatedAt: string | null, capInputs = ENV) =>
    applyPlatformAiCapsAction({ action: "SET_BLANKET", key: "platform", valueUsd, reason, expectedUpdatedAt }, actorOf(actor), deps(capInputs));
  /** The override row's current version (what an editor observed), or null when there is no row. */
  const versionOf = (userId: string) => { const r = fake.one("PlatformAiOperatorCap", { userId }); return r ? (r.updatedAt as Date).toISOString() : null; };
  const setOverride = (actor: string, targetUserId: string, dailyUsd: unknown, capInputs: typeof ENV | typeof PROD = ENV, extra: Record<string, unknown> = {}) =>
    applyPlatformAiCapsAction({ action: "SET_OVERRIDE", targetUserId, dailyUsd, reason, expectedUpdatedAt: versionOf(targetUserId), ...extra }, actorOf(actor), deps(capInputs));
  const resetOverride = (actor: string, targetUserId: string, extra: Record<string, unknown> = {}) =>
    applyPlatformAiCapsAction({ action: "RESET_OVERRIDE", targetUserId, reason, expectedUpdatedAt: versionOf(targetUserId), ...extra }, actorOf(actor), deps());

  t.section("1. distinct actions (S2 09fa-3 / 09fb C1): one action per request, never blanket + override together");
  {
    const w = await world();
    const mixed1 = await applyPlatformAiCapsAction({ action: "SET_BLANKET", key: "platform", valueUsd: 50, expectedUpdatedAt: null, reason, targetUserId: w.op, dailyUsd: 5 }, actorOf(w.sa), deps());
    t.check("SET_BLANKET carrying targetUserId / dailyUsd ⇒ VALIDATION, nothing written, no audit",
      !mixed1.ok && mixed1.code === "VALIDATION" && settings().length === 0 && caps().length === 0 && audits().length === 0, mixed1);
    const mixed2 = await applyPlatformAiCapsAction({ action: "SET_OVERRIDE", targetUserId: w.op, dailyUsd: 5, reason, key: "platform", valueUsd: 50 }, actorOf(w.sa), deps());
    t.check("SET_OVERRIDE carrying key / valueUsd ⇒ VALIDATION, nothing written", !mixed2.ok && mixed2.code === "VALIDATION" && settings().length === 0 && caps().length === 0, mixed2);
    const mixed3 = await applyPlatformAiCapsAction({ action: "RESET_OVERRIDE", targetUserId: w.op, reason, dailyUsd: 3 }, actorOf(w.sa), deps());
    t.check("RESET_OVERRIDE carrying dailyUsd ⇒ VALIDATION", !mixed3.ok && mixed3.code === "VALIDATION", mixed3);
    for (const body of [{ action: "SET_BOTH", reason }, { reason }, null, "x", []]) {
      const r = await applyPlatformAiCapsAction(body, actorOf(w.sa), deps());
      t.check(`unknown / missing action (${JSON.stringify(body)}) ⇒ VALIDATION`, !r.ok && r.code === "VALIDATION" && r.action === null, r);
    }
    t.check("each refusal recorded once, codes only (control platform-ai-caps; target a closed key or 'override', never an id)",
      refusals.length === 8 && refusals.every((r) => r.control === "platform-ai-caps" && (r.targetKey === null || ["platform", "override"].includes(r.targetKey))), refusals);
    t.check("the action field sets are disjoint beyond the shared envelope (action, reason, expectedUpdatedAt)",
      ACTION_FIELDS.SET_BLANKET.filter((f) => ACTION_FIELDS.SET_OVERRIDE.includes(f)).sort().join() === "action,expectedUpdatedAt,reason");
  }

  t.section("2. authority: non-SA ⇒ refused + recordControlRefusal, no write, no audit");
  {
    const w = await world();
    for (const [label, body] of [
      ["SET_OVERRIDE (self-raise)", { action: "SET_OVERRIDE", targetUserId: w.op, dailyUsd: 20, reason }],
      ["SET_BLANKET", { action: "SET_BLANKET", key: "per_operator", valueUsd: 20, reason, expectedUpdatedAt: null }],
      ["RESET_OVERRIDE", { action: "RESET_OVERRIDE", targetUserId: w.op, reason }],
    ] as const) {
      refusals = [];
      const r = await applyPlatformAiCapsAction(body, actorOf(w.op, "USER"), deps());
      t.check(`${label} by a platform-grant holder (role USER) ⇒ FORBIDDEN, recorded, nothing written, no audit`,
        !r.ok && r.code === "FORBIDDEN" && refusals.length === 1 && refusals[0].code === "FORBIDDEN" && caps().length === 0 && settings().length === 0 && audits().length === 0, { r, refusals });
    }
    // The default recorder (recordControlRefusal) writes the PLATFORM_CONTROL_REFUSED row through fm_system.
    const r = await applyPlatformAiCapsAction({ action: "SET_OVERRIDE", targetUserId: w.op, dailyUsd: 20, reason }, actorOf(w.op, "USER"), { capInputs: ENV, now: NOW });
    const rows = audits();
    t.check("…with the real recorder: exactly ONE PLATFORM_CONTROL_REFUSED row, codes only (no submitted value, no user id in metadata)",
      !r.ok && rows.length === 1 && rows[0].action === AuditAction.PLATFORM_CONTROL_REFUSED && meta(rows[0]).refusal === "FORBIDDEN" && meta(rows[0]).control === "platform-ai-caps"
      && meta(rows[0]).target.id === "platform-ai-cap:override" && !JSON.stringify(rows[0].metadata).includes(w.op) && !JSON.stringify(rows[0].metadata).includes("20"), rows);

    // Through the REAL route: the fresh SYSTEM_ADMIN guard refuses a grant holder before any code runs.
    fake.table("AuditLog").length = 0;
    const s = await signIn(fake, w.op);
    const res = await invoke(POST as never, request("/api/admin/platform-ai-caps", { method: "POST", cookie: s.cookie, body: { action: "SET_OVERRIDE", targetUserId: w.op, dailyUsd: 20, reason } }));
    t.check("route POST by a grant holder ⇒ 403, nothing written", res.status === 403 && caps().length === 0 && settings().length === 0, res.status);
    const g = await invoke(GET as never, request("/api/admin/platform-ai-caps", { cookie: s.cookie }));
    t.check("route GET by a grant holder ⇒ 403", g.status === 403, g.status);
  }

  t.section("3. a reason is required on every write");
  {
    const w = await world();
    fake.seed("PlatformAiOperatorCap", { userId: w.op, dailyUsd: 5, updatedById: w.sa });
    for (const [label, body] of [
      ["SET_BLANKET", { action: "SET_BLANKET", key: "platform", valueUsd: 50, expectedUpdatedAt: null }],
      ["SET_BLANKET clear", { action: "SET_BLANKET", key: "platform", valueUsd: null, expectedUpdatedAt: null }],
      ["SET_OVERRIDE", { action: "SET_OVERRIDE", targetUserId: w.op, dailyUsd: 3 }],
      ["RESET_OVERRIDE", { action: "RESET_OVERRIDE", targetUserId: w.op }],
    ] as const) {
      for (const bad of [undefined, null, {}, { code: "NOPE" }, { code: "TESTING", note: "mail me at a@b.co" }]) {
        const r = await applyPlatformAiCapsAction({ ...body, ...(bad === undefined ? {} : { reason: bad }) }, actorOf(w.sa), deps());
        t.check(`${label} with reason ${JSON.stringify(bad)} ⇒ VALIDATION, nothing changed, no audit`,
          !r.ok && r.code === "VALIDATION" && settings().length === 0 && caps().length === 1 && caps()[0].dailyUsd === 5 && audits().length === 0, r);
      }
    }
    for (const a of [AuditAction.PLATFORM_AI_OPERATOR_CAP_CHANGED, AuditAction.PLATFORM_AI_OPERATOR_CAP_RESET, AuditAction.PLATFORM_POLICY_CHANGED, AuditAction.PLATFORM_POLICY_RESET]) {
      let threw = false;
      try { buildOperatorActionData({ actor: { userId: w.sa, via: "SYSTEM_ADMIN" }, action: a, target: { kind: "PLATFORM_AI_OPERATOR_CAP", id: "x" }, result: "SUCCESS" }); }
      catch (e) { threw = e instanceof OperatorActionValidationError; }
      t.check(`${a} is reason-required at the audit writer`, REASON_REQUIRED_ACTIONS.has(a) && threw);
    }
  }

  t.section("4. SET_BLANKET: descriptor max at write (S2 R4), clear = RESET, lowering below overrides allowed with the COUNT (09fb Q2)");
  {
    const w = await world();
    for (const [key, max] of [["per_operator", 20], ["platform", 100]] as const) {
      for (const bad of [max + 1, 1000, -1, 2.5, "10", Number.NaN]) {
        const r = await applyPlatformAiCapsAction({ action: "SET_BLANKET", key, valueUsd: bad, reason, expectedUpdatedAt: null }, actorOf(w.sa), deps());
        t.check(`${key} = ${JSON.stringify(bad)} ⇒ VALIDATION (max $${max}), nothing written`, !r.ok && r.code === "VALIDATION" && !fake.one("PlatformSetting", { key: K[key] }) && audits(AuditAction.PLATFORM_POLICY_CHANGED).length === (key === "platform" ? 1 : 0), r);
      }
      const ok = await applyPlatformAiCapsAction({ action: "SET_BLANKET", key, valueUsd: max, reason, expectedUpdatedAt: null }, actorOf(w.sa), deps());
      const row = fake.one("PlatformSetting", { key: K[key] });
      const a = audits(AuditAction.PLATFORM_POLICY_CHANGED).at(-1)!;
      t.check(`${key} = ${max} (the ceiling) ⇒ written, PLATFORM_POLICY_CHANGED audit (before null → after "${max}", SYSTEM_ADMIN actor, reason)`,
        ok.ok && row?.value === String(max) && row?.updatedById === w.sa && a.performedByAdminId === w.sa && meta(a).target.id === K[key]
        && meta(a).change.before.value === null && meta(a).change.after.value === String(max) && meta(a).actor.via === "SYSTEM_ADMIN" && meta(a).reason.code === "TESTING", { ok, row, a });
    }
    const stale = await applyPlatformAiCapsAction({ action: "SET_BLANKET", key: "platform", valueUsd: 50, reason, expectedUpdatedAt: null }, actorOf(w.sa), deps());
    t.check("a stale version (expected null, a row exists) ⇒ CONFLICT, the row stands", !stale.ok && stale.code === "CONFLICT" && fake.one("PlatformSetting", { key: K.platform })?.value === "100", stale);
    const noVersion = await applyPlatformAiCapsAction({ action: "SET_BLANKET", key: "platform", valueUsd: 50, reason }, actorOf(w.sa), deps());
    t.check("expectedUpdatedAt omitted on SET_BLANKET ⇒ VALIDATION", !noVersion.ok && noVersion.code === "VALIDATION", noVersion);

    // Overrides at 15 / 12 / 5, then lower the platform cap to $10: ALLOWED, warning counts 2.
    fake.seed("PlatformAiOperatorCap", { userId: w.op, dailyUsd: 15, updatedById: w.sa });
    fake.seed("PlatformAiOperatorCap", { userId: w.sa2, dailyUsd: 12, updatedById: w.sa });
    fake.seed("PlatformAiOperatorCap", { userId: w.sa, dailyUsd: 5, updatedById: w.sa });
    const v = (fake.one("PlatformSetting", { key: K.platform })!.updatedAt as Date).toISOString();
    const lowered = await setPlatform(w.sa, 10, v);
    t.check("lowering the platform cap to $10 below two overrides ⇒ ALLOWED, warning OVERRIDES_ABOVE_PLATFORM_CAP count 2, overrides untouched",
      lowered.ok && lowered.warning?.code === "OVERRIDES_ABOVE_PLATFORM_CAP" && lowered.warning.count === 2 && lowered.warning.platformCapUsd === 10
      && fake.one("PlatformSetting", { key: K.platform })?.value === "10" && caps().length === 3, lowered);
    const v2 = (fake.one("PlatformSetting", { key: K.platform })!.updatedAt as Date).toISOString();
    const raised = await setPlatform(w.sa, 100, v2);
    t.check("raising above every override ⇒ no warning", raised.ok && raised.warning === undefined, raised);

    // Clear = delete the row, PLATFORM_POLICY_RESET.
    const v3 = (fake.one("PlatformSetting", { key: K.platform })!.updatedAt as Date).toISOString();
    const cleared = await setPlatform(w.sa, null, v3);
    const ra = audits(AuditAction.PLATFORM_POLICY_RESET).at(-1);
    t.check("valueUsd null ⇒ the row is DELETED (back to not set), PLATFORM_POLICY_RESET audit (before '100' → after null)",
      cleared.ok && !fake.one("PlatformSetting", { key: K.platform }) && !!ra && meta(ra).change.before.value === "100" && meta(ra).change.after.value === null, { cleared, ra });
    const again = await setPlatform(w.sa, null, null);
    t.check("clearing an absent value ⇒ NOT_FOUND", !again.ok && again.code === "NOT_FOUND", again);
  }

  t.section("5. SET_OVERRIDE: eligibility (C3), PLATFORM_CAP_NOT_SET, the effective platform bound (Q2), selfEdit (09fa), the audit (C4)");
  {
    const w = await world();
    for (const [label, target] of [["a customer (no grant, not SA)", w.customer], ["a REVOKED grant holder", w.revoked], ["a deactivated SA", w.deadSa], ["an unknown id", "c_nobody"]] as const) {
      refusals = [];
      const r = await setOverride(w.sa, target, 5);
      t.check(`target = ${label} ⇒ NOT_ELIGIBLE, recorded, nothing written, no audit`,
        !r.ok && r.code === "NOT_ELIGIBLE" && refusals[0]?.code === "NOT_ELIGIBLE" && refusals[0]?.targetKey === "override" && caps().length === 0 && audits().length === 0, r);
    }
    {
      const r = await setOverride(w.sa, w.op, 5, PROD);
      t.check("platform cap unresolved (Production, no env, no setting: CAP_MISSING) ⇒ PLATFORM_CAP_NOT_SET, nothing written",
        !r.ok && r.code === "PLATFORM_CAP_NOT_SET" && caps().length === 0 && audits().length === 0, r);
      fake.seed("PlatformSetting", { key: K.platform, value: "abc", updatedById: w.sa });
      const inv = await setOverride(w.sa, w.op, 5, ENV);
      t.check("Q3 (S2 09fu): platform setting INVALID ⇒ PLATFORM_CAP_INVALID (distinct from NOT_SET), recorded with that code, nothing written",
        !inv.ok && inv.code === "PLATFORM_CAP_INVALID" && refusals.at(-1)?.code === "PLATFORM_CAP_INVALID" && caps().length === 0 && audits().length === 0, inv);
      fake.table("PlatformSetting").length = 0;
    }
    for (const bad of [21, -1, 2.5, "5", null, undefined]) {
      const r = await setOverride(w.sa, w.op, bad);
      t.check(`dailyUsd ${JSON.stringify(bad)} ⇒ VALIDATION (0..${PLATFORM_AI_OPERATOR_CAP_CEILING_USD} integers only)`, !r.ok && r.code === "VALIDATION" && caps().length === 0, r);
    }
    {
      fake.seed("PlatformSetting", { key: K.platform, value: "8", updatedById: w.sa });
      const above = await setOverride(w.sa, w.op, 9, PROD);
      t.check("dailyUsd above the EFFECTIVE platform cap (setting $8) ⇒ ABOVE_PLATFORM_CAP, nothing written", !above.ok && above.code === "ABOVE_PLATFORM_CAP" && caps().length === 0 && audits().length === 0, above);
      const at = await setOverride(w.sa, w.op, 8, PROD);
      t.check("…exactly at it ($8) ⇒ written", at.ok && caps()[0]?.dailyUsd === 8, at);
      fake.table("PlatformSetting").length = 0; fake.table("PlatformAiOperatorCap").length = 0; fake.table("AuditLog").length = 0;
      const envCap = await setOverride(w.sa, w.op, 20, { operatorRaw: "20", platformRaw: "15", vercelEnv: "production" });
      t.check("no setting: the ENV platform cap ($15) is the effective bound ⇒ $20 refused ABOVE_PLATFORM_CAP", !envCap.ok && envCap.code === "ABOVE_PLATFORM_CAP", envCap);
    }
    {
      const other = await setOverride(w.sa, w.op, 7);
      const a = audits(AuditAction.PLATFORM_AI_OPERATOR_CAP_CHANGED).at(-1)!;
      const m = meta(a);
      const ref = opaqueUserRef(w.op);
      t.check("SA sets a grant holder's override ⇒ row written (dailyUsd 7, updatedById = actor), selfEdit=false", other.ok && other.selfEdit === false && caps()[0].dailyUsd === 7 && caps()[0].updatedById === w.sa, other);
      t.check("audit PLATFORM_AI_OPERATOR_CAP_CHANGED: detail { targetRef (PRIV-ref), previous null, next 7, selfEdit false, reason }",
        a.performedByAdminId === w.sa && m.targetRef === ref && /^user #[0-9a-f]{8}$/.test(ref) && m.previous === null && m.next === 7 && m.selfEdit === false
        && m.reason.code === "TESTING" && m.target.kind === "PLATFORM_AI_OPERATOR_CAP" && m.target.id === ref && m.actor.via === "SYSTEM_ADMIN", m);
      t.check("…no raw target id anywhere in the row (not the userId column, not the metadata)", a.userId == null && !JSON.stringify(a.metadata).includes(w.op), a);
      const feed = projectOperatorActionEvent({ id: a.id as string, action: a.action as string, createdAt: a.createdAt as Date, performedByAdminId: w.sa, metadata: a.metadata, subjectUsername: null }, "root");
      t.check("…the operator feed text carries no raw id (an opaque tail of the PRIV-ref)", !!feed.target && !feed.target.includes(w.op.slice(-6)) && feed.target.endsWith(ref.slice(-6)), feed.target);
      caps()[0].updatedAt = new Date(Date.now() - 60_000); // a distinct, observable version
      const v = (caps()[0].updatedAt as Date).toISOString();
      const change = await setOverride(w.sa, w.op, 3, ENV, { expectedUpdatedAt: v });
      const a2 = audits(AuditAction.PLATFORM_AI_OPERATOR_CAP_CHANGED).at(-1)!;
      t.check("change 7 → 3 with the observed version ⇒ previous 7, next 3", change.ok && caps()[0].dailyUsd === 3 && meta(a2).previous === 7 && meta(a2).next === 3, meta(a2));
      const stale = await setOverride(w.sa, w.op, 4, ENV, { expectedUpdatedAt: v });
      t.check("Q6: a stale expectedUpdatedAt ⇒ CONFLICT, the row stands at 3", !stale.ok && stale.code === "CONFLICT" && caps()[0].dailyUsd === 3, stale);
      const nullSet = await setOverride(w.sa, w.op, 4, ENV, { expectedUpdatedAt: null });
      t.check("Q6: expecting no row (null) while one exists ⇒ CONFLICT, the row stands at 3", !nullSet.ok && nullSet.code === "CONFLICT" && caps()[0].dailyUsd === 3, nullSet);
      const nAudits = audits().length;
      const noVersion = await applyPlatformAiCapsAction({ action: "SET_OVERRIDE", targetUserId: w.op, dailyUsd: 4, reason }, actorOf(w.sa), deps());
      t.check("Q6: SET_OVERRIDE without expectedUpdatedAt ⇒ VALIDATION (required), nothing written", !noVersion.ok && noVersion.code === "VALIDATION" && caps()[0].dailyUsd === 3 && audits().length === nAudits, noVersion);
      const badVersion = await setOverride(w.sa, w.op, 4, ENV, { expectedUpdatedAt: 12345 });
      t.check("Q6: a non-string version ⇒ VALIDATION", !badVersion.ok && badVersion.code === "VALIDATION", badVersion);
      const n = audits().length;
      const same = await setOverride(w.sa, w.op, 3);
      t.check("setting the same value ⇒ ok, changed=false, no write, no audit", same.ok && same.changed === false && audits().length === n, same);
      const zero = await setOverride(w.sa, w.op, 0);
      t.check("dailyUsd 0 is valid (that operator off) ⇒ written", zero.ok && caps()[0].dailyUsd === 0, zero);
    }
    {
      const self = await setOverride(w.sa, w.sa, 6);
      const a = audits(AuditAction.PLATFORM_AI_OPERATOR_CAP_CHANGED).at(-1)!;
      t.check("an SA editing their OWN cap ⇒ allowed, selfEdit=true in the result and the audit", self.ok && self.selfEdit === true && meta(a).selfEdit === true && meta(a).targetRef === opaqueUserRef(w.sa), { self, m: meta(a) });
      const peer = await setOverride(w.sa, w.sa2, 6);
      const b = audits(AuditAction.PLATFORM_AI_OPERATOR_CAP_CHANGED).at(-1)!;
      t.check("an SA editing ANOTHER SA ⇒ selfEdit=false (selfEdit iff actor == target)", peer.ok && peer.selfEdit === false && meta(b).selfEdit === false, meta(b));
    }
  }

  t.section("6. RESET_OVERRIDE: deletes the row and audits PLATFORM_AI_OPERATOR_CAP_RESET");
  {
    const w = await world();
    fake.seed("PlatformAiOperatorCap", { userId: w.op, dailyUsd: 9, updatedById: w.sa });
    // Q6 (S2 09fu): expectedUpdatedAt is REQUIRED; a stale or null-while-present version ⇒ CONFLICT, the row stands.
    const missing = await applyPlatformAiCapsAction({ action: "RESET_OVERRIDE", targetUserId: w.op, reason }, actorOf(w.sa), deps());
    t.check("Q6: RESET_OVERRIDE without expectedUpdatedAt ⇒ VALIDATION, the row stands", !missing.ok && missing.code === "VALIDATION" && caps().length === 1, missing);
    const staleReset = await resetOverride(w.sa, w.op, { expectedUpdatedAt: new Date(Date.now() - 3_600_000).toISOString() });
    t.check("Q6: RESET_OVERRIDE with a stale version ⇒ CONFLICT, the row stands, no audit", !staleReset.ok && staleReset.code === "CONFLICT" && caps().length === 1 && audits().length === 0, staleReset);
    const nullReset = await resetOverride(w.sa, w.op, { expectedUpdatedAt: null });
    t.check("Q6: RESET_OVERRIDE expecting no row (null) while one exists ⇒ CONFLICT", !nullReset.ok && nullReset.code === "CONFLICT" && caps().length === 1, nullReset);
    const r = await resetOverride(w.sa, w.op);
    const a = audits(AuditAction.PLATFORM_AI_OPERATOR_CAP_RESET).at(-1);
    t.check("reset ⇒ the row is deleted", r.ok && caps().length === 0, r);
    t.check("…audit { targetRef, previous 9, next null, selfEdit false, reason }, no raw id",
      !!a && meta(a).targetRef === opaqueUserRef(w.op) && meta(a).previous === 9 && meta(a).next === null && meta(a).selfEdit === false && meta(a).reason.code === "TESTING"
      && a.userId == null && !JSON.stringify(a.metadata).includes(w.op), a);
    const none = await resetOverride(w.sa, w.op);
    t.check("reset with no row ⇒ NOT_FOUND, no audit", !none.ok && none.code === "NOT_FOUND" && audits(AuditAction.PLATFORM_AI_OPERATOR_CAP_RESET).length === 1, none);
    fake.seed("PlatformAiOperatorCap", { userId: w.revoked, dailyUsd: 4, updatedById: w.sa });
    const cleanup = await resetOverride(w.sa, w.revoked);
    t.check("a former operator's leftover override can still be reset (cleanup)", cleanup.ok && caps().length === 0, cleanup);
    fake.seed("PlatformAiOperatorCap", { userId: w.sa, dailyUsd: 4, updatedById: w.sa });
    const self = await resetOverride(w.sa, w.sa);
    t.check("self reset ⇒ selfEdit=true", self.ok && self.selfEdit === true && meta(audits(AuditAction.PLATFORM_AI_OPERATOR_CAP_RESET).at(-1)!).selfEdit === true, self);
  }

  t.section("7. the GET read model (SA-only route)");
  {
    const w = await world();
    fake.seed("PlatformSetting", { key: K.per_operator, value: "3", updatedById: w.sa });
    fake.seed("PlatformSetting", { key: K.platform, value: "10", updatedById: w.sa });
    fake.seed("PlatformAiOperatorCap", { userId: w.op, dailyUsd: 15, updatedById: w.sa });
    fake.seed("PlatformAiOperatorCap", { userId: w.sa2, dailyUsd: 25, updatedById: w.sa }); // corrupt (CHECK would refuse): INVALID
    fake.seed("PlatformAiOperatorCap", { userId: w.sa, dailyUsd: 0, updatedById: w.sa });
    const m = await loadPlatformAiCapsReadModel(MODEL, { capInputs: PROD, now: NOW });
    const byId = new Map(m.operators.map((o) => [o.userId, o]));
    t.check("operators = current SYSTEM_ADMINs + ACTIVE grant holders (no customer, no revoked holder, no deactivated SA)",
      [...byId.keys()].sort().join() === [w.sa, w.sa2, w.op].sort().join() && byId.get(w.op)?.via === "PLATFORM_GRANT" && byId.get(w.sa)?.via === "SYSTEM_ADMIN", [...byId.keys()]);
    t.check("blanket values with their source (setting $3 / $10, PLATFORM_SETTING) and fits-N-turns", m.blanket.perOperator.stored.usd === 3 && m.blanket.perOperator.effective.usd === 3
      && m.blanket.perOperator.effective.source === "PLATFORM_SETTING" && m.blanket.platform.effective.usd === 10 && m.blanket.platform.fitsTurns === platformAiTurnsThatFit(10, reserve)
      && m.blanket.perOperator.stored.updatedBy === "root", m.blanket);
    t.check("override $15 ⇒ effective $15 (OPERATOR_OVERRIDE), fits floor(15 / reserve) worst-case turns",
      byId.get(w.op)?.override?.dailyUsd === 15 && byId.get(w.op)?.effective.usd === 15 && byId.get(w.op)?.effective.source === "OPERATOR_OVERRIDE" && byId.get(w.op)?.fitsTurns === Math.floor(15 / reserve + 1e-9), byId.get(w.op));
    t.check("an INVALID override row (25) ⇒ state INVALID, effective refusal CAP_INVALID (what the reservation does)",
      byId.get(w.sa2)?.override?.state === "INVALID" && byId.get(w.sa2)?.effective.refusal === "CAP_INVALID" && byId.get(w.sa2)?.fitsTurns === null, byId.get(w.sa2));
    t.check("override 0 ⇒ effective $0, fits 0 turns (that operator is off)", byId.get(w.sa)?.effective.usd === 0 && byId.get(w.sa)?.fitsTurns === 0, byId.get(w.sa));
    t.check("overrides above the effective platform cap counted ($15 and $25 > $10 ⇒ 2)", m.overridesAbovePlatformCap === 2, m.overridesAbovePlatformCap);
    t.check("labels are usernames / PRIV-refs, never an email; the reserve is the model's", !JSON.stringify(m).includes("@example.test") && m.reserveUsd === reserve && byId.get(w.op)?.ref === opaqueUserRef(w.op), m.reserveUsd);
    fake.table("PlatformSetting").length = 0;
    const missing = await loadPlatformAiCapsReadModel(MODEL, { capInputs: PROD, now: NOW });
    t.check("no setting + Production with no env ⇒ blanket refusal CAP_MISSING, no override count", missing.blanket.platform.effective.refusal === "CAP_MISSING" && missing.blanket.platform.stored.state === "ABSENT" && missing.overridesAbovePlatformCap === null, missing.blanket);

    // Through the REAL route as an SA.
    freshCache();
    const s = await signIn(fake, w.sa);
    const g = await invoke<Record<string, any>>(GET as never, request("/api/admin/platform-ai-caps", { cookie: s.cookie }));
    t.check("route GET as an SA ⇒ 200 with the read model, no-store", g.status === 200 && Array.isArray(g.body.operators) && g.body.blanket?.platform?.ceilingUsd === 100 && /no-store/.test(g.headers.get("cache-control") ?? ""), g.status);
    const p = await invoke<Record<string, any>>(POST as never, request("/api/admin/platform-ai-caps", { method: "POST", cookie: s.cookie, body: { action: "SET_BLANKET", key: "platform", valueUsd: 50, reason, expectedUpdatedAt: null } }));
    t.check("route POST SET_BLANKET as an SA ⇒ 200 { result, model }", p.status === 200 && p.body.result?.ok === true && p.body.model?.blanket?.platform?.effective?.usd === 50, p.body);
    const p2 = await invoke<Record<string, any>>(POST as never, request("/api/admin/platform-ai-caps", { method: "POST", cookie: s.cookie, body: { action: "SET_OVERRIDE", targetUserId: w.customer, dailyUsd: 5, reason, expectedUpdatedAt: null } }));
    t.check("route POST SET_OVERRIDE on a customer ⇒ 400 NOT_ELIGIBLE + one PLATFORM_CONTROL_REFUSED row", p2.status === 400 && p2.body.code === "NOT_ELIGIBLE" && audits(AuditAction.PLATFORM_CONTROL_REFUSED).length === 1, p2.body);
    const p3 = await invoke<Record<string, any>>(POST as never, request("/api/admin/platform-ai-caps", { method: "POST", cookie: s.cookie, body: { action: "SET_BLANKET", key: "platform", valueUsd: 60, reason, expectedUpdatedAt: null } }));
    t.check("route POST with a stale version ⇒ 409 CONFLICT", p3.status === 409 && p3.body.code === "CONFLICT", p3.body);
  }

  t.section("8. registration + static pins");
  {
    for (const a of [AuditAction.PLATFORM_AI_OPERATOR_CAP_CHANGED, AuditAction.PLATFORM_AI_OPERATOR_CAP_RESET]) {
      t.check(`${a}: on the operator action feed list, reason-required, Security-only (never the Platform Ops feed)`,
        OPERATOR_ACTION_FEED_ACTIONS.includes(a) && REASON_REQUIRED_ACTIONS.has(a) && SECURITY_ONLY_ACTIONS.includes(a) && !(a in PLATFORM_OPS_FEED_RULES));
    }
    const widget = readFileSync(path.join(ROOT, "components/platform/widgets/SecOperatorActionsWidget.tsx"), "utf8");
    t.check("the Security widget labels both actions", /PLATFORM_AI_OPERATOR_CAP_CHANGED:\s*"[^"]+"/.test(widget) && /PLATFORM_AI_OPERATOR_CAP_RESET:\s*"[^"]+"/.test(widget));
    const fam = MUTATION_FAMILIES.find((f) => f.key === "platform-ai-caps");
    t.check("capability classification: platform-ai-caps is SHIPPED, SYSTEM_ADMIN, citing the route", fam?.status === "SHIPPED" && fam.capability === "SYSTEM_ADMIN" && JSON.stringify(fam.routes) === JSON.stringify(["app/api/admin/platform-ai-caps/route.ts"]));
    const route = strip("app/api/admin/platform-ai-caps/route.ts");
    const get = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function POST"));
    const post = route.slice(route.indexOf("export async function POST"));
    t.check("route: GET requireSystemAdmin; POST requireFreshSystemAdmin then a per-admin rate limit, before the body is read",
      /requireSystemAdmin\(\)/.test(get) && /requireFreshSystemAdmin\(\)/.test(post) && post.indexOf("requireFreshSystemAdmin(") < post.indexOf("limitByUser(admin.id") && post.indexOf("limitByUser(admin.id") < post.indexOf("req.json("));
    t.check("route: never the migration principal, never a PlatformSetting / table write of its own", !/from "@\/lib\/db"/.test(route) && !/platformSetting\.|platformAiOperatorCap\./.test(route));
    const svc = strip("lib/platform/ai/platform-ai-caps-admin.ts");
    t.check("the caps cannot activate Platform AI: neither the route nor the service reads or writes PLATFORM_AI_ENABLED / isPlatformAiEnabled",
      !/PLATFORM_AI_ENABLED|isPlatformAiEnabled/.test(svc) && !/PLATFORM_AI_ENABLED|isPlatformAiEnabled/.test(route));
    t.check("service: fm_system (systemDb), not the migration principal; no console logging (codes only, via the audit rows)",
      /import \{ systemDb \} from "@\/lib\/db"/.test(svc) && !/import\s*\{[^}]*\bdb\b[^}]*\}\s*from\s*"@\/lib\/db"/.test(svc) && !/console\./.test(svc));
    t.check("service: the setting writes go through the registry's conditional primitives (one PlatformSetting writer module)",
      /createSettingIfAbsent\(tx,/.test(svc) && /updateSettingIfVersion\(tx,/.test(svc) && /deleteSettingIfVersion\(tx,/.test(svc) && !/platformSetting\.(create|update|upsert|delete)/.test(svc));
  }

  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
