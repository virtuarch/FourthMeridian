/**
 * lib/platform/intelligence/ai/authz/subject-wiring.test.ts  (Platform AI P5 — subject resolution wiring, I-4 / D-4 / §6.3)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/ai/authz/subject-wiring.test.ts
 *
 * 1. conversations (handlers.ts scrubWithSubjects): OFF ⇒ byte-identical to the one scrub; ON ⇒ the
 *    STORED text has `[customer]` per identifier (no identifier, no handle), the slots go to the runner;
 * 2. the ask path (core.ts handlePlatformAiAsk): with a resolver the MODEL sees `[customer h_…]` /
 *    `[customer not resolved]` and never the identifier, resolution runs before any model call, the one
 *    note is added for a non-match; without a resolver the question is exactly as before (scrubbed);
 * 3. production wiring pins: the ask route resolves ONLY with the customers flag ON, through THIS turn's
 *    boundary, with the fail-closed audit writers; the conversation routes pass the strict flag; the turn
 *    runner fills the slots for the model only (the stored question keeps `[customer]`).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { scrubOperatorText } from "@/lib/ai/privacy/scrub";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 600)}` : ""}`); }
}

const EMAIL = "orrin.vexmoor@e0-sentinel.invalid";
const CUID = "ce0sentinelcustomer0000b2";
const HANDLE = "h_ZyXwVuTsRqPoNmLk";

async function main() {
  const { scrubWithSubjects } = await import("../conversations/handlers");
  const { SUBJECT_STORED_TEXT, SUBJECT_UNRESOLVED_NOTE, SUBJECT_UNRESOLVED_TEXT, fillSubjectSlots } = await import("./subject");
  const { handlePlatformAiAsk } = await import("../core");

  console.log("1. conversations — one scrub, stored vs model text");
  {
    const q = `Why is ${EMAIL} stuck since card 4111 1111 1111 1111? Same as ${CUID}?`;
    check("OFF ⇒ byte-identical to scrubOperatorText (Production unchanged)", scrubWithSubjects(q, false).stored === scrubOperatorText(q, 500) && scrubWithSubjects(q, false).subjects === undefined);
    check("ON, no identifier ⇒ byte-identical too", scrubWithSubjects("How are we looking?", true).stored === scrubOperatorText("How are we looking?", 500));
    const on = scrubWithSubjects(q, true);
    check("ON ⇒ stored text has [customer] per identifier, the rest scrubbed ([number]); no identifier, no slot char",
      on.stored === `Why is ${SUBJECT_STORED_TEXT} stuck since card [number]? Same as ${SUBJECT_STORED_TEXT}?` && !/[]/.test(on.stored), on.stored);
    check("…and the runner gets the slots + the identifiers (in memory only)", on.subjects?.ids.length === 2 && on.subjects.slotted.includes(""));
    const model = fillSubjectSlots(on.subjects!.slotted, [`[customer ${HANDLE}]`, SUBJECT_UNRESOLVED_TEXT]);
    check("the model text fills the slots; the stored text never holds the handle", model.includes(HANDLE) && !on.stored.includes(HANDLE) && !model.includes(EMAIL) && !model.includes(CUID));
  }

  console.log("\n2. the ask path");
  {
    const binding = { surfaceLabel: "Customer Success", listMetrics: () => [], describeMetric: () => null, readMetric: async () => null, listPages: () => [], resolvePage: () => null };
    const run = async (subjects: Parameters<typeof handlePlatformAiAsk>[1]["subjects"], question: string) => {
      const seen: string[] = [];
      let resolvedBeforeModel: boolean | null = null;
      let resolved = false;
      const wrapped = subjects ? { resolve: async (ids: Parameters<NonNullable<typeof subjects>["resolve"]>[0]) => { resolved = true; return subjects.resolve(ids); } } : undefined;
      const res = await handlePlatformAiAsk({ question }, {
        enabled: true, operatorId: "cop00000000000000000000cs1", binding: binding as never,
        admission: async () => ({ paused: false, state: "RUNNING" }), freeze: async () => ({ frozen: false, state: "OFF" }), turns: async () => ({ allowed: true, remaining: 5 }),
        generate: async ({ messages }) => {
          if (resolvedBeforeModel === null) resolvedBeforeModel = resolved;
          seen.push(JSON.stringify(messages));
          return { content: "I checked the customer.", toolCalls: [], raw: { role: "assistant", content: "I checked the customer." }, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, reasoningTokens: 0 } };
        },
        model: "test", now: () => new Date("2026-11-10T12:00:00Z"), classify: () => "PROVIDER",
        ...(wrapped ? { subjects: wrapped } : {}),
      });
      return { res, sent: seen.join("\n"), resolvedBeforeModel };
    };
    const matched = await run({ resolve: async () => ({ fills: [`[customer ${HANDLE}]`], outcomes: ["MATCHED"], note: null }) }, `Is ${EMAIL} ok?`);
    check("matched: the model sees [customer h_…], never the email; resolution ran BEFORE the model call; no note",
      matched.sent.includes(`[customer ${HANDLE}]`) && !matched.sent.includes(EMAIL) && matched.resolvedBeforeModel === true
      && !JSON.stringify(matched.res.body.notes).includes(SUBJECT_UNRESOLVED_NOTE), matched.sent.slice(-400));
    const unresolved = await run({ resolve: async () => ({ fills: [SUBJECT_UNRESOLVED_TEXT], outcomes: ["NO_ACCESS"], note: SUBJECT_UNRESOLVED_NOTE }) }, `Is ${EMAIL} ok?`);
    check("not resolved: the model sees the one literal; the response carries the one note; same 200",
      unresolved.sent.includes(SUBJECT_UNRESOLVED_TEXT) && !unresolved.sent.includes(EMAIL) && unresolved.res.status === 200
      && (unresolved.res.body.notes as string[]).includes(SUBJECT_UNRESOLVED_NOTE));
    const none = await run(undefined, `Is ${EMAIL} ok?`);
    check("no resolver (flag OFF) ⇒ exactly as before: the scrub replaces the email with [email]", none.sent.includes("Is [email] ok?") && !none.sent.includes("[customer"));
    const noId = await run({ resolve: async () => { throw new Error("must not be called"); } }, "How are we looking?");
    check("a question with no identifier never calls the resolver", noId.res.status === 200);
  }

  console.log("\n3. production wiring pins");
  {
    const src = (f: string) => readFileSync(path.join(process.cwd(), f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const ask = src("app/api/platform/ai/ask/route.ts");
    check("ask route: subjects only when isSubjectResolutionEnabled(), through THIS turn's boundary (platformAiSubjectDeps)",
      /const subjects = boundary && isSubjectResolutionEnabled\(\)/.test(ask) && /resolveSubjects\(ids, platformAiSubjectDeps\(\{ operatorId: auth\.user\.id, primaryArea: area, boundary \}\)\)/.test(ask));
    check("ask route: the boundary gets the fail-closed tool audit; the renderer the fail-closed render audit",
      /audit: platformAiToolAudit\(\),/.test(ask) && /audit: platformAiRenderAudit\(\)/.test(ask));
    for (const r of ["app/api/platform/ai/conversations/route.ts", "app/api/platform/ai/conversations/[id]/messages/route.ts"]) {
      check(`${r}: subjectsEnabled = the strict customers flag`, /subjectsEnabled: isSubjectResolutionEnabled,/.test(src(r)));
    }
    const tr = src("app/api/platform/ai/conversations/turn-runner.ts");
    check("turn runner: the boundary audit writer; subjects resolved through THIS boundary; the MODEL question is the filled slots",
      /audit: platformAiToolAudit\(\),/.test(tr) && /resolveSubjects\(subjects\.ids, platformAiSubjectDeps\(\{ operatorId, primaryArea: access\.area, boundary \}\)\)/.test(tr)
      && /modelQuestion = fillSubjectSlots\(subjects\.slotted, r\.fills\)/.test(tr) && /question: modelQuestion/.test(tr));
    const h = src("lib/platform/intelligence/ai/conversations/handlers.ts");
    check("handlers: the STORED question is scrubWithSubjects(…).stored (never a filled slot)",
      (h.match(/const \{ stored: scrubbedQuestion, subjects \} = scrubWithSubjects\(parsed\.question, subjectsOn\(deps\)\);/g) ?? []).length === 2 && !/fillSubjectSlots/.test(h));
  }

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
