/**
 * lib/platform/intelligence/ai/conversations/export.test.ts  (B11 PR D — the subject-access export, S2 Q5)
 *
 * The pure projection (held area ⇒ everything; lost area ⇒ questions plus
 * timestamps, answers omitted and noted), and the pins on where the export
 * reads, decrypts and decides (lib/export/assemble.ts + the data module). The
 * real read is proven on real PostgreSQL roles in
 * scripts/platform-ai-conversations-acceptance.ts ([export]).
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/ai/conversations/export.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { PlatformArea } from "@prisma/client";
import { answersOmittedNote, projectPlatformAiConversationsForExport, renderAnswerText } from "./export";
import type { StoredAnswerV1 } from "./answer";
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

console.log("1. the projection (S2 Q5)");
{
  const out = projectPlatformAiConversationsForExport([held, lost, unreadable], new Set<PlatformArea>(["PLATFORM_OPS"]));
  const [h, l, u] = out.conversations;
  check("a HELD area exports every message, in order, with the answer as rendered text",
    h.answersIncluded && h.answersOmitted === null && h.messages.length === 6 && h.messages[1].text === "There are 3 open incidents — see the incident list.", h.messages[1]);
  check("…with its citations and code-written notes", JSON.stringify(h.messages[1].citations) === JSON.stringify(ANSWER.citations) && h.messages[1].notes?.[0] === ANSWER.notes[0]);
  check("links are exported as TEXT only (no href, no page id, no params)", !JSON.stringify(h).includes("PLATFORM_OPS:platform-incidents") && !JSON.stringify(h).includes("href") && !JSON.stringify(h).includes("\"status\":\"open\""));
  check("evidence refs and message ids are not exported", !JSON.stringify(out).includes("evidenceRefs") && !/"(u1|a1|u9|a9)"/.test(JSON.stringify(out)));
  check("a FAILED reply exports its code and no text; a PENDING one exports no text",
    h.messages[3].status === "FAILED" && h.messages[3].failureCode === "TIMEOUT" && h.messages[3].text === null && h.messages[5].status === "PENDING" && h.messages[5].text === null);
  check("timestamps are ISO strings", h.createdAt === T(0).toISOString() && h.lastActivityAt === T(5).toISOString() && h.messages[3].completedAt === T(4).toISOString());
  check("a LOST area exports QUESTIONS plus timestamps only — every ASSISTANT message omitted",
    !l.answersIncluded && l.messages.length === 1 && l.messages[0].role === "USER" && l.messages[0].text === "Any failed logins spike?" && l.messages[0].createdAt === T(0).toISOString());
  check("…the answer text never appears anywhere in the bundle", !JSON.stringify(out).includes("SECRET-SECURITY-ANSWER"));
  check("…and the omission is noted with the area's label (S2 Q5 wording)", l.answersOmitted === answersOmittedNote("SECURITY_OPS") && /^Answers omitted: you no longer have access to .+\.$/.test(l.answersOmitted ?? "") && !l.answersOmitted!.includes("SECURITY_OPS"));
  check("answersOmittedCount counts the lost conversations", out.answersOmittedCount === 1);
  check("an unreadable stored value is exported as unavailable, never as text", u.messages.every((m) => m.unavailable && m.text === null));
  const none = projectPlatformAiConversationsForExport([held], new Set());
  check("NO held area (e.g. operator 2FA refused) ⇒ every conversation is questions-only", none.conversations[0].messages.every((m) => m.role === "USER") && none.answersOmittedCount === 1);
  check("renderAnswerText concatenates every span's text", renderAnswerText(ANSWER) === "There are 3 open incidents — see the incident list.");
  check("no conversation ⇒ an empty section", projectPlatformAiConversationsForExport([], new Set()).conversations.length === 0);
}

console.log("2. pins: where the export reads, decrypts and decides");
{
  const store = code(read("lib/platform/intelligence/ai/conversations/store.ts"));
  const at = store.indexOf("export async function readConversationsForExport");
  const fn = store.slice(at, store.indexOf("async function", at + 30));
  check("the export read is in the ONE data module, through withTenantDb, owner-scoped AND live-only (soft-deleted EXCLUDED)",
    /withTenantDb\(operatorId, \(tx\) => tx\.platformAiConversation\.findMany\(\{\s*where: \{ operatorUserId: operatorId, deletedAt: null \}/.test(fn), fn.slice(0, 300));
  check("…it writes nothing (no abandon, no update) and decrypts AFTER the transaction (toMessageRecord outside withTenantDb)",
    !/updateMany|update\(|create\(|abandonStale|\$executeRaw/.test(fn) && fn.indexOf("toMessageRecord") > fn.indexOf("}));"));
  const exp = code(read("lib/platform/intelligence/ai/conversations/export.ts"));
  check("the projection is pure (no db, env, key, clock or I/O)", !/@\/lib\/db|@\/lib\/env|encryption|new Date\(\)|Date\.now|console\./.test(exp));
  const asm = code(read("lib/export/assemble.ts"));
  check("assemble.ts reads the conversations ONLY through the data module's export reader (never a model or systemDb)",
    /readConversationsForExport\(userId\)/.test(asm) && !/\.platformAiConversation\.|\.platformAiMessage\.|PLATFORM_AI_MESSAGE|systemDb/.test(asm));
  check("the held areas = ONE directory read of the SUBJECT (no per-area fresh guard ⇒ no false OBS-009 rows)",
    /grantedAreasFrom\(await loadPlatformDirectory\(userId\)\)/.test(asm) && !/requireFreshPlatformAccess|requirePlatformAccess|conversationAreaAccess/.test(asm));
  check("operator 2FA enforced and missing ⇒ NO held area (the guard's own SEC-PLAT-1 decision)",
    /const totpRefused = decideOperatorTotpRefusal\(\{ role: user\.role, totpEnabled: user\.totpEnabled, enforced: env\.isOperatorTotpEnforced \}\);\s*const heldAreas = totpRefused \? new Set<never>\(\) :/.test(asm));
  check("the section reaches data.json and the manifest counts", /platformAiConversations: platformAi\.conversations/.test(asm) && /platformAiConversations: data\.platformAiConversations\.length/.test(asm));
  const route = code(read("app/api/user/export/route.ts"));
  check("the ONE caller is the subject's own fresh-session export (requireFreshUser → assembleUserExport(user.id))",
    /const \[user, err\] = await requireFreshUser\(\);/.test(route) && /assembleUserExport\(user\.id\)/.test(route));
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
