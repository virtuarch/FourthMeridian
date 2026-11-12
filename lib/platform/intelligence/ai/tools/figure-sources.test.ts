/**
 * lib/platform/intelligence/ai/tools/figure-sources.test.ts  (B1 — the response's metadata-only figure sources)
 *
 * Pins tools/figure-sources.ts:
 *   · THE CLOSED KEY SET: a record entry is exactly { segment, start, end, source, recordKind, fieldCode }, a metric
 *     entry exactly { segment, start, end, source, metricKey, resultPath }, an aggregate entry (S2 09io) exactly
 *     { segment, start, end, source, tool, resultPath } — adding a key fails here;
 *   · closed values: recordKind / fieldCode from the registry's record schemas ("ref" + declared t2Fields + fields),
 *     metricKey from the metric registry, resultPath "value" | "value.<declared part>"; anything else ⇒ not annotated;
 *   · derived from the FILL only: a real turn (the REAL boundary + compose, a synthetic RECORD tool) places
 *     {{r:h|field}} and the annotation names exactly that kind + field — never the rid, handle, area or value;
 *   · positioning: answer.text.slice(start, end) is exactly the server-rendered span (the /ask display answer,
 *     with or without rendered records) and a conversation's content segment; any disagreement ⇒ [] (fail closed);
 *   · a fuzz (≈1,600 placed spans over hostile ids / handles / values / model text): every entry valid, every
 *     slice exact, no hostile string anywhere in the JSON;
 *   · the wiring: both routes attach it, the handler splits it off BEFORE the settle (nothing stored), the
 *     stored answer never carries the figure's part, no operator branch, and both clients ignore the field.
 * No database, no network, no env.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/ai/tools/figure-sources.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { UserRole, type PlatformArea } from "@prisma/client";
import { displayWithRecords, runPlatformAiTurn, type PlatformAiBinding, type PlatformAiGenerate } from "../core";
import { createTurnBoundary } from "../authz/boundary";
import type { FreshGuard } from "../authz/recheck";
import type { RecordRenderSource } from "../authz/record-render";
import { scopeFromGuard, type ScopedArea } from "../authz/scope";
import { RECORD_GONE_TEXT, RECORD_PENDING_TEXT, type RecordSpan } from "../compose/record";
import type { AnswerSegment, TypedAnswerSegment } from "../compose/segments";
import type { RecordSchema } from "../evidence/record-envelope";
import { storedAnswerOf } from "../conversations/turn";
import { BRIEFING_MORE_KEY } from "../briefing";
import { METRICS, metricKey } from "@/lib/platform/intelligence/metrics/registry";
import { PLATFORM_AI_TOOL_REGISTRY, type PlatformAiTool } from "./registry";
import {
  FIGURE_SOURCE_AGGREGATE_KEYS, FIGURE_SOURCE_KEYS, FIGURE_SOURCE_METRIC_KEYS, FIGURE_SOURCE_RECORD_KEYS, aggregatePathCodes, alignedFigureSources, metricParts,
  placedSourceOf, placedSpansOf, recordFieldCodes, storedFigureSources, type FigureSourceEntry,
} from "./figure-sources";
import { aggregateKey } from "../compose/aggregate";
import { CONNECTION_HEALTH_OVERVIEW_PATHS } from "./packs/connections";
import { parsePair } from "@/components/platform/platform-ai-conversations-model";

let failures = 0;
let passed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)?.slice(0, 800)}`}`); }
}
const read = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const FIELDS = recordFieldCodes();
const AGG_PATHS = aggregatePathCodes();
const METRIC_KEYS: ReadonlySet<string> = new Set<string>(METRICS.map(metricKey));
const valid = (e: FigureSourceEntry): boolean => {
  const keys = JSON.stringify(Object.keys(e));
  if (e.source === "record") {
    return keys === JSON.stringify([...FIGURE_SOURCE_RECORD_KEYS]) && !!FIELDS.get(e.recordKind)?.has(e.fieldCode);
  }
  if (e.source === "aggregate") {
    return keys === JSON.stringify([...FIGURE_SOURCE_AGGREGATE_KEYS]) && !!AGG_PATHS.get(e.tool)?.has(e.resultPath);
  }
  if (e.source === "metric") {
    const part = e.resultPath === "value" ? null : e.resultPath.startsWith("value.") ? e.resultPath.slice(6) : "∅";
    return keys === JSON.stringify([...FIGURE_SOURCE_METRIC_KEYS]) && METRIC_KEYS.has(e.metricKey) && (part === null || metricParts(e.metricKey).includes(part));
  }
  return false;
};
const posOk = (e: FigureSourceEntry) => Number.isSafeInteger(e.segment) && Number.isSafeInteger(e.start) && Number.isSafeInteger(e.end) && e.segment >= 0 && e.start >= 0 && e.end >= e.start;

const rec = (rk: string, f: string, rid = "cridsentinel000000000000a1", a = "CUSTOMER_SUCCESS", v?: number | string): RecordSpan =>
  ({ kind: "record", text: RECORD_PENDING_TEXT, rk, rid, a, f, ...(v !== undefined ? { v } : {}) });
/** A typed aggregate figure exactly as core.ts builds it from a {{a:<tool>|<path>}} fill (S2 09io B5). */
const aggFig = (text: string, tool: string, path: string): TypedAnswerSegment => ({ kind: "figure", text, metric: aggregateKey(tool, path), window: "as of 2026-11-12 00:00 UTC", aggregate: { tool, resultPath: path } });
const fig = (text: string, metric: string, part?: string): TypedAnswerSegment => ({ kind: "figure", text, metric, window: 7, ...(part ? { part } : {}) });
const txt = (text: string): TypedAnswerSegment => ({ kind: "text", text });

const SCALAR = "incident-broken-now@1";
const OBJ = "provider-outcome@1"; // declared parts: healthy, degraded, failing, notEnoughData, noRuns

console.log("\nB1 — the closed key set\n");
check("FIGURE_SOURCE_KEYS is EXACTLY segment, start, end, source, recordKind, fieldCode, metricKey, resultPath, tool (adding a key is a deliberate S2 change)",
  JSON.stringify(FIGURE_SOURCE_KEYS) === JSON.stringify(["segment", "start", "end", "source", "recordKind", "fieldCode", "metricKey", "resultPath", "tool"]));
check("an aggregate entry = segment, start, end, source, tool, resultPath (S2 09io)",
  JSON.stringify(FIGURE_SOURCE_AGGREGATE_KEYS) === JSON.stringify(["segment", "start", "end", "source", "tool", "resultPath"]) && FIGURE_SOURCE_AGGREGATE_KEYS.every((k) => (FIGURE_SOURCE_KEYS as readonly string[]).includes(k)));
check("a record entry = segment, start, end, source, recordKind, fieldCode; a metric entry = segment, start, end, source, metricKey, resultPath",
  JSON.stringify(FIGURE_SOURCE_RECORD_KEYS) === JSON.stringify(["segment", "start", "end", "source", "recordKind", "fieldCode"])
  && JSON.stringify(FIGURE_SOURCE_METRIC_KEYS) === JSON.stringify(["segment", "start", "end", "source", "metricKey", "resultPath"])
  && [...FIGURE_SOURCE_RECORD_KEYS, ...FIGURE_SOURCE_METRIC_KEYS].every((k) => (FIGURE_SOURCE_KEYS as readonly string[]).includes(k)));

console.log("\nB1 — closed values (registry only)\n");
{
  const kinds = [...FIELDS.keys()].sort();
  check("record kinds = the registry's RECORD schemas' kinds (CONNECTION, CUSTOMER, INCIDENT)", JSON.stringify(kinds) === JSON.stringify(["CONNECTION", "CUSTOMER", "INCIDENT"]), kinds);
  check("every kind allows `ref`; CUSTOMER / INCIDENT allow the T2 NAMES their schemas declare; CONNECTION declares none",
    kinds.every((k) => FIELDS.get(k)!.has("ref")) && FIELDS.get("CUSTOMER")!.has("name") && FIELDS.get("INCIDENT")!.has("email") && !FIELDS.get("CONNECTION")!.has("name"));
  const fromRegistry = PLATFORM_AI_TOOL_REGISTRY.flatMap((t) => (t.recordSchema ? Object.keys(t.recordSchema.fields).map((f) => `${t.recordSchema!.kind}.${f}`) : []));
  check("every registry schema field is an allowed code of its kind", fromRegistry.length > 0 && fromRegistry.every((x) => { const [k, f] = x.split("."); return FIELDS.get(k)!.has(f); }));
  check("CONNECTION.healthState → { record, CONNECTION, healthState }",
    JSON.stringify(placedSourceOf(rec("CONNECTION", "healthState"))) === JSON.stringify({ source: "record", recordKind: "CONNECTION", fieldCode: "healthState" }));
  check("an undeclared field, an unknown kind, a T2 name a kind does not declare ⇒ not annotated",
    placedSourceOf(rec("CONNECTION", "balance")) === null && placedSourceOf(rec("PROBE", "ref")) === null && placedSourceOf(rec("CONNECTION", "email")) === null);
  check("a scalar metric → value", JSON.stringify(placedSourceOf(fig("3", SCALAR))) === JSON.stringify({ source: "metric", metricKey: SCALAR, resultPath: "value" }));
  check("a declared part → value.<part>", JSON.stringify(placedSourceOf(fig("2", OBJ, "failing"))) === JSON.stringify({ source: "metric", metricKey: OBJ, resultPath: "value.failing" }), metricParts(OBJ));
  check("an undeclared part, an unknown key, the briefing's overflow key ⇒ not annotated",
    placedSourceOf(fig("2", OBJ, "secretPart")) === null && placedSourceOf(fig("2", "nope@1")) === null && placedSourceOf(fig("2", BRIEFING_MORE_KEY)) === null);
  check("a CLOSED record field (#570 span with v) → { record, CONNECTION, healthState } — never its value",
    JSON.stringify(placedSourceOf(rec("CONNECTION", "healthState", "p:x", "CUSTOMER_SUCCESS", "NEEDS_REAUTH"))) === JSON.stringify({ source: "record", recordKind: "CONNECTION", fieldCode: "healthState" }));
  check("aggregate tools = the registry's placeablePaths owners (connection_health_overview, incident_overview, onboarding_overview)",
    JSON.stringify([...AGG_PATHS.keys()].sort()) === JSON.stringify(["connection_health_overview", "incident_overview", "onboarding_overview"]), [...AGG_PATHS.keys()]);
  check("connection_health_overview's closed paths = its placeablePaths allowlist", JSON.stringify([...AGG_PATHS.get("connection_health_overview")!].sort()) === JSON.stringify(CONNECTION_HEALTH_OVERVIEW_PATHS.map((p) => p.path).sort()));
  check("an aggregate fill → { aggregate, tool, resultPath } from the FILL (not from the stored key text)",
    JSON.stringify(placedSourceOf(aggFig("3", "connection_health_overview", "byHealth.ERROR"))) === JSON.stringify({ source: "aggregate", tool: "connection_health_overview", resultPath: "byHealth.ERROR" }));
  check("an aggregate fill of a path outside the allowlist / an unknown tool ⇒ not annotated (and never read as a metric)",
    placedSourceOf(aggFig("3", "connection_health_overview", "unhealthyByInstitution")) === null && placedSourceOf(aggFig("3", "probe_overview", "open")) === null
    && placedSourceOf({ kind: "figure", text: "3", metric: "agg:connection_health_overview:total", window: null }) === null);
  check("text / link / note / memory ⇒ never a source", [txt("x"), { kind: "link", text: "l", href: "/x" }, { kind: "note", text: "n" }, { kind: "memory", text: "noted 1 Nov 2026" }]
    .every((t) => placedSourceOf(t as TypedAnswerSegment) === null));
}

console.log("\nB1 — /ask positioning: the slice is exactly the rendered span; fail closed\n");
{
  const r = rec("CUSTOMER", "name"), c = rec("CONNECTION", "healthState", "p:itemsentinel01");
  const typed: TypedAnswerSegment[] = [{ kind: "note", text: "Note: window." }, txt("There are "), fig("3", SCALAR), txt(" broken; "), r, txt(" has "), c, txt(" — see "), { kind: "link", text: "Incidents", href: "/x" }, txt(".")];
  const rendered = new Map<RecordSpan, string>([[r, "Zelda Quillfeather"], [c, "NEEDS_REAUTH"]]);
  const answer = displayWithRecords(typed, rendered);
  const fs = alignedFigureSources(typed, answer, (t) => rendered.get(t) ?? RECORD_GONE_TEXT);
  check("three placed spans ⇒ three entries in order (metric, CUSTOMER.name, CONNECTION.healthState)",
    JSON.stringify(fs.map((e) => (e.source === "metric" ? `${e.metricKey}|${e.resultPath}` : e.source === "record" ? `${e.recordKind}.${e.fieldCode}` : "?"))) === JSON.stringify([`${SCALAR}|value`, "CUSTOMER.name", "CONNECTION.healthState"]), fs);
  check("each answer[segment].text.slice(start, end) is the rendered span", fs.map((e) => answer[e.segment].text.slice(e.start, e.end)).join("|") === "3|Zelda Quillfeather|NEEDS_REAUTH", { fs, answer });
  check("no rid, area, handle or value in the annotation", !/cridsentinel|itemsentinel|CUSTOMER_SUCCESS|Zelda|NEEDS_REAUTH|h_/.test(JSON.stringify(fs)), fs);
  check("entries are frozen", fs.every((e) => Object.isFrozen(e)));
  // Records not rendered (no renderer): the display shows the fail-closed marker; the positions follow it.
  const pending: AnswerSegment[] = [{ kind: "note", text: "Note: window." }, { kind: "text", text: `There are 3 broken; ${RECORD_PENDING_TEXT} has ${RECORD_PENDING_TEXT} — see ` }, { kind: "link", text: "Incidents", href: "/x" }, { kind: "text", text: "." }];
  const fp = alignedFigureSources(typed, pending, (t) => t.text);
  check("unrendered records: positions on the marker text", fp.length === 3 && fp.map((e) => pending[e.segment].text.slice(e.start, e.end)).join("|") === `3|${RECORD_PENDING_TEXT}|${RECORD_PENDING_TEXT}`, fp);
  // Disagreements ⇒ [].
  const tampered = answer.map((s, i) => (i === 1 ? { ...s, text: s.text.replace("3", "4") } : s));
  check("a display answer that differs from the typed answer anywhere ⇒ [] (never a guessed position)", alignedFigureSources(typed, tampered, (t) => rendered.get(t) ?? "").length === 0);
  check("trailing display text the typed answer does not explain ⇒ []", alignedFigureSources(typed, [...answer, { kind: "text", text: "extra" }], (t) => rendered.get(t) ?? "").length === 0);
  const linkOnly: AnswerSegment[] = [{ kind: "link", text: "a3", href: "/x" }];
  check("a link where text was expected ⇒ []", alignedFigureSources([txt("a"), fig("3", SCALAR)], linkOnly, () => "").length === 0);
  check("not arrays (defensive) ⇒ []", alignedFigureSources(null as never, answer, () => "").length === 0);
}

console.log("\nB1 — conversations positioning (stored segments 1:1 with the content)\n");
{
  const r = rec("INCIDENT", "ref");
  const typed: TypedAnswerSegment[] = [txt("Incident "), r, txt(" has "), fig("2", OBJ, "failing"), txt(" failing.")];
  const placed = placedSpansOf(typed);
  const stored = [{ kind: "text" }, { kind: "record", rk: "INCIDENT", rid: "x", a: "PLATFORM_OPS", f: "ref" }, { kind: "text" }, { kind: "figure", metric: OBJ }, { kind: "text" }];
  const content = [{ kind: "text", text: "Incident " }, { kind: "text", text: "incident #ab12" }, { kind: "text", text: " has " }, { kind: "figure", text: "2" }, { kind: "text", text: " failing." }];
  const fs = storedFigureSources(placed, stored, content);
  check("each placed span → its content segment (start 0, end = its length)",
    JSON.stringify(fs) === JSON.stringify([
      { segment: 1, start: 0, end: 14, source: "record", recordKind: "INCIDENT", fieldCode: "ref" },
      { segment: 3, start: 0, end: 1, source: "metric", metricKey: OBJ, resultPath: "value.failing" },
    ]), fs);
  check("a stored figure that became text (count differs) ⇒ []", storedFigureSources(placed, stored.map((s, i) => (i === 3 ? { kind: "text" } : s)), content).length === 0);
  check("a different metric / field at the same position ⇒ []", storedFigureSources(placed, stored.map((s, i) => (i === 1 ? { ...s, f: "name" } : s)), content).length === 0);
  check("a lost-area content (one marker segment) ⇒ []", storedFigureSources(placed, stored, [{ kind: "text", text: RECORD_GONE_TEXT }]).length === 0);
  check("an un-annotated span keeps the order (never shifts a later entry)",
    JSON.stringify(storedFigureSources(placedSpansOf([fig("9", "nope@1"), r]), [{ kind: "figure", metric: "nope@1" }, { kind: "record", rk: "INCIDENT", f: "ref" }], [{ kind: "figure", text: "9" }, { kind: "text", text: "r" }]))
      === JSON.stringify([{ segment: 1, start: 0, end: 1, source: "record", recordKind: "INCIDENT", fieldCode: "ref" }]));
  const ag = aggFig("3", "connection_health_overview", "byHealth.ERROR");
  check("an aggregate fill aligns with its stored figure (metric agg:<tool>:<path>, as storedAnswerOf writes it)",
    JSON.stringify(storedFigureSources(placedSpansOf([txt("E "), ag]), [{ kind: "text" }, { kind: "figure", metric: "agg:connection_health_overview:byHealth.ERROR" }], [{ kind: "text", text: "E " }, { kind: "figure", text: "3" }]))
      === JSON.stringify([{ segment: 1, start: 0, end: 1, source: "aggregate", tool: "connection_health_overview", resultPath: "byHealth.ERROR" }])
    && storedFigureSources(placedSpansOf([ag]), [{ kind: "figure", metric: "agg:connection_health_overview:total" }], [{ kind: "figure", text: "3" }]).length === 0);
  check("the stored answer never carries the figure's part (storedAnswerOf copies named fields only)",
    !/"part"/.test(JSON.stringify(storedAnswerOf({ citations: [], notes: [], stop: "ANSWERED" } as never, { typed, pages: new Map() }))));
}

async function realTurn(): Promise<void> {
  console.log("\nB1 — derived from the FILL: a real turn (the REAL boundary + compose) places {{r:h|…}}\n");
  const OP = "cop0000000000000000000001";
  const RID = "ce0sentinelcustomer0000a1";
  const T2_NAME = "Zelda Quillfeather";
  const SCHEMA: RecordSchema = { kind: "PROBE", fields: { state: { type: "code", values: ["OPEN", "RESOLVED"] } }, t2Fields: ["name"], placeable: ["state"] };
  // S2 09io: a synthetic AGGREGATE tool under a REGISTERED aggregate name with that tool's REAL allowlist (so the
  // production closed set applies); it returns a test-only result the boundary captures for {{a:…}}.
  const healthTool = { pack: "metrics", description: "test-only", requires: { areas: ["PLATFORM_OPS"], level: "READ", tier: "OPS" }, pii: 0, cost: { toolCalls: 1 },
    name: "connection_health_overview", args: { properties: {} }, scope: "AGGREGATE", customerLinkable: false, placeablePaths: CONNECTION_HEALTH_OVERVIEW_PATHS,
    run: async () => ({ status: "CONFIRMED", asOf: "2026-11-09T12:00:00.000Z", total: 98765, byHealth: { ERROR: 4321 } }),
  } as unknown as PlatformAiTool;
  const probeTool = { pack: "metrics", description: "test-only", requires: { areas: ["PLATFORM_OPS"], level: "READ", tier: "OPS" }, pii: 2, cost: { toolCalls: 1 },
    name: "probe_list", args: { properties: {} }, scope: "RECORD", customerLinkable: false, recordSchema: SCHEMA,
    run: async () => ({ status: "CONFIRMED", asOf: "2026-11-09T12:00:00.000Z", records: [{ ref: { kind: "PROBE", recordId: RID, area: "PLATFORM_OPS", tier: "OPS", linkedUserIds: [] }, fields: { state: "OPEN" } }], truncated: false }),
  } as unknown as PlatformAiTool;
  const binding = (): PlatformAiBinding => ({ surfaceLabel: "Platform Operations", listMetrics: () => [], describeMetric: () => null, readMetric: async () => null, listPages: () => [], resolvePage: () => null });
  const scopeOf = (area: PlatformArea): ScopedArea => scopeFromGuard({ user: { id: OP, role: UserRole.USER }, grant: { area, level: "READ" } }, area, OP)!;
  const recheck = async (area: PlatformArea): Promise<FreshGuard | null> => ({ auth: { user: { id: OP, role: UserRole.USER }, grant: { area, level: "READ" } }, csTier: false });
  const source: RecordRenderSource = { t2Fields: ["name"], placeable: ["state"], revalidate: async () => "OPS", t1: async () => "user #0a1b2c3d", linkedUserIds: async () => [RID], t2: async () => T2_NAME };
  const boundary = createTurnBoundary({ operatorId: OP, correlationId: "fs-1", areas: [{ scope: scopeOf("PLATFORM_OPS"), binding: binding() }], binding: binding(),
    recheck, packs: ["metrics"], packEnabled: () => true, registry: [probeTool, healthTool], recordSources: { PROBE: source } });
  let i = 0;
  let handle = "";
  const generate: PlatformAiGenerate = async ({ messages }) => {
    i++;
    const call = (id: string, name: string) => ({ id, name, arguments: "{}" });
    if (i === 1) return { content: null, toolCalls: [call("c1", "probe_list"), call("c2", "connection_health_overview")],
      raw: { role: "assistant", content: null, tool_calls: [call("c1", "probe_list"), call("c2", "connection_health_overview")].map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: "{}" } })) },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 10, reasoningTokens: 0 } };
    for (const m of messages as { role: string; content?: string }[]) { const h = m.role === "tool" ? /"handle":"(h_[A-Za-z0-9_-]{16})"/.exec(m.content ?? "") : null; if (h) handle = h[1]; }
    const content = `The probe {{r:${handle}|name}} is {{r:${handle}|state}}; ref {{r:${handle}|ref}}. Errored connections: {{a:connection_health_overview|byHealth.ERROR}}.`;
    return { content, toolCalls: [], raw: { role: "assistant", content }, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 10, reasoningTokens: 0 } };
  };
  const { result, record } = await runPlatformAiTurn({ question: "probe?", binding: binding(), generate, model: "m", signal: AbortSignal.timeout(5_000),
    invoke: boundary.invoke, ...(boundary.tools ? { tools: boundary.tools } : {}), records: boundary.recordRef });
  const spans = record.typed.filter((t): t is RecordSpan => t.kind === "record");
  const rendered = new Map<RecordSpan, string>(spans.map((s) => [s, s.f === "name" ? T2_NAME : s.f === "state" ? "open" : "user #0a1b2c3d"]));
  const display = displayWithRecords(record.typed, rendered);
  const probeFields = recordFieldCodes([probeTool]);
  const fs = alignedFigureSources(record.typed, display, (t) => rendered.get(t) ?? RECORD_GONE_TEXT, probeFields);
  check("the turn placed three record spans (T2 name, CLOSED state, ref) and one aggregate (the fills resolved them)",
    !result.grounding.replaced && spans.length === 3 && spans.some((s) => s.f === "state" && s.v === "OPEN") && record.typed.some((t) => t.kind === "figure" && t.aggregate?.tool === "connection_health_overview") && handle.startsWith("h_"),
    { g: result.grounding, typed: record.typed.map((t) => t.kind) });
  check("the annotation names exactly the FILLED codes (PROBE.name, PROBE.state, PROBE.ref, connection_health_overview|byHealth.ERROR), in answer order",
    JSON.stringify(fs.map((e) => (e.source === "record" ? `${e.recordKind}.${e.fieldCode}` : e.source === "aggregate" ? `${e.tool}|${e.resultPath}` : "?")))
      === JSON.stringify(["PROBE.name", "PROBE.state", "PROBE.ref", "connection_health_overview|byHealth.ERROR"]), fs);
  check("…positioned on the rendered values", fs.map((e) => display[e.segment].text.slice(e.start, e.end)).join("|") === `${T2_NAME}|open|user #0a1b2c3d|4,321`, { fs, display });
  const json = JSON.stringify(fs);
  check("…and the annotation carries no rid, handle, area or value",
    !json.includes(RID) && !json.includes(handle) && !json.includes("PLATFORM_OPS") && !json.includes(T2_NAME) && !json.includes("0a1b2c3d") && !/4,?321|98765|OPEN|"open"/.test(json), json);
  check("with the production registry PROBE is not a registered kind ⇒ only the aggregate is annotated (closed set)",
    JSON.stringify(alignedFigureSources(record.typed, display, (t) => rendered.get(t) ?? "").map((e) => e.source)) === JSON.stringify(["aggregate"]));
}

function fuzz(): void {
  console.log("\nB1 — fuzz: hostile ids / handles / values / model text never reach the annotation\n");
  const hostile = ["cabc123def456ghi789jkl0mn", "h_AAAAAAAAAAAAAAAA", "someone@example.org", "Zelda Quillfeather", "p:item-0001", "c:conn-0002",
    "00000000-1111-2222-3333-444444444444", "PLATFORM_OPS", "CUSTOMER_SUCCESS", "{{m:secret@1}}", "E0LINJ-NAME-abcd1234", "\u0001", "a".repeat(200)];
  const kinds = [...FIELDS.keys(), "PROBE", "customer", "C0NN"];
  const fieldsOf = (k: string) => [...(FIELDS.get(k) ?? []), "balance", "address", "Name", "id"];
  const metrics = [SCALAR, OBJ, "connection-health@1", "nope@1", BRIEFING_MORE_KEY, ...[...METRIC_KEYS].slice(0, 6)];
  let seed = 11;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const pick = <T>(xs: readonly T[]) => xs[rnd(xs.length)];
  let spansTotal = 0, entries = 0, allValid = true, slicesExact = true, leaked = false, conversationsOk = true;
  for (let iter = 0; iter < 900; iter++) {
    const typed: TypedAnswerSegment[] = [];
    const rendered = new Map<RecordSpan, string>();
    const expected: string[] = [];
    const n = 1 + rnd(12);
    for (let j = 0; j < n; j++) {
      const r = rnd(6);
      if (r === 0) typed.push(txt(`${pick(hostile)} `));
      else if (r === 1) typed.push({ kind: "link", text: pick(hostile).slice(0, 20), href: `/x/${pick(hostile)}` });
      else if (r === 2) {
        const k = pick(kinds);
        const s = rec(k, pick(fieldsOf(k)), pick(hostile), pick(hostile), rnd(2) ? pick(hostile) : undefined);
        const v = pick(hostile);
        rendered.set(s, v);
        typed.push(s); spansTotal++;
        if (placedSourceOf(s)) expected.push(v);
      } else if (r === 3) {
        const m = pick(metrics);
        const parts = metricParts(m);
        const part = rnd(3) === 0 ? pick(hostile) : parts.length && rnd(2) ? pick(parts) : undefined;
        const v = pick(hostile);
        const f = fig(v, m, part);
        typed.push(f); spansTotal++;
        if (placedSourceOf(f)) expected.push(v);
      } else if (r === 4 && rnd(2) === 0) typed.push({ kind: "note", text: pick(hostile) });
      else if (r === 4) {
        // S2 09io: an aggregate fill (registered tool + allowlisted path, or a hostile tool / path).
        const tools = [...AGG_PATHS.keys(), "probe_overview"];
        const tool = pick(tools);
        const path = rnd(3) === 0 ? pick(hostile) : pick([...(AGG_PATHS.get(tool) ?? new Set(["open"]))]);
        const v = pick(hostile);
        const f = aggFig(v, tool, path);
        typed.push(f); spansTotal++;
        if (placedSourceOf(f)) expected.push(v);
      }
      else typed.push({ kind: "memory", text: "noted 1 Nov 2026" });
    }
    const answer = displayWithRecords(typed, rendered);
    const fs = alignedFigureSources(typed, answer, (t) => rendered.get(t) ?? RECORD_GONE_TEXT);
    entries += fs.length;
    if (!fs.every((e) => valid(e) && posOk(e))) allValid = false;
    if (fs.map((e) => answer[e.segment]?.text.slice(e.start, e.end)).join("\u0000") !== expected.join("\u0000")) slicesExact = false;
    const json = JSON.stringify(fs);
    // Every value in the JSON must be a closed code or an integer: strip those and nothing may remain.
    const residue = json.replace(/"(segment|start|end|source|recordKind|fieldCode|metricKey|resultPath|tool)":/g, "").replace(/"(record|metric|aggregate)"/g, "")
      .replace(/"[a-z][a-z0-9_]*"/g, (m) => (AGG_PATHS.has(m.slice(1, -1)) ? "" : m)).replace(/"[A-Za-z0-9_.-]+"/g, (m) => ([...AGG_PATHS.values()].some((ps) => ps.has(m.slice(1, -1))) ? "" : m))
      .replace(/"[A-Z][A-Z0-9_]*"/g, (m) => (FIELDS.has(m.slice(1, -1)) ? "" : m)).replace(/"value(\.[a-zA-Z0-9]+)?"/g, "").replace(/"[a-z0-9-]+@\d+"/g, (m) => (METRIC_KEYS.has(m.slice(1, -1)) ? "" : m))
      .replace(/"[a-zA-Z][A-Za-z0-9]*"/g, "").replace(/\d+/g, "").replace(/[[\]{},]/g, "");
    if (residue.length > 0 || hostile.some((h) => h.length >= 3 && json.includes(h))) leaked = true;
    // The same answer as a conversation would store it (1:1 content): the same entries, segment-aligned.
    const stored = typed.map((t) => (t.kind === "record" ? { kind: "record", rk: t.rk, f: t.f, ...(t.v !== undefined ? { v: t.v } : {}) } : t.kind === "figure" ? { kind: "figure", metric: t.metric } : { kind: t.kind }));
    const content = typed.map((t) => ({ kind: t.kind === "record" ? "text" : t.kind, text: t.kind === "record" ? rendered.get(t) ?? "" : t.text }));
    const cs = storedFigureSources(placedSpansOf(typed), stored, content);
    if (cs.length !== expected.length || !cs.every((e) => valid(e) && content[e.segment].text.slice(e.start, e.end) === expected[cs.indexOf(e)])) conversationsOk = false;
    if (hostile.some((h) => h.length >= 3 && JSON.stringify(cs).includes(h))) leaked = true;
  }
  check(`fuzz (${spansTotal} placed spans, ${entries} annotated): every entry has the closed keys and closed values`, allValid && spansTotal >= 1_500 && entries > 0, { spansTotal, entries });
  check("fuzz: every /ask slice is exactly the rendered span of an annotated source, in order", slicesExact);
  check("fuzz: the conversations path yields the same entries on its 1:1 content", conversationsOk);
  check("fuzz: no id / ref / handle / area / value / model text — only closed codes and integers — ever reaches the JSON", !leaked);
}

function wiring(): void {
  console.log("\nB1 — wiring: both routes, response only, no per-operator branch, the clients ignore it\n");
  const ask = code(read("app/api/platform/ai/ask/route.ts"));
  check("the ask route passes the projection to the handler", /figureSources: alignedFigureSources,/.test(ask));
  const core = code(read("lib/platform/intelligence/ai/core.ts"));
  check("core.ts adds it to the 200 body from the TYPED answer and the display answer (and imports no registry)",
    /figureSources: deps\.figureSources\(record\.typed, result\.answer, recordText\)/.test(core) && !/tools\/registry|tools\/figure-sources/.test(core));
  const runner = code(read("app/api/platform/ai/conversations/turn-runner.ts"));
  check("the conversations' turn runner computes the placed spans from the turn's typed answer",
    /const figureSources = run\.outcome\.status === "COMPLETE" \? placedSpansOf\(run\.typed \?\? \[\]\) : \[\];/.test(runner) && (runner.match(/toolTrace, figureSources \}/g) ?? []).length === 2);
  const h = code(read("lib/platform/intelligence/ai/conversations/handlers.ts"));
  const rs = h.slice(h.indexOf("async function runAndSettle("), h.indexOf("async function admit("));
  check("the handler splits the figure sources off BEFORE the settle (the stored outcome never carries them)",
    rs.indexOf("const { toolTrace, figureSources, answerVerdict, ...outcome } = run;") > 0 && rs.indexOf("const { toolTrace, figureSources, answerVerdict, ...outcome } = run;") < rs.indexOf("settleTurn(v.operatorId, conversationId, pair.assistant.id, outcome)"), rs);
  check("create AND append responses carry the sources of the turn they ran (a replay carries none)",
    (h.match(/pairResponse\(\d+, [^;]*r\.toolTrace, r\.figureSources, r\.answerVerdict\)/g) ?? []).length === 2 && (h.match(/pairResponse\(/g) ?? []).length >= 4);
  check("the conversations handler positions through the PURE conversations/figure-positions.ts and imports no tool registry (no DB-touching import on the memory / purge routes)",
    /from "\.\/figure-positions"/.test(h) && !/tools\/registry|tools\/figure-sources/.test(h));
  const positions = read("lib/platform/intelligence/ai/conversations/figure-positions.ts");
  check("conversations/figure-positions.ts imports nothing", !/^import\s/m.test(positions));
  const fsrc = code(read("lib/platform/intelligence/ai/tools/figure-sources.ts"));
  check("figure-sources.ts never imports the retrieval contract at runtime (retrieve.test.ts: Platform AI takes its types only)", !/metrics\/retrieve(-core)?"/.test(fsrc));
  const store = code(read("lib/platform/intelligence/ai/conversations/store.ts"));
  const answer = code(read("lib/platform/intelligence/ai/conversations/answer.ts"));
  check("the store and the stored-answer validator never mention figure sources or a figure part (persist nothing new)", !/figureSources|\bpart\b/.test(store) && !/figureSources/.test(answer));
  const src = code(read("lib/platform/intelligence/ai/tools/figure-sources.ts"));
  check("the projection has no operator / synthetic / env branch (identical for every operator)", !/operator|synthetic|process\.env|@\/lib\/env|userId|role/i.test(src));
  check("the projection reads no rid / area / href off a span", !/\.rid\b|\.a\b|\.href\b/.test(src));
  const pair = { userMessage: { id: "u1", role: "USER", status: "COMPLETE", createdAt: "2026-11-12T00:00:00.000Z", completedAt: null, content: "q", citations: [], notes: [], failureCode: null, unavailable: false, stale: false },
    assistantMessage: { id: "a1", role: "ASSISTANT", status: "COMPLETE", createdAt: "2026-11-12T00:00:00.000Z", completedAt: null, content: [{ kind: "text", text: "a" }], citations: [], notes: [], failureCode: null, unavailable: false, stale: false } };
  const without = parsePair(pair);
  const withSources = parsePair({ ...pair, figureSources: [{ segment: 0, start: 0, end: 1, source: "metric", metricKey: SCALAR, resultPath: "value" }] });
  check("the conversations client parses a pair the same with or without figureSources (the field is ignored)", without !== null && JSON.stringify(without) === JSON.stringify(withSources), { without, withSources });
  const askUi = code(read("components/platform/PlatformAiAsk.tsx"));
  check("the ask UI renders answer / citations / notes only and never reads figureSources", !/figureSources/.test(askUi) && /segments=\{answer\.answer\}/.test(askUi));
}

async function main() {
  await realTurn();
  fuzz();
  wiring();
  if (failures) { console.error(`\n${failures} check(s) failed, ${passed} passed`); process.exit(1); }
  console.log(`\nall ${passed} checks passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
