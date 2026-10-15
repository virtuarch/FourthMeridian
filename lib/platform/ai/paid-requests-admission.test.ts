/**
 * lib/platform/ai/paid-requests-admission.test.ts  (AI COST CONTROLS — the kill switch)
 *
 * The reader's five states (absent ⇒ off; "true" ⇒ paused; invalid ⇒ paused;
 * unreadable ⇒ paused), the provider chokepoint refusing BEFORE the price and
 * before the provider with one zero-token FAILED / AI_PAUSED fact, precedence
 * over every override, and the routes' order. No live database.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/ai/paid-requests-admission.test.ts
 */
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key-never-used";

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AI_PAUSED_CODE, AI_PAUSED_CUSTOMER_MESSAGE, judgePaidRequests, paidRequestsPausedResponse, readPaidRequestsAdmission,
} from "./paid-requests-admission";
import {
  AiPausedError, OPENAI_API_BASE_URL, UnpricedModelError, assertPaidRequestsAdmitted, generateStructuredWithUsage, generateWithTools, isAiPausedFailure,
  type StructuredClient,
} from "@/lib/ai/provider";
import { runWithAiInvocationContext } from "@/lib/ai/invocation-context";
import { dailyAllowanceVerdict } from "@/lib/ai/allowance-core";
import { resolveEffectiveEntitlements } from "@/lib/entitlements/resolve";
import { allowanceUsdOf } from "@/lib/ai/allowance";
import { classifyAiFailure } from "@/lib/ai/invocation";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("  ✗ unexpected:", err); process.exit(1);
});
const ROOT = process.cwd();
const strip = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const settle = () => new Promise((r) => setImmediate(r));

const reader = (value: string | null | undefined, fail = false) => ({ platformSetting: { findUnique: async () => { if (fail) throw new Error("boom"); return value == null ? null : { value }; } } });
function ledger() {
  const rows: Record<string, unknown>[] = [];
  return { rows, invocationClient: { aiInvocation: { create: async ({ data }: { data: Record<string, unknown> }) => { rows.push(data); } } } };
}
function countingClient(): { client: StructuredClient; calls: number } {
  const c = { client: undefined as unknown as StructuredClient, calls: 0 };
  c.client = { chat: { completions: { create: async () => { c.calls++; return { choices: [{ message: { content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }; } } } };
  return c;
}
const SCHEMA = { name: "t", schema: { type: "object", properties: {}, additionalProperties: false } };

async function main() {
  console.log("1. the reader: absent ⇒ off; true ⇒ paused; invalid ⇒ paused; unreadable ⇒ paused");
  {
    check("no row ⇒ MISSING, not paused (ABSENT_MEANS_OFF)", judgePaidRequests(null).state === "MISSING" && !judgePaidRequests(null).paused);
    check('"false" ⇒ OFF', !judgePaidRequests("false").paused && judgePaidRequests("false").state === "OFF");
    check('"true" ⇒ ON, paused', judgePaidRequests("true").paused && judgePaidRequests("true").state === "ON");
    for (const bad of ["yes", "1", "TRUE", "", " true"]) check(`${JSON.stringify(bad)} ⇒ INVALID, paused (fail closed)`, judgePaidRequests(bad).paused && judgePaidRequests(bad).state === "INVALID");
    check("the real reader resolves the row", (await readPaidRequestsAdmission(reader("true"))).paused && !(await readPaidRequestsAdmission(reader(null))).paused);
    const broken = await readPaidRequestsAdmission(reader(null, true));
    check("a throwing store ⇒ UNAVAILABLE, paused, never throws", broken.paused && broken.state === "UNAVAILABLE");
    const res = paidRequestsPausedResponse();
    const body = await res.json() as { error: string; code: string };
    check("the refusal: 503, no-store, { error: customerMessage, code: AI_PAUSED }", res.status === 503 && res.headers.get("Cache-Control") === "no-store" && body.code === AI_PAUSED_CODE && body.error === AI_PAUSED_CUSTOMER_MESSAGE);
    check("the customer sentence names no internals", !/setting|PlatformSetting|kill|switch/i.test(AI_PAUSED_CUSTOMER_MESSAGE) && /paused/.test(AI_PAUSED_CUSTOMER_MESSAGE));
  }

  console.log("\n2. the chokepoint: refused BEFORE the price and before the provider, one FAILED / AI_PAUSED fact");
  {
    const paused = async () => ({ paused: true as const, state: "ON" as const, raw: "true" });
    const admitted = async () => ({ paused: false as const, state: "MISSING" as const, raw: null });
    const CTX = { correlationId: "conv-p", turnIndex: 1, surface: "chat", subSurface: "chat:answer", userId: "usr_9", spaceId: "spc_9" };
    {
      const L = ledger(); const C = countingClient(); let caught: unknown = null;
      await runWithAiInvocationContext(CTX, async () => {
        try { await generateStructuredWithUsage("s", [], SCHEMA, { model: "gpt-5.1" }, { client: C.client, sinks: { invocationClient: L.invocationClient, paidRequestsAdmission: paused } }); } catch (e) { caught = e; }
      });
      await settle();
      check("structured: AiPausedError, provider never called", caught instanceof AiPausedError && C.calls === 0);
      const row = L.rows[0] ?? {};
      check("structured: exactly one zero-token FAILED / AI_PAUSED fact, attributed", L.rows.length === 1 && row.outcome === "FAILED" && row.errorCode === AI_PAUSED_CODE && row.promptTokens === 0 && row.userId === "usr_9" && row.surface === "chat", JSON.stringify(row));
      check("the error message carries the code marker the turn loop records (isAiPausedFailure)", isAiPausedFailure((caught as Error).message) && !isAiPausedFailure("no final answer"));
    }
    {
      const L = ledger(); const C = countingClient(); let caught: unknown = null;
      try { await generateWithTools({ model: "gpt-99-unpriced", messages: [] }, { client: C.client, sinks: { invocationClient: L.invocationClient, paidRequestsAdmission: paused } }); } catch (e) { caught = e; }
      await settle();
      check("tools: the kill switch outranks the unpriced refusal (judged first), one AI_PAUSED fact, not UNPRICED_MODEL", caught instanceof AiPausedError && !(caught instanceof UnpricedModelError) && C.calls === 0 && L.rows.length === 1 && L.rows[0].errorCode === AI_PAUSED_CODE);
    }
    {
      const L = ledger(); const C = countingClient();
      const r = await generateWithTools({ model: "gpt-5.1", messages: [] }, { client: C.client, sinks: { invocationClient: L.invocationClient, paidRequestsAdmission: admitted } });
      await settle();
      check("admitted: the call proceeds and records one RETURNED row, no spurious failure", C.calls === 1 && r.usage?.promptTokens === 10 && L.rows.length === 1 && L.rows[0].outcome === "RETURNED");
    }
    const D = ledger();
    let direct: unknown = null; try { await assertPaidRequestsAdmitted("gpt-5.1", { paidRequestsAdmission: paused, invocationClient: D.invocationClient }); } catch (e) { direct = e; }
    check("assertPaidRequestsAdmitted throws the typed error with the state", direct instanceof AiPausedError && direct.state === "ON" && direct.model === "gpt-5.1");
    const src = strip("lib/ai/provider.ts");
    const entry = ["generateChatReply", "generateWithTools", "generateStructuredWithUsage"];
    for (const fn of entry) {
      const body = src.slice(src.indexOf(`export async function ${fn}`));
      check(`${fn}: awaits the kill switch BEFORE assertPricedModel`, body.indexOf("await assertPaidRequestsAdmitted(") > 0 && body.indexOf("await assertPaidRequestsAdmitted(") < body.indexOf("assertPricedModel("));
    }
    check("the provider reads no PlatformSetting itself (the fm_system reader is imported from lib/platform; the evidence ratchet stays clean)", !/platformSetting|systemDb|@\/lib\/db/.test(src) && /from '@\/lib\/platform\/ai\/paid-requests-admission'/.test(src));
    check("the SDK client pins organization: null and the one base URL (no OPENAI_ORG_ID / OPENAI_BASE_URL side channel)", /organization: null/.test(src) && /baseURL: OPENAI_API_BASE_URL/.test(src) && OPENAI_API_BASE_URL === "https://api.openai.com/v1" && /resolveOpenAiCredentials\(\)/.test(src));
    check("no production file reads OPENAI_BASE_URL or OPENAI_ORG_ID", !/OPENAI_BASE_URL|OPENAI_ORG_ID/.test(strip("lib/ai/openai-credentials.ts") + strip("lib/env.ts")));
  }

  console.log("\n3. precedence: paused beats every override; a QUOTA failure bills nothing");
  {
    const founder = resolveEffectiveEntitlements({ policyGroup: "BETA_FULL_ACCESS_V1", overlay: "FOUNDER_INTERNAL_V1", assignedAt: new Date(), assignedById: null, aiDailyUsdAllowanceOverride: 20 }, { aiDailyUsdAllowanceUsd: 20 });
    check("a customer with the founder overlay, the max override and the max platform value still has an allowance — the allowance does not know about the pause", allowanceUsdOf(founder) === 20 && dailyAllowanceVerdict({ spentUsd: 0, allowanceUsd: 20, unpricedInvocations: 0 }).allowed);
    check("…but the kill switch is judged before the allowance in both routes and before the price at the chokepoint (pinned above), and nothing in its reader takes an entitlement", !/entitlement|overlay|override|SYSTEM_ADMIN|grant/i.test(strip("lib/platform/ai/paid-requests-admission.ts")));
    const chat = strip("app/api/ai/chat/route.ts"), brief = strip("app/api/brief/generate/route.ts");
    check("chat: auth → entitlement → pacing → kill switch → allowance", chat.indexOf("requireUser()") < chat.indexOf("entitlementsForUser(") && chat.indexOf("'ai-chat-hour'") < chat.indexOf("readPaidRequestsAdmission()") && chat.indexOf("readPaidRequestsAdmission()") < chat.indexOf("dailyAiAllowanceFor("));
    check("brief: auth → entitlement → pacing → kill switch → allowance → pricing pre-flight", brief.indexOf("'ai-brief-generate'") < brief.indexOf("readPaidRequestsAdmission()") && brief.indexOf("readPaidRequestsAdmission()") < brief.indexOf("dailyAiAllowanceFor(") && brief.indexOf("dailyAiAllowanceFor(") < brief.indexOf("assertPricedModel("));
    const spendLimit = Object.assign(new Error("429 project spend limit"), { status: 429, code: "project_spend_limit_exceeded" });
    check("a project spend-limit 429 classifies as QUOTA (no retry), a zero-token row the spend fold never counts (RETURNED only)", classifyAiFailure(spendLimit).outcome === "QUOTA" && /outcome: "RETURNED"/.test(strip("lib/platform/ai/customer-spend-today.ts")) && /"outcome" = 'RETURNED'/.test(strip("lib/platform/ai/spend-health.ts")));
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}
void main();
