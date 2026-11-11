/**
 * lib/platform/intelligence/ai/tools/packs/incidents.test.ts  (Platform AI P8 — the incidents pack, I-1 / I-3 / I-5 / D-3)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/ai/tools/packs/incidents.test.ts
 *
 * Through the REAL turn boundary (authz/boundary.ts) over the E0 incident fixtures (eval/fixtures.ts
 * e0IncidentWorld — sentinel free text in the verdict label / operationLabel, the affected institution, timeline
 * and resolution codes; a customer sentinel id as the subject):
 * 1. OPS tier (PLATFORM_OPS): list_incidents / investigate_incident — closed fields only, identity-free (no
 *    customer field, no linkage, no audit), NO sentinel / injection / customer id in what the model receives;
 * 2. CS tier (CUSTOMER_SUCCESS): list_incidents_cs / investigate_incident_cs — + the keyed customer ref, one
 *    PLATFORM_AI_RECORD_VIEWED row per customer FIRST, T2 names only; audit failure ⇒ UNAVAILABLE, no data;
 * 3. incident_overview: counts / codes only; refusals: flag OFF, wrong tier, Ops operator → CS tool, no token,
 *    a handle of another tier / turn;
 * 4. the INCIDENT record source: revalidate per audience, t1 = a code-derived label (never the verdict label),
 *    T2 only on the CS tier; static: the mappers read no excluded field; pure;
 * 5. the inferred-cause contract (compose/causal.ts): UNMARKED_CAUSAL marking matrix + through a real turn;
 * 6. incident-id disambiguation (authz/subject.ts, PACK-PR-CONDITIONS 8): flag ON ⇒ [incident h_…], no limiter,
 *    no subject audit; not an incident ⇒ the customer path unchanged; customers OFF ⇒ the scrub's text; flag OFF
 *    ⇒ exactly P5; stored text; route wiring.
 */

process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET || "incidents-pack-test-secret-not-real";

import { readFileSync } from "node:fs";
import path from "node:path";
import { UserRole, type PlatformArea } from "@prisma/client";
import {
  E0_CUSTOMERS, E0_INCIDENT_IDS, E0_INCIDENT_INJECTIONS, E0_INJECTION_MARKER, E0_T2_SENTINELS, e0IncidentReaders, e0IncidentWorld,
} from "../../eval/fixtures";
import type { BoundaryAuditRow } from "../../authz/boundary";
import type { IncidentsPackReaders } from "./incidents";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 700)}` : ""}`); }
}

const OP = "cop000000000000000000000p8";
const NOW = new Date("2026-11-10T12:00:00.000Z");
const [ZELDA] = E0_CUSTOMERS;
const PLANTED = [...E0_T2_SENTINELS, ...Object.values(E0_INCIDENT_INJECTIONS), E0_INJECTION_MARKER, ...Object.values(E0_INCIDENT_IDS), "e0-item-0001", "e0-acct-0001", "e0-exec-1"];
const leaks = (x: unknown) => { const s = JSON.stringify(x).toLowerCase(); return PLANTED.filter((v) => s.includes(v.toLowerCase())); };
const OPS_TOKEN = { audience: "PLATFORM_OPS" } as never;
const CS_TOKEN = { audience: "CUSTOMER_SUCCESS" } as never;

async function main() {
  const { createTurnBoundary } = await import("../../authz/boundary");
  const { scopeFromGuard } = await import("../../authz/scope");
  const { incidentsPackTools, INCIDENT_TOOL_NAMES } = await import("./incidents");
  const authOf = (area: PlatformArea) => ({ user: { id: OP, role: UserRole.USER }, grant: { area, level: "READ" as const } });
  const ev = () => ({ envelopes: [], hrefs: new Set<string>(), definitions: [], labels: new Set<string>(), trace: [] as { tool: string; outcome: string }[], pages: new Map() });

  function turn(opts: { areas?: PlatformArea[]; readers?: IncidentsPackReaders; flag?: boolean; correlationId?: string; auditFails?: boolean; token?: (a: PlatformArea) => unknown } = {}) {
    const areas = opts.areas ?? ["PLATFORM_OPS"];
    const rows: BoundaryAuditRow[] = [];
    const b = createTurnBoundary({
      operatorId: OP, correlationId: opts.correlationId ?? "corr-1",
      areas: areas.map((a) => ({ scope: scopeFromGuard(authOf(a), a, OP)!, binding: {} as never })), binding: {} as never,
      recheck: async (a) => {
        const token = opts.token ? opts.token(a) : a === "CUSTOMER_SUCCESS" ? CS_TOKEN : a === "PLATFORM_OPS" ? OPS_TOKEN : null;
        return { auth: authOf(a), csTier: a === "CUSTOMER_SUCCESS", ...(token ? { incidentToken: token as never } : {}) };
      },
      packs: ["incidents"], packEnabled: () => opts.flag ?? true,
      registry: incidentsPackTools(opts.readers ?? e0IncidentReaders(NOW)) as never,
      audit: async (r) => { if (opts.auditFails) throw new Error("down"); rows.push(...r); },
    });
    const e = ev();
    const call = (name: string, args: unknown) => b.invoke(name, JSON.stringify(args), { ev: e as never, paramKeys: [], asked: [] }) as Promise<Record<string, unknown>>;
    return { b, rows, call, ev: e };
  }
  type Res = { status: string; truncated: boolean; records: { handle: string; kind: string; fields: Record<string, unknown>; t2Fields?: string[] }[] };
  const NF = JSON.stringify({ found: false });

  console.log("1. OPS tier — identity-free records");
  let opsHandle = "";
  {
    const t = turn();
    const list = await t.call("list_incidents", {}) as unknown as Res;
    const [c, h, n] = list.records;
    check("list_incidents: 3 INCIDENT records with handles, the module's codes", list.status === "CONFIRMED" && list.records.length === 3
      && list.records.every((r) => r.kind === "INCIDENT" && /^h_[A-Za-z0-9_-]{16}$/.test(r.handle) && r.t2Fields === undefined), list);
    check("causeStatus / cause: CONFIRMED + PROVIDER_OUTAGE, HYPOTHESIS + PLATFORM_DEFECT, NONE + null (a stray non-code cause never echoed)",
      c.fields.causeStatus === "CONFIRMED" && c.fields.cause === "PROVIDER_OUTAGE" && h.fields.causeStatus === "HYPOTHESIS" && h.fields.cause === "PLATFORM_DEFECT"
      && n.fields.causeStatus === "NONE" && n.fields.cause === null);
    check("an unknown kind / domain ⇒ OTHER / unknown (never the planted text)", n.fields.kind === "OTHER" && n.fields.domain === "unknown");
    check("closed base fields exactly (no label, no operationLabel, no ids)", JSON.stringify(Object.keys(c.fields)) === JSON.stringify([
      "state", "severity", "domain", "kind", "provider", "operation", "brokenNow", "customerActionable", "firstSeenAt", "lastSeenAt", "resolvedAt",
      "occurrences", "spread", "affectedSources", "generation", "causeStatus", "cause", "closure"]), Object.keys(c.fields));
    check("OPS: no customer field, no audit row (not customer-linkable)", list.records.every((r) => !("customer" in r.fields)) && t.rows.length === 0);
    check("OPS: NO sentinel (label, operationLabel, customer id / name / email, incident / item / account id) in the result", leaks(list).length === 0, leaks(list));
    const inv = await t.call("investigate_incident", { incident: c.handle }) as unknown as Res;
    const f = inv.records[0]?.fields ?? {};
    check("investigate_incident by THIS turn's handle: the drawer's projections as codes (displayStatus, remedy, allowlisted provider code, attempts, last action)",
      inv.status === "CONFIRMED" && f.displayStatus !== undefined && f.remedy === "customer-reconnect" && f.customerActionRequired === true && f.providerErrorCode === "ITEM_LOGIN_REQUIRED"
      && f.connectionStatus === "ERROR" && f.attempts === 3 && f.attemptsSucceeded === 1 && f.attemptsFailed === 2 && f.lastActionCode === "RESYNC"
      && f.lastOutcomeCode === null && f.resolutionReason === null && f.timelineEvents === 2 && f.sourceState === "LIVE", f);
    check("investigate: NO sentinel — institution, timeline / resolution free text, label, ids", leaks(inv).length === 0, leaks(inv));
    const unrec = await t.call("investigate_incident", { incident: h.handle }) as unknown as Res;
    check("an unrecognised provider error ⇒ code null + unrecognised flag (the raw value never echoed)", unrec.records[0]?.fields.providerErrorCode === null && unrec.records[0]?.fields.providerErrorUnrecognised === true);
    check("a guessed handle / a raw incident id ⇒ NOT_FOUND", JSON.stringify(await t.call("investigate_incident", { incident: "h_AAAAAAAAAAAAAAAA" })) === NF
      && JSON.stringify(await t.call("investigate_incident", { incident: E0_INCIDENT_IDS.confirmed })) === NF);
    const other = turn({ correlationId: "corr-2" });
    check("a handle from ANOTHER turn ⇒ NOT_FOUND", JSON.stringify(await other.call("investigate_incident", { incident: c.handle })) === NF);
    check("trace: codes and counts only", leaks(t.b.trace()).length === 0 && leaks(t.ev.trace).length === 0);
    opsHandle = c.handle;
    const sev = await t.call("list_incidents", { severity: "error" }) as unknown as Res;
    check("severity filter (closed enum) passes through to the module's search", sev.records.length === 1 && sev.records[0].fields.causeStatus === "HYPOTHESIS");
    check("a free-text status ⇒ NOT_FOUND", JSON.stringify(await t.call("list_incidents", { status: "zelda" })) === NF);
  }

  console.log("\n2. CS tier — customer linkage through the T1 ref + audit");
  {
    const t = turn({ areas: ["CUSTOMER_SUCCESS"] });
    const list = await t.call("list_incidents_cs", {}) as unknown as Res;
    check("list_incidents_cs: + customer = the keyed T1 ref; t2Fields = names only", list.status === "CONFIRMED" && list.records.length === 3
      && list.records.every((r) => r.fields.customer === "user #a1a1a1a1" && r.t2Fields?.join() === "name,email"), list.records.map((r) => r.fields.customer));
    check("CS: one PLATFORM_AI_RECORD_VIEWED row per linked customer (deduped), kind INCIDENT, area CUSTOMER_SUCCESS",
      t.rows.length === 1 && t.rows[0].action === "PLATFORM_AI_RECORD_VIEWED" && t.rows[0].targetUserId === ZELDA.id && t.rows[0].detail.recordKind === "INCIDENT" && t.rows[0].area === "CUSTOMER_SUCCESS");
    check("CS: NO sentinel (the customer id stays server-side; name / email never present)", leaks(list).length === 0, leaks(list));
    const inv = await t.call("investigate_incident_cs", { incident: list.records[0].handle }) as unknown as Res;
    check("investigate_incident_cs: CONFIRMED with customer ref, audited, no sentinel", inv.status === "CONFIRMED" && inv.records[0].fields.customer === "user #a1a1a1a1"
      && t.rows.length === 2 && leaks(inv).length === 0, leaks(inv));
    const failing = turn({ areas: ["CUSTOMER_SUCCESS"], auditFails: true });
    const fa = await failing.call("list_incidents_cs", {}) as unknown as Res;
    check("audit write failure ⇒ UNAVAILABLE, no record data (I-5)", fa.status === "UNAVAILABLE" && fa.records.length === 0 && !/user #|h_/.test(JSON.stringify(fa)));
    check("an OPS-tier handle never reaches a CS tool (another area / tier) ⇒ NOT_FOUND", JSON.stringify(await t.call("investigate_incident_cs", { incident: opsHandle })) === NF);
  }

  console.log("\n3. overview + refusals");
  {
    const t = turn();
    const ov = await t.call("incident_overview", {}) as Record<string, unknown>;
    check("incident_overview: counts and codes only (brokenNow, severities, domains, widespread, causeStatus)",
      ov.status === "CONFIRMED" && ov.brokenNow === 3 && ov.needsVerification === 0 && (ov.bySeverity as Record<string, number>).critical === 2
      && (ov.byDomain as Record<string, number>).unknown === 1 && ov.widespread === 1 && ov.customerActionable === 1
      && JSON.stringify(ov.causeStatus) === JSON.stringify({ CONFIRMED: 1, HYPOTHESIS: 1, NONE: 1 }) && leaks(ov).length === 0, ov);
    check("incident_overview records its own metadata trace step", t.ev.trace.some((s) => s.tool === "incident_overview" && s.outcome === "OK"));
    const noTok = turn({ token: () => null });
    check("incident_overview without a fresh audience token ⇒ UNAVAILABLE (never a partial count)", (await noTok.call("incident_overview", {}) as { status?: string }).status === "UNAVAILABLE");
    const csOnly = turn({ areas: ["CUSTOMER_SUCCESS"] });
    check("incident_overview for a CS-only operator: the CS token, counts only", (await csOnly.call("incident_overview", {}) as { brokenNow?: number }).brokenNow === 3);
    const off = turn({ flag: false });
    check("pack flag OFF ⇒ NOT_FOUND for every incidents tool", (await Promise.all(INCIDENT_TOOL_NAMES.map((n) => off.call(n, {})))).every((r) => JSON.stringify(r) === NF));
    const ops = turn();
    check("an Ops operator calling a CS tool ⇒ NOT_FOUND (area not in scope), no audit", JSON.stringify(await ops.call("list_incidents_cs", {})) === NF && ops.rows.length === 0);
    const cs = turn({ areas: ["CUSTOMER_SUCCESS"] });
    check("a CS operator calling an OPS tool ⇒ NOT_FOUND", JSON.stringify(await cs.call("list_incidents", {})) === NF);
    const wrongTok = turn({ token: () => CS_TOKEN });
    check("an OPS tool with a non-Ops token ⇒ UNAVAILABLE (reader refused), no records", (await wrongTok.call("list_incidents", {}) as unknown as Res).status === "UNAVAILABLE");
    const growth = turn({ areas: ["GROWTH_REVENUE"] });
    check("an operator with neither area ⇒ every incidents tool NOT_FOUND", (await Promise.all(INCIDENT_TOOL_NAMES.map((n) => growth.call(n, {})))).every((r) => JSON.stringify(r) === NF));
  }

  console.log("\n4. the INCIDENT record source + static");
  {
    const { incidentRecordSource } = await import("./incidents.server");
    const w = e0IncidentWorld(NOW);
    const strip = (v: Record<string, unknown>) => { const { subjectUserId: _x, ...rest } = v; return rest; };
    const acc = {
      detail: async (token: { audience: string }, id: string) => { const v = w.verdicts.find((x) => x.id === id); return v ? (token.audience === "CUSTOMER_SUCCESS" ? v : strip(v)) : null; },
      investigate: async () => null,
    };
    const users = [{ id: ZELDA.id, email: ZELDA.email, name: ZELDA.name, role: "USER" }];
    const client = {
      user: {
        findFirst: async (a: { where: { AND: [unknown, { id: string }] } }) => users.find((u) => u.id === a.where.AND[1].id) ? { id: a.where.AND[1].id } : null,
        findUnique: async (a: { where: { id: string } }) => users.find((u) => u.id === a.where.id) ?? null,
      },
    };
    const src = incidentRecordSource(acc as never, client as never);
    const opsG = { auth: authOf("PLATFORM_OPS"), csTier: false, incidentToken: OPS_TOKEN };
    const csG = { auth: authOf("CUSTOMER_SUCCESS"), csTier: true, incidentToken: CS_TOKEN };
    const id = E0_INCIDENT_IDS.confirmed;
    check("revalidate: Ops guard on PLATFORM_OPS ⇒ OPS; CS guard on CUSTOMER_SUCCESS ⇒ CUSTOMER_SUCCESS",
      (await src.revalidate(id, "PLATFORM_OPS", opsG)) === "OPS" && (await src.revalidate(id, "CUSTOMER_SUCCESS", csG)) === "CUSTOMER_SUCCESS");
    check("revalidate: a guard without its token, a token of the other area, no CS tier, an unknown id ⇒ not visible",
      (await src.revalidate(id, "PLATFORM_OPS", { auth: authOf("PLATFORM_OPS"), csTier: false })) === null
      && (await src.revalidate(id, "CUSTOMER_SUCCESS", opsG)) === null && (await src.revalidate(id, "CUSTOMER_SUCCESS", { ...csG, csTier: false })) === null
      && (await src.revalidate("cnotanincident00000000001", "PLATFORM_OPS", opsG)) === null);
    const t1 = await src.t1(id, "PLATFORM_OPS", opsG);
    check("t1 = a CODE-DERIVED label (sync-issue-semantics incidentLabel), never the verdict's label", typeof t1 === "string" && t1.startsWith("incident: ") && leaks(t1).length === 0, t1);
    check("linkedUserIds: CS ⇒ the subject; OPS ⇒ none", (await src.linkedUserIds(id, "CUSTOMER_SUCCESS", csG)).join() === ZELDA.id && (await src.linkedUserIds(id, "PLATFORM_OPS", opsG)).length === 0);
    check("t2: CS ⇒ the customer's value (renderer-only path); OPS ⇒ null", (await src.t2(id, "CUSTOMER_SUCCESS", "email", csG)) === ZELDA.email && (await src.t2(id, "PLATFORM_OPS", "email", opsG)) === null);

    const code = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/description: [`"][^`"]*[`"]/g, "");
    const pack = code("lib/platform/intelligence/ai/tools/packs/incidents.ts");
    const banned = ["\\.label\\b", "\\.operationLabel\\b", "\\.institution\\b", "\\.detail\\b", "\\.note\\b", "\\.message\\b", "\\.headline\\b", "\\.reason\\b(?!Code)", "\\.plaidItemId\\b", "\\.financialAccountId\\b", "\\.refreshExecutionId\\b", "\\.\\.\\.(?:v|inv|dto|row|e)\\b"];
    const hit = banned.filter((b) => new RegExp(b).test(pack));
    check("the mappers read no excluded field (label / operationLabel / institution / detail / notes / ids) and never spread a DTO", hit.length === 0, hit);
    check("incidents.ts is pure (no DB, env, clock, minter)", !/@\/lib\/db|systemDb|process\.env|new Date\(\)|Date\.now|incidentAudienceFor|intelligence\/audience/.test(pack));
    const server = code("lib/platform/intelligence/ai/tools/packs/incidents.server.ts");
    check("incidents.server.ts: token TYPES from the intelligence index only; no minter, no raw SyncIssue read",
      /from "@\/lib\/platform\/incidents\/intelligence"/.test(server) && !/intelligence\/audience|incidentAudienceFor|systemIncidentAudience|\.syncIssue\./.test(server));
  }

  console.log("\n5. the inferred-cause contract (UNMARKED_CAUSAL)");
  {
    const { markUnbackedCausal, causalInPlay } = await import("../../compose/causal");
    const { INFERRED_OPEN, INFERRED_CLOSE, renderInferred, RECORD_OPEN, RECORD_CLOSE } = await import("../../compose/record");
    const span = (i: number) => `${RECORD_OPEN}${String.fromCharCode(97 + i)}${RECORD_CLOSE}`;
    const inc = { rk: "INCIDENT" };
    const conf = { causeStatus: "CONFIRMED", cause: "PROVIDER_OUTAGE" }, hyp = { causeStatus: "HYPOTHESIS", cause: "PLATFORM_DEFECT" };
    const mark = (t: string, facts: (Record<string, unknown> | null)[] = [], inPlay = true) => {
      const r = markUnbackedCausal(t, { inPlay, spans: facts.map(() => inc), facts });
      return { ...r, shown: renderInferred(r.text.replace(new RegExp(`${RECORD_OPEN}[a-t]${RECORD_CLOSE}`, "g"), "[incident]")) };
    };
    const a = mark(`${span(0)} failed because the provider was down.`, [conf]);
    check("CONFIRMED cause, incident placed, the sentence names it ⇒ kept as fact", a.marked === 0 && !a.shown.includes("Likely"), a.shown);
    const b = mark(`${span(0)} failed because of a platform bug.`, [hyp]);
    check("HYPOTHESIS cause stated as fact ⇒ marked \"Likely: …\"", b.marked === 1 && b.shown === "Likely: [incident] failed because of a platform bug.", b.shown);
    const c = mark(`${span(0)} failed because of a platform bug.`, [conf]);
    check("CONFIRMED but a DIFFERENT cause than the confirmed one ⇒ marked", c.marked === 1 && c.shown.startsWith("Likely: "), c.shown);
    const d = mark("It failed because the provider was down.", []);
    check("a cause with no incident placed ⇒ marked (a model-inferred cause)", d.marked === 1, d.shown);
    const e = mark(`Two incidents are open. ${span(0)} is a provider outage. Nothing else changed.`, [hyp]);
    check("only the causal sentence is marked; the others stay", e.marked === 1 && e.shown === "Two incidents are open. Likely: [incident] is a provider outage. Nothing else changed.", e.shown);
    const f = mark(`${INFERRED_OPEN}it is due to a platform bug${INFERRED_CLOSE}. Two are open.`, []);
    check("an already-inferred span is untouched (not double-marked)", f.marked === 0 && f.shown === "Likely: it is due to a platform bug. Two are open.", f.shown);
    const g = mark("It failed because the provider was down.", [], false);
    check("not in play (no incident tool / record / subject this turn) ⇒ unchanged", g.marked === 0 && !g.shown.includes("Likely"));
    const h = mark("Likely it failed due to a provider outage.", []);
    check("a sentence the model opened with \"Likely\" is left as written", h.marked === 0, h.shown);
    const i = mark(`${span(0)} is open.\nRoot cause: configuration error.`, [conf]);
    check("line breaks split sentences; a cause-code phrase is a causal claim", i.marked === 1 && i.shown === "[incident] is open.\nLikely: Root cause: configuration error.", i.shown);
    check("in play: an incidents tool answered / an INCIDENT span / an [incident h_…] subject",
      causalInPlay({ traceTools: ["list_incidents"], spans: [], question: "" }) && causalInPlay({ traceTools: [], spans: [inc], question: "" })
      && causalInPlay({ traceTools: [], spans: [], question: "what about [incident h_AAAAAAAAAAAAAAAA]?" }) && !causalInPlay({ traceTools: ["get_metric"], spans: [{ rk: "CUSTOMER" }], question: "why?" }));

    // Through a real turn: list_incidents, then a causal answer about the HYPOTHESIS incident without a marker.
    const { runPlatformAiTurn } = await import("../../core");
    const t = turn();
    const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 10, reasoningTokens: 0 };
    let step = 0;
    const generate = async ({ messages }: { messages: unknown[] }) => {
      step++;
      if (step === 1) return { content: null, toolCalls: [{ id: "c1", name: "list_incidents", arguments: "{}" }], raw: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "list_incidents", arguments: "{}" } }] }, usage };
      const res = JSON.parse((messages as { role: string; content: string }[]).filter((m) => m.role === "tool").at(-1)!.content) as Res;
      const [cf, hy] = res.records;
      const content = `{{r:${cf.handle}|ref}} failed because the provider was down. {{r:${hy.handle}|ref}} failed because of a platform bug. {{inferred}}the widespread incident may share a cause{{/inferred}}.`;
      return { content, toolCalls: [], raw: { role: "assistant", content }, usage };
    };
    const { result, record } = await runPlatformAiTurn({ question: "Why are incidents failing?", binding: { surfaceLabel: "T", listMetrics: () => [], describeMetric: () => null, readMetric: async () => null, listPages: () => [], resolvePage: () => null } as never,
      generate: generate as never, model: "p8-scripted", classifyBriefing: false, invoke: t.b.invoke, records: t.b.recordRef, questionScrubbed: true });
    const shown = JSON.stringify(result.answer), stored = JSON.stringify(record.typed);
    check("turn: verdict UNMARKED_CAUSAL (kept, not replaced)", result.grounding.verdict === "UNMARKED_CAUSAL" && !result.grounding.replaced, result.grounding);
    check("turn: the CONFIRMED sentence stays fact; the HYPOTHESIS one reads \"Likely:\" in the display AND the stored answer",
      /failed because the provider was down/.test(shown) && !/Likely: \[restricted\] failed because the provider/.test(shown)
      && /Likely: \[restricted\] failed because of a platform bug/.test(shown) && /Likely: /.test(stored) && /failed because of a platform bug/.test(stored), shown);
  }

  console.log("\n6. incident-id disambiguation (PACK-PR-CONDITIONS 8)");
  {
    const { resolveSubjects, storedSubjectText, extractSubjects, SUBJECT_UNRESOLVED_TEXT, SUBJECT_STORED_TEXT } = await import("../../authz/subject");
    const { scrubOperatorText } = await import("@/lib/ai/privacy/scrub");
    const HANDLE = "h_IncIdentHandle00";
    const mk = (o: { incident?: boolean; customers?: boolean; isIncident?: boolean }) => {
      let t = 0, limits = 0, lookups = 0;
      const rows: unknown[] = [];
      return {
        rows, counts: () => ({ limits, lookups }), clockNow: () => t,
        d: {
          operatorId: OP, primaryArea: "CUSTOMER_SUCCESS" as PlatformArea, enabled: () => o.customers ?? true,
          limit: async () => { limits++; return "ok" as const; },
          eligibility: async () => ({ csTier: true, area: "CUSTOMER_SUCCESS" as PlatformArea }),
          lookup: async () => { lookups++; return null; },
          audit: async (r: unknown) => { rows.push(r); }, mint: async () => null, keyHash: () => "0badc0de",
          clock: { now: () => t, sleep: async (ms: number) => { t += ms; }, after: () => new Promise<void>(() => {}) },
          ...(o.incident ? { incident: { resolve: async (id: string) => (o.isIncident && id === E0_INCIDENT_IDS.confirmed ? HANDLE : null) } } : {}),
        },
      };
    };
    const id = { kind: "USER_ID" as const, normalized: E0_INCIDENT_IDS.confirmed };
    const on = mk({ incident: true, isIncident: true });
    const r1 = await resolveSubjects([id], on.d);
    check("flag ON + an exact incident id ⇒ [incident h_…], outcome INCIDENT, NO limiter count, NO subject audit, NO customer note",
      r1.fills[0] === `[incident ${HANDLE}]` && r1.outcomes[0] === "INCIDENT" && on.counts().limits === 0 && on.rows.length === 0 && r1.note === null, { r1, c: on.counts() });
    const userCuid = mk({ incident: true, isIncident: false });
    const r2 = await resolveSubjects([{ kind: "USER_ID", normalized: ZELDA.id }], userCuid.d);
    check("flag ON + a cuid that is not an incident ⇒ the customer path unchanged (limiter, lookup, audit, the one literal)",
      r2.fills[0] === SUBJECT_UNRESOLVED_TEXT && r2.outcomes[0] === "NOT_FOUND" && userCuid.counts().limits === 1 && userCuid.counts().lookups === 1 && userCuid.rows.length === 1);
    const custOff = mk({ incident: true, customers: false, isIncident: false });
    const r3 = await resolveSubjects([{ kind: "USER_ID", normalized: ZELDA.id }, { kind: "EMAIL", normalized: ZELDA.email }], custOff.d);
    check("customers flag OFF ⇒ a non-incident identifier gets the scrub's own text ([id] / [email]), no lookup, no audit",
      r3.fills.join() === `${scrubOperatorText(ZELDA.id, 99)},${scrubOperatorText(ZELDA.email, 99)}` && r3.outcomes.every((o) => o === "PASSTHROUGH")
      && custOff.counts().limits === 0 && custOff.rows.length === 0 && r3.note === null, r3);
    const flagOff = mk({ incident: false });
    const r4 = await resolveSubjects([id], flagOff.d);
    check("incidents flag OFF ⇒ exactly P5: the incident id is a customer lookup ([customer not resolved] + audit + limiter)",
      r4.fills[0] === SUBJECT_UNRESOLVED_TEXT && flagOff.counts().limits === 1 && flagOff.rows.length === 1);
    check("timing: the incident and passthrough paths are padded to the same floor as a customer lookup (fake clock)", on.clockNow() === 300 && custOff.clockNow() === 600 && userCuid.clockNow() === 300, [on.clockNow(), custOff.clockNow(), userCuid.clockNow()]);
    const ex = extractSubjects(`Is ${E0_INCIDENT_IDS.confirmed} related to ${ZELDA.email}?`);
    const slotted = scrubOperatorText(ex.text, 500);
    check("stored text: incidents ON ⇒ a cuid stores [id] (it may be an incident), an email [customer]; flags absent ⇒ P5",
      storedSubjectText(slotted, ex.ids, { customers: true, incidents: true }) === "Is [id] related to [customer]?"
      && storedSubjectText(slotted, ex.ids, { customers: false, incidents: true }) === "Is [id] related to [email]?"
      && storedSubjectText(slotted) === `Is ${SUBJECT_STORED_TEXT} related to ${SUBJECT_STORED_TEXT}?`
      && storedSubjectText(slotted, ex.ids, { customers: true, incidents: false }) === `Is ${SUBJECT_STORED_TEXT} related to ${SUBJECT_STORED_TEXT}?`);

    // Through the real boundary: adoptRecord mints an INCIDENT handle per the incident audience rules.
    const src = { t2Fields: [] as never[], revalidate: async (rid: string, area: PlatformArea, g: { csTier: boolean }) => (rid === E0_INCIDENT_IDS.confirmed ? (area === "CUSTOMER_SUCCESS" ? (g.csTier ? "CUSTOMER_SUCCESS" : null) : "OPS") : null) as never, t1: async () => null, linkedUserIds: async () => [], t2: async () => null };
    const mkB = (areas: PlatformArea[]) => createTurnBoundary({
      operatorId: OP, correlationId: "corr-s", areas: areas.map((a) => ({ scope: scopeFromGuard(authOf(a), a, OP)!, binding: {} as never })), binding: {} as never,
      recheck: async (a) => ({ auth: authOf(a), csTier: a === "CUSTOMER_SUCCESS" }), packs: ["incidents"], packEnabled: () => true, recordSources: { INCIDENT: src },
    });
    const both = mkB(["PLATFORM_OPS", "CUSTOMER_SUCCESS"]);
    const hb = await both.adoptRecord({ rk: "INCIDENT", rid: E0_INCIDENT_IDS.confirmed }, ["CUSTOMER_SUCCESS", "PLATFORM_OPS"]);
    check("adoptRecord: CS first ⇒ a CS-tier handle on CUSTOMER_SUCCESS", !!hb && both.recordRef(hb)?.a === "CUSTOMER_SUCCESS" && both.recordRef(hb)?.rk === "INCIDENT");
    const opsOnly = mkB(["PLATFORM_OPS"]);
    const ho = await opsOnly.adoptRecord({ rk: "INCIDENT", rid: E0_INCIDENT_IDS.confirmed }, ["CUSTOMER_SUCCESS", "PLATFORM_OPS"]);
    check("adoptRecord: an Ops operator ⇒ an OPS-tier handle on PLATFORM_OPS", !!ho && opsOnly.recordRef(ho)?.a === "PLATFORM_OPS");
    check("adoptRecord: not visible / unknown kind / no area ⇒ null",
      (await opsOnly.adoptRecord({ rk: "INCIDENT", rid: "cnotanincident00000000001" }, ["PLATFORM_OPS"])) === null
      && (await opsOnly.adoptRecord({ rk: "NOPE", rid: E0_INCIDENT_IDS.confirmed }, ["PLATFORM_OPS"])) === null
      && (await mkB(["GROWTH_REVENUE"]).adoptRecord({ rk: "INCIDENT", rid: E0_INCIDENT_IDS.confirmed }, ["CUSTOMER_SUCCESS", "PLATFORM_OPS"])) === null);

    const ss = readFileSync(path.join(process.cwd(), "lib/platform/intelligence/ai/authz/subject.server.ts"), "utf8");
    check("subject.server: the incident resolver exists ONLY while the incidents flag is ON; extraction follows customers OR incidents",
      /\.\.\.\(platformAiPackEnabled\("incidents"\) \? \{/.test(ss) && /isSubjectResolutionEnabled = \(\): boolean => platformAiPackEnabled\("customers"\) \|\| platformAiPackEnabled\("incidents"\);/.test(ss));
    for (const r of ["app/api/platform/ai/conversations/route.ts", "app/api/platform/ai/conversations/[id]/messages/route.ts"]) {
      check(`${r}: subjectFlags = platformAiSubjectFlags (the stored text follows the flags)`, /subjectFlags: platformAiSubjectFlags,/.test(readFileSync(path.join(process.cwd(), r), "utf8")));
    }
  }

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
