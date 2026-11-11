/**
 * lib/platform/intelligence/ai/authz/people.test.ts  (Platform AI — the @ people picker + bare-username guard)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/ai/authz/people.test.ts
 *
 * Owner request 2026-11-10; S2 09fc. No real names: every identity is an E0 sentinel.
 * 1. picker query + strict prefix rule (P1): username / email LOCAL-PART prefix only; no `@`, wildcard, domain or mid-string;
 * 2. searchPeople (P4 / P5): the shared limiter counts; LIMITED / UNAVAILABLE / aborted / audit failure / none ⇒ the ONE
 *    uniform empty response; every outcome takes exactly SUBJECT_FLOOR_MS (fake clock); the audit row = counts + keyed
 *    fingerprint only; ≤ 8 matches;
 * 3. chips (P3 / P6): the serialised draft never carries the label; a chip is an OPAQUE_REF identifier (the slot path);
 *    a forged / unknown chip ⇒ the uniform not-resolved literal + note; stored text `[customer]`;
 * 4. the guard (G1–G6): bare username ⇒ refused, one limiter count, a code-only audit row; miss ⇒ pass, no count;
 *    limiter exhausted ⇒ refused without a lookup; failed lookup ⇒ refused; P5 email ⇒ not refused; no P5 authority ⇒
 *    no lookup at all, email refused; product vocabulary exempt ("connections" as a customer username);
 * 5. the ask handler: a guard refusal ⇒ 422 with ZERO provider calls and no spend; a pass ⇒ the turn; the E0 leak
 *    sentinel never appears in any provider payload;
 * 6. the conversation handlers: a guard refusal stores nothing and runs no turn;
 * 7. the keyed fingerprint + static pins (route gates, POST body, no logging).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { EMAIL_REMINDER_BODY, GUARD_UNAVAILABLE_BODY, USE_PEOPLE_PICKER_BODY, handlePlatformAiAsk, type PlatformAiAskDeps, type PlatformAiGenerate } from "../core";
import { PEOPLE_STOP_WORDS, PEOPLE_STOP_WORDS_MAX } from "./people-stopwords";
import { handleAppendMessage, handleCreateConversation, type TurnRunDeps } from "../conversations/handlers";
import {
  GUARD_MAX_TOKENS, PEOPLE_EMPTY, PEOPLE_LIMIT, PEOPLE_LIMITER_NAME, PEOPLE_RESULTS_MAX, likePrefixPattern, guardCandidates, normalizePeopleQuery, parsePeopleBody, prefixMatches, runPickerGuard, searchPeople,
  type PeopleRow, type PeopleSearchAuditRow, type PickerGuardAuditRow, type PickerGuardDeps,
} from "./people";
import { EMAIL_REMINDER, EMAIL_REMINDER_CODE, PEOPLE_PICKER_REMINDER, USE_PEOPLE_PICKER, activeMention, displayQuestion, hasEmailShaped, insertChip, liveChips, serializeDraft } from "./people-chip";
import { buildProductVocabulary, isProductVocabulary } from "./people-vocabulary";
import {
  SUBJECT_FLOOR_MS, SUBJECT_STORED_TEXT, SUBJECT_UNRESOLVED_NOTE, SUBJECT_UNRESOLVED_TEXT, extractSubjects, fillSubjectSlots, resolveSubjects, storedSubjectText,
  type SubjectDeps, type SubjectLimiterVerdict,
} from "./subject";
import { opaquePurposeFingerprintWith, OPAQUE_USER_REF_LABEL } from "@/lib/platform/opaque-user-ref";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

// E0-style sentinels — never a real person.
const U1 = { id: "ce0sentinelcustomer0000a1", username: "e0sentinelzelda", email: "zelda.quillfeather@e0-sentinel.invalid", ref: "a1a1a1a1" };
const U2 = { id: "ce0sentinelcustomer0000b2", username: null, email: "e0sentinelorrin@e0-sentinel.invalid", ref: "b2b2b2b2" };
const SENTINELS = [U1.id, U1.username, U1.email, U2.id, U2.email];
const leaked = (s: string) => SENTINELS.filter((x) => s.toLowerCase().includes(x.toLowerCase()));
const refOf = (id: string) => (id === U1.id ? U1.ref : id === U2.id ? U2.ref : null);

function fakeClock() {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms: number) => { t += Math.max(0, ms); }, after: () => new Promise<void>(() => {}), advance: (ms: number) => { t += ms; } };
}

async function main() {
  console.log("1. picker query + strict prefix rule (P1)");
  check("3+ of [a-z0-9._+-], case-folded", normalizePeopleQuery("  E0Sen ") === "e0sen" && normalizePeopleQuery("ab") === null);
  check("no @, space, % or other characters", ["e0s@x", "e0 s", "e0%", "e0*", "zel'", "x".repeat(65)].every((q) => normalizePeopleQuery(q) === null));
  check("C4: `_` is a username character the picker accepts", normalizePeopleQuery("e0_sen") === "e0_sen");
  check("C4: the LIKE prefix escapes `_`, `%` and the escape char, then ONE trailing %",
    likePrefixPattern("e0_sen") === "e0!_sen%" && likePrefixPattern("a%b!c_") === "a!%b!!c!_%" && likePrefixPattern("e0sen") === "e0sen%");
  check("the body is exactly { q }", parsePeopleBody({ q: "e0sen" }) === "e0sen" && parsePeopleBody({ q: "e0sen", x: 1 }) === null && parsePeopleBody(["e0sen"]) === null && parsePeopleBody(null) === null);
  const rows: PeopleRow[] = [
    { id: U1.id, username: U1.username, email: U1.email },
    { id: U2.id, username: U2.username, email: U2.email },
  ];
  check("username prefix matches; the label is the username", JSON.stringify(prefixMatches(rows, "e0sentinelz", refOf)) === JSON.stringify([{ opaqueRef: U1.ref, label: U1.username }]));
  check("email LOCAL-PART prefix matches (no username ⇒ the email is the label)", JSON.stringify(prefixMatches(rows, "e0sentinelo", refOf)) === JSON.stringify([{ opaqueRef: U2.ref, label: U2.email }]));
  check("a domain-only or mid-string match is dropped (the read's LIKE is re-checked)", prefixMatches(rows, "e0-sentinel", refOf).length === 0 && prefixMatches(rows, "quillf", refOf).length === 0);
  check("a row without a server reference is dropped", prefixMatches(rows, "e0sentinelz", () => null).length === 0);
  const many: PeopleRow[] = Array.from({ length: 20 }, (_, i) => ({ id: `id${i}`, username: `e0many${i}`, email: `m${i}@e0-sentinel.invalid` }));
  check(`at most ${PEOPLE_RESULTS_MAX} matches`, prefixMatches(many, "e0many", (id) => `0000${id.slice(2).padStart(4, "0")}`.slice(-8)).length === PEOPLE_RESULTS_MAX);

  console.log("\n2. searchPeople — limiter, uniform response, floor, audit (P4 / P5)");
  async function search(over: { limit?: SubjectLimiterVerdict | "throw"; search?: "throw" | "slow"; audit?: "throw"; rows?: PeopleRow[] }) {
    const clock = fakeClock();
    const audits: PeopleSearchAuditRow[] = [];
    const counts = { limiter: 0, search: 0 };
    const start = clock.now();
    const res = await searchPeople("e0sentinelz", {
      operatorId: "op_cs",
      limit: async () => { counts.limiter++; if (over.limit === "throw") throw new Error("down"); return over.limit ?? "ok"; },
      search: async () => { counts.search++; if (over.search === "throw") throw new Error("db"); if (over.search === "slow") return new Promise<PeopleRow[]>(() => {}); clock.advance(20); return over.rows ?? rows; },
      refOf, fingerprint: () => "0f0f0f0f",
      audit: async (r) => { if (over.audit === "throw") throw new Error("audit"); audits.push(r); },
      clock: { ...clock, after: over.search === "slow" ? async () => { clock.advance(1_500); } : clock.after },
    });
    return { res, audits, counts, elapsed: clock.now() - start };
  }
  const ok = await search({});
  check("authorized + found ⇒ { opaqueRef, label }", ok.res.matches.length === 1 && ok.res.matches[0].opaqueRef === U1.ref && ok.res.matches[0].label === U1.username);
  check("the audit row is counts + keyed fingerprint ONLY (never the query or a label)",
    ok.audits.length === 1 && JSON.stringify(Object.keys(ok.audits[0]).sort()) === JSON.stringify(["fingerprint", "operatorId", "queryLength", "resultCount"]) && ok.audits[0].queryLength === 11 && ok.audits[0].resultCount === 1 && leaked(JSON.stringify(ok.audits)).length === 0 && !JSON.stringify(ok.audits).includes("e0sentinelz"));
  const outcomes = {
    limited: await search({ limit: "limited" }), unavailable: await search({ limit: "unavailable" }), limiterThrows: await search({ limit: "throw" }),
    readFails: await search({ search: "throw" }), aborted: await search({ search: "slow" }), auditFails: await search({ audit: "throw" }), none: await search({ rows: [] }),
  };
  check("LIMITED / UNAVAILABLE / failed read / abort / failed audit / none ⇒ the ONE uniform empty response",
    Object.values(outcomes).every((o) => JSON.stringify(o.res) === JSON.stringify(PEOPLE_EMPTY)), Object.fromEntries(Object.entries(outcomes).map(([k, o]) => [k, o.res])));
  check("a limited search never reads", outcomes.limited.counts.search === 0 && outcomes.unavailable.counts.search === 0);
  check("every search counts against the shared limiter", Object.values(outcomes).every((o) => o.counts.limiter === 1));
  check("every outcome is audited (a failed audit withholds the labels)", Object.entries(outcomes).every(([k, o]) => (k === "auditFails" ? o.audits.length === 0 : o.audits.length === 1)));
  const fast = [ok, ...Object.entries(outcomes).filter(([k]) => k !== "aborted").map(([, o]) => o)];
  check(`every outcome whose work fits under the floor takes exactly ${SUBJECT_FLOOR_MS} ms`, fast.every((o) => o.elapsed === SUBJECT_FLOOR_MS), fast.map((o) => o.elapsed));

  console.log("\n3. chips — serialisation, OPAQUE_REF, stored text (P3 / P6)");
  const chips = [{ ref: U1.ref, label: U1.username }, { ref: U2.ref, label: U2.email }];
  const draft = `Why is @${U1.username} stuck, and @${U2.email} too?`;
  const wire = serializeDraft(draft, chips);
  check("the serialised draft carries tokens, never a label", wire === `Why is [[cust:${U1.ref}]] stuck, and [[cust:${U2.ref}]] too?` && leaked(wire).length === 0, wire);
  check("an edited mention is no longer a chip (and a chip prefix never leaves a tail)", liveChips(`Why is @${U1.username}x stuck?`, chips).length === 0
    && serializeDraft("@e0sentinelzelda2 and @e0sentinelzelda", [{ ref: U1.ref, label: "e0sentinelzelda" }, { ref: U2.ref, label: "e0sentinelzelda2" }]) === `[[cust:${U2.ref}]] and [[cust:${U1.ref}]]`);
  check("the operator's own display shows the label; an unknown chip ⇒ [customer]", displayQuestion(`${wire} [[cust:0badc0de]]`, chips) === `${draft} [customer]`);
  const mention = activeMention("Is @e0sen", 9);
  check("`@` before the caret opens the picker; insertChip replaces the mention", mention?.query === "e0sen" && insertChip("Is @e0sen", mention!, U1.username).draft === `Is @${U1.username} `);
  check("no mention mid-word (an email is not a mention)", activeMention("x@e0sen", 7) === null);
  check("the client hint: an email in the SERIALISED draft only (a chip label never trips it)", !hasEmailShaped(wire) && hasEmailShaped("is someone@e0-sentinel.invalid ok"));
  const ex = extractSubjects(`${wire} and [[cust:0badc0de]]`);
  check("a chip is an OPAQUE_REF identifier (`user #` + 8 hex) — the slot path", ex.ids.length === 3 && ex.ids.every((i) => i.kind === "OPAQUE_REF") && ex.ids[0].normalized === `user #${U1.ref}`);
  check("the stored text of a chip is [customer] (no label, no reference)", storedSubjectText(ex.text, ex.ids, { customers: true, incidents: false }) === `Why is ${SUBJECT_STORED_TEXT} stuck, and ${SUBJECT_STORED_TEXT} too? and ${SUBJECT_STORED_TEXT}`);
  {
    const clock = fakeClock();
    const looked: string[] = [];
    const d: SubjectDeps = {
      operatorId: "op_cs", primaryArea: "CUSTOMER_SUCCESS", enabled: () => true, limit: async () => "ok",
      eligibility: async () => ({ csTier: true, area: "CUSTOMER_SUCCESS" }),
      lookup: async (id) => { looked.push(id.kind); return id.normalized === `user #${U1.ref}` ? U1.id : null; },
      audit: async () => {}, mint: async (uid) => (uid === U1.id ? "h_AbCdEfGhIjKlMnOp" : null), keyHash: () => "e0e0e0e0", clock,
    };
    const one = extractSubjects(`Why is [[cust:${U1.ref}]] stuck? [[cust:0badc0de]]`);
    const r = await resolveSubjects(one.ids, d);
    const model = fillSubjectSlots(one.text, r.fills);
    check("the server resolves a chip through OPAQUE_REF to a handle", looked.join() === "OPAQUE_REF,OPAQUE_REF" && model.startsWith("Why is [customer h_AbCdEfGhIjKlMnOp] stuck?"), model);
    check("a forged / unknown chip ⇒ the uniform not-found literal + note", model.endsWith(SUBJECT_UNRESOLVED_TEXT) && r.note === SUBJECT_UNRESOLVED_NOTE && r.outcomes[1] === "NOT_FOUND");
  }

  console.log("\n4. the guard (G1–G6)");
  const vocab = buildProductVocabulary();
  check("the vocabulary is built from the registries (areas, packs, tools, metrics)", ["connections", "incidents", "customer", "success", "growth", "get_metric", "providers"].every((w) => vocab.has(w) || isProductVocabulary(w)), [...vocab].length);
  check("a sentinel username is not vocabulary", !isProductVocabulary(U1.username));
  function gd(over: { p5?: boolean; exhausted?: boolean | "throw"; usernames?: string[]; hit?: "throw" | "slow" } = {}) {
    const clock = fakeClock();
    const rows: PickerGuardAuditRow[] = [];
    const seen: string[][] = [];
    const counts = { consume: 0, lookups: 0 };
    const usernames = new Set(over.usernames ?? [U1.username]);
    const deps: PickerGuardDeps = {
      operatorId: "op_cs", authority: async () => over.p5 ?? true, exempt: isProductVocabulary,
      exhausted: async () => { if (over.exhausted === "throw") throw new Error("x"); return over.exhausted === true; },
      consume: async () => { counts.consume++; return "ok"; },
      usernameHit: async (tokens) => {
        counts.lookups++; seen.push([...tokens]);
        if (over.hit === "throw") throw new Error("db");
        if (over.hit === "slow") return new Promise<boolean>(() => {});
        clock.advance(10); return tokens.some((t) => usernames.has(t));
      },
      audit: async (r) => { rows.push(r); },
      clock: { ...clock, after: over.hit === "slow" ? async () => { clock.advance(1_500); } : clock.after },
    };
    return { deps, rows, seen, counts, clock };
  }
  {
    const g = gd();
    const start = g.clock.now();
    const v = await runPickerGuard(`Why is ${U1.username.toUpperCase()} stuck?`, g.deps);
    check("bare username (any case) ⇒ refused USERNAME", !v.pass && v.kind === "USERNAME");
    check("…one limiter count (a HIT counts), one bounded lookup", g.counts.consume === 1 && g.counts.lookups === 1);
    check("…a code-only audit row (no token)", g.rows.length === 1 && g.rows[0].kind === "USERNAME" && leaked(JSON.stringify(g.rows)).length === 0);
    check(`…padded to ${SUBJECT_FLOOR_MS} ms`, g.clock.now() - start === SUBJECT_FLOOR_MS);
  }
  {
    const g = gd();
    const v = await runPickerGuard("How are providers doing this week?", g.deps);
    check("non-matching words pass; a MISS does not count", v.pass && g.counts.consume === 0 && g.rows.length === 0);
    check("…vocabulary never looked up (providers, week…)", !g.seen.flat().includes("providers"));
  }
  {
    const g = gd({ usernames: ["connections"] });
    const v = await runPickerGuard("Are connections healthy?", g.deps);
    check("G3: a customer named like an area word (\"connections\") does not block an ordinary question", v.pass && !g.seen.flat().includes("connections"));
  }
  {
    const g = gd({ exhausted: true });
    const v = await runPickerGuard("Why is e0probe stuck?", g.deps);
    check("G1: limiter exhausted ⇒ refused (uniform) WITHOUT a lookup — the guard is never skipped", !v.pass && v.kind === "LIMITED" && g.counts.lookups === 0);
    const t = gd({ exhausted: "throw" });
    check("…an unreadable limiter fails closed", !(await runPickerGuard("Why is e0probe stuck?", t.deps)).pass);
  }
  {
    const f = gd({ hit: "throw" }), s = gd({ hit: "slow" });
    const vf = await runPickerGuard("Why is e0probe stuck?", f.deps), vs = await runPickerGuard("Why is e0probe stuck?", s.deps);
    check("a failed / aborted lookup ⇒ refused (fail closed)", !vf.pass && vf.kind === "UNAVAILABLE" && !vs.pass && vs.kind === "UNAVAILABLE");
  }
  {
    const g = gd();
    const v = await runPickerGuard(`Is ${U1.email} ok?`, g.deps);
    check("G4: a P5 caller's exact email is NOT refused (the slot path resolves it)", v.pass && !g.seen.flat().some((t) => U1.email.includes(t) && t.length > 4));
    const c = gd();
    await runPickerGuard(`Is [[cust:${U1.ref}]] or user #${U1.ref} or ${U1.id} ok?`, c.deps);
    check("chips, refs and cuids are never username candidates", !c.seen.flat().some((t) => t.includes(U1.ref) || t === U1.id || t === "cust"));
  }
  {
    const g = gd({ p5: false });
    const v = await runPickerGuard(`Why is ${U1.username} stuck?`, g.deps);
    check("G5: no P5 authority ⇒ no username lookup at all", v.pass && g.counts.lookups === 0 && g.counts.consume === 0);
    const e = gd({ p5: false });
    const ve = await runPickerGuard(`Why is ${U1.email} stuck?`, e.deps);
    check("…and any email-shaped text is refused (EMAIL, code-only row)", !ve.pass && ve.kind === "EMAIL" && e.counts.lookups === 0 && e.rows.length === 1 && leaked(JSON.stringify(e.rows)).length === 0);
  }
  {
    const words = Array.from({ length: 200 }, (_, i) => `w0rd${i}`).join(" ");
    check(`one bounded query: at most ${GUARD_MAX_TOKENS} distinct tokens`, guardCandidates(words, () => false).tokens.length === GUARD_MAX_TOKENS && guardCandidates("ab abc ABC abc", () => false).tokens.join() === "abc");
  }
  {
    check(`ruling 2: the stop-word list is CLOSED (≤ ${PEOPLE_STOP_WORDS_MAX})`, PEOPLE_STOP_WORDS.size <= PEOPLE_STOP_WORDS_MAX && PEOPLE_STOP_WORDS_MAX === 300, PEOPLE_STOP_WORDS.size);
    check("…and holds the function words + question verbs (sample)", ["the", "show", "why", "how", "what", "which", "list", "give", "tell", "find", "count", "compare"].every((w) => PEOPLE_STOP_WORDS.has(w)));
    check("…lower-case, username-shaped entries only", [...PEOPLE_STOP_WORDS].every((w) => /^[a-z]{3,30}$/.test(w)));
    const g = gd({ usernames: ["show", "the"] });
    const v = await runPickerGuard("Show me the connections broken today", g.deps);
    check("customers named \"show\" / \"the\" do not block an ordinary question (never looked up)", v.pass && !g.seen.flat().some((t) => t === "show" || t === "the"));
    const j = gd({ usernames: ["e0jsmith"] });
    const vj = await runPickerGuard("Why is e0jsmith stuck?", j.deps);
    check("a plain-letter username (\"e0jsmith\") is STILL caught", !vj.pass && vj.kind === "USERNAME");
    const k = gd({ usernames: ["jsmith"] });
    check("…including one with no digits (\"jsmith\")", !(await runPickerGuard("Why is jsmith stuck?", k.deps)).pass);
    const c2 = gd({ usernames: ["E0Legacy"] });
    const v2 = await runPickerGuard("Why is E0Legacy stuck?", c2.deps);
    check("C2: the lookup gets the case-folded token AND the as-typed form (a legacy row stored as typed is caught)",
      !v2.pass && c2.seen[0].includes("e0legacy") && c2.seen[0].includes("E0Legacy"));
  }

  console.log("\n5. the ask handler — zero provider calls on a guard refusal; the leak sentinel");
  const requests: string[] = [];
  const generate: PlatformAiGenerate = async ({ messages }) => {
    requests.push(JSON.stringify(messages));
    return { content: "ok", toolCalls: [], raw: { role: "assistant", content: "ok" }, usage: null };
  };
  const binding = { describeMetric: () => null } as unknown as NonNullable<PlatformAiAskDeps["binding"]>;
  let spends = 0;
  const askDeps = (guard: PlatformAiAskDeps["guard"]): PlatformAiAskDeps => ({
    enabled: true, operatorId: "op_cs", binding, guard,
    admission: async () => ({ paused: false, state: "OFF" }), freeze: async () => ({ frozen: false, state: "OFF" }), turns: async () => ({ allowed: true, remaining: 5 }),
    spend: async () => { spends++; return { verdict: { allowed: true }, release: async () => {} }; },
    generate, model: "m", now: () => new Date("2026-11-10T12:00:00Z"), classify: () => "PROVIDER",
  });
  for (const [label, q, p5, code] of [["bare username (P5)", `Why is ${U1.username} stuck?`, true, "USE_PEOPLE_PICKER"], ["email (no P5 authority)", `Why is ${U1.email} stuck?`, false, "EMAIL_REMINDER"]] as const) {
    requests.length = 0; spends = 0;
    const g = gd({ p5 });
    const r = await handlePlatformAiAsk({ question: q }, askDeps((raw) => runPickerGuard(raw, g.deps)));
    check(`${label} ⇒ 422 ${code} with ZERO provider calls and no spend`, r.status === 422 && r.body.code === code && r.body.reason === code && requests.length === 0 && spends === 0, r);
    check(`${label}: the refusal never echoes the identifier`, leaked(JSON.stringify(r.body)).length === 0);
  }
  check("C3: the non-P5 refusal copy never mentions the @ picker; the P5 one does",
    !/@|pick/i.test(EMAIL_REMINDER_BODY.error) && EMAIL_REMINDER_BODY.error === EMAIL_REMINDER && EMAIL_REMINDER_BODY.code === EMAIL_REMINDER_CODE && /@/.test(USE_PEOPLE_PICKER_BODY.error));
  {
    // C1 — runtime: a deps object WITHOUT its guard (a JS caller / a cast) is refused fail-closed, before any provider call.
    requests.length = 0; spends = 0;
    const { guard: _omit, ...noGuard } = askDeps(async () => ({ pass: true as const }));
    void _omit;
    const r = await handlePlatformAiAsk({ question: "How are providers?" }, noGuard as unknown as PlatformAiAskDeps);
    check("C1: no guard ⇒ refused (503 GUARD_UNAVAILABLE) with ZERO provider calls and no spend",
      r.status === 503 && r.body.reason === GUARD_UNAVAILABLE_BODY.reason && requests.length === 0 && spends === 0, r);
    // C1 — type level: both deps types REQUIRE the guard (tsc fails if `guard` ever becomes optional again).
    const guardRequiredAsk: undefined extends PlatformAiAskDeps["guard"] ? false : true = true;
    const guardRequiredTurn: undefined extends TurnRunDeps["guard"] ? false : true = true;
    check("C1: `guard` is required in PlatformAiAskDeps and TurnRunDeps (type-level pin)", guardRequiredAsk && guardRequiredTurn);
  }
  {
    requests.length = 0;
    const thrown = await handlePlatformAiAsk({ question: "Why is someone stuck?" }, askDeps(async () => { throw new Error("guard down"); }));
    check("a guard that throws refuses (fail closed, USE_PEOPLE_PICKER), still zero provider calls", thrown.status === 422 && thrown.body.code === "USE_PEOPLE_PICKER" && requests.length === 0);
  }
  check("E0 leak sentinel: no sentinel in any provider payload across the refused paths", requests.every((q) => leaked(q).length === 0));
  check("core.ts's refusal copy / code equal people-chip.ts's (core imports nothing new)",
    USE_PEOPLE_PICKER_BODY.error === PEOPLE_PICKER_REMINDER && USE_PEOPLE_PICKER_BODY.code === USE_PEOPLE_PICKER && USE_PEOPLE_PICKER_BODY.reason === USE_PEOPLE_PICKER);

  console.log("\n6. the conversation handlers — a refusal stores nothing, runs no turn");
  {
    const calls: string[] = [];
    const store = new Proxy({}, { get: (_t, k) => async () => { calls.push(`store.${String(k)}`); return null; } });
    const deps = {
      store, now: () => new Date("2026-11-10T12:00:00Z"),
      areaAccess: async () => { calls.push("areaAccess"); return null; },
      admission: async () => ({ paused: false, state: "OFF" }), freeze: async () => ({ frozen: false, state: "OFF" }), turns: async () => ({ allowed: true, remaining: 5 }),
      spend: async () => { calls.push("spend"); return { verdict: { allowed: true }, release: async () => {} }; },
      runTurn: async () => { calls.push("runTurn"); throw new Error("no turn"); },
      guard: async () => ({ pass: false as const, kind: "USERNAME" as const }),
    } as unknown as Parameters<typeof handleCreateConversation>[2];
    const V = { operatorId: "op_cs", area: "CUSTOMER_SUCCESS" as const };
    const body = { clientRequestId: "6f1d4c1e-7d0a-4b8e-9b55-0a1b2c3d4e5f", question: `Why is ${U1.username} stuck?` };
    calls.length = 0;
    const c = await handleCreateConversation(V, body, deps);
    check("create: 422 USE_PEOPLE_PICKER; only the metadata replay lookup ran — nothing stored, no spend, no turn",
      c.status === 422 && (c.body as { code?: string }).code === "USE_PEOPLE_PICKER" && calls.join() === "store.findCreateConversation", calls);
    // append: the conversation's own area must pass first (the guard runs after it, before anything is stored).
    const live = { ...deps, store: new Proxy({}, { get: (_t, k) => async () => { calls.push(`store.${String(k)}`); return k === "findLiveConversation" ? { id: "c1", area: "CUSTOMER_SUCCESS" } : null; } }), areaAccess: async () => ({ binding }) } as unknown as Parameters<typeof handleAppendMessage>[3];
    calls.length = 0;
    const a = await handleAppendMessage(V, "c1aaaaaaaaaaaaaaaaaaaaaaa", body, live);
    check("follow-up: 422 USE_PEOPLE_PICKER; no append, no spend, no turn", a.status === 422 && !calls.some((x) => /appendTurn|spend|runTurn/.test(x)), [a.status, calls]);
    // C1 — runtime: conversation deps WITHOUT a guard ⇒ refused fail-closed; nothing stored, no turn.
    const { guard: _g, ...noGuardDeps } = deps as unknown as Record<string, unknown>;
    void _g;
    calls.length = 0;
    const ng = await handleCreateConversation(V, { ...body, question: "How are providers?" }, noGuardDeps as unknown as Parameters<typeof handleCreateConversation>[2]);
    check("C1: conversation create without a guard ⇒ 503 GUARD_UNAVAILABLE; nothing stored, no spend, no turn",
      ng.status === 503 && (ng.body as { reason?: string }).reason === "GUARD_UNAVAILABLE" && !calls.some((x) => /createConversation|spend|runTurn/.test(x)), [ng.status, calls]);
  }

  console.log("\n7. keyed fingerprint + static pins");
  const fp = opaquePurposeFingerprintWith("fm/platform-ai-people-search/v1", "e0sentinelz", "secret-a");
  check("the fingerprint is keyed (secret-dependent), 8 hex, never the query", !!fp && /^[0-9a-f]{8}$/.test(fp) && fp !== opaquePurposeFingerprintWith("fm/platform-ai-people-search/v1", "e0sentinelz", "secret-b"));
  check("no secret ⇒ no fingerprint (never unkeyed); the reference label is refused as a purpose",
    opaquePurposeFingerprintWith("fm/platform-ai-people-search/v1", "x", undefined) === null && opaquePurposeFingerprintWith(OPAQUE_USER_REF_LABEL, "x", "s") === null);
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const read = (f: string) => strip(readFileSync(path.join(process.cwd(), f), "utf8"));
  const route = read("app/api/platform/ai/people/route.ts");
  const csGuard = route.indexOf('requireFreshPlatformAccess("CUSTOMER_SUCCESS", "READ")');
  check("picker route: flag + customers pack → FRESH CS guard → P5 authority → #352 limiter (guard's user id) → body → search; POST only; never logs",
    /export async function POST/.test(route) && !/export async function GET/.test(route) && !/console\./.test(route)
    && route.indexOf("isPlatformAiEnabled") < csGuard && csGuard > 0 && csGuard < route.indexOf("platformAiP5Authority(auth.user.id)")
    && route.indexOf("platformAiP5Authority(") < route.indexOf('limitPlatformMutation(auth.user.id, "platform-ai-people")') && route.indexOf("limitPlatformMutation(") < route.indexOf("searchPeople("));
  const srv = read("lib/platform/intelligence/ai/authz/people.server.ts");
  check("people.server.ts: the SHARED P5 limiter (name + config), the PRIV-ref key, I-7 (no break-glass), the CS tier from the fresh guard",
    /checkKeyLimitStrict\(operatorId, SUBJECT_LIMITER_NAME, SUBJECT_LIMIT\)/.test(srv) && /peekKey\(input\.operatorId, SUBJECT_LIMITER_NAME, SUBJECT_LIMIT\.windowSec\)/.test(srv)
    && /opaqueUserRef\(/.test(srv) && /fresh\.grant !== null/.test(srv) && /UserRole\.SYSTEM_ADMIN/.test(srv) && !/console\./.test(srv));
  check("ruling 3: the picker has its OWN bucket (30 / h); the guard stays on the P5 subject bucket",
    PEOPLE_LIMITER_NAME === "platform-ai-people-search" && PEOPLE_LIMIT.limit === 30 && PEOPLE_LIMIT.windowSec === 3600
    && /checkKeyLimitStrict\(operatorId, PEOPLE_LIMITER_NAME, PEOPLE_LIMIT\)/.test(srv) && /limit: \(\) => pickerLimit\(operatorId\)/.test(srv)
    && /consume: \(\) => subjectLimit\(input\.operatorId\)/.test(srv));
  const readers = read("lib/platform/intelligence/ai/authz/people-readers.server.ts");
  check("C4: the read declares the escape and uses the escaped pattern (no Prisma startsWith)",
    /likePrefixPattern\(q\)/.test(readers) && (readers.match(/ESCAPE '!'/g) ?? []).length === 2 && !/startsWith:/.test(readers));
  check("the reads: CUSTOMER_WHERE, username / email only (never a name), a transaction-local timeout, an exact IN for the guard",
    (readers.match(/CUSTOMER_WHERE/g) ?? []).length >= 3 && !/\bname:|firstName|lastName/.test(readers) && /SET LOCAL statement_timeout/.test(readers) && /username: \{ in: list \}/.test(readers));
  for (const f of ["app/api/platform/ai/ask/route.ts", "app/api/platform/ai/conversations/route.ts", "app/api/platform/ai/conversations/[id]/messages/route.ts"]) {
    check(`${f}: wires the guard`, /platformAiPickerGuard\(/.test(read(f)));
  }
  const client = read("components/platform/platform-ai-people-picker.tsx");
  check("ruling 3 (client): ≥ 3 characters, debounce ≥ 400 ms, identical in-flight queries share one request",
    /export const SEARCH_DEBOUNCE_MS = (\d+);/.test(client) && Number(/export const SEARCH_DEBOUNCE_MS = (\d+);/.exec(client)![1]) >= 400
    && /export const QUERY_MIN = 3;/.test(client) && /inflight\.current\.get\(query\)/.test(client));
  check("the client searches with a POST body (never a URL query) and stores nothing", /method: "POST"/.test(client) && !/localStorage|sessionStorage|console\./.test(client) && !/\?q=/.test(client));

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
