/**
 * lib/platform/intelligence/ai/assessment/incident.test.ts  (Incident drawer PR-D — the Platform AI assessment; S2 09gg (d) pins)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/ai/assessment/incident.test.ts
 *
 *   1. flag / pack off ⇒ both routes 404 NOT_AVAILABLE before anything else (no DB call); the drawer slot
 *      renders nothing unless the detail DTO says aiAssessmentAvailable: true (the detail routes set it
 *      from the pack flag);
 *   2. admission: one Assess = one turn read + one $ reservation (released) + exactly ONE model call; the
 *      turn cap / kill switch / cost freeze / $ cap refuse BEFORE the tool and BEFORE any provider call;
 *      an invisible incident is 404 before admission;
 *   3. the inferred-cause contract: HYPOTHESIS is never stated as fact (always "Likely:"), CONFIRMED is,
 *      NONE ⇒ "Cause not yet confirmed.";
 *   4. no "recovered / resolved / fixed" without verifiedRecovery — across every state × closure × remedy
 *      × provider code × kind, and in the framing sentence;
 *   5. answers 3, 4, 5 never come from the model (a stubbed model's output is ignored for them); the
 *      framing sentence is dropped on a digit, a causal claim or a recovery claim;
 *   6. the provider payload is the record only (no handle, no T2 field names, no free text);
 *   7. source pins: the routes' gate order and guards, the wiring (one correlation id, the boundary with
 *      the incidents pack only and the audit writer), render-only (no persistence), the drawer wiring;
 *   8. the view-model: quiet lines, hypothesis marking, 390 px-safe markup.
 *   The CS audit (PLATFORM_AI_RECORD_VIEWED) and the T2-sentinel payload scan run through the REAL
 *   boundary over the E0 fixtures: eval/cases/incidents.ts "pd.incident-assessment".
 */

import "@/lib/test-support/route-env";

for (const k of Object.keys(process.env)) if (k.startsWith("PLATFORM_AI_")) delete process.env[k];

import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { invoke, request } from "@/lib/test-support/route-harness";
import { KNOWN_PROVIDER_ERROR_CODES, REMEDY_CLASS_ANSWERS } from "@/lib/platform/incidents/explanations";
import type { IncidentDetailDTO } from "@/lib/platform/incidents/investigation-dto";
import {
  ASSESSMENT_RECOVERY_LABEL, ASSESSMENT_TOOL, CAUSE_NOT_CONFIRMED, RECOVERY_CLAIM, assessmentPayload, checkAssessmentFraming, composeAssessmentAnswers,
  handleIncidentAssessment, type IncidentAssessment, type IncidentAssessmentDeps, type RecoveryKind,
} from "./incident";
import type { PlatformAiGenerate } from "../core";
import { RECOVERY_LABEL } from "@/components/platform/incidents/incidents-model";
import { AiAssessmentSurface, IncidentAiAssessment } from "@/components/platform/incidents/AiAssessmentSection";
import { ASSESSMENT_QUIET, assessmentQuietLine, incidentAssessmentPath, isHypothesis, parseAssessment } from "@/components/platform/incidents/ai-assessment-model";
import { aiAssessmentSlot } from "@/components/platform/incidents/IncidentsLead";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}

const NOW = new Date("2026-11-11T12:00:00.000Z");
const code = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** An OPS-tier investigate record (the pack's closed fields; synthetic). */
function fields(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: "active", severity: "critical", domain: "transactions", kind: "TRANSACTION_PERSISTENCE_FAILED", provider: "PLAID", operation: "transaction-persist",
    brokenNow: true, customerActionable: false, firstSeenAt: "2026-11-11T08:00:00.000Z", lastSeenAt: "2026-11-11T11:55:00.000Z", resolvedAt: null,
    occurrences: 4, spread: "isolated", affectedSources: 1, generation: 1, causeStatus: "NONE", cause: null, closure: null,
    displayStatus: "action-needed", remedy: "server-retry", customerActionRequired: false, providerErrorCode: null, providerErrorUnrecognised: false,
    connectionStatus: "ERROR", sourceState: "LIVE", attempts: 3, attemptsSucceeded: 1, attemptsFailed: 2, lastSucceededAt: null, lastFailedAt: null,
    earlierEpisodes: 0, closureOutcome: null, resolutionReason: null, recoveryProofs: 0, timelineEvents: 2, lastEventType: "OBSERVED",
    lastActionCode: null, lastOutcomeCode: null, archived: false, ...o,
  };
}
const confirmedResult = (f: Record<string, unknown>) => ({ status: "CONFIRMED", asOf: NOW.toISOString(), records: [{ handle: "h_AAAAAAAAAAAAAAAA", kind: "INCIDENT", fields: f, t2Fields: ["name", "email"] }], truncated: false });

const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 10, reasoningTokens: 0 };
const reply = (content: string) => ({ content, toolCalls: [], raw: { role: "assistant", content }, usage });

function deps(log: string[], o: Partial<IncidentAssessmentDeps> & { record?: Record<string, unknown>; content?: string; requests?: unknown[][] } = {}): IncidentAssessmentDeps {
  const generate: PlatformAiGenerate = async ({ messages, tools }) => {
    log.push("generate");
    o.requests?.push(messages as unknown[]);
    if (tools.length !== 0) log.push("tools-offered");
    return reply(o.content ?? JSON.stringify({ framing: "This needs attention today." })) as never;
  };
  return {
    enabled: true, tier: "ops", operatorId: "op_test_1",
    recovery: async () => { log.push("recovery"); return []; },
    admission: async () => { log.push("admission"); return { paused: false }; },
    freeze: async () => { log.push("freeze"); return { frozen: false }; },
    turns: async () => { log.push("turns"); return { allowed: true }; },
    spend: async () => { log.push("spend"); return { verdict: { allowed: true }, release: async () => { log.push("release"); } }; },
    investigate: async () => { log.push("investigate"); return confirmedResult(o.record ?? fields()); },
    generate, model: "test-model", now: () => NOW,
    ...o,
  };
}
const answersOf = (b: Record<string, unknown>) => (b as unknown as IncidentAssessment).answers;
const textOf = (b: Record<string, unknown>, key: string) => answersOf(b).find((a) => a.key === key)?.text ?? "";

async function main() {
  // ── 1. flag / pack off ─────────────────────────────────────────────────────
  console.log("1. flag / pack off ⇒ 404 NOT_AVAILABLE, nothing else; the slot renders nothing");
  {
    const fake = new FakePrisma();
    installFakePrisma(fake);
    for (const [label, path] of [["ops", "app/api/platform/platform-ops/incidents/[id]/assessment/route"], ["cs", "app/api/platform/customer-success/incidents/[id]/assessment/route"]] as const) {
      const mod = (await import(`@/${path}`)) as { POST: unknown };
      const res = await invoke(mod.POST, request(`/api/platform/${label === "ops" ? "platform-ops" : "customer-success"}/incidents/inc_1/assessment`, { method: "POST" }), { id: "inc_1" });
      check(`${label} route: flags unset ⇒ 404 NOT_AVAILABLE`, res.status === 404 && (res.body as { code?: string })?.code === "NOT_AVAILABLE", res);
    }
    check("…and nothing was read (no session, no ledger, no incident)", fake.calls.length === 0, fake.calls.length);
    const log: string[] = [];
    const r = await handleIncidentAssessment(deps(log, { enabled: false }));
    check("handler: pack off ⇒ 404 NOT_AVAILABLE and no dep was called", r.status === 404 && r.body.code === "NOT_AVAILABLE" && log.length === 0, log);

    const dto = (tier: "ops" | "cs", available?: boolean) => ({ tier, incident: { id: "inc_1" }, ...(available === undefined ? {} : { aiAssessmentAvailable: available }) }) as unknown as IncidentDetailDTO;
    for (const t of ["ops", "cs"] as const) {
      check(`${t}: aiAssessmentAvailable false ⇒ the slot is undefined`, aiAssessmentSlot(t, dto(t, false)) === undefined);
      check(`${t}: aiAssessmentAvailable absent ⇒ the slot is undefined`, aiAssessmentSlot(t, dto(t)) === undefined);
      check(`${t}: available ⇒ the slot renders the collapsed disclosure, never an automatic call`, (() => {
        const html = renderToStaticMarkup(createElement(IncidentAiAssessment, { tier: t, d: dto(t, true) }));
        return html.includes("data-ai-assessment") && html.includes("AI assessment") && html.includes("data-ai-assessment-assess") && !/<details[^>]*\sopen/.test(html) && !html.includes("data-ai-assessment-result");
      })());
      check(`${t}: IncidentAiAssessment with the flag false renders ""`, renderToStaticMarkup(createElement(IncidentAiAssessment, { tier: t, d: dto(t, false) })) === "");
    }
    check("a tier / DTO mismatch renders nothing", aiAssessmentSlot("ops", dto("cs", true)) === undefined);
    for (const f of ["app/api/platform/platform-ops/incidents/[id]/route.ts", "app/api/platform/customer-success/incidents/[id]/route.ts"]) {
      check(`${f}: the detail DTO carries aiAssessmentAvailable from the incidents pack flag`, /aiAssessmentAvailable: env\.isPlatformAiPackIncidentsEnabled/.test(code(f)));
    }
    const lead = code("components/platform/incidents/IncidentsLead.tsx");
    check("the drawer passes the slot only through aiAssessmentSlot(tier, data)", /aiAssessment: aiAssessmentSlot\(tier, data\)/.test(lead) && (lead.match(/<IncidentAiAssessment\b/g) ?? []).length === 1);
    const sec = code("components/platform/incidents/AiAssessmentSection.tsx");
    check("the section fetches ONLY inside the Assess handler (never on mount: no useEffect)", !/useEffect/.test(sec) && (sec.match(/fetch\(/g) ?? []).length === 1 && /async function assess\(\)/.test(sec));
  }

  // ── 2. admission ───────────────────────────────────────────────────────────
  console.log("\n2. admission: one turn, one reservation, refusals before any provider call");
  {
    const log: string[] = [];
    const r = await handleIncidentAssessment(deps(log));
    check("200 with five answers", r.status === 200 && answersOf(r.body).length === 5, r);
    check("order: recovery → kill switch → freeze → turns → $ → tool → ONE model call → release",
      log.join() === "recovery,admission,freeze,turns,spend,investigate,generate,release", log);
    check("exactly one turn read, one reservation, one model call (= one turn), released once",
      log.filter((x) => x === "turns").length === 1 && log.filter((x) => x === "spend").length === 1 && log.filter((x) => x === "generate").length === 1 && log.filter((x) => x === "release").length === 1);
    check("the model is offered NO tools", !log.includes("tools-offered"));

    const refusals: [string, Partial<IncidentAssessmentDeps>, number, string][] = [
      ["kill switch", { admission: async () => ({ paused: true }) }, 503, "AI_UNAVAILABLE"],
      ["kill switch unreadable", { admission: async () => { throw new Error("x"); } }, 503, "AI_UNAVAILABLE"],
      ["cost freeze", { freeze: async () => ({ frozen: true }) }, 503, "AI_UNAVAILABLE"],
      ["turn cap reached", { turns: async () => ({ allowed: false, detail: "DAILY_TURNS" }) }, 429, "DAILY_TURNS"],
      ["turn cap unreadable", { turns: async () => ({ allowed: false, detail: "UNAVAILABLE" }) }, 503, "AI_UNAVAILABLE"],
      ["$ cap", { spend: async () => ({ verdict: { allowed: false, detail: "COST_CAP" }, release: async () => {} }) }, 429, "COST_CAP"],
      ["$ gate unavailable", { spend: async () => { throw new Error("x"); } }, 503, "AI_UNAVAILABLE"],
    ];
    for (const [name, over, status, c] of refusals) {
      const l: string[] = [];
      const x = await handleIncidentAssessment(deps(l, over));
      check(`${name} ⇒ ${status} ${c}, before the tool and before any provider call`, x.status === status && x.body.code === c && !l.includes("investigate") && !l.includes("generate"), { x, l });
    }
    {
      const l: string[] = [];
      const x = await handleIncidentAssessment(deps(l, { admission: async () => ({ paused: true }) }));
      const y = await handleIncidentAssessment(deps([], { freeze: async () => ({ frozen: true }) }));
      check("kill switch and cost freeze give the SAME quiet body (one code, no reason)", JSON.stringify(x.body) === JSON.stringify(y.body) && !("reason" in x.body) && l.join() === "recovery", l);
      const t = await handleIncidentAssessment(deps([], { turns: async () => ({ allowed: false, detail: "DAILY_TURNS" }) }));
      check("the turn cap carries Retry-After to UTC midnight", Number(t.headers?.["Retry-After"]) === 12 * 3600);
    }
    {
      const l: string[] = [];
      const x = await handleIncidentAssessment(deps(l, { recovery: async () => { l.push("recovery"); return null; } }));
      check("an incident this guard cannot see ⇒ 404 before admission (no turn, no reservation)", x.status === 404 && l.join() === "recovery", l);
      const m: string[] = [];
      const y = await handleIncidentAssessment(deps(m, { investigate: async () => { m.push("investigate"); return { status: "MISSING", records: [] }; } }));
      check("a MISSING tool result ⇒ 404, the model never called, the reservation released", y.status === 404 && !m.includes("generate") && m.includes("release"), m);
      const u: string[] = [];
      const z = await handleIncidentAssessment(deps(u, { investigate: async () => { u.push("investigate"); return { status: "UNAVAILABLE", records: [] }; } }));
      check("an UNAVAILABLE tool result (e.g. the CS audit failed) ⇒ 503, no model call, released", z.status === 503 && !u.includes("generate") && u.includes("release"), u);
      const p: string[] = [];
      const w = await handleIncidentAssessment(deps(p, { generate: async () => { p.push("generate"); throw new Error("provider down"); } }));
      check("a provider error ⇒ the answers stand (no framing), released", w.status === 200 && (w.body as unknown as IncidentAssessment).framing === null && answersOf(w.body).length === 5 && p.includes("release"));
    }
  }

  // ── 3. the inferred-cause contract ─────────────────────────────────────────
  console.log("\n3. HYPOTHESIS is never fact; CONFIRMED is; NONE ⇒ 'Cause not yet confirmed.'");
  {
    for (const cause of ["PROVIDER_OUTAGE", "PROVIDER_DATA_DEFECT", "PLATFORM_DEFECT", "CONFIGURATION", "MEMBER_INPUT", "UNKNOWN"]) {
      const hyp = composeAssessmentAnswers(fields({ causeStatus: "HYPOTHESIS", cause }), []).find((a) => a.key === "why")!;
      check(`HYPOTHESIS ${cause} ⇒ "Likely: …" and flagged`, /^Likely: /.test(hyp.text) && hyp.hypothesis === true, hyp);
      const conf = composeAssessmentAnswers(fields({ causeStatus: "CONFIRMED", cause }), []).find((a) => a.key === "why")!;
      check(`CONFIRMED ${cause} ⇒ stated as fact (no "Likely")`, !/likely/i.test(conf.text) && conf.hypothesis === undefined && conf.text.length > 3, conf);
    }
    for (const f of [fields({ causeStatus: "NONE", cause: null }), fields({ causeStatus: "HYPOTHESIS", cause: null }), fields({ causeStatus: "CONFIRMED", cause: null })]) {
      const w = composeAssessmentAnswers(f, []).find((a) => a.key === "why")!;
      check(`causeStatus ${f.causeStatus} with no cause ⇒ "${CAUSE_NOT_CONFIRMED}"`, w.text === CAUSE_NOT_CONFIRMED && !w.hypothesis);
    }
    // Every answer: a HYPOTHESIS cause's words never appear unmarked anywhere else.
    const all = composeAssessmentAnswers(fields({ causeStatus: "HYPOTHESIS", cause: "PLATFORM_DEFECT" }), []);
    check("a HYPOTHESIS cause is stated nowhere but the marked answer", all.filter((a) => /defect in the platform/i.test(a.text)).every((a) => a.key === "why" && /^Likely: /.test(a.text)));
    const l: string[] = [];
    const r = await handleIncidentAssessment(deps(l, { record: fields({ causeStatus: "HYPOTHESIS", cause: "PROVIDER_OUTAGE" }), content: JSON.stringify({ framing: "This failed because the provider was down." }) }));
    check("a model framing that states the hypothesis as fact is DROPPED", (r.body as unknown as IncidentAssessment).framing === null && /^Likely: /.test(textOf(r.body, "why")));
  }

  // ── 4. no recovery claim without verifiedRecovery ──────────────────────────
  console.log("\n4. no 'recovered / resolved / fixed' without verifiedRecovery");
  {
    const STATES = ["active", "acknowledged", "recovering", "stale-unverified", "resolved", "archived"];
    const OUTCOMES = [null, "verified-recovery", "operator-fixed", "operator-closed", "dismissed", "subject-removed", "legacy"];
    const REMEDIES = [null, "customer-reconnect", "customer-re-add", "server-retry", "investigate"];
    const CODES = [null, ...KNOWN_PROVIDER_ERROR_CODES];
    const KINDS = ["TRANSACTION_PERSISTENCE_FAILED", "REPLAY_RECOVERED", "REPLAY_FAILED", "MISSING_ACCOUNT", "OTHER"];
    const ACTIONS: RecoveryKind[][] = [[], ["resync"], ["request-reauth"], ["refresh-customer"], ["run-job"]];
    let combos = 0, bad = 0, verifiedSaid = 0;
    const firstBad: unknown[] = [];
    for (const state of STATES) for (const closureOutcome of OUTCOMES) for (const remedy of REMEDIES) for (const providerErrorCode of CODES) for (const kind of KINDS) {
      const f = fields({ state, closureOutcome, remedy, providerErrorCode, kind, brokenNow: state === "active" });
      for (const acts of ACTIONS) {
        combos++;
        const a = composeAssessmentAnswers(f, acts);
        const claim = a.some((x) => RECOVERY_CLAIM.test(x.text));
        if (closureOutcome === "verified-recovery") { if (claim) verifiedSaid++; continue; }
        if (claim) { bad++; if (firstBad.length < 3) firstBad.push({ f: { state, closureOutcome, remedy, providerErrorCode, kind }, a }); }
      }
    }
    check(`no unverified recovery claim across ${combos} combinations`, bad === 0, firstBad);
    check("…and a verified recovery IS said (the rule is not vacuous)", verifiedSaid > 0);
    for (const [s, verified, want] of [["It has recovered.", false, null], ["This was resolved overnight.", false, null], ["Looks fixed now.", false, null], ["It has recovered.", true, "It has recovered."]] as const) {
      check(`framing "${s}" (verified ${verified}) ⇒ ${want ?? "dropped"}`, checkAssessmentFraming(JSON.stringify({ framing: s }), verified).text === want);
    }
    for (const r of Object.values(REMEDY_CLASS_ANSWERS)) check("explanations.ts REMEDY_CLASS_ANSWERS never claims a recovery", ![r.canFix, r.customer, r.operatorNext].some((t) => RECOVERY_CLAIM.test(t)));
  }

  // ── 5. answers 3–5 are the server's ────────────────────────────────────────
  console.log("\n5. answers 3, 4, 5 never come from the model; the framing is checked");
  {
    const f = fields({ remedy: "customer-reconnect", providerErrorCode: "ITEM_LOGIN_REQUIRED", customerActionRequired: true, connectionStatus: "NEEDS_REAUTH" });
    const evil = JSON.stringify({
      framing: "Worth a look today.", fix: "Yes, we fixed it.", canFix: "Yes", customer: "No action needed.", customerAction: "No", next: "Resync now.", operatorNext: "Resync now.",
      answers: [{ key: "fix", text: "Fixed." }], next_actions: [{ label: "Resync", href: "/x" }],
    });
    const r = await handleIncidentAssessment(deps([], { record: f, content: evil, recovery: async () => ["request-reauth"] }));
    const expected = composeAssessmentAnswers(f, ["request-reauth"]);
    for (const k of ["fix", "customer", "next"]) check(`answer ${k} equals the server composition (model reply ignored)`, textOf(r.body, k) === expected.find((a) => a.key === k)!.text, textOf(r.body, k));
    check("…the whole answer set equals the server composition", JSON.stringify(answersOf(r.body)) === JSON.stringify(expected));
    check("…the framing is the only model text kept", (r.body as unknown as IncidentAssessment).framing === "Worth a look today.");
    check("customer-reconnect ⇒ 'Can FourthMeridian fix it' is the class answer", textOf(r.body, "fix") === REMEDY_CLASS_ANSWERS["customer-reconnect"].canFix);
    check("ITEM_LOGIN_REQUIRED ⇒ the customer answer is the code's own action (explanations.ts)", /^Yes\. Reconnect this bank from the Connections page/.test(textOf(r.body, "customer")));
    check("the next step names the drawer's recovery action", textOf(r.body, "next").includes(ASSESSMENT_RECOVERY_LABEL["request-reauth"]));
    check("ASSESSMENT_RECOVERY_LABEL equals the drawer's RECOVERY_LABEL", JSON.stringify(ASSESSMENT_RECOVERY_LABEL) === JSON.stringify(RECOVERY_LABEL));
    const noAct = composeAssessmentAnswers(fields({ remedy: "investigate" }), []).find((a) => a.key === "next")!.text;
    check("no recovery action ⇒ the class / code explanation's next step", noAct === REMEDY_CLASS_ANSWERS.investigate.operatorNext);
    for (const [s, want] of [
      ["There are three failures.", "DROPPED_FRAMING"], ["Seen 4 times today.", "DROPPED_FRAMING"], ["See https://example.test for more.", "DROPPED_FRAMING"],
      ["This happened because of a platform bug.", "DROPPED_CAUSAL"], ["Likely a provider outage.", "DROPPED_CAUSAL"],
      ["", "NONE"], ["Worth a closer look before the next sync.", "KEPT"],
    ] as const) {
      check(`framing "${s}" ⇒ ${want}`, checkAssessmentFraming(JSON.stringify({ framing: s }), false).outcome === want, checkAssessmentFraming(JSON.stringify({ framing: s }), false));
    }
    const two = checkAssessmentFraming(JSON.stringify({ framing: "A calm sentence. And another here." }), false);
    check("at most ONE sentence is kept", two.text === "A calm sentence.", two);
  }

  // ── 6. the payload ─────────────────────────────────────────────────────────
  console.log("\n6. the provider payload is the record's closed fields only");
  {
    const requests: unknown[][] = [];
    await handleIncidentAssessment(deps([], { requests }));
    const sent = JSON.stringify(requests);
    check("one request: system + the record", requests.length === 1 && requests[0].length === 2);
    check("no handle, no T2 field names, no customer field on the Ops record", !/h_AAAAAAAAAAAAAAAA/.test(sent) && !/t2Fields|"name"|"email"/.test(sent) && !/"customer"/.test(sent));
    check("assessmentPayload = kind + fields only", assessmentPayload({ kind: "INCIDENT", fields: { a: 1 } }).endsWith(`{"kind":"INCIDENT","fields":{"a":1}}`));
  }

  // ── 7. source pins ─────────────────────────────────────────────────────────
  console.log("\n7. source pins: routes, wiring, render-only");
  {
    for (const [f, area, tool] of [
      ["app/api/platform/platform-ops/incidents/[id]/assessment/route.ts", "PLATFORM_OPS", "ops"],
      ["app/api/platform/customer-success/incidents/[id]/assessment/route.ts", "CUSTOMER_SUCCESS", "cs"],
    ] as const) {
      const s = code(f);
      const i = (needle: string) => s.indexOf(needle);
      check(`${f}: pack flag first, then a FRESH ${area} READ guard, then the limiter, then the token`,
        i("if (!env.isPlatformAiPackIncidentsEnabled) return NextResponse.json(NOT_AVAILABLE_BODY, { status: 404") > 0
        && i("if (!env.isPlatformAiPackIncidentsEnabled)") < i(`const [auth, err] = await requireFreshPlatformAccess("${area}", "READ");`)
        && i("requireFreshPlatformAccess(") < i("limitPlatformMutation(auth.user.id") && i("limitPlatformMutation(") < i("incidentAudienceFor(auth)"));
      check(`${f}: never touches incident state, never a raw DB / audit write`, !/syncIssue\.|auditLog\.|systemDb|applyOperatorTransition|runIncidentOperatorAction|\bdb\./.test(s));
      check(`${f}: the tier is fixed (${tool}) and the area access is THIS area`, s.includes(`tier: "${tool}"`) && s.includes(`conversationAreaAccess("${area}", auth.user.id)`) && s.includes(`recoveryActionsFor(inv, "${tool}")`));
    }
    check("Ops route reads at the identity-free tier (atOpsTier)", /const token = atOpsTier\(incidentAudienceFor\(auth\)\);/.test(code("app/api/platform/platform-ops/incidents/[id]/assessment/route.ts")));
    check("CS route requires the CUSTOMER_SUCCESS token", /token\.audience !== "CUSTOMER_SUCCESS"/.test(code("app/api/platform/customer-success/incidents/[id]/assessment/route.ts")));
    check("Ops calls investigate_incident; CS calls investigate_incident_cs (the audited one)", ASSESSMENT_TOOL.ops === "investigate_incident" && ASSESSMENT_TOOL.cs === "investigate_incident_cs");
    const w = code("lib/platform/intelligence/ai/assessment/incident.server.ts");
    check("wiring: the ask route's gates, unchanged (admission, freeze, turns, $ with the runner's model)",
      /admission: \(\) => readPaidRequestsAdmission\(\)/.test(w) && /freeze: \(\) => readGlobalCostFreeze\(\)/.test(w) && /turns: \(id, now\) => readPlatformAiTurns\(id, now\)/.test(w)
      && /spend: \(id, now\) => reservePlatformAiSpend\(id, now, \{ model \}\),/.test(w));
    check("wiring: ONE correlation id = the ledger turn id (one turn on the daily cap)", (w.match(/randomUUID\(\)/g) ?? []).length === 1 && /makePlatformAiGenerate\(\{ operatorId: input\.operatorId, turnId: correlationId \}\)/.test(w));
    check("wiring: the boundary routes the incidents pack only, re-reads the pack flag, rechecks fresh and carries the fail-closed audit writer",
      /packs: \["incidents"\]/.test(w) && /packEnabled: \(p\) => platformAiPackEnabled\(p\)/.test(w) && /recheck: platformAiFreshRecheck/.test(w) && /audit: platformAiToolAudit\(\)/.test(w));
    const core = code("lib/platform/intelligence/ai/assessment/incident.ts");
    const h = core.slice(core.indexOf("export async function handleIncidentAssessment"));
    check("handler order: flag → recovery → admission → freeze → turns → $ → investigate → generate, released in finally",
      h.indexOf("deps.enabled") < h.indexOf("deps.recovery()") && h.indexOf("deps.recovery()") < h.indexOf("deps.admission()") && h.indexOf("deps.admission()") < h.indexOf("deps.freeze()")
      && h.indexOf("deps.freeze()") < h.indexOf("deps.turns(") && h.indexOf("deps.turns(") < h.indexOf("admitPlatformAiSpend(deps.spend") && h.indexOf("admitPlatformAiSpend(") < h.indexOf("deps.investigate()")
      && h.indexOf("deps.investigate()") < h.indexOf("deps.generate(") && /finally \{\s*await held\.release\(\);\s*\}/.test(h));
    check("the model call offers no tools and its reply reaches ONLY checkAssessmentFraming", /tools: \[\],/.test(h) && (h.match(/\braw\b/g) ?? []).length === 3 && /checkAssessmentFraming\(raw, verified\)/.test(h));
    check("render-only: nothing persisted (no store, no db, no cache write)", ![core, w].some((s) => /systemDb|@\/lib\/db|\.create\(|\.upsert\(|\.update\(|cache\.set|localStorage/.test(s)));
    check("logs: codes only (one trace line; no record, answer or framing text)", (w.match(/console\.\w+\(/g) ?? []).length === 2 && !/answers|framing\.text|fields\)/.test(h.slice(h.indexOf("deps.trace?.("), h.indexOf("deps.trace?.(") + 200)));
  }

  // ── 8. the view-model and the surface ──────────────────────────────────────
  console.log("\n8. the drawer view: quiet lines, hypothesis marking, restrained, 390 px-safe");
  {
    check("429 DAILY_TURNS / COST_CAP ⇒ the limit line", assessmentQuietLine(429, { code: "DAILY_TURNS" }) === ASSESSMENT_QUIET.limit && assessmentQuietLine(429, { code: "COST_CAP" }) === ASSESSMENT_QUIET.limit);
    check("429 limiter ⇒ wait a minute", assessmentQuietLine(429, null) === ASSESSMENT_QUIET.busy);
    check("503 ⇒ unavailable", assessmentQuietLine(503, { code: "AI_UNAVAILABLE" }) === ASSESSMENT_QUIET.unavailable);
    check("quiet lines are one line each, no codes or figures", Object.values(ASSESSMENT_QUIET).every((s) => !/\n|\d|[A-Z]{3,}_/.test(s)));
    check("paths", incidentAssessmentPath("ops", "inc 1") === "/api/platform/platform-ops/incidents/inc%201/assessment" && incidentAssessmentPath("cs", "x") === "/api/platform/customer-success/incidents/x/assessment");
    check("parseAssessment refuses a malformed body", parseAssessment({ answers: [] }) === null && parseAssessment(null) === null);
    const r = await handleIncidentAssessment(deps([], { record: fields({ causeStatus: "HYPOTHESIS", cause: "PROVIDER_OUTAGE" }) }));
    const a = parseAssessment(r.body)!;
    check("isHypothesis marks the Likely answer only", a.answers.filter(isHypothesis).map((x) => x.key).join() === "why");
    const html = renderToStaticMarkup(createElement(AiAssessmentSurface, { state: { kind: "done", assessment: a }, onAssess: () => {}, open: true }));
    check("five answers rendered with their questions", (html.match(/data-ai-assessment-answer=/g) ?? []).length === 5 && html.includes("Can FourthMeridian fix it") && html.includes("Does the customer need to act"));
    check("the Likely answer is marked visually as a hypothesis", /data-ai-assessment-answer="why" data-hypothesis="yes"/.test(html) && html.includes("Hypothesis") && /italic/.test(html));
    check("no other answer is marked", (html.match(/data-hypothesis="yes"/g) ?? []).length === 1);
    const quiet = renderToStaticMarkup(createElement(AiAssessmentSurface, { state: { kind: "quiet", line: ASSESSMENT_QUIET.limit }, onAssess: () => {}, open: true }));
    check("a refusal is ONE quiet status line", (quiet.match(/data-ai-assessment-quiet/g) ?? []).length === 1 && quiet.includes(ASSESSMENT_QUIET.limit.replace(/'/g, "&#x27;")) && !quiet.includes("data-ai-assessment-result"));
    const busy = renderToStaticMarkup(createElement(AiAssessmentSurface, { state: { kind: "busy" }, onAssess: () => {}, open: true }));
    check("busy ⇒ the button is disabled", /<button[^>]* disabled=""[^>]*data-ai-assessment-assess/.test(busy) && busy.includes("Assessing…"));
    check("390 px: min-w-0 + break-words everywhere text flows; tap targets ≥ 44 px", /min-h-11/.test(html) && (html.match(/break-words/g) ?? []).length >= 6 && !/w-\[\d{3,}px\]|min-w-\[\d{3,}px\]/.test(html));
    check("restrained: no exclamation marks, no 'AI says' / 'I think'", !/!|AI says|I think|I believe/i.test(html.replace(/<!--.*?-->/g, "")));
  }

  if (failures > 0) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
  console.log("\nAll incident-assessment checks passed.");
}

void main().catch((e) => { console.error(e); process.exit(1); });
