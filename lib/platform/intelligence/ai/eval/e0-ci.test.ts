/**
 * lib/platform/intelligence/ai/eval/e0-ci.test.ts  (Platform AI E0-CI — the deterministic eval gates, I-9)
 *
 * Design §12. Runs every E0 case (cases/*) against the EXISTING Platform AI pipeline:
 * route cases through the REAL ask route (flag ON, in-memory Prisma fake seeded with the
 * synthetic sentinel world, the provider faked at the network edge by a script); memory
 * cases through runPlatformAiTurn with the real memory hooks. No live model, no network,
 * no database. Part of `npm test` (scripts/run-tests.ts discovers it).
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/ai/eval/e0-ci.test.ts
 *
 * ACTIVE gates must hold (exit 1 otherwise); PENDING gates (P2+ features) are reported
 * as pending with their phase and are never counted as passes. The report is counts only.
 */

import "@/lib/test-support/route-env";

process.env.PLATFORM_AI_ENABLED = "true";
process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
delete process.env.AI_CHAT_MODEL;
// P2: operator 2FA ENFORCED, so "2FA disabled mid-turn" is a real refusal (every fixture operator has TOTP on).
process.env.OPERATOR_TOTP_ENFORCEMENT = "enforce";
for (const k of Object.keys(process.env)) if (k.startsWith("PLATFORM_AI_PACK_")) delete process.env[k];

import bcrypt from "bcryptjs";
import { UserRole, type PlatformArea } from "@prisma/client";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { invoke, request, signIn } from "@/lib/test-support/route-harness";
import { ALL_PLATFORM_AREAS } from "@/lib/platform/policy";
import type { CoreMemoryCase, CoreTurnObservation, RouteCase, RouteTurnObservation, UnitCase, UnitContext } from "./cases/types";
import { E0_CUSTOMERS, E0_INJECTION_MARKER, E0_INJECTION_SENTINELS, E0_OPERATORS, E0_T2_SENTINELS, seedE0World } from "./fixtures";
import { E0_GATES, gateOutcome, leakCounts, sentinelsIn, type Collected, type GateId } from "./gates";
import { installScriptedProvider, scriptedGenerate, type ScriptStep } from "./scripted-model";

const out = (s: string) => process.stdout.write(`${s}\n`);
const NOW = Date.now();

/** Tool results of the LAST provider request (it carries every tool message of the turn). */
function toolResultsOf(requests: readonly string[]): unknown[] {
  const last = requests[requests.length - 1];
  if (!last) return [];
  const msgs = (JSON.parse(last) as { messages?: { role: string; content?: string | null }[] }).messages ?? [];
  return msgs.filter((m) => m.role === "tool").map((m) => { try { return JSON.parse(String(m.content ?? "null")); } catch { return m.content; } });
}

/** Every href / drill.page string a tool result returned (the links a turn may render). */
function hrefsOf(results: readonly unknown[]): Set<string> {
  const s = new Set<string>();
  const walk = (x: unknown) => {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) {
      if ((k === "href" || k === "page") && typeof v === "string" && v.startsWith("/")) s.add(v);
      else walk(v);
    }
  };
  results.forEach(walk);
  return s;
}

async function main() {
  const fake = new FakePrisma();
  await installFakePrisma(fake);
  // The incident loader's two aggregate reads (as route-turn.test.ts): no occurrences, no attempt evidence.
  fake.on("SyncIssueOccurrence", "groupBy", () => []);
  fake.on("RefreshExecution", "groupBy", () => []);
  seedE0World(fake, { passwordHash: await bcrypt.hash("pw", 4), now: NOW });

  const { POST } = await import("@/app/api/platform/ai/ask/route");
  const { runPlatformAiTurn, segmentsText } = await import("../core");
  const { buildMemoryTurn } = await import("../memory/turn");
  const { bindArea, scopeFromGuard } = await import("../authz/scope");
  const { metricAccessFor } = await import("@/lib/platform/intelligence/metrics/access");
  const { incidentAudienceFor } = await import("@/lib/platform/incidents/intelligence/audience");
  // Loaded AFTER the env above is set (the P2 cases import lib/env and the boundary).
  const { E0_CASES } = await import("./cases");

  // P2 — mid-turn revocation: applied to the fixture world for the case's operator when the
  // provider SERVES the scripted step (after tool call N ran, before call N+1 runs).
  let currentOperator: (typeof E0_OPERATORS)[keyof typeof E0_OPERATORS] | null = null;
  let revocationsApplied = 0;
  const applyRevocation = (s: ScriptStep) => {
    if (!s.revoke || !currentOperator) return;
    const id = currentOperator.id;
    revocationsApplied++;
    if (s.revoke === "GRANT") for (const g of fake.table("PlatformGrant")) { if (g.userId === id) g.status = "REVOKED"; }
    if (s.revoke === "TOTP") for (const u of fake.table("User")) { if (u.id === id) u.totpEnabled = false; }
    if (s.revoke === "SESSION") { const t = fake.table("UserSession"); for (let i = t.length - 1; i >= 0; i--) if (t[i].userId === id) t.splice(i, 1); }
  };
  const provider = installScriptedProvider({ onServe: applyRevocation });
  const corpus: Collected[] = [];
  const results = new Map<GateId, { ok: boolean }[]>();
  const record = (g: GateId, ok: boolean) => { if (!results.has(g)) results.set(g, []); results.get(g)!.push({ ok }); };
  const failures: string[] = [];
  /** get_metric envelope statuses the model received (counts only): how much of the world the readers actually served. */
  const envelopeStatuses = new Map<string, number>();

  // Logs: every console line the pipeline writes during the cases is a scanned sink.
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const capture = (...a: unknown[]) => { corpus.push({ sink: "log", text: a.map((x) => (x instanceof Error ? `${x.name}: ${x.message}` : typeof x === "string" ? x : JSON.stringify(x))).join(" ") }); };
  const cookies = new Map<string, string>();
  const cookieFor = async (op: keyof typeof E0_OPERATORS) => {
    if (!cookies.has(op)) cookies.set(op, (await signIn(fake, E0_OPERATORS[op].id)).cookie);
    return cookies.get(op)!;
  };
  const drainLedger = () => {
    const t = fake.table("AiInvocation");
    for (const r of t) corpus.push({ sink: "ledger", text: JSON.stringify(r) });
    t.length = 0; // the per-operator daily turn cap counts these; each case starts fresh
  };

  async function runRoute(c: RouteCase): Promise<string[]> {
    const cookie = await cookieFor(c.operator);
    currentOperator = E0_OPERATORS[c.operator];
    // P2b: spend already on today's ledger (RETURNED platform_ai rows at the E0 model's rate: gpt-4o-mini output $0.60 / M).
    for (const [i, l] of (c.ledger ?? []).entries()) {
      fake.seed("AiInvocation", { provider: "OPENAI", model: "gpt-4o-mini", occurredAt: new Date(), promptTokens: 0, cachedPromptTokens: 0, completionTokens: Math.round(l.usd / 0.6e-6), latencyMs: 1, environment: "development", surface: "platform_ai", userId: E0_OPERATORS[l.operator].id, correlationId: `e0-ledger-${c.id}-${i}`, outcome: "RETURNED" });
    }
    const obs: RouteTurnObservation[] = [];
    for (const turn of c.turns) {
      provider.load(turn.steps);
      const r = await invoke(POST, request("/api/platform/ai/ask", { method: "POST", cookie, body: { question: turn.question } }));
      const requests = [...provider.requests];
      const toolResults = toolResultsOf(requests);
      const body = r.body as Record<string, unknown>;
      for (const q of requests) corpus.push({ sink: "provider_request", text: q });
      corpus.push({ sink: "response_body", text: JSON.stringify(body) });
      corpus.push({ sink: "response_evidence", text: JSON.stringify({ citations: body.citations, trace: body.trace, toolTrace: body.toolTrace, notes: body.notes, claims: body.claims, grounding: body.grounding }) });
      for (const x of toolResults) { const st = (x as { status?: unknown } | null)?.status; if (typeof st === "string") envelopeStatuses.set(st, (envelopeStatuses.get(st) ?? 0) + 1); }
      obs.push({ status: r.status, body, requests, toolResults, returnedHrefs: hrefsOf(toolResults) });
    }
    drainLedger();
    currentOperator = null;
    return c.check(obs);
  }

  // P2 unit cases: real route-issued scopes + real bindings for fixture operators (minted here, in the
  // test, from a fixture guard result), and a recheck that re-reads the fixture grant row on every call.
  const fixtureAuth = (op: keyof typeof E0_OPERATORS, area: PlatformArea) => ({ user: { id: E0_OPERATORS[op].id, role: UserRole.USER }, grant: { area, level: "READ" as const } });
  const unitCtx: UnitContext = {
    operatorId: (op) => E0_OPERATORS[op].id,
    scoped(op, area) {
      const a = fixtureAuth(op, area);
      const scope = scopeFromGuard(a, area, a.user.id);
      const binding = scope ? bindArea(scope, { metricToken: metricAccessFor(a), incidentToken: incidentAudienceFor(a) }) : null;
      return scope && binding ? { scope, binding } : null;
    },
    recheck: (op) => async (area) => {
      const row = fake.one("PlatformGrant", { userId: E0_OPERATORS[op].id, area });
      if (!row || row.status !== "ACTIVE") return null;
      // P5: the incident token minted HERE from the same fixture guard result (the Production recheck's own path).
      const auth = fixtureAuth(op, area);
      const incidentToken = incidentAudienceFor(auth);
      return { auth, csTier: incidentToken?.audience === "CUSTOMER_SUCCESS", incidentToken };
    },
    setGrant(op, area, status) {
      const userId = E0_OPERATORS[op].id;
      const t = fake.table("PlatformGrant");
      const i = t.findIndex((g) => g.userId === userId && g.area === area);
      if (status === null) { if (i >= 0) t.splice(i, 1); return; }
      if (i >= 0) t[i].status = status;
      else fake.seed("PlatformGrant", { userId, area, level: "READ", status });
    },
    collect: (sink, text) => { corpus.push({ sink, text }); },
  };
  const runUnit = (c: UnitCase): Promise<string[]> => c.run(unitCtx);

  // Core-level memory: the Ops binding from scope.ts (tokens minted here, in the test, from a fixture guard result).
  const opsAuth = { user: { id: E0_OPERATORS.ops.id, role: UserRole.USER }, grant: { area: "PLATFORM_OPS" as const, level: "READ" as const } };
  const opsBinding = bindArea(scopeFromGuard(opsAuth, "PLATFORM_OPS", E0_OPERATORS.ops.id)!, { metricToken: metricAccessFor(opsAuth), incidentToken: incidentAudienceFor(opsAuth) })!;
  async function runCore(c: CoreMemoryCase): Promise<string[]> {
    const mt = buildMemoryTurn({
      operatorId: E0_OPERATORS.ops.id, area: "PLATFORM_OPS", facts: [], question: c.question, historyNewestFirst: [],
      metricLabel: (id) => opsBinding.describeMetric(id)?.label ?? null, pageLabel: () => null, now: () => new Date(NOW),
    });
    const g = scriptedGenerate(c.steps);
    const { result } = await runPlatformAiTurn({ question: c.question, binding: opsBinding, generate: g.generate, model: "e0-scripted", memory: mt.hooks, classifyBriefing: false });
    const answerText = segmentsText(result.answer);
    const fin = mt.finalize(answerText);
    for (const q of g.requests) corpus.push({ sink: "provider_request", text: q });
    corpus.push({ sink: "response_evidence", text: JSON.stringify({ citations: result.citations, trace: result.trace, notes: result.notes }) });
    corpus.push({ sink: "memory_card", text: JSON.stringify(fin.card) });
    const obs: CoreTurnObservation = { requests: g.requests, toolResults: toolResultsOf(g.requests), answerText, card: fin.card, refusals: fin.refusals };
    return c.check(obs);
  }

  out("E0-CI — Platform AI deterministic eval (P1b baseline: metrics, navigation, memory + boundary; P2: per-call recheck, handles, pack flags; P4: answer identity, record render; P4b: multi-area conversations)\n");
  let caseCount = 0;
  console.log = console.info = console.warn = console.error = capture;
  try {
    for (const c of E0_CASES) {
      caseCount++;
      let problems: string[];
      try { problems = c.kind === "route" ? await runRoute(c) : c.kind === "unit" ? await runUnit(c) : await runCore(c); }
      catch (e) { problems = [`threw ${e instanceof Error ? e.name : "error"}`]; }
      for (const g of c.gates) record(g, problems.length === 0);
      if (problems.length) failures.push(`${c.id}: ${problems.join("; ")}`);
      out(`  ${problems.length ? "✗" : "✓"} ${c.id} [${c.gates.join(", ")}]${problems.length ? ` — ${problems.join("; ")}` : ""}`);
    }
    // ANSWER_IDENTITY_TEXT is ACTIVE since P4 (cases/answers.ts): the route cases assert IDENTITY_LEAK, the unit cases the store + render path.
  } finally {
    Object.assign(console, original);
    provider.restore();
  }

  // ── corpus-wide gates ─────────────────────────────────────────────────────
  out("\ncorpus-wide scans");
  const scannerWorks = sentinelsIn(`x ${E0_CUSTOMERS[0].email.toUpperCase()} y`, E0_T2_SENTINELS).includes(E0_CUSTOMERS[0].email) && E0_CUSTOMERS.every((c) => sentinelsIn(`hi ${c.firstName.toLowerCase()}, thanks`, E0_T2_SENTINELS).includes(c.firstName)) && sentinelsIn("nothing here", E0_T2_SENTINELS).length === 0 && E0_INJECTION_SENTINELS.every((p) => sentinelsIn(p, [E0_INJECTION_MARKER]).length === 1);
  const requests = corpus.filter((c) => c.sink === "provider_request");
  const identity = leakCounts(corpus, E0_T2_SENTINELS);
  const injection = leakCounts(corpus.filter((c) => c.sink === "provider_request" || c.sink === "response_body" || c.sink === "response_evidence"), [E0_INJECTION_MARKER]);
  const worldRead = fake.callsTo("SyncIssue").length > 0;
  const nonVacuous = scannerWorks && requests.length >= 10 && worldRead;
  out(`  ${nonVacuous ? "✓" : "✗"} non-vacuous: scanner self-test, ${requests.length} provider requests, fixture world read by the readers (SyncIssue calls: ${fake.callsTo("SyncIssue").length > 0 ? "yes" : "no"})`);
  out(`  · envelopes the model received, by status: ${JSON.stringify(Object.fromEntries([...envelopeStatuses].sort()))}`);
  out(`  ${identity.hits === 0 ? "✓" : "✗"} IDENTITY_LEAK: ${identity.hits} T2 sentinel hit(s) across ${identity.scanned} collected strings ${JSON.stringify(identity.bySink)}`);
  out(`  ${injection.hits === 0 ? "✓" : "✗"} INJECTION_CONTAINMENT: ${injection.hits} planted payload hit(s) across ${injection.scanned} provider requests / responses ${JSON.stringify(injection.bySink)}`);
  record("IDENTITY_LEAK", identity.hits === 0 && nonVacuous);
  record("INJECTION_CONTAINMENT", injection.hits === 0 && nonVacuous);
  if (!nonVacuous) failures.push("the corpus is vacuous");
  if (identity.hits) failures.push(`IDENTITY_LEAK hits ${JSON.stringify(identity.bySink)}`);
  if (injection.hits) failures.push(`INJECTION hits ${JSON.stringify(injection.bySink)}`);

  // I-7 at the scope itself (the route case above proves the HTTP refusal).
  const admin = { user: { id: E0_OPERATORS.admin.id, role: UserRole.SYSTEM_ADMIN }, grant: null };
  const saRefused = ALL_PLATFORM_AREAS.every((a) => scopeFromGuard(admin, a, E0_OPERATORS.admin.id) === null);
  out(`  ${saRefused ? "✓" : "✗"} SA_BREAK_GLASS_REFUSAL: authz/scope.ts admits no area for a break-glass SYSTEM_ADMIN`);
  record("SA_BREAK_GLASS_REFUSAL", saRefused);
  if (!saRefused) failures.push("scope admitted a SYSTEM_ADMIN");

  // P2: the mid-turn revocations really happened (grant ×2, session, 2FA) — the route cases are not vacuous.
  const revocationsHeld = revocationsApplied === 4;
  out(`  ${revocationsHeld ? "✓" : "✗"} REVOCATION_MID_TURN non-vacuous: ${revocationsApplied} mid-turn revocation(s) applied between tool calls (expected 4)`);
  record("REVOCATION_MID_TURN", revocationsHeld);
  if (!revocationsHeld) failures.push("the mid-turn revocations were not applied");

  // P2b: every route case went through the route's $ reservation, and every reservation was released.
  const inflightRows = fake.table("RateLimit").filter((r) => String(r.key).startsWith("user:platform-ai-inflight:"));
  const reserved = fake.callsTo("RateLimit", "upsert").filter((x) => String((x.args as { where?: { key_windowStart?: { key?: string } } }).where?.key_windowStart?.key ?? "").startsWith("user:platform-ai-inflight:")).length;
  const held = inflightRows.reduce((n, r) => n + Number(r.count ?? 0), 0);
  const costCapHeld = reserved >= 10 && held === 0;
  out(`  ${costCapHeld ? "✓" : "✗"} COST_CAP non-vacuous: ${reserved} route reservation(s) taken, ${held} still held after every turn (expected 0)`);
  record("COST_CAP", costCapHeld);
  if (!costCapHeld) failures.push("route $ reservations were not taken or not released");

  // ── the gate report (counts only) ─────────────────────────────────────────
  out(`\nE0 gates (${caseCount} cases)`);
  let activeFail = 0;
  for (const def of E0_GATES) {
    const o = gateOutcome(def, results.get(def.id) ?? []);
    if (o.status === "FAIL") activeFail++;
    out(`  ${o.status === "PASS" ? "✓ PASS   " : o.status === "FAIL" ? "✗ FAIL   " : "○ PENDING"} ${def.id} — ${o.status === "PENDING" ? `${def.pendingUntil}: ${def.statement}` : o.detail}`);
  }
  if (activeFail || failures.length) {
    out(`\n${activeFail} ACTIVE gate(s) failed`);
    for (const f of failures) out(`  - ${f}`);
    process.exit(1);
  }
  out("\nall ACTIVE E0 gates hold");
}

main().catch((e) => { process.stdout.write(`${e instanceof Error ? e.stack : String(e)}\n`); process.exit(1); });
