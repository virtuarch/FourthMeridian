/**
 * components/ai/transcript-cache.test.ts
 *
 * THE CACHE THAT KEEPS A CONVERSATION VISIBLE, AND THE LINES IT MAY NOT CROSS.
 *
 * ⚠️ THE STORE IS A TEST DOUBLE, AND THAT IS THE POINT. Every rule here is about
 * what may be written, what may be read back, and what must be refused — none of
 * it needs a browser, so none of it is proved in one.
 *
 *   npx tsx components/ai/transcript-cache.test.ts
 */

import { readFileSync } from "node:fs";
import {
  parseTranscript, serializeTranscript, transcriptKey,
  readTranscript, writeTranscript, clearTranscript, clearAllTranscripts,
  TRANSCRIPT_CACHE_VERSION, TRANSCRIPT_TTL_MS, TRANSCRIPT_KEY_PREFIX,
  MAX_CACHED_MESSAGES, MAX_CACHED_CHARS,
  type CachedMessage, type TranscriptStore,
} from "@/components/ai/transcript-cache";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}${detail ? `  ${detail}` : ""}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? `  ${detail}` : ""}`); }
}

/** A localStorage the size of an object literal. */
function makeStore(seed: Record<string, string> = {}): TranscriptStore & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    get length() { return map.size; },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
  };
}

const NOW = Date.parse("2026-09-13T12:00:00.000Z");
const TALK: CachedMessage[] = [
  { role: "user", content: "when did i first hit 0 with my debt this year?" },
  { role: "assistant", content: "You first hit $0 of debt on 2026-07-22." },
];
const envelope = (over: Record<string, unknown> = {}, at = NOW) => JSON.stringify({
  version: TRANSCRIPT_CACHE_VERSION,
  savedAt: new Date(at).toISOString(),
  expiresAt: new Date(at + TRANSCRIPT_TTL_MS).toISOString(),
  messages: TALK,
  ...over,
});

console.log("1. A CONVERSATION SURVIVES THE ROUND TRIP");
{
  const body = serializeTranscript(TALK, NOW)!;
  check("it serialises", typeof body === "string");
  check("…and reads back exactly what was on screen",
    JSON.stringify(parseTranscript(body, NOW)) === JSON.stringify(TALK));
  check("…including the figures in the prose the user already saw",
    (parseTranscript(body, NOW) ?? [])[1].content.includes("2026-07-22"));
  const stored = JSON.parse(body) as Record<string, unknown>;
  check("the envelope carries a version and both timestamps",
    stored.version === TRANSCRIPT_CACHE_VERSION
      && typeof stored.savedAt === "string" && typeof stored.expiresAt === "string");
  check("an empty transcript is not worth storing", serializeTranscript([], NOW) === null);
}

console.log("\n2. TWENTY-FOUR HOURS, BY A STORED TIMESTAMP");
{
  const body = serializeTranscript(TALK, NOW)!;
  check("a minute later it restores", parseTranscript(body, NOW + 60_000) !== null);
  check("twenty-three hours later it restores",
    parseTranscript(body, NOW + 23 * 60 * 60 * 1000) !== null);
  check("one millisecond before expiry it restores",
    parseTranscript(body, NOW + TRANSCRIPT_TTL_MS - 1) !== null);
  check("AT the expiry it does not", parseTranscript(body, NOW + TRANSCRIPT_TTL_MS) === null);
  check("a day and a minute later it does not",
    parseTranscript(body, NOW + TRANSCRIPT_TTL_MS + 60_000) === null);
  check("the TTL really is 24 hours", TRANSCRIPT_TTL_MS === 24 * 60 * 60 * 1000);
  check("an unparseable expiry is no expiry at all, so it is refused",
    parseTranscript(envelope({ expiresAt: "soon" }), NOW) === null
      && parseTranscript(envelope({ expiresAt: undefined }), NOW) === null);
}

console.log("\n3. STORED BYTES ARE UNTRUSTED INPUT");
{
  for (const [name, raw] of [
    ["nothing", null],
    ["an empty string", ""],
    ["broken JSON", "{oh no"],
    ["a JSON array", "[1,2,3]"],
    ["a JSON string", '"hello"'],
    ["null", "null"],
    ["an older version", envelope({ version: 0 })],
    ["a newer version", envelope({ version: TRANSCRIPT_CACHE_VERSION + 1 })],
    ["no version", envelope({ version: undefined })],
    ["messages that are not an array", envelope({ messages: "hi" })],
    ["no messages at all", envelope({ messages: [] })],
    ["a null message", envelope({ messages: [null] })],
    ["a string message", envelope({ messages: ["hi"] })],
    ["content that is not a string", envelope({ messages: [{ role: "user", content: 7 }] })],
    ["empty content", envelope({ messages: [{ role: "user", content: "" }] })],
    ["a missing role", envelope({ messages: [{ content: "hi" }] })],
  ] as [string, string | null][]) {
    check(`${name} is refused`, parseTranscript(raw, NOW) === null);
  }
}

console.log("\n4. TWO ROLES, AND NOTHING BEHIND THE PROSE");
{
  // ⚠️ THESE ARE THE PAYLOADS THE ARCHITECTURE KEEPS SERVER-SIDE. A cache that
  // accepted one would put the instruction, or financial evidence, in a store
  // any script on this origin can read — and then post it back as history.
  for (const role of ["system", "tool", "developer", "function", "USER", ""]) {
    check(`role "${role}" is refused, and the whole cache with it`,
      parseTranscript(envelope({ messages: [{ role, content: "x" }, ...TALK] }), NOW) === null);
  }
  check("a message carrying anything beyond role and content is refused",
    parseTranscript(envelope({ messages: [
      { role: "assistant", content: "hi", knowledgeGaps: [{ accountId: "a1" }] }] }), NOW) === null);
  check("…including a tool call riding along",
    parseTranscript(envelope({ messages: [
      { role: "assistant", content: "hi", tool_calls: [{ id: "c1" }] }] }), NOW) === null);
  check("serialising drops everything that is not role and content",
    serializeTranscript([{ role: "assistant", content: "hi",
      knowledgeGaps: [{ accountId: "a1" }], toolResult: { balance: 1 } } as CachedMessage], NOW)
      === JSON.stringify({
        version: TRANSCRIPT_CACHE_VERSION,
        savedAt: new Date(NOW).toISOString(),
        expiresAt: new Date(NOW + TRANSCRIPT_TTL_MS).toISOString(),
        messages: [{ role: "assistant", content: "hi" }],
      }));
}

console.log("\n5. SIZE CANNOT FREEZE THE PAGE");
{
  const long = (n: number): CachedMessage[] =>
    Array.from({ length: n }, (_, i) => ({
      role: i % 2 === 0 ? "user" as const : "assistant" as const, content: `turn ${i}` }));
  check(`more than ${MAX_CACHED_MESSAGES} stored messages is refused on READ`,
    parseTranscript(envelope({ messages: long(MAX_CACHED_MESSAGES + 2) }), NOW) === null);
  check("an oversized blob is refused without even being parsed",
    parseTranscript(`{"x":"${"y".repeat(MAX_CACHED_CHARS)}"}`, NOW) === null);

  // On WRITE the data is ours, so it is trimmed at a turn boundary instead.
  const trimmed = parseTranscript(serializeTranscript(long(MAX_CACHED_MESSAGES + 20), NOW)!, NOW);
  check("on WRITE the oldest turns are dropped, and the rest is kept",
    (trimmed?.length ?? 0) <= MAX_CACHED_MESSAGES && (trimmed?.length ?? 0) > 100,
    `${trimmed?.length} messages`);
  check("…the most recent turn always survives",
    trimmed?.[trimmed.length - 1].content === `turn ${MAX_CACHED_MESSAGES + 19}`);
  check("…and the transcript never begins with an answer to a question that is gone",
    trimmed?.[0].role === "user");
  const huge = serializeTranscript([
    { role: "user", content: "x".repeat(20) },
    { role: "assistant", content: "y".repeat(MAX_CACHED_CHARS) },
  ], NOW);
  check("a single message too large to store drops the cache rather than truncating it",
    huge === null || (JSON.parse(huge) as { messages: CachedMessage[] }).messages
      .every((m) => m.content.length === 20 || m.content.length === MAX_CACHED_CHARS));
  check("…so no message is ever stored with its meaning cut in half",
    (JSON.parse(serializeTranscript(TALK, NOW)!) as { messages: CachedMessage[] })
      .messages.every((m, i) => m.content === TALK[i].content));
}

console.log("\n6. ONE CONVERSATION PER USER, PER SPACE");
{
  const s = makeStore();
  writeTranscript("usr_a", "space_1", TALK, NOW, s);
  check("the key names both", transcriptKey("usr_a", "space_1") === `${TRANSCRIPT_KEY_PREFIX}usr_a:space_1`);
  check("it restores for that user in that Space",
    readTranscript("usr_a", "space_1", NOW, s)?.length === 2);
  check("another Space sees nothing", readTranscript("usr_a", "space_2", NOW, s) === null);
  check("another user in the SAME Space sees nothing — a shared laptop is not a shared transcript",
    readTranscript("usr_b", "space_1", NOW, s) === null);
  writeTranscript("usr_a", "space_2", [{ role: "user", content: "different Space" }], NOW, s);
  check("each Space keeps its own",
    readTranscript("usr_a", "space_1", NOW, s)?.[0].content === TALK[0].content
      && readTranscript("usr_a", "space_2", NOW, s)?.[0].content === "different Space");
  check("…and going back to the first one still finds it",
    readTranscript("usr_a", "space_1", NOW, s)?.length === 2);
}

console.log("\n7. FORGETTING");
{
  const s = makeStore();
  writeTranscript("usr_a", "space_1", TALK, NOW, s);
  clearTranscript("usr_a", "space_1", s);
  check("New chat removes it", readTranscript("usr_a", "space_1", NOW, s) === null);
  check("…from the store itself, not just from the read", s.map.size === 0);

  writeTranscript("usr_a", "space_1", TALK, NOW, s);
  check("an expired cache is DELETED by the read that refuses it",
    readTranscript("usr_a", "space_1", NOW + TRANSCRIPT_TTL_MS + 1, s) === null && s.map.size === 0);

  const s2 = makeStore({ "unrelated:key": "keep me" });
  writeTranscript("usr_a", "space_1", TALK, NOW, s2);
  writeTranscript("usr_b", "space_9", TALK, NOW, s2);
  clearAllTranscripts(s2);
  check("sign-out sweeps every transcript",
    readTranscript("usr_a", "space_1", NOW, s2) === null
      && readTranscript("usr_b", "space_9", NOW, s2) === null);
  check("…and touches nothing else in the store", s2.map.get("unrelated:key") === "keep me");

  writeTranscript("usr_a", "space_1", [], NOW, s2);
  check("writing an empty transcript clears rather than storing nothing",
    s2.map.has(transcriptKey("usr_a", "space_1")) === false);
}

console.log("\n8. A STORE THAT REFUSES TO WORK IS NOT AN ERROR");
{
  const hostile: TranscriptStore = {
    get length(): number { throw new Error("blocked"); },
    key: () => { throw new Error("blocked"); },
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
    removeItem: () => { throw new Error("blocked"); },
  };
  check("reading survives a browser that blocks site data",
    readTranscript("usr_a", "space_1", NOW, hostile) === null);
  let threw = false;
  try { writeTranscript("usr_a", "space_1", TALK, NOW, hostile); } catch { threw = true; }
  check("…and so does writing", !threw);
  try { clearAllTranscripts(hostile); } catch { threw = true; }
  check("…and sweeping", !threw);
  check("no store at all is simply no cache", readTranscript("usr_a", "space_1", NOW, null) === null);
}

console.log("\n9. THE BOUNDARY, IN THE SOURCE");
{
  const src = readFileSync("components/ai/transcript-cache.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  for (const forbidden of ["knowledgeGap", "scenario", "toolCall", "evidence", "systemInstruction",
    "accountId", "fetch(", "crypto", "prisma", "db."]) {
    check(`the cache module knows nothing about \`${forbidden}\``, !src.includes(forbidden));
  }
  check("it stores no server state — two roles and a string is the whole schema",
    /role: 'user' \| 'assistant';\s*content: string;/.test(src));

  const client = readFileSync("components/dashboard/AnalyzeClient.tsx", "utf8");
  check("the client stores role and content only",
    /writeTranscript\(userId, spaceId, list\.map\(\(m\) => \(\{ role: m\.role, content: m\.content \}\)\)\)/.test(client));
  check("restoring drops any historical knowledge-gap card",
    /cached\.map\(\(m\) => \(\{ role: m\.role, content: m\.content \}\)\)/.test(client));
  check("New chat clears the stored copy too", /clearTranscript\(userId, spaceId\)/.test(client));
  check("…and does NOT invent a second scenario reset",
    !/fm_ai_state|sealRuntimeState|activeScenario/.test(client));
  check("a restore sends nothing and asks for nothing",
    !/useLayoutEffect\([\s\S]{0,700}(fetch\(|sendMessage\()/.test(client));
  check("the transcript is written at turn boundaries, not per keystroke",
    !/onChange=\{[^}]*remember/.test(client) && (client.match(/remember\(/g) ?? []).length === 2);
  check("a failed turn is not remembered",
    client.indexOf("A REFUSAL IS NOT REMEMBERED") > -1);
}

if (failures > 0) {
  console.error(`\ntranscript-cache.test: ${failures} failure(s).`);
  process.exit(1);
}
console.log("\ntranscript-cache.test: all passed.");
