/**
 * lib/notifications/content/store.test.ts  (Comms Center B1 — versions, publish, rollback, the send path)
 *
 * The SAME handlers the routes call, over the in-memory Prisma fake (the real
 * schema), with injected auth:
 *   1. route wiring — every route names its gate (READ / fresh WRITE / fresh
 *      CONTROL) and its bucket; a refused gate does no work;
 *   2. the lifecycle — draft → publish → rollback, CONTROL + reason + ONE audit
 *      row in the SAME transaction (an audit failure rolls the change back);
 *   3. immutability and the optimistic token — every save is a new version,
 *      content is never updated, a stale expectedRevision is 409 CONFLICT
 *      with `current` and writes nothing; STALE_DRAFT; INVALID_STATE;
 *   4. 409 PROTECTED on every write to every locked template (malformed body too);
 *   5. render persists nothing and audits nothing;
 *   6. preview by versionId is synthetic only;
 *   7. the send path renders the PUBLISHED version, records contentVersionId,
 *      and falls back to the code template;
 *   8. the viewer block per role.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/notifications/content/store.test.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- assertions read loosely-typed JSON bodies */

import "@/lib/test-support/route-env";
import { readFileSync } from "node:fs";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}
const j = async (r: Response) => ({ status: r.status, body: (await r.json()) as any });
const code = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const fake = new FakePrisma();
const NOW = new Date("2026-10-31T12:00:00.000Z");
const META = { ip: "203.0.113.9", userAgent: "test" };
const REASON = { code: "SUPPORT_REQUEST" as const, note: "copy update" };

type Auth = { user: { id: string; role: string }; grant: { area: string; level: string } | null };
const READ: Auth = { user: { id: "op_read", role: "USER" }, grant: { area: "CUSTOMER_SUCCESS", level: "READ" } };
const WRITE: Auth = { user: { id: "op_write", role: "USER" }, grant: { area: "CUSTOMER_SUCCESS", level: "WRITE" } };
const CONTROL: Auth = { user: { id: "op_control", role: "USER" }, grant: { area: "CUSTOMER_SUCCESS", level: "CONTROL" } };
const ADMIN: Auth = { user: { id: "op_admin", role: "SYSTEM_ADMIN" }, grant: null };

const inAppContent = (title: string) => ({
  subject: `${title} {{institutionName}}`, preheader: null,
  blocks: [{ kind: "paragraph", text: "Please reconnect {{institutionName}} from Connections." }, { kind: "cta", label: "Reconnect now", link: "inAppHref" }],
});
const emailContent = () => ({
  subject: "Action needed for {{institutionName}}", preheader: "Sign in to {{institutionName}} again",
  blocks: [{ kind: "hero", heading: "Reconnect {{institutionName}}" }, { kind: "paragraph", text: "Edited copy: sign in to {{institutionName}} again." }, { kind: "cta", label: "Reconnect", link: "actionUrl" }],
});
const draftReq = (rev: number, content: unknown, opts: { channel?: string; variant?: string; parent?: string | null } = {}) => ({
  expectedRevision: rev,
  body: { channel: opts.channel ?? "IN_APP", variant: opts.variant ?? "reauth-required", parentVersionId: opts.parent ?? null, content, source: { kind: "MANUAL" } },
});

async function main(): Promise<void> {
  await installFakePrisma(fake);
  const H = await import("./http");
  const { contentServices } = await import("./deps");
  const store = await import("./store");
  const { createNotification } = await import("@/lib/notifications/create");
  const { liveRenderFor } = await import("./send");
  const { emailDataFor } = await import("@/lib/notifications/channels/email");
  const { createEmailSender } = await import("@/lib/email/send");
  const { renderNotificationEmail } = await import("@/lib/email/templates/notification");
  const { COMMS_CATALOG } = await import("@/lib/notifications/catalog/definitions");
  const { definitionLock, LIMITS } = await import("./legs");
  const { CODE_DEFAULT_VERSION_ID } = await import("./types");
  const { CODE_DEFAULT_ID } = store;
  const { NOTIFICATION_REGISTRY } = await import("@/lib/notifications/registry");
  const { AuditAction, OPERATOR_ACTION_FEED_ACTIONS } = await import("@/lib/audit-actions");
  const { REASON_REQUIRED_ACTIONS } = await import("@/lib/audit");

  let self: { email: string | null; verified: boolean } | null = { email: "op@example.invalid", verified: true };
  const aiCalls: unknown[] = [];
  const svc = {
    ...contentServices,
    readSelf: async () => self,
    env: { VERCEL: "1", VERCEL_ENV: "production" },
    ai: {
      admission: async () => ({ paused: false, state: "MISSING" as const, raw: null }),
      freeze: async () => ({ frozen: false, state: "MISSING" as const, reason: null }),
      readAllowance: async () => ({ allowed: true as const, remainingCalls: 40, remainingUsd: 2 }),
      reserve: async () => ({ verdict: { allowed: true as const, remainingCalls: 39, remainingUsd: 2 }, release: async () => {} }),
      call: async (a: unknown) => { aiCalls.push(a); throw new Error("the model must not be called by store.test"); },
      newId: () => `sug_${Math.random().toString(36).slice(2)}`,
    },
  } as unknown as Parameters<typeof H.versionsList>[4];

  // ── 1. route wiring ────────────────────────────────────────────────────────
  console.log("1. route wiring");
  const B = "app/api/platform/customer-success/notifications/catalog/[key]";
  const routes: Array<[string, string, RegExp]> = [
    [`${B}/versions/route.ts`, "GET", /export async function GET[\s\S]*requirePlatformAccess\("CUSTOMER_SUCCESS", "READ"\), rateLimit: csCommsReadLimit/],
    [`${B}/versions/route.ts`, "POST", /export async function POST[\s\S]*requireFreshPlatformAccess\("CUSTOMER_SUCCESS", "WRITE"\), rateLimit: csCommsWriteLimit/],
    [`${B}/versions/[id]/route.ts`, "GET", /requirePlatformAccess\("CUSTOMER_SUCCESS", "READ"\), rateLimit: csCommsReadLimit/],
    [`${B}/versions/[id]/publish/route.ts`, "POST", /requireFreshPlatformAccess\("CUSTOMER_SUCCESS", "CONTROL"\), rateLimit: csCommsControlLimit/],
    [`${B}/versions/[id]/rollback/route.ts`, "POST", /requireFreshPlatformAccess\("CUSTOMER_SUCCESS", "CONTROL"\), rateLimit: csCommsControlLimit/],
    [`${B}/versions/[id]/ai-suggest/route.ts`, "POST", /requireFreshPlatformAccess\("CUSTOMER_SUCCESS", "WRITE"\), rateLimit: csCommsAiLimit/],
    [`${B}/render/route.ts`, "POST", /requirePlatformAccess\("CUSTOMER_SUCCESS", "READ"\), rateLimit: csCommsRenderLimit/],
  ];
  for (const [f, m, re] of routes) check(`${f} ${m}: gate + bucket`, re.test(code(f)));
  check("publish / rollback routes never use a WRITE or READ gate", [`${B}/versions/[id]/publish/route.ts`, `${B}/versions/[id]/rollback/route.ts`].every((f) => !/"WRITE"|"READ"|requirePlatformAccess\(/.test(code(f))));
  check("buckets: render 30/min, write 20/min, ai 10 per 10 min, control 10/min",
    H.CS_COMMS_RENDER_LIMIT.limit === 30 && H.CS_COMMS_RENDER_LIMIT.windowSec === 60 && H.CS_COMMS_WRITE_LIMIT.limit === 20
    && H.CS_COMMS_AI_LIMIT.limit === 10 && H.CS_COMMS_AI_LIMIT.windowSec === 600 && H.CS_COMMS_CONTROL_LIMIT.limit === 10);
  let ran = 0;
  const denied = await H.runContent({ guard: async () => [null, new Response(JSON.stringify({ error: "Forbidden." }), { status: 403 })], rateLimit: async () => null }, async () => { ran++; return new Response("{}"); });
  check("a refused gate (403) does no work", denied.status === 403 && ran === 0 && (await j(denied)).body.code === "FORBIDDEN");
  check("audit vocabulary: publish + rollback reason-required, draft + ai optional",
    [AuditAction.COMMS_TEMPLATE_DRAFT_SAVED, AuditAction.COMMS_TEMPLATE_AI_SUGGESTED, AuditAction.COMMS_TEMPLATE_PUBLISHED, AuditAction.COMMS_TEMPLATE_ROLLED_BACK].every((a) => typeof a === "string" && !OPERATOR_ACTION_FEED_ACTIONS.includes(a))
    && REASON_REQUIRED_ACTIONS.has(AuditAction.COMMS_TEMPLATE_PUBLISHED) && REASON_REQUIRED_ACTIONS.has(AuditAction.COMMS_TEMPLATE_ROLLED_BACK)
    && !REASON_REQUIRED_ACTIONS.has(AuditAction.COMMS_TEMPLATE_DRAFT_SAVED) && !REASON_REQUIRED_ACTIONS.has(AuditAction.COMMS_TEMPLATE_AI_SUGGESTED));

  // ── 2. lifecycle ───────────────────────────────────────────────────────────
  console.log("2. draft → publish → rollback");
  const audits = (action: string) => fake.rows("AuditLog").filter((r) => r.action === action);
  const s1 = await j(await H.saveDraftHandler("SYNC_FAILED", draftReq(0, inAppContent("First")), WRITE, META, NOW, svc));
  check("draft 1 saved: 201, DRAFT, version 1, revision 1, OPERATOR", s1.status === 201 && s1.body.result.state === "DRAFT" && s1.body.result.version === 1 && s1.body.result.revision === 1 && s1.body.result.createdBy.kind === "OPERATOR", s1);
  const d1 = s1.body.result.id as string;
  const draftAudit = audits(AuditAction.COMMS_TEMPLATE_DRAFT_SAVED)[0] as any;
  check("one DRAFT_SAVED audit row, its id stored on the version, target the stream, no content text",
    audits(AuditAction.COMMS_TEMPLATE_DRAFT_SAVED).length === 1 && draftAudit.id === s1.body.result.auditLogId
    && draftAudit.metadata.target.kind === "COMMS_TEMPLATE" && draftAudit.metadata.target.id === "SYNC_FAILED:IN_APP:reauth-required"
    && !JSON.stringify(draftAudit.metadata).includes("Please reconnect"));
  const noReason = await j(await H.publishHandler("SYNC_FAILED", d1, { expectedRevision: 1, body: { acknowledgeWarnings: false } }, CONTROL, META, NOW, svc).catch((e) => new Response(JSON.stringify({ code: e.name }), { status: 400 })));
  check("publish without a reason is refused and nothing changes", noReason.status === 400 && (fake.one("CommsTemplate", { definitionKey: "SYNC_FAILED" }) as any).publishedVersionId === null);

  // Same transaction: an audit failure rolls the publish back.
  fake.on("AuditLog", "create", () => { throw new Error("audit store down"); }, { once: true });
  const failed = await H.runContent({ guard: async () => [CONTROL as never, null], rateLimit: async () => null },
    (auth, now) => H.publishHandler("SYNC_FAILED", d1, { reason: REASON, expectedRevision: 1, body: { acknowledgeWarnings: true } }, auth, META, now, svc));
  const headAfterFail = fake.one("CommsTemplate", { definitionKey: "SYNC_FAILED" }) as any;
  check("an audit-write failure ⇒ 503 and the publish is rolled back (no publishedAt, head unchanged)",
    failed.status === 503 && headAfterFail.publishedVersionId === null && headAfterFail.revision === 1 && (fake.one("CommsTemplateVersion", { id: d1 }) as any).publishedAt === null);

  // …and a failure AFTER the audit row (the head update) rolls the audit row back with it.
  const auditCount = fake.rows("AuditLog").length;
  fake.on("CommsTemplate", "updateMany", () => { throw new Error("head write failed"); }, { once: true });
  const failed2 = await H.runContent({ guard: async () => [CONTROL as never, null], rateLimit: async () => null },
    (auth, now) => H.publishHandler("SYNC_FAILED", d1, { reason: REASON, expectedRevision: 1, body: { acknowledgeWarnings: true } }, auth, META, now, svc));
  check("a failure after the audit write ⇒ 503 and NO audit row survives (one transaction)",
    failed2.status === 503 && fake.rows("AuditLog").length === auditCount && (fake.one("CommsTemplateVersion", { id: d1 }) as any).publishedAt === null);
  const storeCode = code("lib/notifications/content/store.ts");
  check("store.ts: every audit row is written through the transaction client", (storeCode.match(/await audit\(/g) ?? []).length === 5 && (storeCode.match(/await audit\(tx, /g) ?? []).length === 5);

  const p1 = await j(await H.publishHandler("SYNC_FAILED", d1, { reason: REASON, expectedRevision: 1, body: { acknowledgeWarnings: false } }, CONTROL, META, NOW, svc));
  const pubAudit = audits(AuditAction.COMMS_TEMPLATE_PUBLISHED);
  check("publish: 200, PUBLISHED, superseded = CODE_DEFAULT, revision 2 returned (D6c)",
    p1.status === 200 && p1.body.result.published.state === "PUBLISHED" && p1.body.result.superseded.source === "CODE_DEFAULT" && p1.body.result.revision === 2, p1);
  check("ONE PUBLISHED audit row with the reason; its id is the version's publishAuditLogId; change before/after are ids + hash",
    pubAudit.length === 1 && (pubAudit[0] as any).id === p1.body.result.published.publishAuditLogId && (pubAudit[0] as any).metadata.reason.code === "SUPPORT_REQUEST"
    && (pubAudit[0] as any).metadata.change.before.versionId === null && (pubAudit[0] as any).metadata.change.after.versionId === d1 && typeof (pubAudit[0] as any).metadata.change.after.contentHash === "string");

  const s2 = await j(await H.saveDraftHandler("SYNC_FAILED", draftReq(2, inAppContent("Second"), { parent: d1 }), WRITE, META, NOW, svc));
  const d2 = s2.body.result.id as string;
  check("draft 2 is a NEW version (2) based on the live one", s2.status === 201 && s2.body.result.version === 2 && s2.body.result.basePublishedVersionId === d1 && s2.body.result.parentVersionId === d1);
  const p2 = await j(await H.publishHandler("SYNC_FAILED", d2, { reason: REASON, expectedRevision: 3, body: { acknowledgeWarnings: false } }, CONTROL, META, NOW, svc));
  check("publish draft 2 supersedes version 1", p2.status === 200 && p2.body.result.superseded.versionId === d1 && p2.body.result.superseded.version === 1);
  const v1 = await j(await H.versionGet("SYNC_FAILED", d1, svc));
  check("version 1 is now SUPERSEDED, content unchanged", v1.body.state === "SUPERSEDED" && v1.body.subject === "First {{institutionName}}");

  const rbDraft = await j(await H.rollbackHandler("SYNC_FAILED", d2, { reason: REASON, expectedRevision: 4 }, CONTROL, META, NOW, svc));
  check("rollback to the LIVE version is INVALID_STATE", rbDraft.status === 409 && rbDraft.body.code === "INVALID_STATE");
  const rb = await j(await H.rollbackHandler("SYNC_FAILED", d1, { reason: REASON, expectedRevision: 4 }, CONTROL, META, NOW, svc));
  check("rollback to version 1: a NEW version 3 (ROLLBACK, restoredFrom v1) is published; v2 superseded; revision 5",
    rb.status === 200 && rb.body.result.published.version === 3 && rb.body.result.published.createdBy.kind === "ROLLBACK"
    && rb.body.result.published.restoredFromVersionId === d1 && rb.body.result.superseded.versionId === d2 && rb.body.result.revision === 5, rb);
  check("one ROLLED_BACK audit row with the reason", audits(AuditAction.COMMS_TEMPLATE_ROLLED_BACK).length === 1 && (audits(AuditAction.COMMS_TEMPLATE_ROLLED_BACK)[0] as any).metadata.reason.code === "SUPPORT_REQUEST");
  const rbNoReason = await H.runContent({ guard: async () => [CONTROL as never, null], rateLimit: async () => null },
    (auth, now) => H.rollbackHandler("SYNC_FAILED", "code-default", { expectedRevision: 5, body: { channel: "IN_APP", variant: "reauth-required" } }, auth, META, now, svc));
  check("rollback without a reason ⇒ 400", rbNoReason.status === 400);
  const rbCode = await j(await H.rollbackHandler("SYNC_FAILED", "code-default", { reason: REASON, expectedRevision: 5, body: { channel: "IN_APP", variant: "reauth-required" } }, CONTROL, META, NOW, svc));
  check("rollback to code-default: published = CODE_DEFAULT, head cleared, revision 6",
    rbCode.status === 200 && rbCode.body.result.published.source === "CODE_DEFAULT" && rbCode.body.result.revision === 6
    && (fake.one("CommsTemplate", { definitionKey: "SYNC_FAILED", channel: "IN_APP" }) as any).publishedVersionId === null);
  const rbCode2 = await j(await H.rollbackHandler("SYNC_FAILED", "code-default", { reason: REASON, expectedRevision: 6, body: { channel: "IN_APP", variant: "reauth-required" } }, CONTROL, META, NOW, svc));
  check("rollback to code-default when it is already live ⇒ INVALID_STATE", rbCode2.status === 409 && rbCode2.body.code === "INVALID_STATE");

  // ── 3. immutability + optimistic token ─────────────────────────────────────
  console.log("3. immutability, CONFLICT, STALE_DRAFT, INVALID_STATE");
  const before = fake.rows("CommsTemplateVersion").length;
  const stale = await j(await H.saveDraftHandler("SYNC_FAILED", draftReq(1, inAppContent("stale")), WRITE, META, NOW, svc));
  check("stale expectedRevision ⇒ 409 { code: CONFLICT, current: 6 } and nothing written",
    stale.status === 409 && stale.body.code === "CONFLICT" && stale.body.current === 6 && fake.rows("CommsTemplateVersion").length === before, stale.body);
  const stalePub = await j(await H.publishHandler("SYNC_FAILED", d2, { reason: REASON, expectedRevision: 2, body: { acknowledgeWarnings: true } }, CONTROL, META, NOW, svc));
  check("publish with a stale token ⇒ CONFLICT with current", stalePub.status === 409 && stalePub.body.code === "CONFLICT" && stalePub.body.current === 6);
  const rePub = await j(await H.publishHandler("SYNC_FAILED", d1, { reason: REASON, expectedRevision: 6, body: { acknowledgeWarnings: true } }, CONTROL, META, NOW, svc));
  check("publishing a SUPERSEDED version ⇒ INVALID_STATE (republish = rollback)", rePub.status === 409 && rePub.body.code === "INVALID_STATE");
  const a = await j(await H.saveDraftHandler("SYNC_FAILED", draftReq(6, inAppContent("A")), WRITE, META, NOW, svc));
  const b = await j(await H.saveDraftHandler("SYNC_FAILED", draftReq(7, inAppContent("B")), WRITE, META, NOW, svc));
  await H.publishHandler("SYNC_FAILED", a.body.result.id, { reason: REASON, expectedRevision: 8, body: { acknowledgeWarnings: true } }, CONTROL, META, NOW, svc);
  const sd = await j(await H.publishHandler("SYNC_FAILED", b.body.result.id, { reason: REASON, expectedRevision: 9, body: { acknowledgeWarnings: true } }, CONTROL, META, NOW, svc));
  check("two drafts from the same base: publishing the second after the first ⇒ STALE_DRAFT", sd.status === 409 && sd.body.code === "STALE_DRAFT", sd.body);
  const invalid = await j(await H.saveDraftHandler("SYNC_FAILED", draftReq(9, { subject: "no placeholder", preheader: null, blocks: [] }), WRITE, META, NOW, svc));
  check("invalid content ⇒ 400 CONTENT_INVALID with typed issues, nothing written",
    invalid.status === 400 && invalid.body.code === "CONTENT_INVALID" && invalid.body.issues.some((i: any) => i.code === "REQUIRED_PLACEHOLDER_MISSING"));
  const warn = await j(await H.saveDraftHandler("SYNC_FAILED", draftReq(9, { ...inAppContent("W"), blocks: [{ kind: "paragraph", text: "Earn more with {{institutionName}}." }] }), WRITE, META, NOW, svc));
  check("a warning-only draft saves, carrying its warnings", warn.status === 201 && warn.body.result.issues.some((i: any) => i.code === "FINANCIAL_CLAIM" && i.severity === "warning"));
  const unack = await j(await H.publishHandler("SYNC_FAILED", warn.body.result.id, { reason: REASON, expectedRevision: 10, body: { acknowledgeWarnings: false } }, CONTROL, META, NOW, svc));
  check("publish with warnings unacknowledged ⇒ 409 WARNINGS_UNACKNOWLEDGED", unack.status === 409 && unack.body.code === "WARNINGS_UNACKNOWLEDGED");
  const storeSrc = code("lib/notifications/content/store.ts");
  const versionUpdates = [...storeSrc.matchAll(/commsTemplateVersion\.(update|updateMany|upsert|delete|deleteMany)\(\{[^]*?data: \{([^}]*)\}/g)];
  check("store.ts: the ONLY version update sets publishedAt / publishAuditLogId, guarded by publishedAt: null; no version delete",
    versionUpdates.length === 1 && versionUpdates[0][1] === "updateMany" && /^\s*publishedAt: now, publishAuditLogId: auditLogId\s*$/.test(versionUpdates[0][2]) && /where: \{ id: v\.id, publishedAt: null \}/.test(storeSrc), versionUpdates.map((m) => m[2]));
  const mig = readFileSync("prisma/migrations/20261031210000_comms_template_versions/migration.sql", "utf8");
  check("migration: content columns have no UPDATE grant (column-level UPDATE on publishedAt/publishAuditLogId only)",
    /GRANT SELECT, INSERT ON TABLE public."CommsTemplateVersion" TO fm_system;/.test(mig) && /GRANT UPDATE \("publishedAt", "publishAuditLogId"\) ON TABLE public."CommsTemplateVersion" TO fm_system;/.test(mig)
    && !/GRANT[^;]*DELETE[^;]*"CommsTemplateVersion"/.test(mig) && !/GRANT[^;]*(fm_app|fm_auth)/.test(mig.replace(/REVOKE[^;]*;/g, "")));

  // ── 4. PROTECTED on every write ────────────────────────────────────────────
  console.log("4. 409 PROTECTED on every write to a locked template");
  const protectedKeys = Object.values(COMMS_CATALOG).filter((d) => definitionLock(d)?.reason === "PROTECTED").map((d) => d.key);
  check("there are protected keys to test (security, ceremony, operator)", protectedKeys.length >= 20, protectedKeys.length);
  let allProtected = true;
  const offenders: string[] = [];
  for (const key of protectedKeys) {
    const writes: Array<[string, Response]> = [
      ["versions", await H.saveDraftHandler(key, { garbage: true }, ADMIN, META, NOW, svc)],
      ["versions(valid)", await H.saveDraftHandler(key, draftReq(0, inAppContent("x"), { channel: "EMAIL" }), ADMIN, META, NOW, svc)],
      ["publish", await H.publishHandler(key, "any-id", {}, ADMIN, META, NOW, svc)],
      ["rollback", await H.rollbackHandler(key, "any-id", {}, ADMIN, META, NOW, svc)],
      ["rollback(code-default)", await H.rollbackHandler(key, "code-default", { body: { channel: "EMAIL" } }, ADMIN, META, NOW, svc)],
      ["ai-suggest", await H.aiSuggestHandler(key, "any-id", { body: { mode: "POLISH" } }, ADMIN, META, NOW, svc)],
      ["render", H.renderHandler(key, { nonsense: 1 }, NOW)],
    ];
    for (const [name, r] of writes) {
      const body = (await r.json()) as any;
      if (r.status !== 409 || body.code !== "PROTECTED") { allProtected = false; offenders.push(`${key}:${name}:${r.status}:${body.code}`); }
    }
  }
  check("every write × every protected key ⇒ 409 PROTECTED (even with a malformed body, even as SYSTEM_ADMIN)", allProtected, offenders.slice(0, 5));
  const legLocked = await j(await H.saveDraftHandler("SPACE_INVITE_RECEIVED", draftReq(0, inAppContent("x"), { channel: "EMAIL", variant: "default" }), ADMIN, META, NOW, svc));
  check("a locked LEG of an editable definition (SPACE_INVITE_RECEIVED EMAIL) ⇒ 409 PROTECTED", legLocked.status === 409 && legLocked.body.code === "PROTECTED");
  const notEditable = await j(await H.saveDraftHandler("DIGEST_SENT", draftReq(0, inAppContent("x"), { channel: "EMAIL", variant: "default" }), ADMIN, META, NOW, svc));
  check("a non-protected, non-editable definition (BUILD_OFF digest) ⇒ 409 NOT_EDITABLE", notEditable.status === 409 && notEditable.body.code === "NOT_EDITABLE");
  check("no content row was written by any refused write", fake.rows("CommsTemplate").every((r) => r.definitionKey === "SYNC_FAILED"));
  const readLocked = await j(await H.versionsList("PASSWORD_RESET_LINK_SENT", new URL("https://x.invalid/v?channel=EMAIL"), CONTROL, NOW, svc));
  check("reads of a protected key are 200 with contentEditable false, locked PROTECTED, no items, canEditContent false",
    readLocked.status === 200 && readLocked.body.contentEditable === false && readLocked.body.locked.reason === "PROTECTED" && readLocked.body.items.length === 0 && readLocked.body.viewer.canEditContent === false);

  // ── 5. render persists nothing ─────────────────────────────────────────────
  console.log("5. POST /render persists nothing, audits nothing");
  const writesBefore = fake.calls.filter((c) => /create|update|upsert|delete/i.test(c.op)).length;
  const auditBefore = fake.rows("AuditLog").length;
  const r1 = await j(H.renderHandler("SYNC_FAILED", { channel: "EMAIL", variant: "reauth-required", content: emailContent() }, NOW));
  const r2 = await j(H.renderHandler("SYNC_FAILED", { channel: "EMAIL", variant: "reauth-required", content: { ...emailContent(), blocks: [{ kind: "cta", label: "x", link: "nope" }] } }, NOW));
  const r3 = await j(H.renderHandler("SYNC_FAILED", { channel: "EMAIL", content: { subject: 5 } }, NOW));
  check("valid unsaved content renders: synthetic, [PREVIEW], source UNSAVED, versionId null, sample values",
    r1.status === 200 && r1.body.synthetic === true && r1.body.subject.startsWith("[PREVIEW]") && r1.body.source === "UNSAVED" && r1.body.versionId === null && r1.body.html.includes("Example Bank"), r1.body.issues);
  check("errors do not fail the request: 200 with issues; html/text null when unrenderable", r2.status === 200 && r2.body.issues.length > 0 && r2.body.html === null && r2.body.text === null);
  check("a body that is not a ContentBody ⇒ 400 VALIDATION", r3.status === 400 && r3.body.code === "VALIDATION");
  const big = await H.readJsonBody(new Request("https://x.invalid", { method: "POST", body: JSON.stringify({ x: "y".repeat(40_000) }) }), H.RENDER_BODY_MAX_BYTES);
  check("a body over 32 KB ⇒ 400", !big.ok && big.res.status === 400);
  check("no write and no audit row by render", fake.calls.filter((c) => /create|update|upsert|delete/i.test(c.op)).length === writesBefore && fake.rows("AuditLog").length === auditBefore);
  check("render takes no store at all (pure by signature)", H.renderHandler.length === 3);

  // ── 6. preview by versionId is synthetic ───────────────────────────────────
  console.log("6. GET /preview?versionId= — synthetic only");
  const e1 = await j(await H.saveDraftHandler("SYNC_FAILED", draftReq(0, emailContent(), { channel: "EMAIL" }), WRITE, META, NOW, svc));
  check("an EMAIL draft saves", e1.status === 201, e1.body);
  const eid = e1.body.result.id as string;
  const pv = await j(await H.previewHandler("SYNC_FAILED", new URL(`https://x.invalid/p?channel=email-html&versionId=${eid}`), NOW, svc));
  check("preview of a DRAFT: synthetic, [PREVIEW], sample value (Example Bank), source VERSION, the version id",
    pv.status === 200 && pv.body.synthetic === true && pv.body.subject.startsWith("[PREVIEW]") && pv.body.html.includes("Example Bank") && pv.body.html.includes("Edited copy") && pv.body.source === "VERSION" && pv.body.versionId === eid, pv.body);
  const injected = await j(await H.previewHandler("SYNC_FAILED", new URL(`https://x.invalid/p?channel=email-html&versionId=${eid}&institutionName=Evil`), NOW, svc));
  check("no query parameter supplies a value (unknown parameter ⇒ 400)", injected.status === 400);
  const otherKey = await j(await H.previewHandler("SYNC_COMPLETED", new URL(`https://x.invalid/p?channel=email-html&versionId=${eid}`), NOW, svc));
  check("a versionId of another key ⇒ 404", otherKey.status === 404 && otherKey.body.code === "NOT_FOUND");
  const wrongChannel = await j(await H.previewHandler("SYNC_FAILED", new URL(`https://x.invalid/p?channel=in-app&versionId=${eid}`), NOW, svc));
  check("a channel that does not match the version ⇒ 409 INVALID_STATE", wrongChannel.status === 409 && wrongChannel.body.code === "INVALID_STATE");
  const pvCode = await j(await H.previewHandler("PASSWORD_RESET_LINK_SENT", new URL("https://x.invalid/p?channel=email-html"), NOW, svc));
  check("a protected key previews its code default (source CODE_DEFAULT)", pvCode.status === 200 && pvCode.body.source === "CODE_DEFAULT" && pvCode.body.versionId === null && pvCode.body.synthetic === true);

  // ── 7. the send path ───────────────────────────────────────────────────────
  console.log("7. send path: the PUBLISHED version, contentVersionId, the code fallback");
  const headE = fake.one("CommsTemplate", { definitionKey: "SYNC_FAILED", channel: "EMAIL", variant: "reauth-required" }) as any;
  const pubE = await j(await H.publishHandler("SYNC_FAILED", eid, { reason: REASON, expectedRevision: headE.revision, body: { acknowledgeWarnings: true } }, CONTROL, META, NOW, svc));
  check("the EMAIL draft publishes", pubE.status === 200, pubE.body);
  const headI = fake.one("CommsTemplate", { definitionKey: "SYNC_FAILED", channel: "IN_APP", variant: "reauth-required" }) as any;
  const liveIn = await j(await H.saveDraftHandler("SYNC_FAILED", draftReq(headI.revision, inAppContent("Live"), { parent: null }), WRITE, META, NOW, svc));
  const headI2 = fake.one("CommsTemplate", { id: headI.id }) as any;
  // A stale draft was published above, so base on the live version.
  const liveIn2 = await j(await H.saveDraftHandler("SYNC_FAILED", draftReq(headI2.revision, inAppContent("Live"), { parent: headI2.publishedVersionId }), WRITE, META, NOW, svc));
  void liveIn;
  const pubI = await j(await H.publishHandler("SYNC_FAILED", liveIn2.body.result.id, { reason: REASON, expectedRevision: (fake.one("CommsTemplate", { id: headI.id }) as any).revision, body: { acknowledgeWarnings: true } }, CONTROL, META, NOW, svc));
  check("the IN_APP draft publishes", pubI.status === 200, pubI.body);

  const ledger: any[] = [];
  const sent: any[] = [];
  const created: any[] = [];
  const client = {
    user: { findUnique: async () => ({ email: "customer@example.invalid" }) },
    notificationDelivery: { create: async () => ({ id: "d1" }) },
    notification: {
      create: async ({ data }: any) => { created.push(data); return { id: `n${created.length}` }; },
      findUnique: async () => null, update: async () => ({ id: "x" }),
    },
  };
  const prefClient = { notificationPreference: { findMany: async () => [] } };
  const emailAdapter = { channel: "EMAIL" as const, name: "fake", deliver: async (m: any) => { sent.push(m); return { status: "captured" as const, provider: "capture" }; } };
  const { liveContentResolver, invalidateLiveContent } = store;
  invalidateLiveContent();
  const resolver = liveContentResolver((await import("@/lib/db")).systemDb as never);
  const data = { plaidItemId: "item_1", institutionName: "Real Bank", connectionState: "reauth-required" };
  const res = await createNotification({ type: "SYNC_FAILED", userId: "u1", data } as never,
    { client: client as never, prefClient: prefClient as never, emailAdapter: emailAdapter as never, ledger: async (row) => { ledger.push(row); }, content: resolver });
  check("createNotification created the in-app row", res.status === "created");
  check("in-app: the PUBLISHED IN_APP copy, with the REAL value substituted",
    created[0]?.title === "Live Real Bank" && created[0]?.body === "Please reconnect Real Bank from Connections." && created[0]?.href === "/dashboard/connections", created[0]);
  const inAppRow = ledger.find((r) => r.channel === "IN_APP" && r.status === "ACCEPTED");
  check("the IN_APP ledger row records contentVersionId = the published in-app version", inAppRow?.contentVersionId === liveIn2.body.result.id, inAppRow);
  check("email: the message carries the PUBLISHED EMAIL content (its own stream, not the in-app copy)",
    sent[0]?.emailContent?.versionId === eid && sent[0]?.emailContent.content.subject === "Action needed for Real Bank" && sent[0]?.title === NOTIFICATION_REGISTRY.SYNC_FAILED.render(data).title, sent[0]);
  const ed = emailDataFor(sent[0], "https://app.example.invalid");
  const html = renderNotificationEmail(ed.data).html;
  check("the email adapter renders that content (real value, trusted URL) and passes its contentVersionId", ed.contentVersionId === eid && html.includes("Edited copy: sign in to Real Bank again.") && html.includes("https://app.test.invalid/dashboard/connections"));
  check("channels/email.ts passes contentVersionId into the sendEmail ledger context", /\.\.\.\(contentVersionId \? \{ contentVersionId \} : \{\}\)/.test(code("lib/notifications/channels/email.ts")));
  const rows: any[] = [];
  const sendEmail = createEmailSender({ env: { NODE_ENV: "test" }, provider: { name: "x", send: async () => ({ status: "sent", provider: "x", id: "p1" }) }, capture: { name: "capture", send: async () => ({ status: "captured", provider: "capture" }) }, ledger: async (r) => { rows.push(r); } });
  await sendEmail("notification", "customer@example.invalid", ed.data as never, { key: "SYNC_FAILED", recipientUserId: "u1", contentVersionId: eid });
  await sendEmail("notification", "customer@example.invalid", { title: "t" }, { key: "SYNC_FAILED", recipientUserId: "u1" });
  check("the EMAIL ledger row records contentVersionId; a code-template send records none", rows[0]?.contentVersionId === eid && !("contentVersionId" in rows[1]), rows);

  // The code-template fallback.
  created.length = 0; sent.length = 0; ledger.length = 0;
  await createNotification({ type: "SYNC_FAILED", userId: "u2", data: { plaidItemId: "item_2", institutionName: "Other Bank", connectionState: "disconnected" } } as never,
    { client: client as never, prefClient: prefClient as never, emailAdapter: emailAdapter as never, ledger: async (row) => { ledger.push(row); }, content: resolver });
  const code0 = NOTIFICATION_REGISTRY.SYNC_FAILED.render({ institutionName: "Other Bank", connectionState: "disconnected" });
  check("no published version for the stream ⇒ the code template, exactly", created[0]?.title === code0.title && created[0]?.body === code0.body && sent[0]?.emailContent === undefined);
  check("…and no contentVersionId on the ledger row", ledger.every((r) => !("contentVersionId" in r)));
  created.length = 0; sent.length = 0;
  await createNotification({ type: "SYNC_FAILED", userId: "u3", data } as never,
    { client: client as never, prefClient: prefClient as never, emailAdapter: emailAdapter as never, ledger: async () => {}, content: async () => { throw new Error("db down"); } });
  check("a content read failure is the code template (delivery is not optional)", created[0]?.title === NOTIFICATION_REGISTRY.SYNC_FAILED.render(data).title);
  const logs: string[] = [];
  const fb = await liveRenderFor({
    type: "SYNC_FAILED", data, codeRendered: NOTIFICATION_REGISTRY.SYNC_FAILED.render(data), appBaseUrl: undefined, log: (l) => logs.push(l),
    resolver: async (s) => (s.channel === "EMAIL" ? { versionId: "v_x", body: emailContent() as never } : null),
  });
  check("a published EMAIL version that cannot render (no trusted app base) falls back to the code default, logged RENDER_FALLBACK",
    fb.email === null && logs.some((l) => l.includes("RENDER_FALLBACK") && !l.includes("Real Bank")));
  check("a type with no editable leg never asks the resolver", await (async () => {
    let asked = 0;
    await liveRenderFor({ type: "PASSWORD_CHANGED", data: {}, codeRendered: { title: "t" }, appBaseUrl: "https://a.invalid", resolver: async () => { asked++; return null; } });
    return asked === 0;
  })());

  // ── 8. viewer per role ─────────────────────────────────────────────────────
  console.log("8. the viewer block, per role");
  const v = async (auth: Auth) => (await j(await H.versionsList("SYNC_FAILED", new URL("https://x.invalid/v?channel=IN_APP&variant=reauth-required"), auth as never, NOW, svc))).body;
  const vr = await v(READ), vw = await v(WRITE), vc = await v(CONTROL), va = await v(ADMIN);
  check("READ: no write flag at all", !vr.viewer.canEditContent && !vr.viewer.canPublish && !vr.viewer.canRollback && !vr.viewer.canAiSuggest && !vr.viewer.canTestSend && !vr.viewer.canPauseDisable);
  check("WRITE: edit, AI suggest, test send, pause — not publish / rollback / activate",
    vw.viewer.canEditContent && vw.viewer.canAiSuggest && vw.viewer.canTestSend && vw.viewer.canPauseDisable && !vw.viewer.canPublish && !vw.viewer.canRollback && !vw.viewer.canActivate);
  check("CONTROL: publish and rollback (the stream has superseded versions)", vc.viewer.canPublish && vc.viewer.canRollback && vc.viewer.canEditContent);
  check("only SYSTEM_ADMIN can approve as owner", va.viewer.canApproveAsOwner === true && vc.viewer.canApproveAsOwner === false && va.viewer.canPublish === true);
  check("the versions list carries stream, revision, live, codeDefault, placeholders (no source / pii), limits",
    vc.stream.variant === "reauth-required" && typeof vc.revision === "number" && vc.live.source === "PUBLISHED" && vc.codeDefault.subject.includes("{{institutionName}}")
    && vc.placeholders.every((p: any) => !("source" in p) && !("pii" in p)) && vc.limits.subject === 120 && vc.items.length > 0);
  // v1.1.1 — per-block limits on the versions list are the validator's numbers; null where the block kind is not allowed.
  check("limits (v1.1.1): IN_APP publishes null for hero / info limits",
    vc.limits.heading === null && vc.limits.greeting === null && vc.limits.infoTitle === null && vc.limits.infoItems === null && vc.limits.infoItem === null
    && vc.limits.paragraph === LIMITS.IN_APP.paragraph && vc.limits.ctaLabel === LIMITS.IN_APP.ctaLabel, vc.limits);
  const ve = (await j(await H.versionsList("SYNC_FAILED", new URL("https://x.invalid/v?channel=EMAIL&variant=disconnected"), CONTROL as never, NOW, svc))).body;
  check("limits (v1.1.1): EMAIL publishes heading / greeting / info limits equal to the validator's",
    ve.limits.heading === LIMITS.EMAIL.heading && ve.limits.greeting === LIMITS.EMAIL.greeting && ve.limits.infoTitle === LIMITS.EMAIL.infoTitle
    && ve.limits.infoItems === LIMITS.EMAIL.infoItems && ve.limits.infoItem === LIMITS.EMAIL.infoItem && ve.limits.preheader === LIMITS.EMAIL.preheader, ve.limits);
  // v1.1.1 — canRollback split into a reason.
  check("rollback reason: absent when canRollback is true", vc.viewer.canRollback === true && !("rollbackUnavailableReason" in vc.viewer));
  check("rollback reason: READ / WRITE ⇒ NO_PERMISSION", vr.viewer.rollbackUnavailableReason === "NO_PERMISSION" && vw.viewer.rollbackUnavailableReason === "NO_PERMISSION");
  check("rollback reason: CONTROL on a never-published stream ⇒ NOTHING_TO_RESTORE (canRollback still false)",
    ve.live.source === "CODE_DEFAULT" && ve.items.length === 0 && ve.viewer.canRollback === false && ve.viewer.rollbackUnavailableReason === "NOTHING_TO_RESTORE", ve.viewer);
  const veW = (await j(await H.versionsList("SYNC_FAILED", new URL("https://x.invalid/v?channel=EMAIL&variant=disconnected"), WRITE as never, NOW, svc))).body;
  check("rollback reason: permission is reported before nothing-to-restore (WRITE on an empty stream ⇒ NO_PERMISSION)", veW.viewer.rollbackUnavailableReason === "NO_PERMISSION");
  const vLocked = (await j(await H.versionsList("SPACE_INVITE_RECEIVED", new URL("https://x.invalid/v?channel=EMAIL"), CONTROL as never, NOW, svc))).body;
  check("rollback reason: CONTROL on a locked leg ⇒ NO_PERMISSION (with `locked` set)",
    vLocked.contentEditable === false && vLocked.locked !== null && vLocked.viewer.rollbackUnavailableReason === "NO_PERMISSION", vLocked.viewer);
  check("CODE_DEFAULT_VERSION_ID (client-safe) is the server's sentinel", CODE_DEFAULT_VERSION_ID === CODE_DEFAULT_ID && CODE_DEFAULT_VERSION_ID === "code-default");
  check("test send: verified + Production ⇒ eligible", vc.viewer.testSendEligible === true && vc.viewer.testSendIneligibleReason === null);
  self = { email: "op@example.invalid", verified: false };
  check("test send: unverified ⇒ SELF_UNVERIFIED", (await v(WRITE)).viewer.testSendIneligibleReason === "SELF_UNVERIFIED");
  self = { email: "op@example.invalid", verified: true };
  const preview = { ...svc, env: { VERCEL: "1", VERCEL_ENV: "preview", EMAIL_NONPROD_ALLOWLIST: "someone@example.invalid" } } as typeof svc;
  const np = (await j(await H.versionsList("SYNC_FAILED", new URL("https://x.invalid/v?channel=IN_APP&variant=reauth-required"), WRITE as never, NOW, preview))).body;
  check("test send: Preview, own address not allowlisted ⇒ NONPROD_ALLOWLIST (and nothing about the list leaks)",
    np.viewer.testSendIneligibleReason === "NONPROD_ALLOWLIST" && !JSON.stringify(np).includes("someone@example.invalid"));
  const det = await j(await H.catalogDetailV11("SYNC_FAILED", NOW, CONTROL as never, svc));
  check("catalog detail: content legs with live per variant, divergesFrom, EDIT_CONTENT / AI_SUGGEST, viewer",
    det.status === 200 && det.body.contentLocked === false && det.body.divergesFrom === "connection-attention" && det.body.content.length === 2
    && det.body.content.some((l: any) => l.live.some((x: any) => x.source === "PUBLISHED")) && det.body.supportedActions.includes("EDIT_CONTENT") && det.body.viewer.canPublish === true, det.body.content);
  const detP = await j(await H.catalogDetailV11("PASSWORD_RESET_LINK_SENT", NOW, CONTROL as never, svc));
  check("catalog detail of a protected key: contentLocked, no content legs, no content actions, viewer cannot edit",
    detP.body.contentLocked === true && detP.body.content.length === 0 && !detP.body.supportedActions.includes("EDIT_CONTENT") && detP.body.viewer.canEditContent === false);
  check("no AI call was made anywhere in this suite", aiCalls.length === 0);

  // ── 9. review fixes ────────────────────────────────────────────────────────
  console.log("9. review fixes: send-time revalidation, render fallback, tx audit, leg lock, P2002, retry");
  const logs2: string[] = [];
  const bad = await liveRenderFor({
    type: "SYNC_FAILED", data, codeRendered: NOTIFICATION_REGISTRY.SYNC_FAILED.render(data), appBaseUrl: "https://app.example.invalid", log: (l) => logs2.push(l),
    resolver: async (st) => ({ versionId: `v_${st.channel}`, body: (st.channel === "EMAIL"
      ? { ...emailContent(), subject: "Hi {{evil}} {{institutionName}}" }
      : { ...inAppContent("Hello"), subject: "Hello {{nope}} {{institutionName}}" }) as never }),
  });
  check("a published body that fails the CURRENT validator is RENDER_FALLBACK (code template) on both legs, logged INVALID",
    bad.email === null && bad.inApp.contentVersionId === null && bad.inApp.rendered.title === NOTIFICATION_REGISTRY.SYNC_FAILED.render(data).title
    && logs2.filter((l) => l.includes("RENDER_FALLBACK") && l.includes("reason=INVALID") && l.includes("UNKNOWN_PLACEHOLDER")).length === 2, logs2);
  const braces = await liveRenderFor({
    type: "SYNC_FAILED", data: { ...data, institutionName: "{{institutionName}} Bank" }, codeRendered: NOTIFICATION_REGISTRY.SYNC_FAILED.render(data), appBaseUrl: "https://app.example.invalid",
    resolver: async (st) => ({ versionId: `v_${st.channel}`, body: (st.channel === "EMAIL" ? emailContent() : inAppContent("Hi")) as never }),
  });
  check("a value carrying braces never puts a literal {{…}} in a send", !JSON.stringify(braces).includes("{{") && braces.email !== null && braces.inApp.contentVersionId === "v_IN_APP");
  const logs3: string[] = [];
  const fbMsg = { userId: "u1", type: "SYNC_FAILED", category: "FINANCIAL" as const, priority: "HIGH" as const, title: "Code title", href: "/dashboard/connections",
    emailContent: { versionId: "v_bad", content: { subject: "S", preheader: "P", blocks: [{ kind: "cta" as const, label: "x", url: "javascript:alert(1)" }] } } };
  const fbData = emailDataFor(fbMsg as never, "https://app.example.invalid", (l) => logs3.push(l));
  check("emailDataFor: published content that does not render ⇒ the code rendering, no contentVersionId, RENDER_FALLBACK logged",
    fbData.contentVersionId === null && fbData.data.content === undefined && fbData.data.title === "Code title" && logs3.some((l) => l.includes("RENDER_FALLBACK") && l.includes("v_bad")));

  // The audit row goes through the TRANSACTION client: the top-level auditLog is made to throw.
  const sysDb = (await import("@/lib/db")).systemDb as unknown as Record<string, unknown>;
  const realAudit = sysDb.auditLog;
  Object.defineProperty(sysDb, "auditLog", { value: { create: () => { throw new Error("audit written outside the transaction"); } }, configurable: true, writable: true });
  const hT = fake.one("CommsTemplate", { definitionKey: "SYNC_COMPLETED" }) as any;
  const txDraft = await j(await H.saveDraftHandler("SYNC_COMPLETED", { expectedRevision: hT?.revision ?? 0, body: { channel: "IN_APP", parentVersionId: null, content: { subject: "{{institutionName}} is ready", preheader: null, blocks: [] }, source: { kind: "MANUAL" } } }, WRITE, META, NOW, svc).catch(() => new Response("{}", { status: 599 })));
  const txPub = txDraft.status === 201 ? await j(await H.publishHandler("SYNC_COMPLETED", txDraft.body.result.id, { reason: REASON, expectedRevision: txDraft.body.result.revision, body: { acknowledgeWarnings: true } }, CONTROL, META, NOW, svc).catch(() => new Response("{}", { status: 599 }))) : { status: 0, body: null };
  Object.defineProperty(sysDb, "auditLog", { value: realAudit, configurable: true, writable: true });
  check("save + publish succeed with the top-level auditLog broken ⇒ the audit rows are written through the transaction client", txDraft.status === 201 && txPub.status === 200, [txDraft.status, txPub.status]);

  const rbLeg = await j(await H.rollbackHandler("SPACE_INVITE_RECEIVED", "code-default", { reason: REASON, expectedRevision: 0, body: { channel: "EMAIL" } }, CONTROL, META, NOW, svc));
  check("code-default rollback of a locked LEG ⇒ 409 PROTECTED (not INVALID_STATE)", rbLeg.status === 409 && rbLeg.body.code === "PROTECTED", rbLeg.body);

  const hC = fake.one("CommsTemplate", { definitionKey: "SYNC_COMPLETED" }) as any;
  const { knownError } = await import("@/lib/test-support/fake-prisma");
  fake.on("CommsTemplateVersion", "create", () => { throw knownError("P2002", "Unique constraint failed"); }, { once: true });
  const race = await j(await H.saveDraftHandler("SYNC_COMPLETED", { expectedRevision: hC.revision, body: { channel: "IN_APP", parentVersionId: null, content: { subject: "{{institutionName}} done", preheader: null, blocks: [] }, source: { kind: "MANUAL" } } }, WRITE, META, NOW, svc));
  check("a unique-violation race ⇒ CONFLICT with the stream's REAL current revision", race.status === 409 && race.body.code === "CONFLICT" && race.body.current === hC.revision, race.body);

  // Retry: the email re-renders the EMAIL leg, never the stored in-app copy.
  const { retryNotifications } = await import("@/jobs/retry-notifications");
  invalidateLiveContent();
  const retryRow = (type: string, title: string, metadata: unknown) => ({
    id: `del_${type}`, attempts: 1, notificationId: `n_${type}`,
    notification: { userId: "u1", type, category: "FINANCIAL", priority: "HIGH", title, body: "stored in-app body", href: "/dashboard/connections", metadata,
      readAt: null, archivedAt: null, expiresAt: null, dedupeKey: null, user: { email: "customer@example.invalid" } },
  });
  const rows2 = [retryRow("SYNC_FAILED", "Live Real Bank", data), retryRow("PASSWORD_CHANGED", "Stored security title", {})];
  const rclient = {
    notificationDelivery: {
      findMany: async () => rows2, update: async () => ({ id: "x" }), updateMany: async () => ({ count: 1 }), count: async () => 1,
    },
  };
  const delivered: any[] = [];
  await retryNotifications(rclient as never, { channel: "EMAIL", name: "fake", deliver: async (m: any) => { delivered.push(m); return { status: "sent", provider: "fake", id: "p" }; } } as never, NOW, null, resolver);
  const rSync = delivered.find((m) => m.type === "SYNC_FAILED");
  const rData = rSync ? emailDataFor(rSync, "https://app.example.invalid") : null;
  check("retry of an editable type: title/body are the REGISTRY render, not the stored in-app copy, and the EMAIL leg's published version rides along",
    rSync?.title === NOTIFICATION_REGISTRY.SYNC_FAILED.render(data).title && rSync?.body === NOTIFICATION_REGISTRY.SYNC_FAILED.render(data).body && rSync?.emailContent?.versionId === eid, rSync);
  check("…so the retried email records contentVersionId", rData?.contentVersionId === eid);
  check("retry of a type with no editable leg keeps the stored copy exactly", delivered.find((m) => m.type === "PASSWORD_CHANGED")?.title === "Stored security title");

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall store checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
