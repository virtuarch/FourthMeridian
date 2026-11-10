/**
 * lib/platform/intelligence/ai/authz/subject.test.ts  (Platform AI P5 — subject resolution, I-4 / D-4)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/ai/authz/subject.test.ts
 *
 * 1. extraction — the EXACT-only matrix: full email (case-folded, whole token), full `user #` + 8 hex,
 *    full cuid; names, prefixes, partial ids, the ≥ 6-char tail form, wildcards, longer tokens ⇒ nothing;
 *    slots survive the real scrub; stored text = `[customer]`; a forged slot character is stripped;
 * 2. resolution — every outcome (MATCHED, NOT_FOUND, NO_ACCESS ×3, LIMITED ×2, UNAVAILABLE ×4, audit
 *    failure): ONE literal for every non-match, the same note, an audit row for EVERY outcome (target only
 *    when matched, keyHash never the identifier), the limiter counts every attempt, ≤ 2 looked up;
 * 3. timing class on a FAKE clock: every outcome's processing ≥ SUBJECT_FLOOR_MS and within [300, 300+ε];
 *    a slow lookup aborts at SUBJECT_ABORT_MS as UNAVAILABLE;
 * 4. static: subject.ts imports no DB / env / name search; subject.server.ts reuses the PRIV-ref key
 *    (opaqueDedupeToken) and the strict limiter with the exact name + config.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { scrubOperatorText } from "@/lib/ai/privacy/scrub";
import {
  SUBJECT_ABORT_MS, SUBJECT_FLOOR_MS, SUBJECT_LIMIT, SUBJECT_LIMITER_NAME, SUBJECT_STORED_TEXT, SUBJECT_UNRESOLVED_NOTE, SUBJECT_UNRESOLVED_TEXT,
  extractSubjects, fillSubjectSlots, hasSubjectSlots, resolveSubjects, storedSubjectText,
  type SubjectAuditRow, type SubjectDeps, type SubjectIdentifier, type SubjectLimiterVerdict, type SubjectOutcome,
} from "./subject";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}

const EMAIL = "zelda.quillfeather@e0-sentinel.invalid";
const CUID = "ce0sentinelcustomer0000a1";
const REF = "user #3fa9c21b";
const HANDLE = "h_AbCdEfGhIjKlMnOp";

/** A fake clock: `now` moves only when a sleep is awaited or a lookup "takes" time. `after` never fires on its own. */
function fakeClock() {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: async (ms: number) => { t += Math.max(0, ms); },
    after: () => new Promise<void>(() => { /* never — a lookup's slowness is modelled by advancing `t` */ }),
    advance: (ms: number) => { t += ms; },
  };
}

type World = {
  enabled?: boolean; limiter?: SubjectLimiterVerdict | "throw"; elig?: { csTier: boolean; area: "CUSTOMER_SUCCESS" | "PLATFORM_OPS" } | null | "throw";
  match?: string | null | "throw"; lookupMs?: number; auditThrows?: boolean; mint?: string | null;
};

function deps(w: World = {}) {
  const clock = fakeClock();
  const rows: SubjectAuditRow[] = [];
  let limiterCalls = 0, lookups = 0, mints = 0;
  const d: SubjectDeps = {
    operatorId: "cop00000000000000000000cs1", primaryArea: "PLATFORM_OPS",
    enabled: () => w.enabled ?? true,
    limit: async () => { limiterCalls++; if (w.limiter === "throw") throw new Error("db"); return w.limiter ?? "ok"; },
    eligibility: async () => { if (w.elig === "throw") throw new Error("db"); return w.elig === undefined ? { csTier: true, area: "CUSTOMER_SUCCESS" } : w.elig; },
    lookup: async (_id: SubjectIdentifier) => { lookups++; clock.advance(w.lookupMs ?? 20); if (w.match === "throw") throw new Error("db"); return w.match === undefined ? "cuserzelda000000000000001" : w.match; },
    audit: async (row) => { if (w.auditThrows) throw new Error("audit down"); rows.push(row); },
    mint: async () => { mints++; return w.mint === undefined ? HANDLE : w.mint; },
    keyHash: () => "0badc0de",
    clock,
  };
  return { d, rows, clock, counts: () => ({ limiterCalls, lookups, mints }) };
}

async function one(w: World, id: SubjectIdentifier = { kind: "EMAIL", normalized: EMAIL }) {
  const x = deps(w);
  const start = x.clock.now();
  const r = await resolveSubjects([id], x.d);
  return { ...x, r, elapsed: x.clock.now() - start };
}

async function main() {
  console.log("1. extraction — exact identifiers only");
  {
    const e = extractSubjects(`Is ${EMAIL.toUpperCase()} ok? Also ${CUID} and ${REF}.`);
    check("email (case-folded), cuid and full opaque ref are each cut out, in text order",
      e.ids.map((i) => `${i.kind}:${i.normalized}`).join("|") === `EMAIL:${EMAIL}|USER_ID:${CUID}|OPAQUE_REF:${REF}`, e.ids);
    check("no identifier remains in the slotted text", !e.text.toLowerCase().includes(EMAIL) && !e.text.includes(CUID) && !e.text.includes("3fa9c21b") && hasSubjectSlots(e.text));
    const none = [
      "Zelda Quillfeather", "zelda", "zelda.quillfeather@", "@e0-sentinel.invalid", "user #3fa9c2", "user #3fa9c21b9", "user …abc123", "user #3FA9C21B",
      "ce0sentinelcustomer0000a", "ce0sentinelcustomer0000a12", `x${CUID}`, "zelda*@e0-sentinel.invalid", "%@%", "customer Zelda", "c0123",
    ];
    const hits = none.filter((t) => extractSubjects(`find ${t} please`).ids.length > 0);
    check(`${none.length} non-exact forms (names, prefixes, partial / tail / upper-case refs, longer tokens, wildcards) ⇒ never extracted`, hits.length === 0, hits);
    check("an email glued into a longer address-like token is not a whole token", extractSubjects(`${EMAIL}@other.invalid`).ids.length === 0 && extractSubjects(`x@${EMAIL}`).ids.length === 0);
    check("an email followed by sentence punctuation still is", extractSubjects(`ask ${EMAIL}.`).ids.length === 1 && extractSubjects(`(${EMAIL})`).ids.length === 1);
    const slotted = scrubOperatorText(e.text, 500);
    check("slots survive the real scrub (one scrub, then fill)", hasSubjectSlots(slotted));
    const model = fillSubjectSlots(slotted, [`[customer ${HANDLE}]`, SUBJECT_UNRESOLVED_TEXT, SUBJECT_UNRESOLVED_TEXT]);
    check("model text: matched ⇒ [customer h_…], others ⇒ the one literal; no slot char left",
      model === `Is [customer ${HANDLE}] ok? Also ${SUBJECT_UNRESOLVED_TEXT} and ${SUBJECT_UNRESOLVED_TEXT}.` && !/[]/.test(model), model);
    const stored = storedSubjectText(slotted);
    check("stored text: every slot ⇒ [customer] (no handle, no identifier)", stored === `Is ${SUBJECT_STORED_TEXT} ok? Also ${SUBJECT_STORED_TEXT} and ${SUBJECT_STORED_TEXT}.`, stored);
    check("a missing fill ⇒ the unresolved literal", fillSubjectSlots(slotted, []).split(SUBJECT_UNRESOLVED_TEXT).length === 4);
    const forged = extractSubjects("x 0 y");
    check("an operator cannot forge a slot (the private code points are stripped first)", forged.ids.length === 0 && !hasSubjectSlots(forged.text) && !/[]/.test(fillSubjectSlots(forged.text, [`[customer ${HANDLE}]`])));
    check("no identifier ⇒ the text is unchanged (the caller scrubs exactly as before)", extractSubjects("How are we looking today?").text === "How are we looking today?");
  }

  console.log("\n2. resolution — every outcome");
  const cases: { label: string; w: World; outcome: SubjectOutcome }[] = [
    { label: "matched", w: {}, outcome: "MATCHED" },
    { label: "no such customer", w: { match: null }, outcome: "NOT_FOUND" },
    { label: "no CS tier (fresh guard of another area)", w: { elig: { csTier: false, area: "PLATFORM_OPS" } }, outcome: "NO_ACCESS" },
    { label: "no area survives the fresh recheck", w: { elig: null }, outcome: "NO_ACCESS" },
    { label: "customers flag OFF", w: { enabled: false }, outcome: "NO_ACCESS" },
    { label: "rate limited", w: { limiter: "limited" }, outcome: "LIMITED" },
    { label: "limiter unavailable (fail closed)", w: { limiter: "unavailable" }, outcome: "UNAVAILABLE" },
    { label: "limiter throws (fail closed)", w: { limiter: "throw" }, outcome: "UNAVAILABLE" },
    { label: "lookup throws", w: { match: "throw" }, outcome: "UNAVAILABLE" },
    { label: "eligibility throws", w: { elig: "throw" }, outcome: "NO_ACCESS" },
    { label: `lookup slower than ${SUBJECT_ABORT_MS} ms`, w: { lookupMs: SUBJECT_ABORT_MS + 1 }, outcome: "UNAVAILABLE" },
    { label: "mint refused (area lost between steps)", w: { mint: null }, outcome: "UNAVAILABLE" },
  ];
  const elapsed: number[] = [];
  const literals = new Set<string>(), notes = new Set<string | null>();
  for (const c of cases) {
    const x = await one(c.w);
    elapsed.push(x.elapsed);
    const row = x.rows[0];
    const matched = c.outcome === "MATCHED";
    check(`${c.label} ⇒ ${c.outcome}; one audit row with that outcome; target only when matched; keyHash, never the identifier`,
      x.r.outcomes.join() === (c.label.startsWith("mint") ? "UNAVAILABLE" : c.outcome) && x.rows.length === 1
      && (c.label.startsWith("mint") ? row.outcome === "MATCHED" : row.outcome === c.outcome)
      && (row.matchedUserId !== null) === (matched || c.label.startsWith("mint")) && row.keyHash === "0badc0de" && !JSON.stringify(row).includes(EMAIL),
      { outcomes: x.r.outcomes, row });
    if (!matched) { literals.add(x.r.fills[0]); notes.add(x.r.note); }
    else check("matched ⇒ `[customer h_…]` and no note", x.r.fills[0] === `[customer ${HANDLE}]` && x.r.note === null);
  }
  check("EVERY non-match gives the SAME literal and the SAME note", literals.size === 1 && [...literals][0] === SUBJECT_UNRESOLVED_TEXT && notes.size === 1 && [...notes][0] === SUBJECT_UNRESOLVED_NOTE, { literals: [...literals], notes: [...notes] });
  {
    const x = await one({ auditThrows: true });
    check("audit write failure ⇒ NOT resolved (the unresolved literal), no handle minted", x.r.fills[0] === SUBJECT_UNRESOLVED_TEXT && x.counts().mints === 0);
    const y = await one({ elig: { csTier: false, area: "PLATFORM_OPS" } });
    check("NO_ACCESS never looks the identifier up, and the audit actor is the fresh guard's area", y.counts().lookups === 0 && y.rows[0].actor.area === "PLATFORM_OPS");
    const z = await one({ elig: null });
    check("no fresh area ⇒ the audit actor is the turn's primary area (a row is still written)", z.rows.length === 1 && z.rows[0].actor.area === "PLATFORM_OPS");
    const many = deps();
    const r = await resolveSubjects([{ kind: "EMAIL", normalized: EMAIL }, { kind: "USER_ID", normalized: CUID }, { kind: "OPAQUE_REF", normalized: REF }, { kind: "EMAIL", normalized: "x@y.invalid" }], many.d);
    check(`≤ 2 identifiers looked up per question; extras are LIMITED (not looked up, not counted), each audited`,
      r.outcomes.join() === "MATCHED,MATCHED,LIMITED,LIMITED" && many.counts().lookups === 2 && many.counts().limiterCalls === 2 && many.rows.length === 4, { outcomes: r.outcomes, c: many.counts() });
    const nf = await one({ match: null });
    check("the limiter counts every attempt, found or not", nf.counts().limiterCalls === 1);
  }

  console.log("\n3. timing class (fake clock)");
  check(`every outcome's processing ≥ ${SUBJECT_FLOOR_MS} ms`, elapsed.every((e) => e >= SUBJECT_FLOOR_MS), elapsed);
  const fast = elapsed.filter((_, i) => !cases[i].label.startsWith("lookup slower"));
  check(`…and within [${SUBJECT_FLOOR_MS}, ${SUBJECT_FLOOR_MS}] for every outcome whose work fits under the floor (matched, not found, no access, limited, unavailable)`,
    fast.every((e) => e === SUBJECT_FLOOR_MS), fast);
  const slow = await one({ lookupMs: SUBJECT_FLOOR_MS + 50 });
  check("work above the floor is not padded further (the floor is a minimum)", slow.elapsed === SUBJECT_FLOOR_MS + 50 && slow.r.outcomes[0] === "MATCHED");
  check("constants: floor 300 ms, abort 1,500 ms, limiter platform-ai-subject 20 / 3600 s",
    SUBJECT_FLOOR_MS === 300 && SUBJECT_ABORT_MS === 1500 && SUBJECT_LIMITER_NAME === "platform-ai-subject" && SUBJECT_LIMIT.limit === 20 && SUBJECT_LIMIT.windowSec === 3600);

  console.log("\n4. static");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const sub = strip(readFileSync(path.join(process.cwd(), "lib/platform/intelligence/ai/authz/subject.ts"), "utf8"));
  check("subject.ts: no DB, env, network or name search (pure orchestration)", !/@\/lib\/db|systemDb|process\.env|fetch\(|contains:|startsWith:|mode: "insensitive"/.test(sub));
  const srv = strip(readFileSync(path.join(process.cwd(), "lib/platform/intelligence/ai/authz/subject.server.ts"), "utf8"));
  check("subject.server.ts: the strict limiter with the exact name + config; the PRIV-ref key (opaqueDedupeToken, ruling 5); the fail-closed audit writer",
    /checkKeyLimitStrict\(input\.operatorId, SUBJECT_LIMITER_NAME, SUBJECT_LIMIT\)/.test(srv) && /opaqueDedupeToken\(/.test(srv) && /platformAiSubjectAudit\(\)/.test(srv) && !/hashSecurityIdentifier|createHmac|randomBytes/.test(srv));
  const cs = strip(readFileSync(path.join(process.cwd(), "lib/platform/intelligence/ai/tools/packs/customers.server.ts"), "utf8"));
  check("the subject lookups are EXACT: email equality (mode insensitive, never contains / startsWith), id equality, the ref digest scan — all within CUSTOMER_WHERE",
    /email: \{ equals: email, mode: "insensitive" \}/.test(cs) && !/contains:|startsWith:|endsWith:|search:/.test(cs) && (cs.match(/CUSTOMER_WHERE/g) ?? []).length >= 4);

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
