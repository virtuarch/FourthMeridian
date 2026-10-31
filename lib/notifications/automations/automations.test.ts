/**
 * lib/notifications/automations/automations.test.ts  (Comms Center B2 — the endpoints, gating and test send)
 *
 * The REAL route handlers, invoked as real signed-in operators over the
 * in-memory Prisma fake (lib/test-support/route-harness.ts — the unmodified
 * session / grant / revocation chain), plus the test-send handler over fake
 * transports. No database, no network, no real send.
 *   1. route wiring — every route names its gate and bucket (census);
 *   2. the GATING MATRIX — READ / WRITE / CONTROL / SYSTEM_ADMIN per endpoint;
 *      WRITE can't activate; activate without owner approval is refused; only
 *      SYSTEM_ADMIN approves; reason required; the audit row commits in the SAME
 *      transaction (an audit failure rolls the change back); the token (D5);
 *   3. the write-body rules — no copy, no code, closed predicates, protected first;
 *   4. dry run — sends nothing, claims nothing, writes no ledger row, echoes the window;
 *   5. activation preconditions — trigger availability, MARKETING, invalidation by PATCH;
 *   6. test send — SELF only, the non-prod allowlist, typed 422 guards, [TEST], mode TEST.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/notifications/automations/automations.test.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- assertions read loosely-typed JSON bodies */

import "@/lib/test-support/route-env";
import { readFileSync, readdirSync } from "node:fs";
import bcrypt from "bcryptjs";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { invoke, request, signIn, freshCache } from "@/lib/test-support/route-harness";
import type { EmailMessage } from "@/lib/email/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}
const quiet = async <T,>(f: () => Promise<T>): Promise<T> => {
  const { log, warn, info } = console; console.log = () => {}; console.warn = () => {}; console.info = () => {};
  try { return await f(); } finally { console.log = log; console.warn = warn; console.info = info; }
};
const code = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const fake = new FakePrisma();
const REASON = { code: "DOGFOOD", note: "automation review" };
const BASE = "/api/platform/customer-success/notifications";
const DIR = "app/api/platform/customer-success/notifications";

async function main(): Promise<void> {
  await installFakePrisma(fake);
  const LIST = await import(`@/${DIR}/automations/route`);
  const ONE = await import(`@/${DIR}/automations/[id]/route`);
  const RUNS = await import(`@/${DIR}/automations/[id]/runs/route`);
  const DRY = await import(`@/${DIR}/automations/[id]/dry-run/route`);
  const APPROVE = await import(`@/${DIR}/automations/[id]/owner-approval/route`);
  const ACTIVATE = await import(`@/${DIR}/automations/[id]/activate/route`);
  const PAUSE = await import(`@/${DIR}/automations/[id]/pause/route`);
  const DISABLE = await import(`@/${DIR}/automations/[id]/disable/route`);
  const H = await import("./http");
  const R = await import("./rules");
  const { automationServices } = await import("./deps");
  const { contentServices } = await import("@/lib/notifications/content/deps");
  const { createEmailSender } = await import("@/lib/email/send");
  const { PendingSends } = await import("@/lib/notifications/delivery/storm");
  const { getCatalogDefinition } = await import("@/lib/notifications/catalog/definitions");
  const { AuditAction } = await import("@/lib/audit-actions");
  const { REASON_REQUIRED_ACTIONS } = await import("@/lib/audit");
  const T = await import("./types");
  const S = await import("./store");
  /**
   * The routes use the PRODUCTION services, whose gate is automationActivationEnabled(process.env) read per
   * request: a test opens it the only way it can be opened — Preview + the exact flag — and closes it by unsetting.
   */
  const gate = (open: boolean) => {
    if (open) { process.env.VERCEL_ENV = "preview"; process.env.COMMS_AUTOMATIONS_PREVIEW_ENABLED = "true"; }
    else { delete process.env.VERCEL_ENV; delete process.env.COMMS_AUTOMATIONS_PREVIEW_ENABLED; }
  };
  gate(false);

  // ── 1. route wiring ────────────────────────────────────────────────────────
  console.log("1. route wiring — gate + bucket per route (contract v1.1 §6.1)");
  const routes: Array<[string, string, RegExp]> = [
    [`${DIR}/automations/route.ts`, "GET", /export async function GET[\s\S]*requirePlatformAccess\("CUSTOMER_SUCCESS", "READ"\), rateLimit: csCommsReadLimit/],
    [`${DIR}/automations/route.ts`, "POST", /export async function POST[\s\S]*requireFreshPlatformAccess\("CUSTOMER_SUCCESS", "WRITE"\), rateLimit: csCommsWriteLimit/],
    [`${DIR}/automations/[id]/route.ts`, "GET", /export async function GET[\s\S]*requirePlatformAccess\("CUSTOMER_SUCCESS", "READ"\), rateLimit: csCommsReadLimit/],
    [`${DIR}/automations/[id]/route.ts`, "PATCH", /export async function PATCH[\s\S]*requireFreshPlatformAccess\("CUSTOMER_SUCCESS", "WRITE"\), rateLimit: csCommsWriteLimit/],
    [`${DIR}/automations/[id]/runs/route.ts`, "GET", /requirePlatformAccess\("CUSTOMER_SUCCESS", "READ"\), rateLimit: csCommsReadLimit/],
    [`${DIR}/automations/[id]/dry-run/route.ts`, "POST", /requireFreshPlatformAccess\("CUSTOMER_SUCCESS", "WRITE"\), rateLimit: csCommsDryRunLimit/],
    [`${DIR}/automations/[id]/owner-approval/route.ts`, "POST", /requireFreshSystemAdmin\(\)[\s\S]*guard: \(\) => ownerGate\(\), rateLimit: csCommsControlLimit/],
    [`${DIR}/automations/[id]/activate/route.ts`, "POST", /requireFreshPlatformAccess\("CUSTOMER_SUCCESS", "CONTROL"\), rateLimit: csCommsControlLimit/],
    [`${DIR}/automations/[id]/pause/route.ts`, "POST", /requireFreshPlatformAccess\("CUSTOMER_SUCCESS", "WRITE"\), rateLimit: csCommsWriteLimit/],
    [`${DIR}/automations/[id]/disable/route.ts`, "POST", /requireFreshPlatformAccess\("CUSTOMER_SUCCESS", "WRITE"\), rateLimit: csCommsWriteLimit/],
    [`${DIR}/test-send/route.ts`, "POST", /requireFreshPlatformAccess\("CUSTOMER_SUCCESS", "WRITE"\), rateLimit: csCommsTestLimit/],
  ];
  for (const [f, m, re] of routes) check(`${f.replace(DIR, "…")} ${m}: gate + bucket`, re.test(code(f)));
  check("owner-approval uses NO platform grant gate (a CS CONTROL grant is not enough — O-18)", !/requirePlatformAccess|requireFreshPlatformAccess/.test(code(`${DIR}/automations/[id]/owner-approval/route.ts`)));
  check("activate is the ONLY automation route at CONTROL", routes.filter(([f]) => /CONTROL"\)/.test(code(f))).map(([f]) => f).join() === `${DIR}/automations/[id]/activate/route.ts`);
  check("buckets: dry-run 10/min, test 5 per 10 min (v1 §4.1)", H.CS_COMMS_DRYRUN_LIMIT.limit === 10 && H.CS_COMMS_DRYRUN_LIMIT.windowSec === 60 && H.CS_COMMS_TEST_LIMIT.limit === 5 && H.CS_COMMS_TEST_LIMIT.windowSec === 600);
  const B2 = [AuditAction.COMMS_AUTOMATION_CREATED, AuditAction.COMMS_AUTOMATION_UPDATED, AuditAction.COMMS_AUTOMATION_DRY_RUN, AuditAction.COMMS_AUTOMATION_OWNER_APPROVED,
    AuditAction.COMMS_AUTOMATION_ACTIVATED, AuditAction.COMMS_AUTOMATION_PAUSED, AuditAction.COMMS_AUTOMATION_DISABLED, AuditAction.COMMS_TEST_SEND];
  check("every B2 audit action is reason-required", B2.every((a) => typeof a === "string" && REASON_REQUIRED_ACTIONS.has(a)));

  // ── the world ──────────────────────────────────────────────────────────────
  const hash = await bcrypt.hash("pw", 4);
  const op = async (id: string, level: string | null, role = "USER") => {
    fake.seed("User", { id, email: `${id}@example.invalid`, username: id, passwordHash: hash, emailVerifiedAt: new Date(), role, totpEnabled: true, totpSecret: "x" });
    if (level) fake.seed("PlatformGrant", { userId: id, area: "CUSTOMER_SUCCESS", level, status: "ACTIVE" });
    return (await signIn(fake, id)).cookie;
  };
  fake.reset(); freshCache();
  const C = { read: await op("op_read", "READ"), write: await op("op_write", "WRITE"), control: await op("op_control", "CONTROL"), admin: await op("op_admin", null, "SYSTEM_ADMIN") };
  const call = (h: any, path: string, cookie: string, method: string, body?: unknown, params: Record<string, string> = {}) =>
    quiet(() => invoke(h, request(`${BASE}${path}`, { method, cookie, ...(body !== undefined ? { body } : {}) }), params)) as Promise<{ status: number; body: any }>;
  const audits = (action: string) => fake.rows("AuditLog").filter((r) => r.action === action);
  const createBody = (extra: Record<string, unknown> = {}) => ({
    reason: REASON,
    body: { triggerKey: "space.member.role_changed", definitionKey: "MEMBER_ROLE_CHANGED", name: "Role changed nudge", recipient: { kind: "EVENT_SUBJECT_USER" }, channels: ["IN_APP"], ...extra },
  });

  // ── 2. gating matrix ───────────────────────────────────────────────────────
  console.log("2. the gating matrix (v1.1 §6.1): READ < WRITE < CONTROL; owner approval = SYSTEM_ADMIN only");
  const readCreate = await call(LIST.POST, "/automations", C.read, "POST", createBody());
  check("READ cannot create (403), nothing written", readCreate.status === 403 && fake.rows("AutomationDefinition").length === 0, readCreate.body);
  const noReason = await call(LIST.POST, "/automations", C.write, "POST", { body: createBody().body });
  check("WRITE create WITHOUT a reason ⇒ 400, nothing written, nothing audited", noReason.status === 400 && fake.rows("AutomationDefinition").length === 0 && audits("COMMS_AUTOMATION_CREATED").length === 0, noReason.body);
  const created = await call(LIST.POST, "/automations", C.write, "POST", createBody());
  const id = created.body?.result?.id as string;
  check("WRITE creates a DRAFT (201): version 1, customerFacing, ONE audit row with the reason and target", created.status === 201 && created.body.result.state === "DRAFT" && created.body.result.version === 1
    && created.body.result.customerFacing === true && audits("COMMS_AUTOMATION_CREATED").length === 1
    && (audits("COMMS_AUTOMATION_CREATED")[0].metadata as any).reason.code === "DOGFOOD" && (audits("COMMS_AUTOMATION_CREATED")[0].metadata as any).target.id === id
    && created.body.auditLogId === audits("COMMS_AUTOMATION_CREATED")[0].id, created.body);
  check("the detail carries the viewer (D2): WRITE may edit / dry-run, may NOT activate or approve", created.body.result.viewer.canEditAutomation && created.body.result.viewer.canDryRun
    && !created.body.result.viewer.canActivate && !created.body.result.viewer.canApproveAsOwner);
  const writeActivate = await call(ACTIVATE.POST, `/automations/${id}/activate`, C.write, "POST", { reason: REASON, expectedVersion: 1, body: {} }, { id });
  check("WRITE cannot ACTIVATE (403 — activation is CONTROL, O-1); still DRAFT", writeActivate.status === 403 && fake.one("AutomationDefinition", { id })!.state === "DRAFT", writeActivate.body);
  // ── the ACTIVATION GATE (Preview + flag, read per request) ──
  check("production services read the resolver per call: closed with the env unset",
    automationServices.activationEnabled() === false && T.automationActivationEnabled(process.env) === false);
  gate(true); const openNow = automationServices.activationEnabled(); gate(false);
  check("…and open the moment the env says Preview + \"true\", closed again when unset (no caching)", openNow === true && automationServices.activationEnabled() === false);
  check("production wiring (deps.ts, engine-deps.ts) reads the resolver over process.env — no constant, no hard true",
    /activationEnabled: \(\) => automationActivationEnabled\(process\.env\)/.test(code("lib/notifications/automations/deps.ts"))
    && /activationEnabled: \(\) => automationActivationEnabled\(process\.env\)/.test(code("lib/notifications/automations/engine-deps.ts")));
  const auditsBefore = fake.rows("AuditLog").length;
  const gated = await call(ACTIVATE.POST, `/automations/${id}/activate`, C.control, "POST", { reason: REASON, expectedVersion: 1, body: {} }, { id });
  const refusedRows = audits("COMMS_AUTOMATION_ACTIVATION_REFUSED");
  const rm = refusedRows[0]?.metadata as any;
  check("GATE CLOSED: CONTROL activate ⇒ 409 ACTIVATION_DISABLED_PENDING_HARDENING (typed), nothing written to the automation",
    gated.status === 409 && gated.body.code === "ACTIVATION_DISABLED_PENDING_HARDENING" && fake.one("AutomationDefinition", { id })!.state === "DRAFT"
    && fake.one("AutomationDefinition", { id })!.version === 1, gated.body);
  check("…the refusal is AUDITED: ONE COMMS_AUTOMATION_ACTIVATION_REFUSED row (result REFUSED) with the actor, the reason, the requested + current version and the definitionVersion",
    fake.rows("AuditLog").length === auditsBefore + 1 && refusedRows.length === 1 && refusedRows[0].performedByAdminId === "op_control" && rm?.result === "REFUSED"
    && rm?.reason?.code === "DOGFOOD" && rm?.requestedVersion === 1 && rm?.change?.before?.version === 1
    && rm?.definitionVersion === getCatalogDefinition("MEMBER_ROLE_CHANGED")!.definitionVersion && rm?.target?.id === id, { n: refusedRows.length, rm });
  check("the refusal audit action is reason-required", REASON_REQUIRED_ACTIONS.has(AuditAction.COMMS_AUTOMATION_ACTIVATION_REFUSED));
  const gatedUnknown = await call(ACTIVATE.POST, `/automations/nope/activate`, C.control, "POST", { reason: REASON, expectedVersion: 1, body: {} }, { id: "nope" });
  check("…the gate answers BEFORE any read (an unknown id is the gate refusal, not 404)", gatedUnknown.status === 409 && gatedUnknown.body.code === "ACTIVATION_DISABLED_PENDING_HARDENING");
  const gatedNoReason = await call(ACTIVATE.POST, `/automations/${id}/activate`, C.control, "POST", { expectedVersion: 1, body: {} }, { id });
  check("…a request with no reason is still the gate's 409 (the gate comes first), and is not audited (nothing to record a reason for)",
    gatedNoReason.status === 409 && gatedNoReason.body.code === "ACTIVATION_DISABLED_PENDING_HARDENING" && audits("COMMS_AUTOMATION_ACTIVATION_REFUSED").length === 2);
  const gatedAdmin = await call(ACTIVATE.POST, `/automations/${id}/activate`, C.admin, "POST", { reason: REASON, expectedVersion: 1, body: {} }, { id });
  check("…for SYSTEM_ADMIN too (no break-glass around the gate)", gatedAdmin.status === 409 && gatedAdmin.body.code === "ACTIVATION_DISABLED_PENDING_HARDENING");
  const gatedView = await call(ONE.GET, `/automations/${id}`, C.control, "GET", undefined, { id });
  check("…viewer.canActivate is false for CONTROL, with activationDisabledReason", gatedView.body.viewer.canActivate === false && gatedView.body.viewer.activationDisabledReason === "ACTIVATION_DISABLED_PENDING_HARDENING");
  const direct = await S.activate({ id, expectedVersion: 1, actor: { userId: "op_control", via: "PLATFORM_GRANT" }, reason: REASON as any, now: new Date() });
  check("…and the STORE refuses too (defense in depth), before any write", !direct.ok && (direct as any).code === "ACTIVATION_DISABLED_PENDING_HARDENING" && fake.one("AutomationDefinition", { id })!.state === "DRAFT");
  gate(true);
  const ctlActivate = await call(ACTIVATE.POST, `/automations/${id}/activate`, C.control, "POST", { reason: REASON, expectedVersion: 1, body: {} }, { id });
  check("(gate opened) CONTROL activate WITHOUT owner approval ⇒ 409 OWNER_APPROVAL_REQUIRED (typed), every blocker listed, nothing written",
    ctlActivate.status === 409 && ctlActivate.body.code === "OWNER_APPROVAL_REQUIRED" && ctlActivate.body.activationBlockers.includes("DRY_RUN_REQUIRED")
    && fake.one("AutomationDefinition", { id })!.state === "DRAFT" && audits("COMMS_AUTOMATION_ACTIVATED").length === 0, ctlActivate.body);
  gate(false); // owner approval and the dry run below run with the gate CLOSED: both still work
  for (const [who, cookie] of [["READ", C.read], ["WRITE", C.write], ["CONTROL", C.control]] as const) {
    const r = await call(APPROVE.POST, `/automations/${id}/owner-approval`, cookie, "POST", { reason: REASON, expectedVersion: 1, body: {} }, { id });
    check(`${who} cannot record the owner approval (403 — SYSTEM_ADMIN only, O-18)`, r.status === 403 && fake.one("AutomationDefinition", { id })!.ownerApprovedVersion === null, r.body);
  }
  const adminNoReason = await call(APPROVE.POST, `/automations/${id}/owner-approval`, C.admin, "POST", { expectedVersion: 1, body: {} }, { id });
  check("SYSTEM_ADMIN without a reason ⇒ 400, nothing written", adminNoReason.status === 400 && fake.one("AutomationDefinition", { id })!.ownerApprovedVersion === null);
  const adminStale = await call(APPROVE.POST, `/automations/${id}/owner-approval`, C.admin, "POST", { reason: REASON, expectedVersion: 7, body: {} }, { id });
  check("a stale expectedVersion ⇒ 409 CONFLICT with `current` (D5), nothing written", adminStale.status === 409 && adminStale.body.code === "CONFLICT" && adminStale.body.current === 1);
  const approved = await call(APPROVE.POST, `/automations/${id}/owner-approval`, C.admin, "POST", { reason: REASON, expectedVersion: 1, body: {} }, { id });
  const row1 = fake.one("AutomationDefinition", { id }) as any;
  check("SYSTEM_ADMIN approves: (version 1, definitionVersion) pinned, approval does NOT activate and does NOT bump the token; one audit row with the reason",
    approved.status === 200 && row1.ownerApprovedVersion === 1 && row1.ownerApprovedDefinitionVersion === getCatalogDefinition("MEMBER_ROLE_CHANGED")!.definitionVersion
    && row1.state === "DRAFT" && row1.version === 1 && approved.body.result.ownerApproval.current === true && audits("COMMS_AUTOMATION_OWNER_APPROVED").length === 1
    && (audits("COMMS_AUTOMATION_OWNER_APPROVED")[0].metadata as any).reason.code === "DOGFOOD" && approved.body.result.viewer.canApproveAsOwner === true, approved.body);
  gate(true);
  const noDry = await call(ACTIVATE.POST, `/automations/${id}/activate`, C.control, "POST", { reason: REASON, expectedVersion: 1, body: {} }, { id });
  check("approved but never dry-run ⇒ 409 DRY_RUN_REQUIRED", noDry.status === 409 && noDry.body.code === "DRY_RUN_REQUIRED", noDry.body);
  gate(false);

  // ── 4. dry run ─────────────────────────────────────────────────────────────
  console.log("4. dry run (v1.1 §6.8): sends nothing, claims nothing, writes no ledger row; echoes the window");
  fake.seed("User", { id: "cust_1", email: "cust_1@example.invalid", username: "cust1", emailVerifiedAt: new Date(), createdAt: new Date(Date.now() - 90 * 86_400_000) });
  fake.seed("AuditLog", { action: "MEMBER_ROLE_CHANGED", userId: "op_write", spaceId: "sp_1", createdAt: new Date(Date.now() - 86_400_000), metadata: { targetUserId: "cust_1", targetName: "Name", oldRole: "MEMBER", newRole: "ADMIN" } });
  const before = { notes: fake.rows("Notification").length, ledger: fake.rows("CommsDelivery").length, items: fake.rows("AutomationRunItem").length };
  const readDry = await call(DRY.POST, `/automations/${id}/dry-run`, C.read, "POST", { reason: REASON, body: { window: "30d" } }, { id });
  check("READ cannot dry-run (403)", readDry.status === 403);
  const dry = await call(DRY.POST, `/automations/${id}/dry-run`, C.write, "POST", { reason: REASON, body: { window: "30d" } }, { id });
  check("WRITE dry-run (200): ONE AutomationRun{DRY_RUN}, the replayed fact matched, ZERO notifications, ZERO ledger rows, ZERO claimed items",
    dry.status === 200 && fake.rows("AutomationRun", { mode: "DRY_RUN" }).length === 1 && dry.body.result.counts.matched === 1
    && fake.rows("Notification").length === before.notes && fake.rows("CommsDelivery").length === before.ledger && fake.rows("AutomationRunItem").length === before.items, dry.body);
  const lc = dry.body.result.lifecycle;
  check("…the window is echoed (C8: 30d, from/to YYYY-MM-DD), the one lifecycle person is a small cell (withheld, never a 1), one audit row",
    dry.body.result.window?.window === "30d" && /^\d{4}-\d{2}-\d{2}$/.test(dry.body.result.window.from)
    && Object.values(lc).filter((v: any) => v.withheld === true).length === 1 && Object.values(lc).every((v: any) => v.value === 0 || v.value === null)
    && audits("COMMS_AUTOMATION_DRY_RUN").length === 1, dry.body.result);
  check("…and the examples are SYNTHETIC (no real name or Space)", JSON.stringify(dry.body.result.examples).indexOf("cust1") === -1 && dry.body.result.examples.length >= 1);
  // HARDENING A6 — MEMBER_ROLE_CHANGED already has an EV-1 producer: the dry run, the detail and the owner-approval audit say so.
  check("HARDENING A6: the dry-run result, the detail and the owner-approval audit carry overlapsExistingDelivery: true (an EV-1 handler already delivers it)",
    dry.body.result.overlapsExistingDelivery === true && approved.body.result.overlapsExistingDelivery === true
    && (audits("COMMS_AUTOMATION_OWNER_APPROVED")[0].metadata as any).overlapsExistingDelivery === true, { dry: dry.body.result.overlapsExistingDelivery, det: approved.body.result.overlapsExistingDelivery });
  const one = await call(DRY.POST, `/automations/${id}/dry-run`, C.write, "POST", { reason: REASON, body: { sample: { triggerRef: "nope_ref" } } }, { id });
  check("a single unknown triggerRef ⇒ 404 (nothing recorded)", one.status === 404 && fake.rows("AutomationRun", { mode: "DRY_RUN" }).length === 1);

  {
    const stillGated = await call(ACTIVATE.POST, `/automations/${id}/activate`, C.control, "POST", { reason: REASON, expectedVersion: 1, body: {} }, { id });
    check("HARD GATE: owner approval + a fresh dry run both worked while closed, yet activation is still refused",
      stillGated.status === 409 && stillGated.body.code === "ACTIVATION_DISABLED_PENDING_HARDENING" && fake.one("AutomationDefinition", { id })!.ownerApprovedVersion === 1
      && fake.rows("AutomationRun", { mode: "DRY_RUN", automationId: id }).length === 1 && fake.one("AutomationDefinition", { id })!.state === "DRAFT");
  }

  // ── M1: a dry run is stamped ONLY with the version it evaluated ───────────
  console.log("4b. review M1 — a PATCH landing mid-dry-run ⇒ CONFLICT (checked inside the dry-run transaction)");
  {
    const c2 = await call(LIST.POST, "/automations", C.write, "POST", createBody({ name: "race subject" }));
    const rid = c2.body.result.id as string;
    const WRITE_AUTH = { user: { id: "op_write", role: "USER" }, grant: { area: "CUSTOMER_SUCCESS", level: "WRITE" } };
    const actor = { userId: "op_write", via: "PLATFORM_GRANT" as const };
    let patched = false;
    const racing = {
      ...automationServices,
      dryRun: {
        ...automationServices.dryRun,
        // The evaluation reads v1, then — mid-evaluation — a real PATCH moves the row to v2.
        freeze: async () => {
          const cur = fake.one("AutomationDefinition", { id: rid }) as any;
          const r = await S.updateAutomation({ id: rid, expectedVersion: cur.version, actor, reason: REASON as any, fields: (row) => ({ ...S.fieldsOf(row), name: "edited mid-dry-run" }) });
          patched = r.ok;
          return { frozen: false, state: "MISSING" as const, reason: null };
        },
      },
    };
    const runsBefore = fake.rows("AutomationRun", { automationId: rid }).length;
    const auditBefore = audits("COMMS_AUTOMATION_DRY_RUN").length;
    const r = await quiet(() => H.dryRunHandler(rid, { reason: REASON, body: { window: "7d" } }, WRITE_AUTH, {}, new Date(), racing as any));
    const b = (await r.json()) as any;
    const row = fake.one("AutomationDefinition", { id: rid }) as any;
    check("the PATCH landed (v1 → v2) and the dry run of v1 is 409 CONFLICT {current: 2}: no run row, no audit row, no lastDryRunId",
      patched && r.status === 409 && b.code === "CONFLICT" && b.current === 2 && fake.rows("AutomationRun", { automationId: rid }).length === runsBefore
      && audits("COMMS_AUTOMATION_DRY_RUN").length === auditBefore && row.lastDryRunId === null && row.version === 2, b);
    const stale = await S.recordDryRun({ id: rid, evaluatedVersion: 1, evaluation: { counts: R.emptyCounts(), deduped: 0, lifecycle: {} as any, content: [], examples: [], wouldExceedMaxRecipients: false, floor: false, window: null, haltReason: null }, actor, reason: REASON as any, now: new Date() });
    check("recordDryRun REQUIRES the evaluated version and refuses a stale one inside its transaction", !stale.ok && (stale as any).code === "CONFLICT" && (stale as any).current === 2);
    const ok = await call(DRY.POST, `/automations/${rid}/dry-run`, C.write, "POST", { reason: REASON, expectedVersion: 2, body: {} }, { id: rid });
    check("without a race the dry run of v2 is recorded as v2", ok.status === 200 && fake.one("AutomationRun", { id: ok.body.result.runId })!.automationVersion === 2);
    const mism = await call(DRY.POST, `/automations/${rid}/dry-run`, C.write, "POST", { reason: REASON, expectedVersion: 1, body: {} }, { id: rid });
    check("a client expectedVersion that is not the current version ⇒ CONFLICT before evaluating", mism.status === 409 && mism.body.code === "CONFLICT");
  }

  // ── M2: definition drift; customer-facing from the LIVE definition ────────
  console.log("4c. review M2 — stored definitionVersion behind the code ⇒ approval AND activation refused; customerFacing is live");
  {
    const codeV = getCatalogDefinition("MEMBER_ROLE_CHANGED")!.definitionVersion;
    const now = Date.now();
    const drift = fake.seed("AutomationDefinition", {
      name: "drifted", triggerKey: "space.member.role_changed", definitionKey: "MEMBER_ROLE_CHANGED", definitionVersion: codeV - 1,
      customerFacing: false, channels: ["IN_APP"], conditions: [], recipient: { kind: "EVENT_SUBJECT_USER" }, dedupeKeyTemplate: "K:{recipientId}",
      frequencyCapMax: 1, frequencyCapHours: 24, state: "DRAFT", version: 3, ownerApprovedVersion: 3, ownerApprovedDefinitionVersion: codeV - 1,
      ownerApprovedAt: new Date(now), createdById: "op_write", updatedById: "op_write",
    });
    const did = drift.id as string;
    const dr = fake.seed("AutomationRun", { automationId: did, automationVersion: 3, mode: "DRY_RUN", triggerKey: "space.member.role_changed", status: "SUCCEEDED", counts: {}, startedAt: new Date(now) });
    fake.one("AutomationDefinition", { id: did })!.lastDryRunId = dr.id;
    const appr = await call(APPROVE.POST, `/automations/${did}/owner-approval`, C.admin, "POST", { reason: REASON, expectedVersion: 3, body: {} }, { id: did });
    check("owner approval of a row validated against an OLDER definition ⇒ 409 INVALID_STATE / DEFINITION_CHANGED, nothing written",
      appr.status === 409 && appr.body.code === "INVALID_STATE" && appr.body.activationBlockers?.includes("DEFINITION_CHANGED")
      && fake.one("AutomationDefinition", { id: did })!.ownerApprovedDefinitionVersion === codeV - 1, appr.body);
    gate(true);
    const act = await call(ACTIVATE.POST, `/automations/${did}/activate`, C.control, "POST", { reason: REASON, expectedVersion: 3, body: {} }, { id: did });
    gate(false);
    check("activation of the drifted row ⇒ 409 with DEFINITION_CHANGED among the blockers, still DRAFT",
      act.status === 409 && act.body.activationBlockers.includes("DEFINITION_CHANGED") && fake.one("AutomationDefinition", { id: did })!.state === "DRAFT", act.body);
    const view = await call(ONE.GET, `/automations/${did}`, C.control, "GET", undefined, { id: did });
    check("customerFacing is read from the LIVE definition (true), not the stored false — so OWNER_APPROVAL_REQUIRED applies",
      view.body.customerFacing === true && view.body.activationBlockers.includes("OWNER_APPROVAL_REQUIRED") && view.body.activationBlockers.includes("DEFINITION_CHANGED"), view.body.activationBlockers);
    const pure = R.activationBlockers({ state: "DRAFT", version: 1, definitionVersion: codeV, triggerKey: "space.member.role_changed", customerFacing: false, ownerApprovedVersion: null, ownerApprovedDefinitionVersion: null, lastDryRun: { automationVersion: 1, status: "SUCCEEDED", startedAt: new Date(), wouldExceedMaxRecipients: false, window: true } },
      getCatalogDefinition("MEMBER_ROLE_CHANGED")!, new Date());
    check("a stored customerFacing=false never skips the owner-approval gate when the code definition is customer-facing", pure.includes("OWNER_APPROVAL_REQUIRED"), pure);
    const fix = await call(ONE.PATCH, `/automations/${did}`, C.write, "PATCH", { reason: REASON, expectedVersion: 3, body: {} }, { id: did });
    check("a re-validating PATCH moves the row to the code definitionVersion and re-derives customerFacing (DEFINITION_CHANGED clears)",
      fix.status === 200 && fake.one("AutomationDefinition", { id: did })!.definitionVersion === codeV && fake.one("AutomationDefinition", { id: did })!.customerFacing === true
      && !fix.body.result.activationBlockers.includes("DEFINITION_CHANGED"), fix.body.result?.activationBlockers);
  }
  gate(true); // the rest of this suite exercises the post-hardening activation path

  // ── same-transaction audit ─────────────────────────────────────────────────
  console.log("2b. reason + audit in the SAME transaction");
  fake.on("AuditLog", "create", () => { throw new Error("audit store down"); }, { once: true });
  const auditDown = await call(ACTIVATE.POST, `/automations/${id}/activate`, C.control, "POST", { reason: REASON, expectedVersion: 1, body: {} }, { id });
  check("activation whose AUDIT write fails ⇒ 503 and the change ROLLS BACK (still DRAFT, no activatedVersion)",
    auditDown.status === 503 && fake.one("AutomationDefinition", { id })!.state === "DRAFT" && fake.one("AutomationDefinition", { id })!.activatedVersion === null, auditDown.body);
  const act = await call(ACTIVATE.POST, `/automations/${id}/activate`, C.control, "POST", { reason: REASON, expectedVersion: 1, body: {} }, { id });
  const row2 = fake.one("AutomationDefinition", { id }) as any;
  check("CONTROL activates (owner-approved v1 + a fresh dry run of v1): ACTIVE, activatedVersion 1, token bumped, cursor = now, ONE audit row with the reason",
    act.status === 200 && row2.state === "ACTIVE" && row2.activatedVersion === 1 && row2.version === 2 && row2.triggerCursorAt instanceof Date
    && audits("COMMS_AUTOMATION_ACTIVATED").length === 1 && (audits("COMMS_AUTOMATION_ACTIVATED")[0].metadata as any).reason.code === "DOGFOOD", act.body);
  check("activation SENT nothing", fake.rows("Notification").length === before.notes && fake.rows("CommsDelivery").length === before.ledger);
  const patchActive = await call(ONE.PATCH, `/automations/${id}`, C.write, "PATCH", { reason: REASON, expectedVersion: 2, body: { name: "x" } }, { id });
  check("PATCH an ACTIVE automation ⇒ 409 INVALID_STATE", patchActive.status === 409 && patchActive.body.code === "INVALID_STATE");
  // A scheduled item to be cancelled by the pause.
  const runRow = fake.seed("AutomationRun", { automationId: id, automationVersion: 1, mode: "LIVE", triggerKey: "space.member.role_changed", status: "SUCCEEDED", counts: {} });
  fake.seed("AutomationRunItem", { runId: runRow.id, automationId: id, automationVersion: 1, channel: "IN_APP", recipientUserId: "cust_1", idempotencyKey: "k1", status: "SCHEDULED", notBefore: new Date(Date.now() + 3_600_000) });
  const paused = await call(PAUSE.POST, `/automations/${id}/pause`, C.write, "POST", { reason: REASON, expectedVersion: 2, body: {} }, { id });
  check("WRITE pauses (reducing reach is WRITE): PAUSED, its SCHEDULED item CANCELLED / AUTOMATION_PAUSED in the same transaction, audited (cancelledItems: 1)",
    paused.status === 200 && fake.one("AutomationDefinition", { id })!.state === "PAUSED" && fake.one("AutomationRunItem", { idempotencyKey: "k1" })!.status === "CANCELLED"
    && fake.one("AutomationRunItem", { idempotencyKey: "k1" })!.reason === "AUTOMATION_PAUSED" && audits("COMMS_AUTOMATION_PAUSED").length === 1
    && (audits("COMMS_AUTOMATION_PAUSED")[0].metadata as any).cancelledItems === 1, paused.body);
  {
    const m = audits("COMMS_AUTOMATION_PAUSED")[0].metadata as any;
    const am = audits("COMMS_AUTOMATION_ACTIVATED")[0].metadata as any;
    const dv = getCatalogDefinition("MEMBER_ROLE_CHANGED")!.definitionVersion;
    check("the pause audit carries actor, reason, version and definitionVersion; so does the activation audit",
      audits("COMMS_AUTOMATION_PAUSED")[0].performedByAdminId === "op_write" && m.reason?.code === "DOGFOOD" && m.change?.before?.version === 2 && m.definitionVersion === dv && m.definitionKey === "MEMBER_ROLE_CHANGED"
      && audits("COMMS_AUTOMATION_ACTIVATED")[0].performedByAdminId === "op_control" && am.reason?.code === "DOGFOOD" && am.change?.before?.version === 1 && am.definitionVersion === dv, { m, am });
  }
  {
    const rows: any[] = [];
    const S = await import("./store");
    await S.recordCancellations(async (r) => { rows.push(r); }, { VERCEL: "1", VERCEL_ENV: "production" }, "MEMBER_ROLE_CHANGED", [{ id: "it1", recipientUserId: "cust_1", channel: "IN_APP", attempt: 0, runId: "r" }]);
    check("…each cancelled item gets ONE CANCELLED / AUTOMATION_PAUSED ledger row (messageKey = item id), written after commit",
      rows.length === 1 && rows[0].status === "CANCELLED" && rows[0].reason === "AUTOMATION_PAUSED" && rows[0].messageKey === "it1" && rows[0].automationRunItemId === "it1");
  }
  const patched = await call(ONE.PATCH, `/automations/${id}`, C.write, "PATCH", { reason: REASON, expectedVersion: 3, body: { name: "Role changed nudge v2", delay: { minutes: 30 } } }, { id });
  check("PATCH while PAUSED bumps the token and VOIDS the owner approval (current: false) and the dry run",
    patched.status === 200 && patched.body.result.version === 4 && patched.body.result.ownerApproval.current === false
    && patched.body.result.activationBlockers.includes("OWNER_APPROVAL_REQUIRED") && patched.body.result.activationBlockers.includes("DRY_RUN_REQUIRED"), patched.body);
  const reAct = await call(ACTIVATE.POST, `/automations/${id}/activate`, C.control, "POST", { reason: REASON, expectedVersion: 4, body: {} }, { id });
  check("re-activating the edited version ⇒ 409 OWNER_APPROVAL_REQUIRED (the old approval does not carry over)", reAct.status === 409 && reAct.body.code === "OWNER_APPROVAL_REQUIRED");
  const detailCtl = await call(ONE.GET, `/automations/${id}`, C.control, "GET", undefined, { id });
  check("GET detail as CONTROL: viewer.canActivate true, canApproveAsOwner false; history lists the audited actions (ids + actor kind only)",
    detailCtl.status === 200 && detailCtl.body.viewer.canActivate === true && detailCtl.body.viewer.canApproveAsOwner === false
    && detailCtl.body.history.length >= 5 && detailCtl.body.history.every((h: any) => typeof h.auditLogId === "string" && !("userId" in h)), detailCtl.body.history);
  const list = await call(LIST.GET, "/automations?state=PAUSED", C.read, "GET");
  const runs = await call(RUNS.GET, `/automations/${id}/runs`, C.read, "GET", undefined, { id });
  check("GET list (READ) and runs (READ): envelopes with counts only", list.status === 200 && list.body.items.length === 1 && list.body.items[0].id === id
    && runs.status === 200 && runs.body.items.length === 2 && runs.body.items.every((r: any) => typeof r.counts.suppressed.BETA_LIFECYCLE === "number"), { list: list.body, runs: runs.body });
  const disabled = await call(DISABLE.POST, `/automations/${id}/disable`, C.write, "POST", { reason: REASON, expectedVersion: 4, body: {} }, { id });
  const actDisabled = await call(ACTIVATE.POST, `/automations/${id}/activate`, C.control, "POST", { reason: REASON, expectedVersion: 5, body: {} }, { id });
  check("disable is terminal: DISABLED, then activate ⇒ 409 INVALID_STATE", disabled.status === 200 && fake.one("AutomationDefinition", { id })!.state === "DISABLED" && actDisabled.status === 409 && actDisabled.body.code === "INVALID_STATE");

  // ── 3. write-body rules ────────────────────────────────────────────────────
  console.log("3. the write body: no copy, no code, closed sets; PROTECTED before validation");
  const prot = await call(LIST.POST, "/automations", C.write, "POST", { body: { definitionKey: "PASSWORD_CHANGED", junk: true } });
  check("a PROTECTED definition ⇒ 409 PROTECTED even with a malformed body and no reason", prot.status === 409 && prot.body.code === "PROTECTED", prot.body);
  for (const k of ["subject", "body", "template", "code", "html", "recipients", "to"]) {
    const r = await call(LIST.POST, "/automations", C.write, "POST", createBody({ [k]: "x" }));
    check(`a "${k}" field ⇒ 400 (automations carry no copy / code / addresses)`, r.status === 400, r.body);
  }
  const badPred = await call(LIST.POST, "/automations", C.write, "POST", createBody({ conditions: [{ op: "event.expression", js: "1" }] }));
  const piiField = await call(LIST.POST, "/automations", C.write, "POST", createBody({ conditions: [{ op: "event.field_equals", field: "targetName", value: "x" }] }));
  const nine = await call(LIST.POST, "/automations", C.write, "POST", createBody({ conditions: Array.from({ length: 9 }, () => ({ op: "recipient.has_verified_email" })) }));
  check("conditions: an op outside the closed set, a field the trigger does not carry, and a 9th condition are all 400", badPred.status === 400 && piiField.status === 400 && nine.status === 400);
  const badChannel = await call(LIST.POST, "/automations", C.write, "POST", { reason: REASON, body: { triggerKey: "space.member.invited", definitionKey: "SPACE_INVITE_RECEIVED", name: "x", recipient: { kind: "EVENT_SUBJECT_USER" }, channels: ["EMAIL"] } });
  check("a DIRECT ceremony email leg (space-invite) is not automatable ⇒ 400", badChannel.status === 400, badChannel.body);
  const badTpl = await call(LIST.POST, "/automations", C.write, "POST", createBody({ dedupeKeyTemplate: "K:{targetName}" }));
  const noRecip = await call(LIST.POST, "/automations", C.write, "POST", createBody({ dedupeKeyTemplate: "K:{spaceId}" }));
  check("a dedupe template naming a non-payload field, or missing {recipientId}, ⇒ 400", badTpl.status === 400 && noRecip.status === 400);
  const wrongTrig = await call(LIST.POST, "/automations", C.write, "POST", createBody({ triggerKey: "space.member.joined" }));
  check("a trigger that does not produce the definition ⇒ 400", wrongTrig.status === 400);
  const loosen = R.validateAutomationInput({ name: "x", recipient: { kind: "EVENT_SUBJECT_USER" }, frequencyCap: { max: 5, perHours: 1 } },
    { def: { ...getCatalogDefinition("MEMBER_ROLE_CHANGED")!, frequencyCap: { max: 1, perHours: 24 } }, trigger: "space.member.role_changed" });
  check("a frequency cap may only TIGHTEN the definition's", !loosen.ok);

  // ── 5. activation preconditions ───────────────────────────────────────────
  console.log("5. activation preconditions (v1.1 §6.3)");
  const sf = await call(LIST.POST, "/automations", C.write, "POST", { reason: REASON, body: { triggerKey: "plaid.item.sync_failed", definitionKey: "SYNC_FAILED", name: "x", recipient: { kind: "EVENT_SUBJECT_USER" } } });
  check("a trigger with no engine fact source ⇒ TRIGGER_NOT_AVAILABLE among the blockers (draft allowed, activation never)", sf.status === 201 && sf.body.result.activationBlockers.includes("TRIGGER_NOT_AVAILABLE"), sf.body);
  const mkt = R.activationBlockers({ state: "DRAFT", version: 1, definitionVersion: 1, triggerKey: "space.member.role_changed", customerFacing: true, ownerApprovedVersion: 1, ownerApprovedDefinitionVersion: 1, lastDryRun: { automationVersion: 1, status: "SUCCEEDED", startedAt: new Date(), wouldExceedMaxRecipients: false, window: true } },
    { ...getCatalogDefinition("MEMBER_ROLE_CHANGED")!, consentClass: "MARKETING", definitionVersion: 1 }, new Date());
  check("MARKETING ⇒ MARKETING_NOT_IN_V1 (no marketing in v1)", mkt.includes("MARKETING_NOT_IN_V1"), mkt);
  const stale = R.activationBlockers({ state: "DRAFT", version: 1, definitionVersion: 1, triggerKey: "space.member.role_changed", customerFacing: true, ownerApprovedVersion: 1, ownerApprovedDefinitionVersion: 1, lastDryRun: { automationVersion: 1, status: "SUCCEEDED", startedAt: new Date(Date.now() - 8 * 86_400_000), wouldExceedMaxRecipients: false, window: true } },
    { ...getCatalogDefinition("MEMBER_ROLE_CHANGED")!, definitionVersion: 1 }, new Date());
  const over = R.activationBlockers({ state: "DRAFT", version: 1, definitionVersion: 1, triggerKey: "space.member.role_changed", customerFacing: true, ownerApprovedVersion: 1, ownerApprovedDefinitionVersion: 1, lastDryRun: { automationVersion: 1, status: "SUCCEEDED", startedAt: new Date(), wouldExceedMaxRecipients: true, window: true } },
    { ...getCatalogDefinition("MEMBER_ROLE_CHANGED")!, definitionVersion: 1 }, new Date());
  const codeMoved = R.activationBlockers({ state: "DRAFT", version: 1, definitionVersion: 1, triggerKey: "space.member.role_changed", customerFacing: true, ownerApprovedVersion: 1, ownerApprovedDefinitionVersion: 1, lastDryRun: null },
    { ...getCatalogDefinition("MEMBER_ROLE_CHANGED")!, definitionVersion: 2 }, new Date());
  check("a dry run older than 7 days, or one that would exceed the recipient cap, ⇒ DRY_RUN_REQUIRED; a definition code bump voids the approval",
    stale.includes("DRY_RUN_REQUIRED") && over.includes("DRY_RUN_REQUIRED") && codeMoved.includes("OWNER_APPROVAL_REQUIRED"), { stale, over, codeMoved });
  check("nothing customer-facing ships ACTIVE: no automation row exists outside this test, and no migration seeds one",
    !/INSERT INTO "AutomationDefinition"/i.test(readFileSync("prisma/migrations/20261031220000_comms_automations/migration.sql", "utf8")));

  // ── 7. the migration: additive, RLS ENABLE + FORCE, least-privilege grants ──
  console.log("7. the migration (20261031220000_comms_automations): additive, RLS, house grants");
  {
    const sql = readFileSync("prisma/migrations/20261031220000_comms_automations/migration.sql", "utf8").replace(/--[^\n]*/g, "");
    const names = readdirSync("prisma/migrations").filter((n) => /^\d{14}_/.test(n)).sort();
    // Phase C's 20261031230000_comms_provider_events now follows it; it must still sort after B1.
    check("it sorts after 20261031210000 (the B1 migration)", names.indexOf("20261031220000_comms_automations") > names.indexOf("20261031210000_comms_template_versions"));
    check("additive only: no DROP, no ALTER COLUMN, no UPDATE / DELETE of rows; CommsDelivery gains two columns", !/\bDROP\b|ALTER\s+COLUMN|^\s*UPDATE\s|^\s*DELETE\s/im.test(sql)
      && /ALTER TABLE "CommsDelivery" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'LIVE'/.test(sql) && /ALTER TABLE "CommsDelivery" ADD COLUMN "automationRunItemId" TEXT;/.test(sql));
    for (const t of ["AutomationDefinition", "AutomationRun", "AutomationRunItem"]) {
      check(`${t}: ENABLE + FORCE RLS, an fm_system policy, fm_app / fm_auth revoked and never granted, fm_backup SELECT`,
        sql.includes(`ALTER TABLE public."${t}" ENABLE ROW LEVEL SECURITY;`) && sql.includes(`ALTER TABLE public."${t}" FORCE ROW LEVEL SECURITY;`)
        && sql.includes(`CREATE POLICY fm_system_all ON public."${t}" FOR ALL TO fm_system USING (true) WITH CHECK (true);`)
        && sql.includes(`REVOKE ALL ON TABLE public."${t}" FROM fm_app;`) && sql.includes(`REVOKE ALL ON TABLE public."${t}" FROM fm_auth;`)
        && !new RegExp(`GRANT[^;]*ON TABLE public\\."${t}" TO (fm_app|fm_auth)`).test(sql) && sql.includes(`GRANT SELECT ON TABLE public."${t}" TO fm_backup;`)
        && sql.includes(`'REVOKE ALL ON TABLE public."${t}" FROM anon, authenticated, service_role'`));
    }
    check("AutomationDefinition: SELECT, INSERT, UPDATE — NO DELETE (disabled rows are kept); runs and items: + DELETE (retention)",
      sql.includes(`GRANT SELECT, INSERT, UPDATE ON TABLE public."AutomationDefinition" TO fm_system;`)
      && sql.includes(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."AutomationRun" TO fm_system;`)
      && sql.includes(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."AutomationRunItem" TO fm_system;`));
    check("the claim is a UNIQUE index on idempotencyKey; one LIVE run per fact is a UNIQUE liveKey; items cascade with their run",
      /CREATE UNIQUE INDEX "AutomationRunItem_idempotencyKey_key"/.test(sql) && /CREATE UNIQUE INDEX "AutomationRun_liveKey_key"/.test(sql) && /REFERENCES "AutomationRun"\("id"\) ON DELETE CASCADE/.test(sql));
  }

  // ── 6. test send ──────────────────────────────────────────────────────────
  console.log("6. test send (v1.1 §6.9): SELF only; outside Production only when allowlisted; typed 422 guards");
  const outbox: EmailMessage[] = [];
  let providerFail = false;
  const provider = { name: "resend", send: async (m: EmailMessage) => {
    outbox.push(m);
    return providerFail ? { status: "error" as const, provider: "resend", error: "provider 500" } : { status: "sent" as const, id: `re_${outbox.length}`, provider: "resend" };
  } };
  const capture = { name: "capture", send: async (m: EmailMessage) => { outbox.push(m); return { status: "captured" as const, provider: "capture" }; } };
  const ledger = async (row: any) => { await (fake.delegate("CommsDelivery") as any).createMany({ data: [row] }); };
  let env: Record<string, string> = { VERCEL: "1", VERCEL_ENV: "production" };
  let self: { email: string | null; verified: boolean } | null = { email: "op_write@example.invalid", verified: true };
  let stormReads = 0;
  const svc = () => ({
    ...automationServices,
    content: { ...contentServices, readSelf: async () => self, env: env as any },
    ledger, ledgerEnv: env as any,
    sendEmail: createEmailSender({ env: { ...env, RESEND_API_KEY: "re_test_not_real", NODE_ENV: "production" } as any, provider, capture, ledger,
      storm: async () => { stormReads++; return 99; }, pending: new PendingSends(), log: () => {} }),
  });
  const WRITE_AUTH = { user: { id: "op_write", role: "USER" }, grant: { area: "CUSTOMER_SUCCESS", level: "WRITE" } };
  const ts = async (body: unknown) => {
    const r = await quiet(() => H.testSendHandler(body, WRITE_AUTH, { ip: "203.0.113.9" }, new Date(), svc() as any));
    return { status: r.status, body: (await r.json()) as any };
  };
  const tsAudits = () => audits("COMMS_TEST_SEND").length;
  const tsBody = (b: Record<string, unknown>) => ({ reason: REASON, body: { key: "SYNC_FAILED", channel: "EMAIL", ...b } });

  env = { VERCEL: "1", VERCEL_ENV: "preview" };
  const a0 = tsAudits();
  const nonprod = await ts(tsBody({}));
  check("Preview, own address NOT on EMAIL_NONPROD_ALLOWLIST ⇒ 422 GUARD_REFUSED guard NONPROD_ALLOWLIST, nothing rendered, sent or audited",
    nonprod.status === 422 && nonprod.body.code === "GUARD_REFUSED" && nonprod.body.guard === "NONPROD_ALLOWLIST" && outbox.length === 0 && tsAudits() === a0, nonprod.body);
  check("…and the refusal reveals nothing about the allowlist", !/allowlist(ed)? (has|contains|size|entries)|@/.test(nonprod.body.error));
  env = { VERCEL: "1", VERCEL_ENV: "preview", EMAIL_NONPROD_ALLOWLIST: "op_write@example.invalid" };
  const allowed = await ts(tsBody({}));
  check("Preview, own address allowlisted ⇒ sent to THAT address only", allowed.status === 200 && outbox.length === 1 && outbox[0].to === "op_write@example.invalid", allowed.body);
  env = { VERCEL: "1", VERCEL_ENV: "production" };
  self = { email: "op_write@example.invalid", verified: false };
  const unverified = await ts(tsBody({}));
  check("an UNVERIFIED own address ⇒ 422 guard SELF_UNVERIFIED", unverified.status === 422 && unverified.body.guard === "SELF_UNVERIFIED" && outbox.length === 1);
  self = { email: "op_write@example.invalid", verified: true };
  for (const k of ["to", "recipient", "address", "userId"]) {
    const r = await ts({ reason: REASON, body: { key: "SYNC_FAILED", channel: "EMAIL", [k]: "victim@example.invalid" } });
    check(`a "${k}" field ⇒ 400: there is no way to name another recipient`, r.status === 400 && outbox.length === 1);
  }
  const noR = await ts({ body: { key: "SYNC_FAILED", channel: "EMAIL" } });
  check("no reason ⇒ 400", noR.status === 400);
  stormReads = 0;
  const prodSend = await ts(tsBody({}));
  const last = outbox[outbox.length - 1];
  check("Production, verified: sent to the operator's OWN address, subject \"[TEST] …\", ledger mode TEST, the storm limit not consulted (OPERATOR-class), audited with the reason",
    prodSend.status === 200 && prodSend.body.result.status === "ACCEPTED" && last.to === "op_write@example.invalid" && last.subject.startsWith("[TEST] ")
    && fake.rows("CommsDelivery", { messageKey: prodSend.body.result.deliveryId, mode: "TEST" }).length === 1 && stormReads === 0
    && (audits("COMMS_TEST_SEND").at(-1)!.metadata as any).reason.code === "DOGFOOD" && (audits("COMMS_TEST_SEND").at(-1)!.metadata as any).recipient === "SELF", { b: prodSend.body, subject: last.subject });
  {
    // HARDENING N11 — the attempt row precedes the send; a second row records the REAL outcome.
    const rows = audits("COMMS_TEST_SEND").filter((r) => (r.metadata as any).deliveryId === prodSend.body.result.deliveryId);
    const [attemptRow, outcomeRow] = rows.map((r) => r.metadata as any);
    check("HARDENING N11: a test send writes the ATTEMPT row first, then an OUTCOME row with the real outcome (ACCEPTED ⇒ SUCCESS), the reason on both",
      rows.length === 2 && attemptRow.phase === "ATTEMPT" && outcomeRow.phase === "OUTCOME" && outcomeRow.outcome === "ACCEPTED" && outcomeRow.result === "SUCCESS"
      && outcomeRow.attemptAuditLogId === prodSend.body.auditLogId && outcomeRow.reason.code === "DOGFOOD", rows.map((r) => r.metadata));
    const failAt = outbox.length;
    providerFail = true;
    const failed = await ts(tsBody({}));
    providerFail = false;
    const fr = audits("COMMS_TEST_SEND").filter((r) => (r.metadata as any).deliveryId === failed.body.result?.deliveryId).map((r) => r.metadata as any);
    check("…a provider failure is recorded as result FAILURE / outcome FAILED (never a SUCCESS for a send that did not happen)",
      failed.status === 200 && failed.body.result.status === "FAILED" && fr.length === 2 && fr[1].result === "FAILURE" && fr[1].outcome === "FAILED" && outbox.length >= failAt, { b: failed.body, fr });
  }
  const prot2 = await ts({ reason: REASON, body: { key: "PASSWORD_RESET_LINK_SENT", channel: "EMAIL", versionId: "v1" } });
  check("versionId on a PROTECTED key ⇒ 409 PROTECTED", prot2.status === 409 && prot2.body.code === "PROTECTED");
  const protCode = await ts({ reason: REASON, body: { key: "PASSWORD_RESET_LINK_SENT", channel: "EMAIL" } });
  check("a protected key's CODE content may be test-sent (synthetic, non-redeemable token, to self, [TEST])",
    protCode.status === 200 && outbox.at(-1)!.to === "op_write@example.invalid" && outbox.at(-1)!.subject.startsWith("[TEST] ") && outbox.at(-1)!.text.includes("preview-not-redeemable"), protCode.body);
  const inApp = await ts({ reason: REASON, body: { key: "MEMBER_ROLE_CHANGED", channel: "IN_APP" } });
  const bell = fake.rows("Notification", { userId: "op_write", type: "MEMBER_ROLE_CHANGED" })[0] as any;
  check("IN_APP test send: a bell in the OPERATOR's own inbox, metadata._commsTest, expires in 24 h, ledger mode TEST, no email",
    inApp.status === 200 && bell && bell.metadata._commsTest === true && bell.expiresAt instanceof Date
    && fake.rows("CommsDelivery", { messageKey: inApp.body.result.deliveryId, mode: "TEST", channel: "IN_APP" }).length === 1 && fake.rows("Notification", { userId: { not: "op_write" } }).length === 0, inApp.body);

  console.log(failures === 0 ? "\n✅ comms automations endpoints: all checks passed" : `\n❌ ${failures} check(s) failed`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
