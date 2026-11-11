/**
 * lib/platform/intelligence/ai/conversations/records.test.ts  (Platform AI P4 — StoredAnswerV2, record placeholders, replay re-authz)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/ai/conversations/records.test.ts
 *
 * Design v2 §8.1 (I-1), §8.2 (replay), §9 (placeholders, verdicts); S2 ruling 3 (ids only inside
 * the encrypted answer; plain JSONB = kinds + counts). Today's six tools return no records, so
 * every RECORD path here runs a SYNTHETIC test-only RECORD tool (never registered) through the
 * REAL turn boundary and the REAL conversation turn. No network, no database, no live model.
 *
 *   1. StoredAnswerV2: record segments V2-only, the identity rule on store (T2 sentinel, email,
 *      cuid, uuid, handle), lowest version written (V1 byte-identical for today's answers), V1
 *      rows still parse, evidenceRefs = kinds + counts (+ areas) — a record id is refused there
 *   2. compose/record.ts: {{r:h|field}} (this turn's handles only), {{inferred}}…{{/inferred}},
 *      identity shapes, replay markers
 *   3. the turn: RECORD_UNRESOLVED (foreign / forged handle, undeclared field, bare handle),
 *      IDENTITY_LEAK (a model-written email / cuid ⇒ the answer replaced, never stored),
 *      "Likely:" rendering, the display answer shows the fail-closed marker until rendered
 *   4. the chain: synthetic RECORD tool → handle → {{r:h|name}} → stored V2 (rid inside the
 *      answer only; evidenceRefs / transcript / display carry none) → next turn: history grants
 *      nothing — a handle is re-minted ONLY after the area recheck + revalidate pass
 *   5. export: a record span is its kind marker, never a value or an id
 */

import { UserRole, type PlatformArea } from "@prisma/client";
import { IDENTITY_FALLBACK, UNVERIFIED_FALLBACK, runPlatformAiTurn, type PlatformAiBinding, type PlatformAiGenerate } from "../core";
import { createTurnBoundary } from "../authz/boundary";
import type { FreshGuard } from "../authz/recheck";
import type { RecordRenderSource } from "../authz/record-render";
import { scopeFromGuard, type ScopedArea } from "../authz/scope";
import {
  INFERRED_LEAD, RECORD_PENDING_TEXT, extractRecordPlaceholders, hasHandleText, identityShapesIn, markInferred, recordReplayMarker, renderInferred,
} from "../compose/record";
import type { RecordSchema } from "../evidence/record-envelope";
import type { PlatformAiTool } from "../tools/registry";
import {
  STORED_ANSWER_V2, STORED_ANSWER_VERSION, answerIdentityProblems, isStoredAnswer, parseEvidenceRefs, parseStoredAnswer, serializeStoredAnswer,
  storableAnswerVersion, validateEvidenceRefs, type EvidenceRef, type StoredAnswer,
} from "./answer";
import { renderAnswerText } from "./export";
import type { HistoryMessage } from "./history";
import { evidenceRefsOf, runConversationTurn, storedAnswerOf } from "./turn";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)?.slice(0, 600)}` : ""}`); }
}
const throws = (f: () => unknown) => { try { f(); return false; } catch { return true; } };

const OP = "cop0000000000000000000001";
const CONV = "c000000000000000000000001";
const AS_OF = "2026-11-09T12:00:00.000Z";
const RID = "ce0sentinelcustomer0000a1";           // a cuid-shaped record id (also an E0 T2 sentinel)
const T2_NAME = "Zelda Quillfeather";              // the record's T2 value — the model never receives it
const NOW = new Date("2026-11-10T12:00:00.000Z");

const text = (t: string) => ({ kind: "text" as const, text: t });
const v1 = (segments: StoredAnswer["segments"]): StoredAnswer => ({ v: STORED_ANSWER_VERSION, segments, citations: [], notes: [], stop: "ANSWERED" });
const v2 = (segments: StoredAnswer["segments"], stop: StoredAnswer["stop"] = "ANSWERED"): StoredAnswer => ({ v: STORED_ANSWER_V2, segments, citations: [], notes: [], stop });
const recSeg = { kind: "record" as const, rk: "PROBE", rid: RID, a: "PLATFORM_OPS", f: "name" };

// ── fixtures: a stub binding, a synthetic RECORD tool, a recheck, a record source ─────────────

const binding = (): PlatformAiBinding => ({
  surfaceLabel: "Platform Operations", listMetrics: () => [], describeMetric: () => null, readMetric: async () => null, listPages: () => [], resolvePage: () => null,
});
const scopeOf = (area: PlatformArea): ScopedArea => scopeFromGuard({ user: { id: OP, role: UserRole.USER }, grant: { area, level: "READ" } }, area, OP)!;
const SCHEMA: RecordSchema = { kind: "PROBE", fields: { state: { type: "code", values: ["OPEN", "RESOLVED"] } }, t2Fields: ["name"] };
const probeTool = (): PlatformAiTool => ({
  pack: "metrics", description: "test-only", requires: { areas: ["PLATFORM_OPS"], level: "READ", tier: "OPS" }, pii: 2, cost: { toolCalls: 1 },
  name: "probe_list", args: { properties: {} }, scope: "RECORD", customerLinkable: false, recordSchema: SCHEMA,
  run: async () => ({ status: "CONFIRMED", asOf: AS_OF, records: [{ ref: { kind: "PROBE", recordId: RID, area: "PLATFORM_OPS", tier: "OPS", linkedUserIds: [] }, fields: { state: "OPEN" } }], truncated: false }),
} as PlatformAiTool);

function world() {
  const held = new Set<PlatformArea>(["PLATFORM_OPS"]);
  const visible = new Set<string>([RID]);
  const reads: string[] = [];
  const recheck = async (area: PlatformArea): Promise<FreshGuard | null> => {
    reads.push(`grant:${area}`);
    return held.has(area) ? { auth: { user: { id: OP, role: UserRole.USER }, grant: { area, level: "READ" } }, csTier: false } : null;
  };
  const source: RecordRenderSource = {
    t2Fields: ["name"],
    revalidate: async (rid) => { reads.push(`revalidate:${rid}`); return visible.has(rid) ? "OPS" : null; },
    t1: async () => "user #0a1b2c3d",
    linkedUserIds: async () => [RID],
    t2: async () => T2_NAME,
  };
  const boundaryFor = (correlationId: string) => createTurnBoundary({
    operatorId: OP, correlationId, areas: [{ scope: scopeOf("PLATFORM_OPS"), binding: binding() }], binding: binding(),
    recheck, packs: ["metrics"], packEnabled: () => true, registry: [probeTool()], recordSources: { PROBE: source },
  });
  return { held, visible, reads, boundaryFor, source };
}

/** A scripted model: step i may be a function of the messages so far (to copy a handle it received). */
type Step = { calls?: { name: string; args: unknown }[]; content?: string | ((messages: unknown[]) => string) };
function scripted(steps: Step[]) {
  const requests: string[] = [];
  let i = 0;
  const generate: PlatformAiGenerate = async ({ messages }) => {
    requests.push(JSON.stringify(messages));
    const s = steps[Math.min(i, steps.length - 1)];
    i++;
    const toolCalls = (s.calls ?? []).map((c, k) => ({ id: `call_${i}_${k}`, name: c.name, arguments: JSON.stringify(c.args) }));
    const content = typeof s.content === "function" ? s.content(messages) : s.content ?? null;
    const raw = { role: "assistant", content, ...(toolCalls.length ? { tool_calls: toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.arguments } })) } : {}) };
    return { content, toolCalls, raw, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 50, reasoningTokens: 0 } };
  };
  return { generate, requests };
}
/** The first handle the model received in a tool result. */
const handleIn = (messages: unknown[]): string => {
  for (const m of messages as { role: string; content?: string }[]) {
    if (m.role !== "tool") continue;
    const h = /"handle":"(h_[A-Za-z0-9_-]{16})"/.exec(m.content ?? "");
    if (h) return h[1];
  }
  return "h_nohandlereceived0";
};
const classify = () => "PROVIDER" as const;

async function main() {
  console.log("1. StoredAnswerV2 — the stored shape (I-1, S2 ruling 3)");
  {
    check("a V2 answer with a record segment (field CODE only) is valid and serialises", isStoredAnswer(v2([text("The record is "), recSeg])) && !throws(() => serializeStoredAnswer(v2([text("The record is "), recSeg]))));
    check("a record segment is refused in a V1 answer (V2 only)", !isStoredAnswer(v1([text("x"), recSeg])));
    check("stop COST_CAP is V2 only", isStoredAnswer(v2([text("x")], "COST_CAP")) && !isStoredAnswer({ ...v1([text("x")]), stop: "COST_CAP" }));
    check("a record segment with a value / text / extra key is refused", !isStoredAnswer(v2([{ ...recSeg, text: T2_NAME } as never])) && !isStoredAnswer(v2([{ ...recSeg, value: T2_NAME } as never])));
    check("a record segment with a bad kind / id / area / field shape is refused",
      [{ rk: "probe" }, { rid: "has space" }, { rid: "x".repeat(65) }, { a: "ALL" }, { f: "Name" }, { f: "" }].every((o) => !isStoredAnswer(v2([{ ...recSeg, ...o } as never]))));
    check("the writer stores the LOWEST version: no record + no COST_CAP ⇒ V1 (today's answers unchanged)",
      storableAnswerVersion(v1([text("x")])) === 1 && storableAnswerVersion(v2([recSeg])) === 2 && storableAnswerVersion(v2([text("x")], "COST_CAP")) === 2);
    check("a V2-labelled answer that V1 can express is refused on store (no needless version bump)", throws(() => serializeStoredAnswer(v2([text("plain")]))));
    check("a V1 row written before P4 still parses unchanged", JSON.stringify(parseStoredAnswer(JSON.stringify(v1([text("ok "), { kind: "figure", text: "3", metric: "incident-broken-now@1", window: null }])))) === JSON.stringify(v1([text("ok "), { kind: "figure", text: "3", metric: "incident-broken-now@1", window: null }])));
    // S2 09io A4: V3 exists (a closed field's value on a record segment); V4+ is still refused.
    check("parse accepts V1 | V2 | V3 only", parseStoredAnswer(JSON.stringify({ ...v2([recSeg]), v: 4 })) === null && parseStoredAnswer(JSON.stringify(v2([recSeg])))?.v === 2
      && parseStoredAnswer(JSON.stringify({ ...v2([recSeg]), v: 3 }))?.v === 3);

    // The identity rule on store (every version).
    const leaks: [string, StoredAnswer][] = [
      ["a T2 sentinel value the caller knows", v1([text(`It is ${T2_NAME}.`)])],
      ["an email", v1([text("Contact probe@e0-model.invalid now.")])],
      ["a cuid-shaped id", v1([text(`Record ${RID} is open.`)])],
      ["a uuid-shaped id", v1([text("Ref 3f2a9b1c-1234-4abc-8def-0123456789ab.")])],
      ["a handle key", v1([text("See h_AbCdEfGhIjKlMnOp.")])],
      ["an email in a LINK label", v1([{ kind: "link", text: "mail probe@e0-model.invalid", page: "platform:overview", params: {} }])],
    ];
    for (const [what, a] of leaks) check(`store REFUSES text carrying ${what} (IDENTITY_LEAK, never stored)`, throws(() => serializeStoredAnswer(a, { t2Values: [T2_NAME] })), answerIdentityProblems(a, [T2_NAME]));
    check("the opaque T1 ref \"user #xxxxxxxx\" is allowed in text", !throws(() => serializeStoredAnswer(v1([text("Affected: user #0a1b2c3d.")]))));
    check("server-written notes / figures are not model text (a note with an id shape is not scanned)", answerIdentityProblems(v1([{ kind: "note", text: `Note ${RID}` }])).length === 0);

    // evidenceRefs: kinds + counts (+ areas) — never a record id.
    const refs: EvidenceRef[] = [{ k: "m", id: "incident-broken-now@1", w: null }, { k: "a", id: "PLATFORM_OPS" }, { k: "r", t: "PROBE", n: 2 }];
    check("evidenceRefs accept {k:a, area} and {k:r, kind, count}", JSON.stringify(validateEvidenceRefs(refs)) === JSON.stringify(refs));
    check("evidenceRefs REFUSE a record id anywhere (an id key on r, an id as the kind, a non-area a)",
      [{ k: "r", t: "PROBE", n: 1, id: RID }, { k: "r", t: RID, n: 1 }, { k: "a", id: RID }, { k: "r", t: "PROBE", n: 0 }, { k: "rid", id: RID }]
        .every((r) => throws(() => validateEvidenceRefs([r as never]))));
    check("a stored evidenceRefs value with a record id is dropped on read", parseEvidenceRefs([{ k: "r", t: "PROBE", n: 1, id: RID }, { k: "a", id: "PLATFORM_OPS" }]).length === 1);
  }

  console.log("\n2. compose/record.ts — placeholders, inferred, identity shapes, markers");
  {
    const lookup = (h: string) => (h === "h_AAAAAAAAAAAAAAAA" ? { rk: "PROBE", rid: RID, a: "PLATFORM_OPS", fields: ["ref", "name"] } : null);
    const x = extractRecordPlaceholders("A {{r:h_AAAAAAAAAAAAAAAA|name}} and {{r:h_AAAAAAAAAAAAAAAA|ref}}.", lookup);
    check("this turn's handle + a declared field ⇒ a span (kind, id, area, field code); the text keeps a sentinel only",
      x.spans.length === 2 && x.unresolved === 0 && x.claims === 2 && x.spans[0].f === "name" && x.spans[0].text === RECORD_PENDING_TEXT && !x.text.includes(RID) && !x.text.includes("{{"));
    check("a foreign / forged handle ⇒ unresolved", extractRecordPlaceholders("{{r:h_BBBBBBBBBBBBBBBB|name}}", lookup).unresolved === 1);
    check("an undeclared field (email not in t2Fields) ⇒ unresolved", extractRecordPlaceholders("{{r:h_AAAAAAAAAAAAAAAA|email}}", lookup).unresolved === 1);
    check("a malformed record placeholder ⇒ unresolved, removed", (() => { const r = extractRecordPlaceholders("{{r:customer zelda}}", lookup); return r.unresolved === 1 && !r.text.includes("{{"); })());
    check("no lookup (today's tools) ⇒ every record placeholder unresolved", extractRecordPlaceholders("{{r:h_AAAAAAAAAAAAAAAA|ref}}", undefined).unresolved === 1);
    check("{{inferred}}…{{/inferred}} ⇒ \"Likely: …\"", renderInferred(markInferred("{{inferred}}the token expired{{/inferred}}").text) === `${INFERRED_LEAD}the token expired`);
    check("an unpaired {{inferred}} stays in the prose (the malformed rule refuses it)", markInferred("{{inferred}} dangling").spans === 0);
    check("identity shapes: email / cuid / uuid found; the opaque ref and ordinary words are not",
      identityShapesIn("a@b.co").includes("EMAIL") && identityShapesIn(`x ${RID} y`).includes("CUID") && identityShapesIn("3f2a9b1c-1234-4abc-8def-0123456789ab").includes("UUID")
        && identityShapesIn("user #0a1b2c3d characteristically uncomplicatedness").length === 0);
    check("a bare handle key in prose is detected", hasHandleText("see h_AbCdEfGhIjKlMnOp now") && !hasHandleText("hello_world"));
    check("replay markers: kind word, plus a re-minted handle only when given", recordReplayMarker("PROBE", null) === "[probe]" && recordReplayMarker("SYNC_INCIDENT", "h_AAAAAAAAAAAAAAAA") === "[sync incident h_AAAAAAAAAAAAAAAA]");
  }

  console.log("\n3. the turn — RECORD_UNRESOLVED, IDENTITY_LEAK, Likely:");
  {
    const run = async (content: string) => {
      const sc = scripted([{ content }]);
      return runPlatformAiTurn({ question: "What is open?", binding: binding(), generate: sc.generate, model: "m", classifyBriefing: false });
    };
    const forged = await run("The record is {{r:h_AAAAAAAAAAAAAAAA|name}}.");
    check("a record placeholder with no record this turn ⇒ RECORD_UNRESOLVED, the safe fallback", forged.result.grounding.verdict === "RECORD_UNRESOLVED" && forged.result.grounding.replaced && JSON.stringify(forged.result.answer).includes(UNVERIFIED_FALLBACK), forged.result.grounding);
    const bare = await run("Look at h_AbCdEfGhIjKlMnOp.");
    check("a bare handle in prose ⇒ RECORD_UNRESOLVED (a key is never shown or stored)", bare.result.grounding.verdict === "RECORD_UNRESOLVED" && !JSON.stringify(bare.result.answer).includes("h_AbCd"));
    const email = await run("The affected customer is probe@e0-model.invalid.");
    check("a model-written email ⇒ IDENTITY_LEAK: the answer is replaced (hard fail), nothing of it survives",
      email.result.grounding.verdict === "IDENTITY_LEAK" && email.result.grounding.replaced && JSON.stringify(email.result.answer) === JSON.stringify([{ kind: "text", text: IDENTITY_FALLBACK }]) && !JSON.stringify(email.record.typed).includes("probe@"));
    const cuid = await run(`The record ${RID} is open.`);
    check("a model-written cuid ⇒ IDENTITY_LEAK (before the digit rule)", cuid.result.grounding.verdict === "IDENTITY_LEAK" && !JSON.stringify(cuid.result).includes(RID));
    const t1ok = await run("The affected account is user #0a1b2c3d.");
    check("…the opaque T1 ref is not an identity leak", t1ok.result.grounding.verdict !== "IDENTITY_LEAK");
    const inferred = await run("{{inferred}}the provider token expired{{/inferred}}.");
    check("{{inferred}} renders \"Likely:\" in the display and the stored typed answer", inferred.result.grounding.verdict === "NONE"
      && JSON.stringify(inferred.result.answer).includes("Likely: the provider token expired") && JSON.stringify(inferred.record.typed).includes("Likely: the provider token expired"), inferred.result.answer);
    const sneaky = await run("Done.a and x");
    check("the model's own private-sentinel characters are stripped (cannot forge a span)", !JSON.stringify(sneaky.record.typed).includes("\"record\"") && !/[-]/.test(JSON.stringify(sneaky.result.answer)));
  }

  console.log("\n4. the chain — synthetic RECORD tool → handle → {{r:h|name}} → stored V2 → replay re-authz");
  {
    const w = world();
    const b1 = w.boundaryFor("turn-1");
    const s1 = scripted([{ calls: [{ name: "probe_list", args: {} }] }, { content: (m) => `The open record is {{r:${handleIn(m)}|name}} ({{r:${handleIn(m)}|ref}}).` }]);
    const t1 = await runConversationTurn({ conversationId: CONV, question: "Which record is open?", binding: binding(), history: [], generate: s1.generate, model: "m", classify, invoke: b1.invoke, records: b1.recordRef, remint: b1.remint });
    const out = t1.outcome;
    check("turn 1 COMPLETE", out.status === "COMPLETE", out);
    if (out.status !== "COMPLETE") return;
    const a = out.answer;
    check("the stored answer is V2 with two record segments: kind, id, area, field CODE — no value", a.v === 2 && a.segments.filter((s) => s.kind === "record").length === 2
      && a.segments.some((s) => s.kind === "record" && s.f === "name" && s.rid === RID && s.a === "PLATFORM_OPS") && !JSON.stringify(a).includes(T2_NAME));
    check("it serialises (rid only inside the encrypted plaintext)", !throws(() => serializeStoredAnswer(a, { t2Values: [T2_NAME] })));
    check("evidenceRefs: kinds + counts + areas, NO record id", !JSON.stringify(out.evidenceRefs).includes(RID)
      && out.evidenceRefs.some((r) => r.k === "r" && r.t === "PROBE" && r.n === 2) && out.evidenceRefs.some((r) => r.k === "a" && r.id === "PLATFORM_OPS"), out.evidenceRefs);
    check("the model never received the id or the T2 value (every provider request)", s1.requests.every((q) => !q.includes(RID) && !q.includes(T2_NAME)));
    check("the live display answer shows the fail-closed marker until rendered (never a value / id)",
      JSON.stringify(t1.result?.answer).includes(RECORD_PENDING_TEXT) && !JSON.stringify(t1.result).includes(RID) && !JSON.stringify(t1.result).includes(T2_NAME));
    check("evidenceRefsOf over the turn record agrees (no rid)", !JSON.stringify(evidenceRefsOf({ metricsRead: [], pages: new Map(), areasRead: ["PLATFORM_OPS"], typed: [{ kind: "record", text: RECORD_PENDING_TEXT, rk: "PROBE", rid: RID, a: "PLATFORM_OPS", f: "name" }] })).includes(RID));
    const handle1 = handleIn(JSON.parse(s1.requests[1]) as unknown[]);

    // Turn 2: history replays the record as a marker; a handle is re-minted ONLY after re-authz.
    const history: HistoryMessage[] = [
      { id: "u1", conversationId: CONV, role: "USER", status: "COMPLETE", createdAt: new Date(NOW.getTime() - 60_000), replyToId: null, content: "Which record is open?", evidenceRefs: [] },
      { id: "a1", conversationId: CONV, role: "ASSISTANT", status: "COMPLETE", createdAt: new Date(NOW.getTime() - 59_000), replyToId: "u1", content: a, evidenceRefs: out.evidenceRefs },
    ];
    const turn2 = async (allowed: boolean) => {
      w.reads.length = 0;
      if (!allowed) w.visible.delete(RID); else w.visible.add(RID);
      const b2 = w.boundaryFor("turn-2");
      const s2 = scripted([{ content: (m) => { const reminted = /\[probe (h_[A-Za-z0-9_-]{16})\]/.exec(JSON.stringify(m)); return reminted ? `Still {{r:${reminted[1]}|ref}}.` : `Still {{r:${handle1}|ref}}.`; } }]);
      const r = await runConversationTurn({ conversationId: CONV, question: "Is it still open?", binding: binding(), history, generate: s2.generate, model: "m", classify, invoke: b2.invoke, records: b2.recordRef, remint: b2.remint });
      return { r, s2, b2 };
    };
    const ok = await turn2(true);
    const replay = ok.s2.requests[0];
    const reminted = /\[probe (h_[A-Za-z0-9_-]{16})\]/.exec(replay)?.[1] ?? null;
    check("replay: the prior record reaches the model as [probe h_…] with a handle of THIS turn — never the id / value / old handle",
      reminted !== null && reminted !== handle1 && !replay.includes(RID) && !replay.includes(T2_NAME) && !replay.includes(handle1), replay.slice(0, 400));
    check("re-authz ran FRESH: the area recheck and the record revalidate (before the model call)", w.reads.includes("grant:PLATFORM_OPS") && w.reads.includes(`revalidate:${RID}`), w.reads);
    check("the re-minted handle resolves in THIS turn ⇒ the follow-up places the record (COMPLETE, V2)",
      ok.r.outcome.status === "COMPLETE" && ok.r.outcome.answer.v === 2 && ok.r.outcome.answer.segments.some((s) => s.kind === "record" && s.f === "ref"), ok.r.result?.grounding);
    check("the re-minted handle is bound to THIS turn only (turn-2's table; turn-1's boundary does not know it)", !!reminted && ok.b2.recordRef(reminted) !== null && b1.recordRef(reminted) === null);

    const gone = await turn2(false);
    const replayGone = gone.s2.requests[0];
    check("record no longer visible ⇒ replay shows the bare kind marker [probe], no handle (history grants nothing)", /\[probe\]/.test(replayGone) && !/\[probe h_/.test(replayGone));
    check("…and the OLD handle copied from history does not resolve ⇒ RECORD_UNRESOLVED (the safe fallback)", gone.r.result?.grounding.verdict === "RECORD_UNRESOLVED", gone.r.result?.grounding);

    w.visible.add(RID); w.held.delete("PLATFORM_OPS");
    const b3 = w.boundaryFor("turn-3");
    check("area no longer held ⇒ remint returns null without asking the source", (await b3.remint([{ rk: "PROBE", rid: RID, a: "PLATFORM_OPS" }]))[0] === null && !w.reads.slice(-1)[0]?.startsWith("revalidate"));
    w.held.add("PLATFORM_OPS");
    const b4 = w.boundaryFor("turn-4");
    check("an unknown record kind / an out-of-scope area ⇒ null", (await b4.remint([{ rk: "OTHER", rid: RID, a: "PLATFORM_OPS" }, { rk: "PROBE", rid: RID, a: "CUSTOMER_SUCCESS" }])).every((h) => h === null));
    check("JSON / inspect of a boundary never carries a record id", !JSON.stringify(b4).includes(RID));

    console.log("\n5. export — never T2, never the id");
    const exported = renderAnswerText(a);
    check("a record span exports as its kind marker", exported.includes("[probe]") && !exported.includes(RID) && !exported.includes(T2_NAME), exported);
    check("storedAnswerOf drops the span's display text (stored = ref only)", JSON.stringify(storedAnswerOf(t1.result!, { typed: [{ kind: "record", text: RECORD_PENDING_TEXT, rk: "PROBE", rid: RID, a: "PLATFORM_OPS", f: "ref" }], pages: new Map() }).segments) === JSON.stringify([{ kind: "record", rk: "PROBE", rid: RID, a: "PLATFORM_OPS", f: "ref" }]));
  }

  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
