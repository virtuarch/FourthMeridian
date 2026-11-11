/**
 * lib/platform/intelligence/ai/eval/cases/people.ts  (Platform AI E0-CI — the @ people picker + bare-username guard)
 *
 * Owner request 2026-11-10; S2 09fc. UNIT cases through the REAL ask handler (core.ts handlePlatformAiAsk),
 * the REAL guard (authz/people.ts runPickerGuard) with the REAL product vocabulary (people-vocabulary.ts),
 * the REAL picker search (searchPeople) and chip serialisation (people-chip.ts), the REAL subject resolver
 * (authz/subject.ts, fake clock) and the REAL turn boundary — over the E0 sentinel customers.
 *
 *   people.guard-zero-provider     PEOPLE_PICKER_PRIVACY + IDENTITY_LEAK — a bare customer username (P5 caller)
 *                                  and an email (caller without P5 authority) are refused 422 (USE_PEOPLE_PICKER / EMAIL_REMINDER)
 *                                  with ZERO provider calls and no spend; a customer whose username is a product
 *                                  word ("connections") does not block an ordinary question; non-matching words
 *                                  pass through to the provider; no sentinel in any provider request
 *   people.chip-label-never-sent   PEOPLE_PICKER_PRIVACY + IDENTITY_LEAK — the picker's label never appears in the
 *                                  serialised draft, the provider payload or the stored conversation text; the chip
 *                                  resolves through OPAQUE_REF to a handle of THIS turn; a forged chip ⇒ the
 *                                  uniform `[customer not resolved]`
 */

import type { PlatformArea } from "@prisma/client";
import { handlePlatformAiAsk, type PlatformAiAskDeps, type PlatformAiGenerate } from "../../core";
import { createTurnBoundary } from "../../authz/boundary";
import type { RecordRenderSource } from "../../authz/record-render";
import { runPickerGuard, searchPeople, type PickerGuardDeps } from "../../authz/people";
import { serializeDraft } from "../../authz/people-chip";
import { isProductVocabulary } from "../../authz/people-vocabulary";
import { SUBJECT_UNRESOLVED_TEXT, resolveSubjects, type SubjectDeps } from "../../authz/subject";
import { scrubWithSubjects } from "../../conversations/handlers";
import { CUSTOMER_AREA, CUSTOMER_RECORD_KIND, customersPackTools, type CustomersPackReaders } from "../../tools/packs/customers";
import { E0_CUSTOMERS, E0_CUSTOMER_REF_TOKENS, E0_T2_SENTINELS, e0CustomerDtos } from "../fixtures";
import { sentinelsIn } from "../gates";
import type { UnitCase, UnitContext } from "./types";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const [ZELDA] = E0_CUSTOMERS;
const ridOf = (id: string) => (E0_CUSTOMER_REF_TOKENS[id] ? `u:${E0_CUSTOMER_REF_TOKENS[id]}` : null);
const byRid = new Map(Object.entries(E0_CUSTOMER_REF_TOKENS).map(([id, t]) => [`u:${t}`, id]));
const byRef = new Map(Object.entries(E0_CUSTOMER_REF_TOKENS).map(([id, t]) => [`user #${t}`, id]));
/** A product word that is ALSO a customer's username in this case (G3). */
const VOCAB_USERNAME = "connections";

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += Math.max(0, ms); }, after: () => new Promise<void>(() => {}) };
}

function spyGenerate(): { generate: PlatformAiGenerate; requests: string[] } {
  const requests: string[] = [];
  const generate: PlatformAiGenerate = async ({ messages }) => {
    requests.push(JSON.stringify(messages));
    return { content: "All good.", toolCalls: [], raw: { role: "assistant", content: "All good." }, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 1, reasoningTokens: 0 } };
  };
  return { generate, requests };
}

function guardDeps(over: Partial<PickerGuardDeps> & { p5: boolean; usernames?: readonly string[]; lookups?: { n: number }; rows?: unknown[] }): PickerGuardDeps {
  const usernames = new Set((over.usernames ?? [ZELDA.username, VOCAB_USERNAME]).map((u) => u.toLowerCase()));
  return {
    operatorId: "e0-guard-operator",
    authority: async () => over.p5,
    exempt: isProductVocabulary,
    exhausted: async () => false,
    consume: async () => "ok",
    usernameHit: async (tokens) => { if (over.lookups) over.lookups.n++; return tokens.some((t) => usernames.has(t)); },
    audit: async (row) => { over.rows?.push(row); },
    clock: fakeClock(),
    ...over,
  };
}

function askDeps(ctx: UnitContext, generate: PlatformAiGenerate, over: Partial<PlatformAiAskDeps> & Pick<PlatformAiAskDeps, "guard">): PlatformAiAskDeps & { spends: { n: number } } {
  const part = ctx.scoped("cs", "CUSTOMER_SUCCESS");
  const spends = { n: 0 };
  return {
    spends,
    enabled: true, operatorId: ctx.operatorId("cs"), binding: part?.binding ?? null,
    admission: async () => ({ paused: false, state: "OFF" }), freeze: async () => ({ frozen: false, state: "OFF" }),
    turns: async () => ({ allowed: true, remaining: 5 }),
    spend: async () => { spends.n++; return { verdict: { allowed: true }, release: async () => {} }; },
    generate, model: "e0-scripted", now: () => NOW, classify: () => "PROVIDER",
    ...over,
  };
}

const leaked = (s: string) => sentinelsIn(s, [...E0_T2_SENTINELS]).length;

async function guardZeroProvider(ctx: UnitContext): Promise<string[]> {
  const problems: string[] = [];
  if (!ctx.scoped("cs", "CUSTOMER_SUCCESS")) return ["fixture CS operator not in scope"];
  const scenarios: { label: string; q: string; p5: boolean; refused: boolean }[] = [
    { label: "bare username (P5)", q: `Why is ${ZELDA.username} stuck?`, p5: true, refused: true },
    { label: "bare username, other case (P5)", q: `Why is ${ZELDA.username.toUpperCase()} stuck?`, p5: true, refused: true },
    { label: "email (no P5 authority)", q: `Why is ${ZELDA.email} stuck?`, p5: false, refused: true },
    { label: "username-shaped words (no P5 authority: no lookup at all)", q: "How are widgets doing today?", p5: false, refused: false },
    { label: "exact email (P5: the supported identifier, not refused)", q: `Is ${ZELDA.email} ok?`, p5: true, refused: false },
    { label: "product word that is also a username (P5)", q: `Are ${VOCAB_USERNAME} healthy today?`, p5: true, refused: false },
    { label: "non-matching words (P5)", q: "How are providers doing this week?", p5: true, refused: false },
  ];
  for (const s of scenarios) {
    const g = spyGenerate();
    const rows: unknown[] = [];
    const lookups = { n: 0 };
    const gd = guardDeps({ p5: s.p5, rows, lookups });
    const d = askDeps(ctx, g.generate, { guard: (raw) => runPickerGuard(raw, gd) });
    const r = await handlePlatformAiAsk({ question: s.q }, d);
    for (const q of g.requests) ctx.collect("provider_request", q);
    ctx.collect("response_body", JSON.stringify(r.body));
    if (s.refused) {
      const want = s.p5 ? "USE_PEOPLE_PICKER" : "EMAIL_REMINDER";
      if (r.status !== 422 || r.body.code !== want) problems.push(`${s.label}: not refused with ${want} (${r.status} ${String(r.body.code)})`);
      if (!s.p5 && /@|pick/i.test(String(r.body.error))) problems.push(`${s.label}: the non-P5 copy mentions the picker`);
      if (g.requests.length !== 0) problems.push(`${s.label}: ${g.requests.length} provider call(s) (want 0)`);
      if (d.spends.n !== 0) problems.push(`${s.label}: spend reserved for a refused question`);
      if (rows.length !== 1 || leaked(JSON.stringify(rows)) > 0 || JSON.stringify(rows).includes(ZELDA.username)) problems.push(`${s.label}: the audit row is missing or carries a token`);
      if (leaked(JSON.stringify(r.body)) > 0) problems.push(`${s.label}: the refusal echoes the identifier`);
    } else {
      if (r.status !== 200) problems.push(`${s.label}: refused (${r.status}) — want an ordinary turn`);
      if (g.requests.length === 0) problems.push(`${s.label}: the provider was never called (vacuous)`);
      if (!s.p5 && lookups.n !== 0) problems.push(`${s.label}: a username lookup ran without P5 authority`);
    }
    if (g.requests.some((q) => leaked(q) > 0)) problems.push(`${s.label}: a sentinel reached the provider`);
  }
  return problems;
}

function readers(): CustomersPackReaders {
  const d = e0CustomerDtos(NOW);
  return {
    attention: async () => ({ fold: d.attention as never }), recentlyJoined: async () => d.recentlyJoined as never,
    profile: async (id) => (id === ZELDA.id ? d.profile as never : null),
    ridOf, resolveRid: async (rid) => byRid.get(rid) ?? null, now: () => NOW,
  };
}

/** The fixture CUSTOMER source (as cases/customers.ts; the Production one reads the DB — same contract). */
const SOURCE: RecordRenderSource = {
  t2Fields: ["name", "email"],
  revalidate: async (rid, area, guard) => (area === CUSTOMER_AREA && guard.csTier && byRid.has(rid) ? "CUSTOMER_SUCCESS" : null),
  t1: async (rid) => `user #${rid.slice(2)}`,
  linkedUserIds: async (rid) => [byRid.get(rid)!],
  t2: async () => null,
};

async function chipLabelNeverSent(ctx: UnitContext): Promise<string[]> {
  const problems: string[] = [];
  const part = ctx.scoped("cs", "CUSTOMER_SUCCESS");
  if (!part) return ["fixture CS operator not in scope"];
  // 1. The picker search returns the label to THIS operator only.
  const found = await searchPeople("e0sentinelz", {
    operatorId: ctx.operatorId("cs"), limit: async () => "ok",
    search: async () => [{ id: ZELDA.id, username: ZELDA.username, email: ZELDA.email }],
    refOf: (id) => E0_CUSTOMER_REF_TOKENS[id] ?? null, fingerprint: () => "0f0f0f0f", audit: async () => {}, clock: fakeClock(),
  });
  const m = found.matches[0];
  if (!m || m.label !== ZELDA.username) return ["the picker returned no labelled match (vacuous)"];
  // 2. The composer sends the chip token, never the label.
  const wire = serializeDraft(`Why is @${m.label} stuck? And [[cust:0badc0de]]?`, [{ ref: m.opaqueRef, label: m.label }]);
  if (wire.includes(m.label) || leaked(wire) > 0) problems.push("the serialised draft carries the label");
  // 3. The ask turn: guard (P5) passes, the chip resolves through OPAQUE_REF to a handle of THIS turn.
  const b = createTurnBoundary({
    operatorId: ctx.operatorId("cs"), correlationId: "e0-people-chip", areas: [part], binding: part.binding, recheck: ctx.recheck("cs"),
    packs: ["customers"], packEnabled: () => true, registry: customersPackTools(readers()) as never,
    recordSources: { [CUSTOMER_RECORD_KIND]: SOURCE },
  });
  const kinds: string[] = [];
  const sd: SubjectDeps = {
    operatorId: ctx.operatorId("cs"), primaryArea: "CUSTOMER_SUCCESS" as PlatformArea, enabled: () => true, limit: async () => "ok",
    eligibility: () => b.subjectEligibility(),
    lookup: async (id) => { kinds.push(id.kind); return id.kind === "OPAQUE_REF" ? byRef.get(id.normalized) ?? null : null; },
    audit: async () => {}, keyHash: () => "e0e0e0e0", clock: fakeClock(),
    mint: async (userId) => { const rid = ridOf(userId); return rid ? b.adoptSubject({ rk: CUSTOMER_RECORD_KIND, rid, area: CUSTOMER_AREA }) : null; },
  };
  const g = spyGenerate();
  const d = askDeps(ctx, g.generate, {
    guard: (raw) => runPickerGuard(raw, guardDeps({ p5: true })),
    subjects: { resolve: (ids) => resolveSubjects(ids, sd) },
  });
  const r = await handlePlatformAiAsk({ question: wire }, d);
  for (const q of g.requests) ctx.collect("provider_request", q);
  const sent = g.requests.join("\n");
  if (r.status !== 200 || g.requests.length === 0) problems.push(`the chip question did not become a turn (${r.status}) (vacuous)`);
  if (kinds.join() !== "OPAQUE_REF,OPAQUE_REF") problems.push(`the chips were not resolved through OPAQUE_REF (${kinds.join() || "none"})`);
  const h = /\[customer (h_[A-Za-z0-9_-]{16})\]/.exec(sent)?.[1];
  if (!h || b.recordRef(h)?.rid !== ridOf(ZELDA.id)) problems.push("the chip is not a handle of THIS turn bound to the keyed rid");
  if (!sent.includes(SUBJECT_UNRESOLVED_TEXT)) problems.push("the forged chip did not give the uniform not-resolved literal");
  if (sent.includes(m.label) || leaked(sent) > 0) problems.push("the label / a sentinel reached the provider");
  if (sent.includes(m.opaqueRef) || sent.includes("[[cust:")) problems.push("the chip reference reached the provider (want the per-turn handle only)");
  // 4. Conversation storage: the stored text of a chip is `[customer]` — no label, no reference.
  const { stored } = scrubWithSubjects(wire, true, { customers: true, incidents: false });
  if (stored.includes(m.label) || stored.includes(m.opaqueRef) || stored.includes("0badc0de") || leaked(stored) > 0) problems.push("the stored text carries the label or a reference");
  if (stored !== "Why is [customer] stuck? And [customer]?") problems.push("the stored text is not `[customer]` per chip");
  ctx.collect("response_body", stored);
  return problems;
}

export const PEOPLE_CASES: readonly UnitCase[] = [
  { kind: "unit", id: "people.guard-zero-provider", pack: "customers", gates: ["PEOPLE_PICKER_PRIVACY", "IDENTITY_LEAK"], run: guardZeroProvider },
  { kind: "unit", id: "people.chip-label-never-sent", pack: "customers", gates: ["PEOPLE_PICKER_PRIVACY", "IDENTITY_LEAK"], run: chipLabelNeverSent },
];
