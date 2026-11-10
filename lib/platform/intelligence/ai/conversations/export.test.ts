/**
 * lib/platform/intelligence/ai/conversations/export.test.ts  (B11 PR D — the subject-access export, S2 Q5)
 *
 * The pure projection under the S2 STRICT ruling (held area ⇒ everything;
 * lost area ⇒ a COUNT and a fixed line, no content), and the pins on where the
 * export reads, decrypts and decides (lib/export/assemble.ts + the data
 * module). The real read — including a decrypt SPY proving nothing of a lost
 * area is decrypted — is proven on real PostgreSQL roles in
 * scripts/platform-ai-conversations-acceptance.ts ([export]).
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/ai/conversations/export.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { PlatformArea } from "@prisma/client";
import { omittedConversationsNote, projectPlatformAiConversationsForExport, renderAnswerText } from "./export";
import type { EvidenceRef, StoredAnswer, StoredAnswerV1 } from "./answer";
import type { ScopedArea } from "../authz/boundary";
import { RECORD_GONE_TEXT } from "../compose/record";
import { messageDto, type AreaAccess } from "./handlers";
import { freshlyHeldAreas } from "./multi-area";
import type { ExportConversationRecord, MessageRecord } from "./store";

let failures = 0;
function check(name: string, ok: boolean, detail: unknown = ""): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`); }
}
const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const T = (m: number) => new Date(Date.UTC(2026, 0, 1, 10, m));
const ANSWER: StoredAnswerV1 = {
  v: 1,
  segments: [
    { kind: "text", text: "There are " },
    { kind: "figure", text: "3", metric: "provider-outcome@1", window: 7 },
    { kind: "text", text: " open incidents — see " },
    { kind: "link", text: "the incident list", page: "PLATFORM_OPS:platform-incidents:open", params: { status: "open" } },
    { kind: "text", text: "." },
  ],
  citations: [{ metric: "provider-outcome@1", label: "Provider outcomes", window: "last 7 days" }],
  notes: ["Figures are as of the time of the answer."],
  stop: "ANSWERED",
};
const msg = (o: Partial<MessageRecord> & Pick<MessageRecord, "id" | "role">): MessageRecord => ({
  conversationId: "cv1", status: "COMPLETE", createdAt: T(0), completedAt: T(0), replyToId: null,
  content: null, unreadable: false, failureCode: null, evidenceRefs: [], ...o,
});
const conv = (id: string, area: PlatformArea, messages: MessageRecord[]): ExportConversationRecord =>
  ({ id, area, createdAt: T(0), lastActivityAt: T(5), messages });

const held = conv("cvheld", "PLATFORM_OPS", [
  msg({ id: "u1", role: "USER", content: "How many provider incidents are open?" }),
  msg({ id: "a1", role: "ASSISTANT", replyToId: "u1", content: ANSWER, evidenceRefs: [{ k: "m", id: "provider-outcome@1", w: 7 }] }),
  msg({ id: "u2", role: "USER", content: "And last week?", createdAt: T(3) }),
  msg({ id: "a2", role: "ASSISTANT", replyToId: "u2", status: "FAILED", failureCode: "TIMEOUT", completedAt: T(4), createdAt: T(3) }),
  msg({ id: "u3", role: "USER", content: "Third?", createdAt: T(5) }),
  msg({ id: "a3", role: "ASSISTANT", replyToId: "u3", status: "PENDING", completedAt: null, createdAt: T(5) }),
]);
const lost = conv("cvlost", "SECURITY_OPS", [
  msg({ id: "u9", role: "USER", content: "Any failed logins spike?" }),
  msg({ id: "a9", role: "ASSISTANT", replyToId: "u9", content: { ...ANSWER, segments: [{ kind: "text", text: "SECRET-SECURITY-ANSWER" }] } }),
]);
const unreadable = conv("cvbad", "PLATFORM_OPS", [
  msg({ id: "u5", role: "USER", content: null, unreadable: true }),
  msg({ id: "a5", role: "ASSISTANT", replyToId: "u5", content: null, unreadable: true }),
]);

console.log("1. the projection (S2 STRICT export ruling)");
{
  const held2 = new Set<PlatformArea>(["PLATFORM_OPS"]);
  // What the data module hands back: held conversations read in full, lost areas as counts only.
  const out = projectPlatformAiConversationsForExport({ conversations: [held, unreadable], omitted: [{ area: "SECURITY_OPS", count: 2 }] }, held2, held2);
  const [h, u] = out.conversations;
  check("a HELD area exports every message, in order, with the answer as rendered text",
    out.conversations.length === 2 && h.messages.length === 6 && h.messages[1].text === "There are 3 open incidents — see the incident list.", h.messages[1]);
  check("…with its citations and code-written notes", JSON.stringify(h.messages[1].citations) === JSON.stringify(ANSWER.citations) && h.messages[1].notes?.[0] === ANSWER.notes[0]);
  check("links are exported as TEXT only (no href, no page id, no params)", !JSON.stringify(h).includes("PLATFORM_OPS:platform-incidents") && !JSON.stringify(h).includes("href") && !JSON.stringify(h).includes("\"status\":\"open\""));
  check("evidence refs and message ids are not exported", !JSON.stringify(out).includes("evidenceRefs") && !/"(u1|a1|u9|a9)"/.test(JSON.stringify(out)));
  check("a FAILED reply exports its code and no text; a PENDING one exports no text",
    h.messages[3].status === "FAILED" && h.messages[3].failureCode === "TIMEOUT" && h.messages[3].text === null && h.messages[5].status === "PENDING" && h.messages[5].text === null);
  check("timestamps are ISO strings", h.createdAt === T(0).toISOString() && h.lastActivityAt === T(5).toISOString() && h.messages[3].completedAt === T(4).toISOString());
  check("a LOST area is a COUNT and the S2 line only — area, label, count, note; nothing else",
    out.omitted.length === 1 && Object.keys(out.omitted[0]).sort().join() === "area,areaLabel,count,note" && out.omitted[0].count === 2
      && out.omitted[0].note === omittedConversationsNote(2, "SECURITY_OPS") && /^2 conversations in .+ omitted: you no longer have access$/.test(out.omitted[0].note) && !out.omitted[0].note.includes("SECURITY_OPS"));
  check("an unreadable stored value is exported as unavailable, never as text", u.messages.every((m) => m.unavailable && m.text === null));
  const leaked = projectPlatformAiConversationsForExport({ conversations: [held, lost], omitted: [] }, held2, held2);
  check("DEFENCE IN DEPTH: a lost-area conversation handed in anyway is DROPPED and counted — no question, answer, id or label",
    leaked.conversations.length === 1 && leaked.omitted.length === 1 && leaked.omitted[0].count === 1
      && !/Any failed logins spike|SECRET-SECURITY-ANSWER|cvlost/.test(JSON.stringify(leaked)));
  const none = projectPlatformAiConversationsForExport({ conversations: [], omitted: [{ area: "PLATFORM_OPS", count: 3 }, { area: "SECURITY_OPS", count: 1 }] }, new Set(), new Set());
  check("NO held area (e.g. operator 2FA refused) ⇒ nothing but per-area counts", none.conversations.length === 0 && none.omitted.map((o) => `${o.area}:${o.count}`).join() === "PLATFORM_OPS:3,SECURITY_OPS:1");
  check("the omission line is singular for 1 and plural otherwise",
    /^1 conversation in .+ omitted: you no longer have access$/.test(omittedConversationsNote(1, "SECURITY_OPS"))
      && /^3 conversations in .+ omitted: you no longer have access$/.test(omittedConversationsNote(3, "PLATFORM_OPS"))
      && leaked.omitted[0].note === omittedConversationsNote(1, "SECURITY_OPS") && leaked.omitted[0].note.startsWith("1 conversation in "),
    [omittedConversationsNote(1, "SECURITY_OPS"), leaked.omitted[0].note]);
  check("renderAnswerText concatenates every span's text", renderAnswerText(ANSWER) === "There are 3 open incidents — see the incident list.");
  check("nothing stored ⇒ an empty section", (() => { const e = projectPlatformAiConversationsForExport({ conversations: [], omitted: [] }, new Set(), new Set()); return e.conversations.length === 0 && e.omitted.length === 0; })());
}

async function lostAreaRule(): Promise<void> {
  console.log("\n3. S2 09ed — the P4b lost-area rule inside a held conversation (export == view)");
  const OPS: PlatformArea = "PLATFORM_OPS";
  const CS: PlatformArea = "CUSTOMER_SUCCESS";
  const OP = "cop0000000000000000000001";
  const SENTINEL = "Zephyrlantern";
  const csAnswer: StoredAnswerV1 = {
    v: 1,
    segments: [{ kind: "text", text: `${SENTINEL} customers: ` }, { kind: "figure", text: "17", metric: "cs-needs-help@1", window: 7 }],
    citations: [{ metric: "cs-needs-help@1", label: "Customers needing help", window: "last 7 days" }],
    notes: [`${SENTINEL} note.`],
    stop: "ANSWERED",
  };
  const recAnswer = { v: 2, segments: [{ kind: "text", text: `${SENTINEL} case ` }, { kind: "record", rk: "CUSTOMER", rid: "kref", a: CS, f: "ref" }], citations: [], notes: [], stop: "ANSWERED" } as unknown as StoredAnswer;
  const opsRefs: EvidenceRef[] = [{ k: "m", id: "provider-outcome@1", w: 7 }, { k: "a", id: OPS }];
  const multi = conv("cvmulti", OPS, [
    msg({ id: "u1", role: "USER", content: "How many provider incidents are open?" }),
    msg({ id: "a1", role: "ASSISTANT", replyToId: "u1", content: ANSWER, evidenceRefs: opsRefs }),
    msg({ id: "u2", role: "USER", content: "And customers needing help?" }),
    msg({ id: "a2", role: "ASSISTANT", replyToId: "u2", content: csAnswer, evidenceRefs: [{ k: "a", id: OPS }, { k: "a", id: CS }] }),
    msg({ id: "u3", role: "USER", content: "Which case?" }),
    // Only the record span names CS (no {k:"a"} ref for it): still CS's answer.
    msg({ id: "a3", role: "ASSISTANT", replyToId: "u3", content: recAnswer, evidenceRefs: [{ k: "a", id: OPS }] }),
    msg({ id: "u4", role: "USER", content: "Old question?" }),
    // Stored before P4b: no recorded areas.
    msg({ id: "a4", role: "ASSISTANT", replyToId: "u4", content: ANSWER, evidenceRefs: [{ k: "m", id: "provider-outcome@1", w: 7 }] }),
  ]);
  const directoryHeld = new Set<PlatformArea>([OPS, CS]);
  const project = (answerHeld: ReadonlySet<PlatformArea>, c = multi) => projectPlatformAiConversationsForExport({ conversations: [c], omitted: [] }, directoryHeld, answerHeld);

  // The view of the SAME messages with the access of NOW (handlers.ts messageDto — what GET /conversations/[id] returns).
  const viewAccess = (held: ReadonlySet<PlatformArea>) => ({ resolvePage: () => null, area: OPS, heldAreas: held }) as unknown as AreaAccess;
  const hiddenInView = (held: ReadonlySet<PlatformArea>) => multi.messages
    .filter((m) => JSON.stringify(messageDto(m, viewAccess(held), false).content) === JSON.stringify([{ kind: "text", text: RECORD_GONE_TEXT }])).map((m) => m.id);
  const hiddenInExport = (held: ReadonlySet<PlatformArea>) => {
    const out = project(held).conversations[0].messages;
    return out.map((m, i) => (m.text === RECORD_GONE_TEXT ? multi.messages[i].id : null)).filter((x): x is string => x !== null);
  };

  const both = project(new Set([OPS, CS]));
  check("both areas held now ⇒ every answer exported in full (the CS answers included)",
    JSON.stringify(both).includes(SENTINEL) && both.conversations[0].messages.every((m) => m.text !== RECORD_GONE_TEXT));
  const lostCs = project(new Set([OPS]));
  const lm = lostCs.conversations[0].messages;
  check("CS lost ⇒ each answer that read CS (an {k:a} ref OR only a record span) is EXACTLY \"[no longer available]\" — no text, figure, citation, note",
    lm[3].text === RECORD_GONE_TEXT && lm[5].text === RECORD_GONE_TEXT && lm[3].citations?.length === 0 && lm[3].notes?.length === 0 && lm[5].citations?.length === 0 && lm[5].notes?.length === 0, lm);
  check("…nothing of the lost answers anywhere in the export (sentinel, figure, metric id, label)",
    !/Zephyrlantern|cs-needs-help|Customers needing help|"17"|kref/.test(JSON.stringify(lostCs)), JSON.stringify(lostCs).slice(0, 300));
  check("…the operator's questions stay; the held-area answer and the pre-P4b answer are unchanged (byte-equal to the both-held export)",
    lm[2].text === "And customers needing help?" && lm[4].text === "Which case?"
      && JSON.stringify(lm[1]) === JSON.stringify(both.conversations[0].messages[1]) && JSON.stringify(lm[7]) === JSON.stringify(both.conversations[0].messages[7]));
  check("…status / timestamps / failure code of the hidden answer kept (the same envelope the view keeps)",
    lm[3].status === "COMPLETE" && lm[3].role === "ASSISTANT" && lm[3].createdAt === T(0).toISOString() && lm[3].unavailable === false && lm[3].failureCode === null);
  for (const [label, held] of [["CS lost", new Set([OPS])], ["both held", new Set([OPS, CS])], ["nothing held now", new Set<PlatformArea>()], ["Ops lost", new Set([CS])]] as const) {
    const v = hiddenInView(held), e = hiddenInExport(held);
    check(`export == view (${label}): the SAME set of hidden answers [${e.join()}]`, JSON.stringify(v) === JSON.stringify(e), { view: v, export: e });
  }
  const viewMarker = messageDto(multi.messages[3], viewAccess(new Set([OPS])), false).content as { text: string }[];
  check("the hidden marker is byte-equal to the view's (RECORD_GONE_TEXT)", lm[3].text === viewMarker[0].text && Buffer.from(lm[3].text ?? "").equals(Buffer.from(RECORD_GONE_TEXT)));
  const none = project(new Set());
  check("pre-P4b answers (no recorded areas) are unaffected even when NO area passes the probe now",
    JSON.stringify(none.conversations[0].messages[7]) === JSON.stringify(both.conversations[0].messages[7]) && none.conversations[0].messages[7].text === renderAnswerText(ANSWER));
  check("the pre-existing projection (no recorded areas anywhere) is byte-identical whatever the probe says",
    JSON.stringify(projectPlatformAiConversationsForExport({ conversations: [held], omitted: [] }, directoryHeld, new Set()))
      === JSON.stringify(projectPlatformAiConversationsForExport({ conversations: [held], omitted: [] }, directoryHeld, directoryHeld)));

  // Single-area operator: the Ops-only conversation with P4 area refs equals its export without them.
  const single = conv("cvsingle", OPS, [msg({ id: "u1", role: "USER", content: "Ops?" }), msg({ id: "a1", role: "ASSISTANT", replyToId: "u1", content: ANSWER, evidenceRefs: opsRefs })]);
  const singleLegacy = conv("cvsingle", OPS, [msg({ id: "u1", role: "USER", content: "Ops?" }), msg({ id: "a1", role: "ASSISTANT", replyToId: "u1", content: ANSWER, evidenceRefs: [] })]);
  check("single-area operator (Ops held, probe passes) ⇒ the export is unchanged (byte-equal to the pre-rule export)",
    JSON.stringify(project(new Set([OPS]), single)) === JSON.stringify(project(new Set(), singleLegacy)));

  // The FRESH per-area probe (multi-area.ts freshlyHeldAreas — the view's own acceptance rule).
  const scopeOf = (area: PlatformArea, operatorId = OP) => ({ area, operatorId }) as unknown as ScopedArea;
  const accessOf = (area: PlatformArea, operatorId = OP) => ({ resolvePage: () => null, binding: {} as never, area, scope: scopeOf(area, operatorId) }) as AreaAccess;
  const probed: PlatformArea[] = [];
  const csRefused = await freshlyHeldAreas([OPS, CS], OP, async (a) => { probed.push(a); return a === CS ? null : accessOf(a); });
  check("an area the directory lists but whose fresh probe REFUSES now ⇒ not held ⇒ its answers hidden in the export",
    [...csRefused].join() === OPS && probed.join() === `${OPS},${CS}` && project(csRefused).conversations[0].messages[3].text === RECORD_GONE_TEXT);
  const thrown = await freshlyHeldAreas([OPS, CS], OP, async (a) => { if (a === CS) throw new Error("guard down"); return accessOf(a); });
  check("a probe that THROWS ⇒ that area not held (fail closed)", [...thrown].join() === OPS);
  const wrong = await freshlyHeldAreas([OPS, CS], OP, async (a) => (a === CS ? accessOf(CS, "cother0000000000000000001") : a === OPS ? accessOf(CS) : null));
  check("a probe result for another operator / another area ⇒ not held", wrong.size === 0);
  check("the export's own area is probed too (no conversation gate in an export): Ops refused ⇒ Ops answers hidden, pre-P4b kept",
    (() => { const m = project(new Set([CS])).conversations[0].messages; return m[1].text === RECORD_GONE_TEXT && m[7].text === renderAnswerText(ANSWER); })());
}

console.log("\n2. pins: where the export reads, decrypts and decides");
{
  const store = code(read("lib/platform/intelligence/ai/conversations/store.ts"));
  const at = store.indexOf("export async function readConversationsForExport");
  const fn = store.slice(at, store.indexOf("async function", at + 30));
  check("LIVE = not soft-deleted AND at least one VISIBLE (unexpired, migration 20261105120000) message",
    /const LIVE = \{ deletedAt: null, messages: \{ some: \{\} \} \} as const;/.test(store));
  check("the export read is in the ONE data module, through withTenantDb, owner-scoped AND live-only (soft-deleted and all-expired EXCLUDED)",
    /withTenantDb\(operatorId, async \(tx\) => \{\s*const metas = await tx\.platformAiConversation\.findMany\(\{\s*where: \{ operatorUserId: operatorId, \.\.\.LIVE \},[\s\S]*?select: CONVERSATION_SELECT,/.test(fn), fn.slice(0, 400));
  check("S2 STRICT: messages are selected ONLY for HELD conversations (lost areas are never read past metadata)",
    /const held = metas\.filter\(\(c\) => heldAreas\.has\(c\.area\)\);/.test(fn) && /tx\.platformAiMessage\.findMany\(\{\s*where: \{ conversationId: \{ in: held\.map\(\(c\) => c\.id\) \}/.test(fn)
      && (fn.match(/platformAiMessage\./g) ?? []).length === 1 && !/messages: \{/.test(fn));
  check("…it writes nothing (no abandon, no update) and decrypts AFTER the transaction (toMessageRecord outside withTenantDb)",
    !/updateMany|update\(|create\(|abandonStale|\$executeRaw/.test(fn) && fn.indexOf("toMessageRecord") > fn.indexOf("return { metas, held, messages };"));
  const exp = code(read("lib/platform/intelligence/ai/conversations/export.ts"));
  check("the projection is pure (no db, env, key, clock or I/O)", !/@\/lib\/db|@\/lib\/env|encryption|new Date\(\)|Date\.now|console\./.test(exp));
  const asm = code(read("lib/export/assemble.ts"));
  check("assemble.ts reads the conversations ONLY through the data module's export reader (never a model or systemDb)",
    /readConversationsForExport\(userId, heldAreas\)/.test(asm) && !/\.platformAiConversation\.|\.platformAiMessage\.|PLATFORM_AI_MESSAGE|systemDb/.test(asm));
  check("the held CONVERSATION areas = ONE directory read of the SUBJECT (no per-area non-probe guard ⇒ no false OBS-009 rows)",
    /const directory = totpRefused \? \[\] : await loadPlatformDirectory\(userId\);\s*const heldAreas = totpRefused \? new Set<never>\(\) : grantedAreasFrom\(directory\);/.test(asm)
      && !/requireFreshPlatformAccess|requirePlatformAccess|conversationAreaAccess|conversationHeldAccess/.test(asm));
  check("operator 2FA enforced and missing ⇒ NO held area (the guard's own SEC-PLAT-1 decision)",
    /const totpRefused = decideOperatorTotpRefusal\(\{ role: user\.role, totpEnabled: user\.totpEnabled, enforced: env\.isOperatorTotpEnforced \}\);\s*const directory = totpRefused \? \[\] : await loadPlatformDirectory\(userId\);\s*const heldAreas = totpRefused \? new Set<never>\(\) :/.test(asm));
  check("the section reaches data.json and the manifest counts — with a count PER LOST AREA",
    /platformAiConversations: platformAi\.conversations/.test(asm) && /platformAiConversationsOmitted: platformAi\.omitted/.test(asm)
      && /platformAiConversations: data\.platformAiConversations\.length/.test(asm) && /`platformAiConversationsOmitted:\$\{o\.area\}`, o\.count/.test(asm));
  const route = code(read("app/api/user/export/route.ts"));
  check("the ONE caller is the subject's own fresh-session export (requireFreshUser → assembleUserExport(user.id))",
    /const \[user, err\] = await requireFreshUser\(\);/.test(route) && /assembleUserExport\(user\.id, \{ answerHeldAreas: \(rows\) => conversationFreshHeldAreas\(rows, user\.id\) \}\)/.test(route));

  // S2 09ed — the export's held areas for the lost-area rule = the view's SAME fresh per-area probe.
  const access = code(read("app/api/platform/ai/conversations/area-access.ts"));
  const fresh = access.slice(access.indexOf("export function conversationFreshHeldAreas"));
  check("S2 09ed: conversationFreshHeldAreas probes each directory area through heldAreaAccess (the view's widening probe), via multi-area freshlyHeldAreas",
    /return freshlyHeldAreas\(platformAiAreasFor\(rows\), operatorId, \(a\) => heldAreaAccess\(a, operatorId\)\);/.test(fresh)
      && /requireFreshPlatformAccess\(area, "READ", \{ probe: true \}\)/.test(access.slice(access.indexOf("async function heldAreaAccess"), access.indexOf("export function conversationHeldAccess"))));
  const ma = code(read("lib/platform/intelligence/ai/conversations/multi-area.ts"));
  check("…the view's widening and the export's probe share ONE acceptance rule (freshAreaPart), not a copy",
    (ma.match(/acc\.scope\.operatorId !== operatorId/g) ?? []).length === 1
      && /const part = await freshAreaPart\(a, own\.scope\.operatorId, accessFor\);/.test(ma) && /await freshAreaPart\(a, operatorId, accessFor\)/.test(ma.slice(ma.indexOf("export async function freshlyHeldAreas"))));
  check("…assemble.ts: probed only when a held conversation was read, never wider than the directory, not wired / throwing ⇒ NO area (fail closed)",
    /const probed = conversationsRead\.conversations\.length === 0 \|\| !opts\.answerHeldAreas\s*\? new Set<PlatformArea>\(\)\s*: await opts\.answerHeldAreas\(directory\)\.catch\(\(\) => new Set<PlatformArea>\(\)\);/.test(asm)
      && /const answerHeldAreas = new Set\(\[\.\.\.probed\]\.filter\(\(a\) => heldAreas\.has\(a\)\)\);/.test(asm)
      && /projectPlatformAiConversationsForExport\(conversationsRead, heldAreas, answerHeldAreas\)/.test(asm));
  check("…the projection applies the view's rule (answerReadable) and the view's marker (RECORD_GONE_TEXT); the area set is a REQUIRED argument",
    /if \(answer && !answerReadable\(m\.evidenceRefs, answer, answerHeldAreas\)\) return \{ \.\.\.base, text: RECORD_GONE_TEXT, citations: \[\], notes: \[\] \};/.test(exp)
      && /heldAreas: ReadonlySet<PlatformArea>,\s*answerHeldAreas: ReadonlySet<PlatformArea>,\s*\): PlatformAiExportSection/.test(exp));
}

lostAreaRule().then(() => {
  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}).catch((e) => { console.error(e); process.exit(1); });
