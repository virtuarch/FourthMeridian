/**
 * lib/platform/intelligence/ai/authz/recheck.test.ts  (Platform AI P2 — the per-call recheck, I-6 / D-6)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/ai/authz/recheck.test.ts
 *
 * 1. createTurnScope (unit): every recheck is one injected read (no memo); a refusal
 *    removes the area for the rest of the turn; the fresh result must pass scope.ts's I-7 rule.
 * 2. createDenialLog: codes only, one row per identical denial per turn (S2 ruling 2).
 * 3. THE REAL ROUTE (flag ON, in-memory Prisma fake, scripted provider): N tool calls ⇒
 *    N extra grant reads and N extra session reads (requireFreshPlatformAccess per call,
 *    non-probe); the grant revoked between call N and N+1 ⇒ N+1 is NOT_FOUND and a
 *    refusal is recorded (OBS-009 path).
 * 4. static: recheck.server.ts is the non-probe fresh guard.
 */

import "@/lib/test-support/route-env";

process.env.PLATFORM_AI_ENABLED = "true";
process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
delete process.env.AI_CHAT_MODEL;
delete process.env.OPERATOR_TOTP_ENFORCEMENT;

import { readFileSync } from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { UserRole, type PlatformArea } from "@prisma/client";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { invoke, request, signIn } from "@/lib/test-support/route-harness";
import { E0_OPERATORS, seedE0World } from "../eval/fixtures";
import { installScriptedProvider } from "../eval/scripted-model";
import type { DenialRow, FreshGuard } from "./recheck";

// Loaded in main(), AFTER the env above is set (scope.ts → the metric layer reads lib/env at import).
let createDenialLog: typeof import("./recheck").createDenialLog;
let createTurnScope: typeof import("./recheck").createTurnScope;
let scopeFromGuard: typeof import("./scope").scopeFromGuard;

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  // stdout directly: section 3 silences console.log / console.info (the route's own metadata lines).
  if (ok) process.stdout.write(`  ✓ ${name}\n`);
  else { failures++; process.stderr.write(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)?.slice(0, 600)}` : ""}\n`); }
}

const OP = "cop0000000000000000000001";
const scopeOf = (area: PlatformArea, op = OP) => scopeFromGuard({ user: { id: op, role: UserRole.USER }, grant: { area, level: "READ" } }, area, op)!;
const isNotFound = (x: unknown) => JSON.stringify(x) === `{"found":false}`;

async function main() {
  ({ createDenialLog, createTurnScope } = await import("./recheck"));
  ({ scopeFromGuard } = await import("./scope"));
  console.log("1. createTurnScope — one read per recheck, refusal drops the area");
  {
    const held = new Set<PlatformArea>(["PLATFORM_OPS", "CUSTOMER_SUCCESS"]);
    const reads: PlatformArea[] = [];
    const recheck = async (a: PlatformArea): Promise<FreshGuard | null> => { reads.push(a); return held.has(a) ? { auth: { user: { id: OP, role: UserRole.USER }, grant: { area: a, level: "READ" } }, csTier: a === "CUSTOMER_SUCCESS" } : null; };
    const s = createTurnScope({ operatorId: OP, scopes: [scopeOf("PLATFORM_OPS"), scopeOf("CUSTOMER_SUCCESS")], recheck });
    for (let i = 0; i < 5; i++) await s.recheck("PLATFORM_OPS");
    check("5 rechecks ⇒ 5 injected reads (no memoisation)", reads.length === 5);
    check("the fresh guard's CS tier is passed through", (await s.recheck("CUSTOMER_SUCCESS"))?.csTier === true);
    held.delete("CUSTOMER_SUCCESS");
    check("a refused recheck ⇒ null and the area leaves the scope", (await s.recheck("CUSTOMER_SUCCESS")) === null && !s.has("CUSTOMER_SUCCESS") && s.narrowed() && s.areas().join() === "PLATFORM_OPS");
    const before = reads.length;
    check("…and is never read again this turn", (await s.recheck("CUSTOMER_SUCCESS")) === null && reads.length === before);
    check("an area never in scope ⇒ null without a read", (await s.recheck("SECURITY_OPS")) === null && reads.length === before);
    for (const [why, fresh] of [
      ["break-glass (grant null)", { auth: { user: { id: OP, role: UserRole.SYSTEM_ADMIN }, grant: null }, csTier: true }],
      ["a grant for another area", { auth: { user: { id: OP, role: UserRole.USER }, grant: { area: "SECURITY_OPS", level: "READ" } }, csTier: false }],
      ["another session user", { auth: { user: { id: "someone-else", role: UserRole.USER }, grant: { area: "PLATFORM_OPS", level: "READ" } }, csTier: false }],
    ] as const) {
      const t = createTurnScope({ operatorId: OP, scopes: [scopeOf("PLATFORM_OPS")], recheck: async () => fresh as unknown as FreshGuard });
      check(`a fresh result from ${why} fails the I-7 rule ⇒ refused`, (await t.recheck("PLATFORM_OPS")) === null && t.areas().length === 0);
    }
    const thrown = createTurnScope({ operatorId: OP, scopes: [scopeOf("PLATFORM_OPS")], recheck: async () => { throw new Error("db"); } });
    check("a recheck that throws ⇒ refused (fail closed)", (await thrown.recheck("PLATFORM_OPS")) === null);
    const forged = createTurnScope({ operatorId: OP, scopes: [{ area: "PLATFORM_OPS", operatorId: OP } as never, scopeOf("PLATFORM_OPS", "another-op")], recheck });
    check("a forged scope or another operator's scope never enters the turn's scope", forged.areas().length === 0);
  }

  console.log("\n2. createDenialLog — codes only, deduped per turn");
  {
    const rows: DenialRow[] = [];
    const log = createDenialLog((r) => rows.push(r));
    for (let i = 0; i < 3; i++) log.emit({ tool: "get_metric", pack: "metrics", reason: "RECHECK_REFUSED" });
    log.emit({ tool: "get_metric", pack: "metrics", reason: "AREA_NOT_IN_SCOPE" });
    log.emit({ tool: "open_page", pack: "navigation", reason: "AREA_NOT_IN_SCOPE" });
    log.emit({ tool: "get_metric", pack: "metrics", reason: "RECHECK_REFUSED", ...({ args: "secret" } as object) } as DenialRow);
    check("3 identical denials ⇒ 1 row; distinct (tool, pack, reason) ⇒ their own rows", rows.length === 3 && log.rows === 3, rows);
    check("a row carries exactly tool, pack, reason (nothing else is forwarded)", rows.every((r) => Object.keys(r).join() === "tool,pack,reason"));
    const throwing = createDenialLog(() => { throw new Error("sink"); });
    check("a failing log sink never throws into the turn", (() => { try { throwing.emit({ tool: "x", pack: "y", reason: "UNKNOWN_TOOL" }); return true; } catch { return false; } })());
  }

  console.log("\n3. the real ask route — the recheck is real DB reads, every call");
  {
    const fake = new FakePrisma();
    await installFakePrisma(fake);
    fake.on("SyncIssueOccurrence", "groupBy", () => []);
    fake.on("RefreshExecution", "groupBy", () => []);
    const now = Date.now();
    seedE0World(fake, { passwordHash: await bcrypt.hash("pw", 4), now });
    const { POST } = await import("@/app/api/platform/ai/ask/route");
    const provider = installScriptedProvider();
    const warns: string[] = [];
    const orig = { warn: console.warn, log: console.log, info: console.info };
    try {
      console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
      console.log = console.info = () => {};
      const { cookie } = await signIn(fake, E0_OPERATORS.ops.id);
      const toolResults = () => {
        const last = provider.requests[provider.requests.length - 1];
        return ((JSON.parse(last) as { messages: { role: string; content: string }[] }).messages ?? []).filter((m) => m.role === "tool").map((m) => JSON.parse(m.content));
      };
      const N = 4;
      const grantReads = () => fake.callsTo("PlatformGrant", "findUnique").length;
      const sessionReads = () => fake.callsTo("UserSession", "findFirst").length;
      const g0 = grantReads(), s0 = sessionReads();
      provider.load([{ calls: Array.from({ length: N }, () => ({ name: "list_metrics", args: {} })) }, { content: "Listed." }]);
      const r = await invoke(POST, request("/api/platform/ai/ask", { method: "POST", cookie, body: { question: "Which metrics can I read?" } }));
      const g = grantReads() - g0, sr = sessionReads() - s0;
      check(`${N} tool calls ⇒ 1 route guard + ${N} per-call grant reads (no memoisation)`, r.status === 200 && g === N + 1, { status: r.status, grantReads: g });
      check(`…and ${N} per-call live session reads on top of the route's own`, sr >= N + 1, { sessionReads: sr });
      check("every call was answered (non-vacuous)", toolResults().length === N && toolResults().every((x) => !isNotFound(x)));

      // Revoke the operator's grant between tool call 1 and tool call 2 (when the provider serves round 2).
      const grant = fake.table("PlatformGrant").find((x) => x.userId === E0_OPERATORS.ops.id)!;
      provider.load([
        { calls: [{ name: "list_metrics", args: {} }] },
        { calls: [{ name: "list_metrics", args: {} }, { name: "get_metric", args: { id: "incident-broken-now@1" } }], effect: () => { grant.status = "REVOKED"; } },
        { content: "Done." },
      ]);
      warns.length = 0;
      const rv = await invoke(POST, request("/api/platform/ai/ask", { method: "POST", cookie, body: { question: "Which metrics can I read?" } }));
      const res = toolResults();
      check("revoked between call 1 and call 2 ⇒ call 1 answered, calls 2 and 3 NOT_FOUND, the turn still answers",
        rv.status === 200 && res.length === 3 && !isNotFound(res[0]) && isNotFound(res[1]) && isNotFound(res[2]), { status: rv.status, res });
      const rows = warns.filter((w) => w.includes("tool refused"));
      check("denial rows: codes only — RECHECK_REFUSED for call 2, AREA_NOT_IN_SCOPE for call 3 (no second recheck read)",
        rows.length === 2 && /tool=list_metrics pack=metrics reason=RECHECK_REFUSED/.test(rows[0]) && /tool=get_metric pack=metrics reason=AREA_NOT_IN_SCOPE/.test(rows[1]) && !rows.some((w) => /incident-broken-now/.test(w)), rows);
      grant.status = "ACTIVE";
    } finally {
      Object.assign(console, orig);
      provider.restore();
    }
  }

  console.log("\n4. static — the injected recheck is the NON-probe fresh guard");
  {
    const s = readFileSync(path.join(process.cwd(), "lib/platform/intelligence/ai/authz/recheck.server.ts"), "utf8");
    check("recheck.server.ts: requireFreshPlatformAccess(area, \"READ\") — no probe option, no cache",
      /await requireFreshPlatformAccess\(area, "READ"\);/.test(s) && !/probe/.test(s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")) && !/new Map|cache/i.test(s.replace(/\/\*[\s\S]*?\*\//g, "")));
    const r = readFileSync(path.join(process.cwd(), "lib/platform/intelligence/ai/authz/recheck.ts"), "utf8");
    check("recheck.ts keeps no module-level cache", !/^(?:const|let|var) \w+ = new (?:Map|Set|WeakMap)/m.test(r));
  }

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
