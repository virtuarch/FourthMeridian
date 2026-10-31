/**
 * lib/notifications/content/ai.test.ts  (Comms Center B1 — AI-assisted authoring end to end, NO real AI)
 *
 * The real ai-suggest handler, the REAL provider seam (generateStructuredWithUsage)
 * with a FAKE OpenAI client, the REAL kill-switch / global-freeze / allowance
 * readers, all over the in-memory Prisma fake:
 *   1. the exact payload: only template text + placeholder names (customer data
 *      seeded in the DB never appears);
 *   2. a clean suggestion: 200, a separate OFFERED row, the base untouched, the
 *      audit chain, the AiInvocation ledger row (existing cost accounting);
 *   3. accept = a NEW draft (AI_ASSISTED, aiEditedAfterAccept), suggestion ACCEPTED, once;
 *   4. invalid output is REJECTED (422, no text returned or stored): dropped
 *      placeholder, added link, added financial claim;
 *   5. every typed UNAVAILABLE reason (kill switch, global freeze ON / INVALID /
 *      unreadable, a Beta-group-only freeze NOT blocking, allowance exhausted,
 *      provider error, a pause mid-call), the model never called before a refusal;
 *   6. the `ai` availability block per state;
 *   7. the caps ($2, 40 calls per operator per day, $10 fleet) and the reservation;
 *   8. manual editing always works while AI is unavailable.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/notifications/content/ai.test.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- assertions read loosely-typed JSON bodies */

import "@/lib/test-support/route-env";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}
const j = async (r: Response) => ({ status: r.status, headers: r.headers, body: (await r.json()) as any });

const fake = new FakePrisma();
const NOW = new Date();
const META = { ip: null, userAgent: null };
const OP = { user: { id: "op_write", role: "USER" }, grant: { area: "CUSTOMER_SUCCESS", level: "WRITE" } };
const CONTROL = { user: { id: "op_control", role: "USER" }, grant: { area: "CUSTOMER_SUCCESS", level: "CONTROL" } };

const BASE = {
  subject: "Action needed for {{institutionName}}", preheader: "Sign in to {{institutionName}} again",
  blocks: [{ kind: "hero", heading: "Reconnect {{institutionName}}" }, { kind: "paragraph", text: "please sign in to {{institutionName}} again so your accounts stay up to date." }, { kind: "cta", label: "Reconnect", link: "actionUrl" }],
};
type Wire = { subject: string; preheader: string | null; blocks: any[]; notes: any[] };
const wire = (b: typeof BASE, notes: any[] = []): Wire => ({
  subject: b.subject, preheader: b.preheader, notes,
  blocks: b.blocks.map((x: any) => ({ kind: x.kind, heading: x.heading ?? null, greeting: null, text: x.text ?? null, label: x.label ?? null, link: x.link ?? null, title: null, items: null })),
});
const CLEAN: Wire = wire({ ...BASE, blocks: BASE.blocks.map((x: any) => (x.kind === "paragraph" ? { ...x, text: "Please sign in to {{institutionName}} again so your accounts stay up to date." } : x)) },
  [{ blockIndex: 1, field: "text", category: "GRAMMAR", text: "Capitalised the first word." }, { blockIndex: null, field: null, category: "TONE", text: "See https://x.example.com" }]);

async function main(): Promise<void> {
  await installFakePrisma(fake);
  const H = await import("./http");
  const { contentServices, makeStructuredCall } = await import("./deps");
  const { readPaidRequestsAdmission } = await import("@/lib/platform/ai/paid-requests-admission");
  const { readGlobalCostFreeze } = await import("@/lib/platform/cost-freeze");
  const AA = await import("./ai-allowance");
  const { AI_SYSTEM_PROMPT, buildAiRequest } = await import("./ai");
  const { PlatformSettingKey } = await import("@/lib/platform-settings");
  const { AuditAction } = await import("@/lib/audit-actions");

  // The fake OpenAI client: records the exact body; answers with `next`.
  const bodies: any[] = [];
  let next: () => Promise<unknown> = async () => ({ choices: [{ message: { content: JSON.stringify(CLEAN) }, finish_reason: "stop" }], usage: { prompt_tokens: 900, completion_tokens: 150 } });
  const client = { chat: { completions: { create: async (body: unknown) => { bodies.push(body); return next(); } } } };
  let midCallPause = false;
  const call = makeStructuredCall({
    client: client as never,
    sinks: { paidRequestsAdmission: async () => (midCallPause ? { paused: true, state: "ON", raw: "true", cause: "KILL_SWITCH" } : readPaidRequestsAdmission()) } as never,
  });
  let ids = 0;
  const svc = {
    ...contentServices,
    readSelf: async () => ({ email: "op@example.invalid", verified: true }),
    env: { VERCEL: "1", VERCEL_ENV: "production" },
    ai: {
      admission: () => readPaidRequestsAdmission(),
      freeze: () => readGlobalCostFreeze(),
      readAllowance: (id: string, now: Date) => AA.readAuthoringAllowance(id, now),
      reserve: (id: string, now: Date) => AA.reserveAuthoringCall(id, now),
      call,
      newId: () => `sugg${++ids}`,
    },
  } as unknown as Parameters<typeof H.versionsList>[4];

  const setting = (key: string, value: string | null) => {
    fake.tables.set("PlatformSetting", fake.rows("PlatformSetting").filter((r) => r.key !== key));
    if (value !== null) fake.seed("PlatformSetting", { key, value });
  };
  const suggest = (id: string, mode = "POLISH") => H.aiSuggestHandler("SYNC_FAILED", id, { body: { mode, tone: "WARM" }, reason: { code: "SUPPORT_REQUEST", note: "tidy copy" } }, OP as never, META, NOW, svc).then(j);

  // Customer data that must never reach the model.
  fake.seed("PlatformSetting", { key: "unrelated", value: "x" });
  const save = await j(await H.saveDraftHandler("SYNC_FAILED", { expectedRevision: 0, body: { channel: "EMAIL", variant: "reauth-required", parentVersionId: null, content: BASE, source: { kind: "MANUAL" } } }, OP as never, META, NOW, svc));
  check("the base draft saves", save.status === 201, save.body);
  const baseId = save.body.result.id as string;

  // ── 1. exact payload ───────────────────────────────────────────────────────
  console.log("1. exact payload: template text + placeholder names only");
  const ok = await suggest(baseId);
  check("a clean suggestion ⇒ 200", ok.status === 200, ok.body);
  const sent = bodies[0];
  const expected = buildAiRequest(BASE as never, ["institutionName", "actionUrl"], "POLISH", "WARM");
  check("messages = [system: the fixed instruction, user: exactly the built request]",
    sent.messages.length === 2 && sent.messages[0].role === "system" && sent.messages[0].content === AI_SYSTEM_PROMPT
    && sent.messages[1].role === "user" && sent.messages[1].content === expected.messages[0].content);
  check("the user message is the base text, the kinds, the placeholder names, mode and tone — nothing else",
    sent.messages[1].content === JSON.stringify({ mode: "POLISH", tone: "WARM", placeholders: ["{{institutionName}}", "{{actionUrl}}"], content: {
      subject: BASE.subject, preheader: BASE.preheader,
      blocks: [
        { kind: "hero", heading: "Reconnect {{institutionName}}", greeting: null, text: null, label: null, link: null, title: null, items: null },
        { kind: "paragraph", heading: null, greeting: null, text: BASE.blocks[1].text, label: null, link: null, title: null, items: null },
        { kind: "cta", heading: null, greeting: null, text: null, label: "Reconnect", link: "actionUrl", title: null, items: null },
      ] } }));
  const serial = JSON.stringify(sent);
  check("no operator identity, reason note, sample, fallback or setting value is sent",
    !/op_write|tidy copy|Example Bank|your institution|SUPPORT_REQUEST|unrelated/.test(serial));
  check("strict json_schema response format", sent.response_format?.type === "json_schema" && sent.response_format.json_schema.strict === true);

  // ── 2. a clean suggestion ──────────────────────────────────────────────────
  console.log("2. the suggestion is a separate row; the draft is never overwritten");
  check("result: suggestion, changes, checks; the link-bearing note is dropped",
    ok.body.suggestionId === "sugg1" && ok.body.baseVersionId === baseId && ok.body.changes.length === 1 && ok.body.changes[0].location.prop === "text"
    && ok.body.checks.placeholdersPreserved === true && ok.body.checks.linksAdded === false && ok.body.notes.length === 1 && ok.body.notes[0].category === "GRAMMAR");
  check("the base version is untouched and no version was written", fake.rows("CommsTemplateVersion").length === 1 && (fake.one("CommsTemplateVersion", { id: baseId }) as any).blocks[1].text === BASE.blocks[1].text);
  const row = fake.one("CommsAiSuggestion", { id: "sugg1" }) as any;
  check("CommsAiSuggestion OFFERED with the suggested content, its hash and model; expires in 24 h",
    row?.status === "OFFERED" && row.suggestedContent.blocks[1].text.startsWith("Please") && typeof row.suggestedHash === "string" && row.model === "gpt-4o-mini"
    && Math.abs(new Date(row.expiresAt).getTime() - NOW.getTime() - 86_400_000) < 1000);
  const aud = fake.rows("AuditLog").filter((r) => r.action === AuditAction.COMMS_TEMPLATE_AI_SUGGESTED) as any[];
  check("one AI_SUGGESTED audit row (requestAuditLogId), no text in it", aud.length === 1 && aud[0].id === row.requestAuditLogId && !JSON.stringify(aud[0].metadata).includes("Please sign"));
  const inv = fake.rows("AiInvocation") as any[];
  check("the existing AI ledger recorded the call: surface comms_authoring, sub-surface polish, the operator, correlationId = suggestion id, tokens",
    inv.length === 1 && inv[0].surface === "comms_authoring" && inv[0].subSurface === "comms_authoring:polish" && inv[0].userId === "op_write" && inv[0].correlationId === "sugg1" && inv[0].promptTokens === 900, inv);

  // ── 3. accept ──────────────────────────────────────────────────────────────
  console.log("3. accept by saving a new draft");
  const tmpl = () => fake.one("CommsTemplate", { definitionKey: "SYNC_FAILED", channel: "EMAIL" }) as any;
  const acceptReq = (content: unknown, sid: string, parent: string | null = baseId) => ({ expectedRevision: tmpl().revision, body: { channel: "EMAIL", variant: "reauth-required", parentVersionId: parent, content, source: { kind: "AI_SUGGESTION", suggestionId: sid } } });
  const wrongParent = await j(await H.saveDraftHandler("SYNC_FAILED", acceptReq(row.suggestedContent, "sugg1", null), OP as never, META, NOW, svc));
  check("the parent must be the suggestion's base ⇒ 400", wrongParent.status === 400);
  const acc = await j(await H.saveDraftHandler("SYNC_FAILED", acceptReq(row.suggestedContent, "sugg1"), OP as never, META, NOW, svc));
  check("accepted: a NEW draft, AI_ASSISTED, sourceSuggestionId, aiEditedAfterAccept false",
    acc.status === 201 && acc.body.result.createdBy.kind === "AI_ASSISTED" && acc.body.result.sourceSuggestionId === "sugg1" && acc.body.result.aiEditedAfterAccept === false, acc.body);
  check("the suggestion is ACCEPTED with acceptedVersionId", (fake.one("CommsAiSuggestion", { id: "sugg1" }) as any).status === "ACCEPTED" && (fake.one("CommsAiSuggestion", { id: "sugg1" }) as any).acceptedVersionId === acc.body.result.id);
  const again = await j(await H.saveDraftHandler("SYNC_FAILED", acceptReq(row.suggestedContent, "sugg1"), OP as never, META, NOW, svc));
  check("a suggestion is accepted once ⇒ 409 SUGGESTION_EXPIRED", again.status === 409 && again.body.code === "SUGGESTION_EXPIRED");
  const s2 = await suggest(baseId, "CHECK");
  const edited = { ...(fake.one("CommsAiSuggestion", { id: s2.body.suggestionId }) as any).suggestedContent, subject: "Please reconnect {{institutionName}}" };
  const acc2 = await j(await H.saveDraftHandler("SYNC_FAILED", acceptReq(edited, s2.body.suggestionId), OP as never, META, NOW, svc));
  check("edited before saving ⇒ aiEditedAfterAccept true; CHECK mode recorded as comms_authoring:check",
    acc2.status === 201 && acc2.body.result.aiEditedAfterAccept === true && (fake.rows("AiInvocation") as any[]).some((r) => r.subSurface === "comms_authoring:check"));
  const s3 = await suggest(baseId);
  const late = await j(await H.saveDraftHandler("SYNC_FAILED", acceptReq((fake.one("CommsAiSuggestion", { id: s3.body.suggestionId }) as any).suggestedContent, s3.body.suggestionId), OP as never, META, new Date(NOW.getTime() + 25 * 3_600_000), svc));
  check("an expired suggestion (24 h) ⇒ SUGGESTION_EXPIRED", late.status === 409 && late.body.code === "SUGGESTION_EXPIRED");

  // ── 4. rejected output ─────────────────────────────────────────────────────
  console.log("4. invalid output is rejected, never returned as clean");
  const reject = async (mut: (w: Wire) => void, want: string) => {
    const w = JSON.parse(JSON.stringify(CLEAN)) as Wire;
    mut(w);
    next = async () => ({ choices: [{ message: { content: JSON.stringify(w) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
    const r = await suggest(baseId);
    const stored = fake.one("CommsAiSuggestion", { id: r.body.suggestionId }) as any;
    check(`${want}: 422 SUGGESTION_REJECTED with typed issues, no text returned, stored REJECTED without content`,
      r.status === 422 && r.body.code === "SUGGESTION_REJECTED" && r.body.issues.some((i: any) => i.code === want) && !("suggestion" in r.body) && !JSON.stringify(r.body).includes(w.blocks[1].text ?? "∅")
      && stored?.status === "REJECTED" && stored.suggestedContent === null && stored.rejectionCodes.includes(want), r.body);
  };
  await reject((w) => { w.subject = "Action needed for your bank"; }, "PLACEHOLDERS_DROPPED");
  await reject((w) => { w.blocks[1].text = "Please sign in to {{institutionName}} again at https://phish.example.net now."; }, "LINK_NOT_ALLOWED");
  await reject((w) => { w.blocks[1].text = "Please sign in to {{institutionName}} again and earn 4% interest, guaranteed."; }, "FINANCIAL_CLAIM");
  await reject((w) => { w.blocks[1].text = "Please sign in to {{institutionName}} again. We recommend you sell your bonds."; }, "ADVICE_LANGUAGE");
  await reject((w) => { w.blocks.pop(); }, "STRUCTURE_CHANGED");
  check("rejections never wrote a version", fake.rows("CommsTemplateVersion").length === 3);
  next = async () => ({ choices: [{ message: { content: JSON.stringify(CLEAN) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } });

  // ── 5. typed UNAVAILABLE ───────────────────────────────────────────────────
  console.log("5. typed UNAVAILABLE reasons, checked before any model call");
  const unavailable = async (label: string, reason: string, detail: string | null, retry = false) => {
    const calls = bodies.length;
    const r = await suggest(baseId);
    const all = fake.rows("CommsAiSuggestion") as any[];
    const stored = all[all.length - 1];
    check(`${label}: 503 AI_UNAVAILABLE / ${reason}${detail ? ` / ${detail}` : ""}; row UNAVAILABLE`,
      r.status === 503 && r.body.code === "AI_UNAVAILABLE" && r.body.reason === reason && (detail === null || r.body.detail === detail)
      && stored?.status === "UNAVAILABLE" && stored.unavailableReason === reason && (!retry || Number(r.headers.get("retry-after")) > 0), r.body);
    return bodies.length - calls;
  };
  setting(PlatformSettingKey.AI_PAID_REQUESTS_PAUSED, "true");
  check("kill switch: the model is not called", (await unavailable("kill switch ON", "KILL_SWITCH", "KILL_SWITCH")) === 0);
  setting(PlatformSettingKey.AI_PAID_REQUESTS_PAUSED, "maybe");
  check("kill switch unreadable value: refused, not called", (await unavailable("kill switch INVALID", "KILL_SWITCH", "UNREADABLE")) === 0);
  setting(PlatformSettingKey.AI_PAID_REQUESTS_PAUSED, null);
  setting(PlatformSettingKey.PLATFORM_COST_FROZEN, "true");
  check("global freeze ON: not called", (await unavailable("global Cost Freeze ON", "COST_FREEZE", "FROZEN")) === 0);
  setting(PlatformSettingKey.PLATFORM_COST_FROZEN, "garbage");
  check("global freeze INVALID: not called", (await unavailable("global Cost Freeze INVALID", "COST_FREEZE", "UNVERIFIED")) === 0);
  setting(PlatformSettingKey.PLATFORM_COST_FROZEN, null);
  fake.on("PlatformSetting", "findUnique", () => { throw new Error("db down"); }, { once: true });
  check("global freeze UNAVAILABLE (read failed): not called", (await unavailable("global Cost Freeze UNAVAILABLE", "COST_FREEZE", "UNVERIFIED")) === 0);
  setting(PlatformSettingKey.PLATFORM_COST_FROZEN, "false");
  fake.seed("PolicyGroup", { key: "BETA_FULL_ACCESS_V1", label: "Beta", currentVersion: 1, costFrozen: true });
  const groupReadsBefore = fake.callsTo("PolicyGroup").length;
  const groupOnly = await suggest(baseId);
  check("a Beta-GROUP-only freeze (global OFF) does NOT block operator authoring, and the group is never read",
    groupOnly.status === 200 && fake.callsTo("PolicyGroup").length === groupReadsBefore, groupOnly.body);
  setting(PlatformSettingKey.PLATFORM_COST_FROZEN, null);
  check("global freeze MISSING ⇒ not blocked", (await suggest(baseId)).status === 200);

  const seedCalls = (userId: string, n: number, promptTokens = 1) => {
    for (let i = 0; i < n; i++) fake.seed("AiInvocation", { provider: "OPENAI", model: "gpt-4o-mini", occurredAt: NOW, promptTokens, completionTokens: 0, latencyMs: 1, environment: "development", surface: "comms_authoring", userId, outcome: "RETURNED" });
  };
  const used = (fake.rows("AiInvocation") as any[]).filter((r) => r.userId === "op_write").length;
  seedCalls("op_write", AA.COMMS_AUTHORING_DAILY_CALLS - used);
  check("allowance: 40 calls today ⇒ not called", (await unavailable("allowance (calls)", "ALLOWANCE", "CALLS", true)) === 0);
  fake.tables.set("AiInvocation", []);
  seedCalls("op_write", 1, 14_000_000); // 14M prompt tokens × $0.15/M = $2.10
  check("allowance: $2 spent ⇒ not called", (await unavailable("allowance (USD)", "ALLOWANCE", "USD", true)) === 0);
  fake.tables.set("AiInvocation", []);
  seedCalls("op_other", 1, 70_000_000); // $10.50 by another operator
  check("allowance: $10 fleet ⇒ not called", (await unavailable("allowance (fleet)", "ALLOWANCE", "FLEET_USD", true)) === 0);
  fake.tables.set("AiInvocation", []);

  next = async () => { throw Object.assign(new Error("upstream 500"), { status: 500 }); };
  check("provider error: the call was made once, then PROVIDER", (await unavailable("provider error", "PROVIDER", "FAILED")) === 1);
  next = async () => { throw Object.assign(new Error("slow down"), { status: 429 }); };
  await unavailable("provider rate limit", "PROVIDER", "RATE_LIMITED", true);
  next = async () => ({ choices: [{ message: { content: "" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 0 } });
  await unavailable("empty provider output", "PROVIDER", "FAILED");
  next = async () => ({ choices: [{ message: { content: JSON.stringify(CLEAN) }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  midCallPause = true;
  check("a pause that lands mid-call (the provider chokepoint) ⇒ KILL_SWITCH, provider not reached", (await unavailable("pause mid-call", "KILL_SWITCH", "KILL_SWITCH")) === 0);
  midCallPause = false;
  const inflight = (fake.rows("RateLimit") as any[]).filter((r) => String(r.key).startsWith("user:comms-ai-inflight:")).reduce((n, r) => n + r.count, 0);
  check("every reservation was released (in-flight back to 0)", inflight === 0, fake.rows("RateLimit"));

  // ── 6. the ai availability block ───────────────────────────────────────────
  console.log("6. the ai block on GET /versions (advisory, no model call)");
  const aiBlock = async () => (await j(await H.versionsList("SYNC_FAILED", new URL("https://x.invalid/v?channel=EMAIL&variant=reauth-required"), OP as never, NOW, svc))).body.ai;
  const calls0 = bodies.length;
  const a0 = await aiBlock();
  check("available: remaining calls and USD today", a0.available === true && typeof a0.remainingCallsToday === "number" && a0.remainingCallsToday <= 40 && typeof a0.remainingUsdToday === "number", a0);
  setting(PlatformSettingKey.AI_PAID_REQUESTS_PAUSED, "true");
  const a1 = await aiBlock();
  setting(PlatformSettingKey.AI_PAID_REQUESTS_PAUSED, null);
  setting(PlatformSettingKey.PLATFORM_COST_FROZEN, "true");
  const a2 = await aiBlock();
  setting(PlatformSettingKey.PLATFORM_COST_FROZEN, null);
  seedCalls("op_write", 40);
  const a3 = await aiBlock();
  fake.tables.set("AiInvocation", []);
  fake.on("AiInvocation", "findMany", () => { throw new Error("ledger down"); }, { once: true });
  const a4 = await aiBlock();
  check("kill switch ⇒ KILL_SWITCH; global freeze ⇒ COST_FREEZE; exhausted ⇒ ALLOWANCE; unreadable ledger ⇒ ALLOWANCE (fail closed)",
    a1.available === false && a1.reason === "KILL_SWITCH" && a2.reason === "COST_FREEZE" && a2.detail === "FROZEN" && a3.reason === "ALLOWANCE" && a3.detail === "CALLS" && a4.reason === "ALLOWANCE" && a4.detail === "UNAVAILABLE", [a1, a2, a3, a4]);
  check("the ai block never calls the model and never reserves", bodies.length === calls0 && (fake.rows("RateLimit") as any[]).every((r) => r.count === 0));

  // ── 7. caps ────────────────────────────────────────────────────────────────
  console.log("7. caps: $2 and 40 calls per operator per day, $10 fleet");
  check("contract defaults", AA.COMMS_AUTHORING_DAILY_USD === 2 && AA.COMMS_AUTHORING_DAILY_CALLS === 40 && AA.COMMS_AUTHORING_FLEET_DAILY_USD === 10);
  const u = (o: Partial<{ calls: number; spentUsd: number; unpriced: number; fleetUsd: number; fleetUnpriced: number; inFlight: number }>) =>
    AA.judgeAuthoring({ calls: 0, spentUsd: 0, unpriced: 0, fleetUsd: 0, fleetUnpriced: 0, inFlight: 0, ...o });
  check("39 calls admitted; 39 + 1 in flight refused (CALLS)", u({ calls: 39 }).allowed && !u({ calls: 39, inFlight: 1 }).allowed);
  check("$1.95 + one $0.05 reservation in flight refused (USD)", u({ spentUsd: 1.9 }).allowed && (u({ spentUsd: 1.95, inFlight: 1 }) as any).detail === "USD");
  check("fleet $9.99 + in flight refused (FLEET_USD)", (u({ fleetUsd: 9.99, inFlight: 1 }) as any).detail === "FLEET_USD");
  check("unpriced spend ⇒ remainingUsd null; the call cap still applies", u({ unpriced: 1 }).remainingUsd === null && !u({ unpriced: 1, calls: 40 }).allowed);
  check("Retry-After = seconds to the next UTC midnight", AA.secondsToUtcMidnight(new Date("2026-10-31T23:59:00Z")) === 60);
  const r1 = await AA.reserveAuthoringCall("op_cap", NOW);
  const held = (fake.rows("RateLimit") as any[]).find((r) => r.key === "user:comms-ai-inflight:op_cap");
  check("a reservation takes the operator's advisory lock and holds one in-flight slot", r1.verdict.allowed && held?.count === 1 && fake.raw.some((x) => x.sql.includes("pg_advisory_xact_lock") && x.values.includes("ai-allowance:comms_authoring:op_cap")));
  await r1.release(); await r1.release();
  check("release is idempotent and returns the slot", (fake.rows("RateLimit") as any[]).find((r) => r.key === "user:comms-ai-inflight:op_cap")?.count === 0);
  fake.on("RateLimit", "upsert", () => { throw new Error("db down"); }, { once: true });
  check("a reservation that cannot be taken refuses (fail closed)", !(await AA.reserveAuthoringCall("op_cap", NOW)).verdict.allowed);

  // ── 8. manual editing always works ─────────────────────────────────────────
  console.log("8. manual editing works while AI is unavailable");
  setting(PlatformSettingKey.AI_PAID_REQUESTS_PAUSED, "true");
  setting(PlatformSettingKey.PLATFORM_COST_FROZEN, "true");
  const m = await j(await H.saveDraftHandler("SYNC_FAILED", { expectedRevision: tmpl().revision, body: { channel: "EMAIL", variant: "reauth-required", parentVersionId: null, content: BASE, source: { kind: "MANUAL" } } }, OP as never, META, NOW, svc));
  const p = await j(await H.publishHandler("SYNC_FAILED", m.body.result.id, { reason: { code: "SUPPORT_REQUEST" }, expectedRevision: tmpl().revision, body: { acknowledgeWarnings: true } }, CONTROL as never, META, NOW, svc));
  const pv = await j(await H.previewHandler("SYNC_FAILED", new URL(`https://x.invalid/p?channel=email-html&versionId=${m.body.result.id}`), NOW, svc));
  const rd = await j(H.renderHandler("SYNC_FAILED", { channel: "EMAIL", variant: "reauth-required", content: BASE }, NOW));
  check("save, publish, preview and render all succeed with the kill switch AND the global freeze on", m.status === 201 && p.status === 200 && pv.status === 200 && rd.status === 200, [m.status, p.status, pv.status, rd.status]);

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall AI authoring checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
