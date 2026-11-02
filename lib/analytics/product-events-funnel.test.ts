/**
 * lib/analytics/product-events-funnel.test.ts  (S2-(a) — the four new writers)
 *
 *   1. SHAPE — each writer writes exactly its allow-listed keys (plus the audit
 *      envelope), null forensics, no Space, the right dedupe.
 *   2. RUNTIME ALLOWLIST — a forbidden key or a non-enum-shaped value smuggled
 *      past the types is dropped before the row is built.
 *   3. ENUM MAPPING — Plaid exit stages / error codes map onto the closed
 *      vocabularies; anything else is "OTHER", never itself.
 *   4. ONCE PER USER — FIRST_SYNC_SUCCEEDED dedupes on (user, action) only, and
 *      runFullRefresh calls it on SUCCEEDED only, never breaking the refresh.
 *   5. THE ENDPOINT — unauthenticated, rate-limited, oversized, extra-key,
 *      non-PLAID and long-string bodies are refused and write nothing; a valid
 *      body answers 204 even when the analytics write fails.
 *   6. CALL SITES — the link-token route, the chat route and the two onExit
 *      handlers are wired as designed, and analytics cannot break them.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/analytics/product-events-funnel.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import {
  allowlistedMetadata, linkExitErrorCode, linkExitStage, recordAiTurnFailed, recordConnectionLinkExited,
  recordConnectionLinkStarted, recordFirstSyncSucceeded, recordSpaceViewed, recordBriefViewed,
  LINK_EXIT_ERROR_CODES, LINK_EXIT_STAGES,
  type ProductEventClient,
} from "@/lib/analytics/product-events";
import { handleLinkExit, parseLinkExitBody, MAX_LINK_EXIT_BODY_BYTES, type LinkExitDeps } from "@/lib/analytics/link-exit";
import { reportPlaidLinkExit } from "@/lib/analytics/link-exit-client";
import { runFullRefresh } from "@/lib/plaid/refresh-execution";
import type { LedgerRecorder } from "@/lib/plaid/refresh-ledger";
import type { ExecutionSource, RefreshStageRecorder } from "@/lib/plaid/refresh-execution-types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

type Call = { sql: string; values: unknown[] };
function fakeClient(result = 1): { client: ProductEventClient; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    client: { $executeRaw(q, ...values) { calls.push({ sql: q.join("$?").replace(/\s+/g, " "), values }); return Promise.resolve(result); } },
  };
}
const metaOf = (c: Call) => JSON.parse(String(c.values[4])) as Record<string, unknown>;
const keysOf = (c: Call) => Object.keys(metaOf(c)).sort().join(",");
const FORBIDDEN_VALUE = /Chase|error_message|link_session|request_id|\$|@|balance|prompt/i;

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const warn = console.warn; console.warn = () => {};
  try { return await fn(); } finally { console.warn = warn; }
}

async function main() {
  console.log("1. shape of each writer");
  {
    const { client, calls } = fakeClient();
    check("CONNECTION_LINK_STARTED writes", await recordConnectionLinkStarted(client, { userId: "u1", provider: "PLAID" }));
    const s = calls[0];
    check("…{provider} only, undeduped, no Space, null forensics",
      keysOf(s) === "actorType,provider,result" && metaOf(s).provider === "PLAID" && s.values[3] === "CONNECTION_LINK_STARTED"
      && s.values[2] === null && /VALUES \(/.test(s.sql) && !/NOT EXISTS/.test(s.sql) && /\$\?::jsonb, NULL, NULL/.test(s.sql), s.sql);

    calls.length = 0;
    await recordConnectionLinkExited(client, { userId: "u1", provider: "PLAID", stage: "REQUIRES_CREDENTIALS", errorCode: "INVALID_CREDENTIALS" });
    const e = calls[0];
    check("CONNECTION_LINK_EXITED: {provider, stage, errorCode} only, undeduped",
      keysOf(e) === "actorType,errorCode,provider,result,stage" && metaOf(e).stage === "REQUIRES_CREDENTIALS"
      && metaOf(e).errorCode === "INVALID_CREDENTIALS" && e.values[3] === "CONNECTION_LINK_EXITED" && !/NOT EXISTS/.test(e.sql));

    calls.length = 0;
    await recordFirstSyncSucceeded(client, { userId: "u1", sourceKind: "WALLET" });
    const f = calls[0];
    check("FIRST_SYNC_SUCCEEDED: {sourceKind} only", keysOf(f) === "actorType,result,sourceKind" && metaOf(f).sourceKind === "WALLET" && f.values[3] === "FIRST_SYNC_SUCCEEDED");

    calls.length = 0;
    await recordAiTurnFailed(client, { userId: "u1", surface: "chat", reason: "timedOut" });
    const a = calls[0];
    check("AI_TURN_FAILED: {surface, reason} only, undeduped, no Space",
      keysOf(a) === "actorType,reason,result,surface" && metaOf(a).reason === "timedOut" && a.values[2] === null && !/NOT EXISTS/.test(a.sql));

    calls.length = 0;
    const bad = [
      await recordConnectionLinkStarted(client, { userId: "u1", provider: "COINBASE" as never }),
      await recordFirstSyncSucceeded(client, { userId: "u1", sourceKind: "MANUAL" as never }),
      await recordAiTurnFailed(client, { userId: "u1", surface: "brief" as never, reason: "failed" }),
      await recordAiTurnFailed(client, { userId: "u1", surface: "chat", reason: "the model said: buy BTC" as never }),
    ];
    check("a provider / source kind / surface / reason outside its vocabulary writes nothing", bad.every((b) => b === false) && calls.length === 0);
    await recordConnectionLinkExited(client, { userId: "u1", provider: "PLAID", stage: "Chase login page" as never, errorCode: "bad pw for jo@x.com" as never });
    check("an exit stage / error code that bypassed the mapper is stored as OTHER, never as itself",
      metaOf(calls[0]).stage === "OTHER" && metaOf(calls[0]).errorCode === "OTHER" && !FORBIDDEN_VALUE.test(String(calls[0].values[4])));
  }

  console.log("2. the runtime allowlist");
  {
    const out = allowlistedMetadata({
      provider: "PLAID", institution_name: "Chase", error_message: "bad password", link_session_id: "ls-1",
      amount: 1234.5, reason: "x".repeat(65), stage: { nested: true }, cached: true, prompt: "how much do I have?",
    });
    check("drops unknown keys, numbers, objects and over-long strings; keeps allow-listed strings and booleans",
      JSON.stringify(out) === JSON.stringify({ provider: "PLAID", cached: true }), JSON.stringify(out));
    // Smuggle a forbidden key through a cast: the writer must drop it.
    const { client, calls } = fakeClient();
    await recordConnectionLinkStarted(client, { userId: "u1", provider: "PLAID", institution: "Chase", email: "jo@x.com" } as never);
    check("a forbidden field smuggled into a writer's input never reaches the row", keysOf(calls[0]) === "actorType,provider,result" && !FORBIDDEN_VALUE.test(String(calls[0].values[4])));
    // A value the types would refuse, reaching an allow-listed key through a cast:
    // the shared writer drops it (an object, a prose-length string).
    calls.length = 0;
    await recordSpaceViewed(client, { userId: "u1", spaceId: "s1", spaceType: { balance: 1234, name: "Chase" } as never });
    await recordBriefViewed(client, { userId: "u1", spaceId: "s1", briefDay: "how much do I have in checking? ".repeat(4), cached: true });
    check("the shared writer drops a non-string / over-long value even on an allow-listed key",
      keysOf(calls[0]) === "actorType,day,result" && keysOf(calls[1]) === "actorType,cached,result"
      && !FORBIDDEN_VALUE.test(String(calls[0].values[4]) + String(calls[1].values[4])),
      `${String(calls[0]?.values[4])} | ${String(calls[1]?.values[4])}`);
  }

  console.log("3. enum mapping");
  {
    check("Plaid exit statuses map to their upper-case stage", linkExitStage("requires_credentials") === "REQUIRES_CREDENTIALS" && linkExitStage("institution_not_found") === "INSTITUTION_NOT_FOUND");
    check("no status ⇒ NONE", linkExitStage(null) === "NONE" && linkExitStage(undefined) === "NONE" && linkExitStage("") === "NONE");
    check("an unknown or free-text status ⇒ OTHER", linkExitStage("Chase login page") === "OTHER" && linkExitStage("brand_new_status") === "OTHER" && linkExitStage(42) === "OTHER");
    check("a literal 'none' from a client is OTHER, not NONE", linkExitStage("none") === "OTHER" && linkExitErrorCode("NONE") === "OTHER");
    check("Plaid error codes map to themselves", linkExitErrorCode("INVALID_CREDENTIALS") === "INVALID_CREDENTIALS" && linkExitErrorCode("institution_down") === "INSTITUTION_DOWN");
    check("no error ⇒ NONE; unknown ⇒ OTHER", linkExitErrorCode(null) === "NONE" && linkExitErrorCode("SOMETHING_NEW") === "OTHER" && linkExitErrorCode({}) === "OTHER");
    check("every vocabulary value is an upper-case enum token", [...LINK_EXIT_STAGES, ...LINK_EXIT_ERROR_CODES].every((v) => /^[A-Z_]+$/.test(v)));
  }

  console.log("4. FIRST_SYNC_SUCCEEDED is once per user, on success only");
  {
    const { client, calls } = fakeClient();
    await recordFirstSyncSucceeded(client, { userId: "u1", sourceKind: "PLAID_ITEM" });
    const sql = calls[0].sql;
    check("one INSERT … SELECT … WHERE NOT EXISTS (same user, same action) — no Space, no day, no key",
      /INSERT INTO "AuditLog" \(.*\) SELECT .* WHERE NOT EXISTS \( SELECT 1 FROM "AuditLog" WHERE "userId" = \$\?::text AND "action" = \$\?::text \)$/.test(sql.trim())
      && !/spaceId" IS NOT DISTINCT|metadata"->>/.test(sql) && calls[0].values[5] === "u1" && calls[0].values[6] === "FIRST_SYNC_SUCCEEDED" && calls[0].values.length === 7, sql);
    const { client: dup } = fakeClient(0);
    check("a second success for the same user inserts nothing (resolves false)", (await recordFirstSyncSucceeded(dup, { userId: "u1", sourceKind: "WALLET" })) === false);

    const blackout: LedgerRecorder = { degradations: [], open: async () => null };
    const runner = (status: "SUCCEEDED" | "FAILED" | "MIXED") => async ({ recorder }: { recorder: RefreshStageRecorder; runId: string }) => {
      recorder.begin("BALANCES", "PROVIDER");
      if (status === "FAILED") recorder.fail("BALANCES", new Error("x")); else recorder.succeed("BALANCES", {});
      if (status === "MIXED") { recorder.begin("TRANSACTIONS", "PROVIDER"); recorder.fail("TRANSACTIONS", new Error("x")); }
      return "done";
    };
    const seen: ExecutionSource[] = [];
    const firstSync = async (s: ExecutionSource) => { seen.push(s); return true; };
    const r1 = await runFullRefresh({ source: { kind: "WALLET", ref: "acct-1", network: "BTC" }, trigger: "CRON", profile: "WALLET_SYNC" },
      { client: blackout, refresh: runner("SUCCEEDED"), firstSync });
    check("a SUCCEEDED execution calls the first-sync writer once with its source",
      r1 === "done" && seen.length === 1 && seen[0].kind === "WALLET" && seen[0].ref === "acct-1");
    await runFullRefresh({ itemId: "item-1", trigger: "CRON", profile: "FULL_REFRESH" }, { client: blackout, refresh: runner("MIXED"), firstSync });
    await runFullRefresh({ itemId: "item-1", trigger: "CRON", profile: "FULL_REFRESH" }, { client: blackout, refresh: runner("FAILED"), firstSync });
    check("PARTIAL and FAILED executions never record a first sync", seen.length === 1);
    await runFullRefresh({ itemId: "item-2", trigger: "RECONNECT", profile: "FULL_REFRESH" }, { client: blackout, refresh: runner("SUCCEEDED"), firstSync });
    check("a Plaid item execution passes PLAID_ITEM and the item id", seen[1]?.kind === "PLAID_ITEM" && seen[1]?.ref === "item-2");
    const r2 = await quietly(() => runFullRefresh({ itemId: "item-3", trigger: "MANUAL", profile: "FULL_REFRESH" },
      { client: blackout, refresh: runner("SUCCEEDED"), firstSync: async () => { throw new Error("analytics down"); } }));
    check("a throwing first-sync writer never breaks the refresh (result returned unchanged)", r2 === "done");
    const src = strip(read("lib/plaid/refresh-execution.ts"));
    check("production defaults to recordFirstSyncForSource only when no recorder is injected",
      /const firstSync = deps\.firstSync \?\? \(deps\.client \? undefined : recordFirstSyncForSource\);/.test(src));
    check("the production writer resolves the owner on systemDb and writes through recordFirstSyncSucceeded(systemDb, …)",
      /recordFirstSyncSucceeded\(systemDb, \{ userId, sourceKind: source\.kind \}\)/.test(src) && /plaidItem\.findUnique\(\{ where: \{ id: source\.ref \}, select: \{ userId: true \} \}\)/.test(src));
  }

  console.log("5. POST /api/analytics/link-exit");
  {
    type Write = { userId: string; values: unknown[] };
    const make = (over: Partial<LinkExitDeps> & { writeFails?: boolean; user?: { id: string } | null } = {}) => {
      const writes: Write[] = [];
      const limits: string[] = [];
      const user = over.user === undefined ? { id: "u1" } : over.user;
      const deps: LinkExitDeps = {
        limitByUser: async (uid, name) => { limits.push(`${name}:${uid}`); return null; },
        withTenant: async (userId, fn) => {
          if (over.writeFails) throw new Error("tenant phase refused");
          const { client, calls } = fakeClient();
          const r = await fn(client);
          for (const c of calls) writes.push({ userId, values: c.values });
          return r;
        },
        ...over,
      };
      return { POST: (r: Request) => handleLinkExit(r, user, deps), writes, limits };
    };
    const req = (body: string, headers: Record<string, string> = {}) =>
      new Request("http://localhost/api/analytics/link-exit", { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

    {
      const route = strip(read("app/api/analytics/link-exit/route.ts"));
      check("the route authenticates FIRST, in its own body, and returns the session refusal as-is",
        /export async function POST\(req: Request\) \{\s*const \[user, authErr\] = await requireUser\(\);\s*if \(authErr\) return authErr;\s*return handleLinkExit\(req, user, \{ limitByUser, withTenant: withTenantDb \}\);\s*\}/.test(route));
      const h = make({ user: null });
      const res = await h.POST(req('{"provider":"PLAID"}'));
      check("no session user ⇒ 401, nothing limited, nothing written", res.status === 401 && h.writes.length === 0 && h.limits.length === 0);
    }
    {
      const h = make({ limitByUser: async () => NextResponse.json({ error: "Too many" }, { status: 429 }) });
      const res = await h.POST(req('{"provider":"PLAID"}'));
      check("over the per-user limit ⇒ 429, nothing written", res.status === 429 && h.writes.length === 0);
    }
    {
      const h = make();
      const big = JSON.stringify({ provider: "PLAID", stage: "x".repeat(MAX_LINK_EXIT_BODY_BYTES) });
      const r1 = await h.POST(req(big));
      const r2 = await h.POST(req('{"provider":"PLAID"}', { "content-length": String(MAX_LINK_EXIT_BODY_BYTES + 1) }));
      check("an oversized body (actual or declared) ⇒ 413, nothing written", r1.status === 413 && r2.status === 413 && h.writes.length === 0);
    }
    {
      const h = make();
      const bodies = [
        "not json", "[]", "null", '"PLAID"', "{}",
        '{"provider":"COINBASE"}',
        '{"provider":"PLAID","institution_name":"Chase"}',
        '{"provider":"PLAID","error_message":"bad password"}',
        '{"provider":"PLAID","link_session_id":"ls-123"}',
        '{"provider":"PLAID","stage":42}',
        `{"provider":"PLAID","errorCode":"${"A".repeat(65)}"}`,
      ];
      const statuses = [];
      for (const b of bodies) statuses.push((await h.POST(req(b))).status);
      check("malformed / non-object / missing or non-PLAID provider / any extra key / non-string or long field ⇒ 400, nothing written",
        statuses.every((s) => s === 400) && h.writes.length === 0, statuses.join(","));
      check("parseLinkExitBody refuses the same set", bodies.every((b) => parseLinkExitBody(b) === null));
    }
    {
      const h = make();
      const res = await h.POST(req('{"provider":"PLAID","stage":"requires_credentials","errorCode":"INVALID_CREDENTIALS"}'));
      const meta = h.writes[0] ? JSON.parse(String(h.writes[0].values[4])) as Record<string, unknown> : {};
      check("a valid body ⇒ 204, one row as the session user, enum values only",
        res.status === 204 && h.writes.length === 1 && h.writes[0].userId === "u1" && h.writes[0].values[1] === "u1"
        && meta.stage === "REQUIRES_CREDENTIALS" && meta.errorCode === "INVALID_CREDENTIALS" && meta.provider === "PLAID"
        && Object.keys(meta).sort().join(",") === "actorType,errorCode,provider,result,stage", JSON.stringify(meta));
      check("the limiter is keyed per user", h.limits[0] === "analytics-link-exit:u1");
      await h.POST(req('{"provider":"PLAID","stage":"Chase login page","errorCode":"SOME_NEW_CODE"}'));
      const m2 = JSON.parse(String(h.writes[1].values[4])) as Record<string, unknown>;
      check("unknown stage / error code strings are stored as OTHER", m2.stage === "OTHER" && m2.errorCode === "OTHER");
      await h.POST(req('{"provider":"PLAID","stage":null,"errorCode":null}'));
      const m3 = JSON.parse(String(h.writes[2].values[4])) as Record<string, unknown>;
      check("a clean cancel (no status, no error) is NONE / NONE", m3.stage === "NONE" && m3.errorCode === "NONE");
    }
    {
      const h = make({ writeFails: true });
      const res = await quietly(() => h.POST(req('{"provider":"PLAID","errorCode":"ITEM_LOCKED"}')));
      check("an analytics write failure still answers 204 (never breaks the caller)", res.status === 204);
    }
  }

  console.log("6. call sites");
  {
    const lt = strip(read("app/api/plaid/link-token/route.ts"));
    check("link-token records CONNECTION_LINK_STARTED {provider: PLAID} AFTER the token exists, in its own caught tenant phase",
      /await withTenantDb\(user\.id, \(tx\) => recordConnectionLinkStarted\(tx, \{ userId: user\.id, provider: "PLAID" \}\)\)\s*\.catch\(\(\) => false\);/.test(lt)
      && lt.indexOf("plaidClient.linkTokenCreate(") < lt.indexOf("recordConnectionLinkStarted(tx")
      && lt.indexOf("recordConnectionLinkStarted(tx") < lt.indexOf("return NextResponse.json({ link_token: token })"));

    const chat = strip(read("app/api/ai/chat/route.ts"));
    check("the chat route's failure recorder writes {surface: chat, reason} in a caught tenant phase",
      /const turnFailed = \(reason: AiTurnFailureReason\): Promise<unknown> =>\s*withTenantDb\(user\.id, \(tx\) => recordAiTurnFailed\(tx, \{ userId: user\.id, surface: 'chat', reason \}\)\)\.catch\(\(\) => false\);/.test(chat));
    const recorded = [...chat.matchAll(/await turnFailed\('(\w+)'\)/g)].map((m) => m[1]);
    check("every accepted-turn failure is recorded with its typed reason (failed×2, unpriced×2, paused×2, timedOut, silent)",
      recorded.sort().join(",") === ["failed", "failed", "paused", "paused", "silent", "timedOut", "unpriced", "unpriced"].sort().join(","), recorded.join(","));
    const pairs: Array<[string, RegExp]> = [
      ["unpriced", /await turnFailed\('unpriced'\);\s*return refuse\(SAY\.unpriced, 503\)/g],
      ["paused", /await turnFailed\('paused'\);\s*return paidRequestsPausedResponse\(\)/g],
      ["timedOut", /await turnFailed\('timedOut'\);\s*return refuse\(SAY\.timedOut, 504\)/g],
      ["silent", /await turnFailed\('silent'\);\s*return refuse\(SAY\.silent, 502\)/g],
      ["failed", /await turnFailed\('failed'\);\s*return refuse\(SAY\.failed, 503\)/g],
    ];
    for (const [reason, re] of pairs) {
      const n = [...chat.matchAll(re)].length;
      check(`…'${reason}' is recorded immediately before its own refusal (${n}×)`, n === (reason === "timedOut" || reason === "silent" ? 1 : 2));
    }
    const before = chat.slice(0, chat.indexOf("const turnFailed"));
    check("input refusals and pre-turn gates (pacing, allowance, pause, plan) come before the recorder and record nothing",
      before.includes("paceAiRequest(") && before.includes("allowanceRefusal(") && before.includes("paidRequestsPausedResponse()")
      && !/turnFailed/.test(before) && !/turnFailed\('(malformed|empty|tooLong|forbidden)'\)/.test(chat)
      && /const \{ say, status \} = REFUSAL\[parsed\.refusal\];\s*return refuse\(say, status\);/.test(chat)
      && /return refuse\(SAY\.forbidden, 403\);/.test(chat) && !/turnFailed\([^)]*\);\s*return refuse\(SAY\.forbidden/.test(chat));
    check("no prompt, history, answer or Space is handed to the failure writer",
      !/recordAiTurnFailed\(tx, \{[^}]*(asked|history|answer|spaceId|message)/.test(chat));

    for (const f of ["context/PlaidContext.tsx", "app/plaid-oauth-return/page.tsx"]) {
      const src = strip(read(f));
      check(`${f}: onExit reports the exit through the client helper (err, metadata) only`, /reportPlaidLinkExit\(err, metadata\);/.test(src));
    }
    const client = read("lib/analytics/link-exit-client.ts");
    check("the client helper imports nothing (no server module can reach the browser bundle)", !/^\s*import /m.test(client));

    // The browser half sends exactly three fields, whatever Plaid handed it.
    const sent: Array<{ url: string; init: RequestInit }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => { sent.push({ url, init }); return new Response(null, { status: 204 }); }) as typeof fetch;
    reportPlaidLinkExit(
      { error_code: "INVALID_CREDENTIALS", error_message: "the password is wrong", display_message: "x", error_type: "ITEM_ERROR" } as never,
      { status: "requires_credentials", link_session_id: "ls-1", request_id: "r-1", institution: { name: "Chase", institution_id: "ins_3" } } as never,
    );
    globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
    let threw = false;
    try { reportPlaidLinkExit(null, null); } catch { threw = true; }
    globalThis.fetch = realFetch;
    const body = sent[0] ? JSON.parse(String(sent[0].init.body)) as Record<string, unknown> : {};
    check("reportPlaidLinkExit POSTs {provider, stage, errorCode} and nothing else from err / metadata",
      sent.length === 1 && sent[0].url === "/api/analytics/link-exit" && sent[0].init.method === "POST" && sent[0].init.keepalive === true
      && JSON.stringify(body) === '{"provider":"PLAID","stage":"requires_credentials","errorCode":"INVALID_CREDENTIALS"}', JSON.stringify(body));
    check("…and a network failure never throws into the Link flow", !threw);
  }

  if (failures > 0) { console.error(`\nproduct-events-funnel.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\nproduct-events-funnel.test: all passed.");
}

void main();
