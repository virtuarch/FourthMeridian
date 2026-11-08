/**
 * app/api/platform/ai/ask/route-turn.test.ts  (Platform AI v0 — one ANSWERED turn through the real route)
 *
 * The REAL POST handler, flag ON, over the in-memory Prisma fake (the REAL
 * incident accessors bound to it — no reader fixture), with the model faked
 * at the network edge: `globalThis.fetch` answers the provider chokepoint's
 * chat-completions requests from a script. Nothing reaches a network.
 *
 * Pins the Preview-acceptance defect "How many incidents are broken right now,
 * and where can I see them?":
 *   1. incident-broken-now is RETRIEVABLE on PLATFORM_OPS through the route's own
 *      wiring (bindingFor → retrieveMetric("PLATFORM_OPS", { metricToken,
 *      incidentToken }) → incidentAccessors.search at the Ops tier), and its value
 *      equals the Incidents tile's (GET /api/platform/platform-ops/incidents,
 *      incidentTotalText) for the same world and the same operator;
 *   2. an answer citing that metric renders the metric's registry link, and a
 *      link the turn did not return is stripped;
 *   3. the response carries the metadata-only trace, and the route logs it;
 *   4. (v1) the model writes {{m:<key>}}; the server renders the tile's figure.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs app/api/platform/ai/ask/route-turn.test.ts
 */

import "@/lib/test-support/route-env";

process.env.PLATFORM_AI_ENABLED = "true";
process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
delete process.env.AI_CHAT_MODEL;

import bcrypt from "bcryptjs";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { invoke, request, makeChecker, signIn } from "@/lib/test-support/route-harness";

const t = makeChecker("POST /api/platform/ai/ask — an answered turn through the real route wiring");
const fake = new FakePrisma();
const PATH = "/api/platform/ai/ask";
const QUESTION = "How many incidents are broken right now, and where can I see them?";

// ── the model, faked at the network edge ────────────────────────────────────
type Step = { calls?: { name: string; args: unknown }[]; content?: string };
let script: Step[] = [];
const sent: { messages: { role: string; content?: string | null }[] }[] = [];
globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
  const url = String((input as { url?: string })?.url ?? input);
  if (!url.endsWith("/chat/completions")) throw new Error("unexpected network call");
  const body = JSON.parse(String(init?.body ?? "{}"));
  sent.push(body);
  const s = script.shift() ?? { content: "done" };
  const message = s.calls
    ? { role: "assistant", content: null, tool_calls: s.calls.map((c, i) => ({ id: `call_${sent.length}_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
    : { role: "assistant", content: s.content ?? "" };
  return new Response(JSON.stringify({
    id: "chatcmpl-test", object: "chat.completion", created: 0, model: body.model,
    choices: [{ index: 0, message, finish_reason: s.calls ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

type Answer = {
  answer: { kind: string; text: string; href?: string }[];
  citations: { metric: string; status: string; href: string | null; figures: string[] }[];
  grounding: { replaced: boolean; verdict: string };
  claims: { claims: number; resolved: number; unresolved: number; admitted: number };
  trace: { tool: string; outcome: string; refs: string[]; drillLink?: boolean }[];
};

async function main() {
  await installFakePrisma(fake);
  // The incident loader's two aggregate reads: no correlated occurrences, no attempt evidence.
  fake.on("SyncIssueOccurrence", "groupBy", () => []);
  fake.on("RefreshExecution", "groupBy", () => []);
  const { POST } = await import("./route");
  const { GET } = await import("@/app/api/platform/platform-ops/incidents/route");
  const { incidentTotalText } = await import("@/components/platform/incidents/incidents-model");

  const now = Date.now();
  const at = (minAgo: number) => new Date(now - minAgo * 60_000);
  // Three open incidents (broken now) and one resolved (not broken now).
  for (const kind of ["UPSERT_ERROR", "UPSERT_ERROR", "UPSERT_ERROR"]) {
    fake.seed("SyncIssue", { kind, provider: "PLAID", resolved: false, createdAt: at(120), firstOccurredAt: at(120), lastOccurredAt: at(5) });
  }
  fake.seed("SyncIssue", { kind: "UPSERT_ERROR", provider: "PLAID", resolved: true, resolvedAt: at(30), createdAt: at(300), firstOccurredAt: at(300), lastOccurredAt: at(200) });

  const op = fake.seed("User", { email: "op@fm.test", username: "op", passwordHash: await bcrypt.hash("pw", 4), emailVerifiedAt: new Date(), role: "USER", totpEnabled: true }).id as string;
  fake.seed("PlatformGrant", { userId: op, area: "PLATFORM_OPS", level: "READ", status: "ACTIVE" });
  fake.seed("Space", { name: "Platform Operations", type: "PLATFORM", platformArea: "PLATFORM_OPS" });
  const cookie = (await signIn(fake, op)).cookie;

  const logs: string[] = [];
  const info = console.info;
  console.info = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  const ask = async (steps: Step[]) => {
    script = [...steps];
    sent.length = 0;
    const r = await invoke(POST, request(PATH, { method: "POST", cookie, body: { question: QUESTION } }));
    return { status: r.status, body: r.body as unknown as Answer };
  };

  try {
    t.section("1. incident-broken-now through the route wiring = the Incidents tile");
    const tile = await invoke(GET, request("/api/platform/platform-ops/incidents?status=broken-now", { cookie }));
    const tileBody = tile.body as unknown as { total: number; truncated: boolean };
    t.check("the Incidents tile (same operator, same world) shows 3 broken now", tile.status === 200 && incidentTotalText(tileBody) === "3", tile.body);

    const r = await ask([
      { calls: [{ name: "get_metric", args: { id: "incident-broken-now@1" } }, { name: "find_page", args: { query: "incidents broken now" } }] },
      { content: "{{m:incident-broken-now@1}} incidents are broken now. See [Broken now](/dashboard/platform/PLATFORM_OPS?workspace=platform-incidents)." },
    ]);
    const toolMsgs = (sent[1]?.messages ?? []).filter((m) => m.role === "tool");
    const envelope = JSON.parse(String(toolMsgs[0]?.content ?? "{}")) as { metric?: string; surface?: string; tier?: string; value?: unknown; status?: string; drill?: { page?: string } };
    t.check("200 ANSWERED", r.status === 200, r.body);
    t.check("the model received a MEASURED envelope on PLATFORM_OPS at the Ops tier (not UNAVAILABLE, not not-found)",
      envelope.metric === "incident-broken-now@1" && envelope.surface === "PLATFORM_OPS" && envelope.tier === "OPS" && envelope.status === "MEASURED", envelope);
    t.check("PARITY: the AI envelope's value equals the tile's figure (incidentTotalText)", `${envelope.value}` === incidentTotalText(tileBody), { ai: envelope.value, tile: incidentTotalText(tileBody) });
    t.check("the envelope is an aggregate: no row, no identifier", typeof envelope.value === "number" && !/subjectUserId|cfake/.test(String(toolMsgs[0]?.content)));
    t.check("the SERVER rendered the figure from that envelope (the model wrote a placeholder, not a number)",
      r.body.answer.map((x) => x.text).join("").startsWith(`${incidentTotalText(tileBody)} incidents are broken now.`) && r.body.claims.resolved === 1 && r.body.claims.unresolved === 0, r.body.answer);
    t.check("…and the citation chip pairs with that figure", r.body.citations[0]?.figures.join() === incidentTotalText(tileBody), r.body.citations);
    t.check("the citation is MEASURED with a registry link", r.body.citations.length === 1 && r.body.citations[0].metric === "incident-broken-now@1" && r.body.citations[0].status === "MEASURED" && r.body.citations[0].href === "/dashboard/platform/PLATFORM_OPS?workspace=platform-incidents", r.body.citations);

    t.section("2. an answer citing the metric renders its registry link; nothing else");
    const links = r.body.answer.filter((s) => s.kind === "link");
    t.check("the grounded figure is kept and the Broken-now page renders as a link",
      !r.body.grounding.replaced && links.length === 1 && links[0].href === "/dashboard/platform/PLATFORM_OPS?workspace=platform-incidents", r.body.answer);
    t.check("…that link is exactly the envelope's drill page (this turn, this surface)", links[0]?.href === envelope.drill?.page);
    const forged = await ask([
      { calls: [{ name: "get_metric", args: { id: "incident-broken-now" } }] },
      { content: "See [CS](/dashboard/platform/CUSTOMER_SUCCESS?workspace=platform-incidents&view=open) or [history](/dashboard/platform/PLATFORM_OPS?workspace=platform-incidents&view=history)." },
    ]);
    t.check("a link this turn did not return (another surface; a page never resolved) is stripped", forged.status === 200 && forged.body.answer.every((s) => s.kind === "text"), forged.body.answer);

    t.section("3. the metadata-only trace");
    t.check("the response carries the trace: get_metric MEASURED (+drill), find_page OK",
      r.body.trace.map((x) => `${x.tool}:${x.outcome}`).join() === "get_metric:MEASURED,find_page:OK" && r.body.trace[0].drillLink === true, r.body.trace);
    const line = logs.find((l) => l.startsWith("[platform-ai] turn "));
    t.check("the route logs ONE metadata line per answered turn — no question or answer text",
      logs.filter((l) => l.startsWith("[platform-ai] turn ")).length === 2 && !!line && line.includes("get_metric:MEASURED(incident-broken-now@1)+drill") && line.includes("claims=1 resolved=1 unresolved=0 admitted=0 verdict=RESOLVED") && !/broken right now|See \[|incidents are broken/.test(logs.join("\n")), logs);

    t.section("4. multi-area (owner 2026-11-08): the ask route composes every held area; an extra area refused at its fresh guard is skipped, unrecorded");
    fake.seed("PlatformGrant", { userId: op, area: "CUSTOMER_SUCCESS", level: "READ", status: "ACTIVE" });
    fake.seed("Space", { name: "Customer Success", type: "PLATFORM", platformArea: "CUSTOMER_SUCCESS" });
    const csRead = await ask([{ calls: [{ name: "get_metric", args: { id: "cs-needs-help@1" } }] }, { content: "ok" }]);
    const csEnv = JSON.parse(String((sent[1]?.messages ?? []).filter((m) => m.role === "tool")[0]?.content ?? "{}")) as { metric?: string; surface?: string; area?: string };
    t.check("an operator holding Ops + CS: a CS-only metric is read on the CS surface through the ask route (composed binding)",
      csRead.status === 200 && csEnv.metric === "cs-needs-help@1" && csEnv.surface === "CUSTOMER_SUCCESS" && csEnv.area === "Customer Success", csEnv);
    // The CS grant is revoked between the directory read and its fresh guard (the race the probe exists for).
    fake.on("PlatformGrant", "findUnique", (args) => {
      const w = (args as { where?: { userId_area?: { area?: string } } }).where?.userId_area;
      return w?.area === "CUSTOMER_SUCCESS" ? { area: "CUSTOMER_SUCCESS", level: "READ", status: "REVOKED", user: { totpEnabled: true } } : undefined;
    });
    const auditBefore = fake.callsTo("AuditLog").length;
    const revoked = await ask([{ calls: [{ name: "get_metric", args: { id: "cs-needs-help@1" } }] }, { content: "ok" }]);
    const revokedTool = String((sent[1]?.messages ?? []).filter((m) => m.role === "tool")[0]?.content ?? "");
    t.check("…a revoked extra area is skipped: its metric is NOT_FOUND, the turn still answers from Ops", revoked.status === 200 && revokedTool === JSON.stringify({ found: false }), revokedTool);
    await new Promise((r) => setTimeout(r, 20));
    t.check("…and the skipped area's refusal writes NO access-denied AuditLog row (probe)", fake.callsTo("AuditLog").length === auditBefore, fake.callsTo("AuditLog").slice(auditBefore));
    fake.clearHooks();
    fake.on("SyncIssueOccurrence", "groupBy", () => []);
    fake.on("RefreshExecution", "groupBy", () => []);
  } finally {
    console.info = info;
  }
  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
