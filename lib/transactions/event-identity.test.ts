/**
 * lib/transactions/event-identity.test.ts   (L8 — Part 9)
 *
 * The 18 standing invariants for event identity. Pure and DB-free; the ones that
 * need the corpus live in `scripts/audit-event-identity.ts`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  resolveEventLink, projectEvent, observationKey, isEventEligibleProvider,
  type ObservationFacts, type EventLinkContext,
} from "./event-identity";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const D = (s: string) => new Date(`${s}T00:00:00.000Z`);
const T = (s: string) => new Date(s);

const ctx = (o: Partial<EventLinkContext> = {}): EventLinkContext => ({
  eventByProviderRowId: new Map(),
  accountByProviderRowId: new Map(),
  claimsPerPendingRef: new Map(),
  ...o,
});
const obs = (o: Partial<ObservationFacts> = {}): ObservationFacts => ({
  observedAt: T("2026-07-17T10:00:00Z"),
  lifecycle: "POSTED",
  amount: -50,
  postingDate: D("2026-07-17"),
  economicDate: D("2026-07-17"),
  liveTransactionId: "tx1",
  ...o,
});

// ── 3. An explicit pending→posted reference always unifies the event ────────

test("INV-3: a provider pending→posted reference unifies the event", () => {
  const r = resolveEventLink(
    { transactionId: "posted", financialAccountId: "acct", providerRowId: "p2", providerPendingRef: "p1", persistedEventId: null },
    ctx({
      eventByProviderRowId: new Map([["p1", "event_1"]]),
      accountByProviderRowId: new Map([["p1", "acct"]]),
      claimsPerPendingRef: new Map([["p1", 1]]),
    }),
  );
  assert.equal(r.basis, "PROVIDER_PENDING_REF");
  assert.equal(r.eventId, "event_1");
});

test("INV-3b: the provider's claim OUTRANKS a persisted link", () => {
  const r = resolveEventLink(
    { transactionId: "posted", financialAccountId: "acct", providerRowId: "p2", providerPendingRef: "p1", persistedEventId: "stale_event" },
    ctx({
      eventByProviderRowId: new Map([["p1", "event_1"]]),
      accountByProviderRowId: new Map([["p1", "acct"]]),
      claimsPerPendingRef: new Map([["p1", 1]]),
    }),
  );
  assert.equal(r.eventId, "event_1", "the provider's own succession claim is rank 1");
});

// ── 12. No fuzzy matching may ever create identity ──────────────────────────

test("INV-12: identical amount, merchant, date and account create NO link", () => {
  // Two genuinely separate purchases. Nothing about them may fuse an identity.
  const r = resolveEventLink(
    { transactionId: "b", financialAccountId: "acct", providerRowId: "pB", providerPendingRef: null, persistedEventId: null },
    ctx({
      eventByProviderRowId: new Map([["pA", "event_A"]]),
      accountByProviderRowId: new Map([["pA", "acct"]]),
    }),
  );
  assert.equal(r.basis, "NEW_EVENT");
  assert.equal(r.eventId, null);
});

test("INV-12b: the authority contains no amount/merchant/date joining at all", () => {
  const logic = read("lib/transactions/event-identity.ts").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  for (const forbidden of ["merchant", "Math.abs", "86_400_000", "epsilon", "window"]) {
    assert.ok(!logic.includes(forbidden),
      `the identity authority must not reference "${forbidden}" — identity is provider evidence or a new event`);
  }
});

// ── Refusals — a link that looked possible but is not sound ─────────────────

test("a DANGLING reference becomes a new event, and says so", () => {
  const r = resolveEventLink(
    { transactionId: "posted", financialAccountId: "acct", providerRowId: "p2", providerPendingRef: "gone", persistedEventId: null },
    ctx({ claimsPerPendingRef: new Map([["gone", 1]]) }),
  );
  assert.equal(r.basis, "NEW_EVENT");
  assert.equal(r.refusal, "DANGLING_PENDING_REF");
});

test("a predecessor claimed TWICE unifies nothing — 1:1 or nothing", () => {
  const r = resolveEventLink(
    { transactionId: "posted", financialAccountId: "acct", providerRowId: "p2", providerPendingRef: "p1", persistedEventId: null },
    ctx({
      eventByProviderRowId: new Map([["p1", "event_1"]]),
      accountByProviderRowId: new Map([["p1", "acct"]]),
      claimsPerPendingRef: new Map([["p1", 2]]),
    }),
  );
  assert.equal(r.refusal, "AMBIGUOUS_PREDECESSOR");
  assert.equal(r.eventId, null);
});

test("a cross-account reference is refused — a provider bug, not a movement", () => {
  const r = resolveEventLink(
    { transactionId: "posted", financialAccountId: "acctA", providerRowId: "p2", providerPendingRef: "p1", persistedEventId: null },
    ctx({
      eventByProviderRowId: new Map([["p1", "event_1"]]),
      accountByProviderRowId: new Map([["p1", "acctB"]]),
      claimsPerPendingRef: new Map([["p1", 1]]),
    }),
  );
  assert.equal(r.refusal, "CROSS_ACCOUNT_REF");
});

// ── 7. Economic date does not move on posting ───────────────────────────────

test("INV-7: the economic date comes from the FIRST observation, never the latest", () => {
  const p = projectEvent([
    obs({ observedAt: T("2026-07-17T10:00:00Z"), lifecycle: "PENDING", postingDate: D("2026-07-17"), economicDate: D("2026-07-17"), liveTransactionId: null }),
    // Posting arrives two days later with a LATER posting date...
    obs({ observedAt: T("2026-07-19T10:00:00Z"), lifecycle: "POSTED", postingDate: D("2026-07-19"), economicDate: D("2026-07-17") }),
  ]);
  assert.equal(p.economicDate.toISOString().slice(0, 10), "2026-07-17", "posting must not move when it happened");
  assert.equal(p.lifecycle, "POSTED");
});

test("INV-8: posting date remains provenance — the event stores no posting date", () => {
  const schema = read("prisma/schema.prisma");
  const model = schema.slice(schema.indexOf("model TransactionEvent"), schema.indexOf("model TransactionObservation"));
  assert.ok(!/postingDate/.test(model), "the EVENT carries the economic date; posting lives on the OBSERVATION");
  const observation = schema.slice(schema.indexOf("model TransactionObservation"));
  assert.match(observation.slice(0, 1600), /postingDate/, "each observation records the posting date it saw");
});

// ── 4 / 9 / 10 / 11 — lifecycle projection ─────────────────────────────────

test("INV-4: a pending and its posted successor never both count as current", () => {
  const p = projectEvent([
    obs({ observedAt: T("2026-07-17T10:00:00Z"), lifecycle: "PENDING", liveTransactionId: null }), // tombstoned
    obs({ observedAt: T("2026-07-19T10:00:00Z"), lifecycle: "POSTED", liveTransactionId: "tx_posted" }),
  ]);
  assert.equal(p.currentTransactionId, "tx_posted");
  assert.equal(p.observationCount, 2, "both observations survive — only one is current");
});

test("INV-9: an amount restatement stays observable and moves the current amount", () => {
  const p = projectEvent([
    obs({ observedAt: T("2026-07-17T10:00:00Z"), lifecycle: "PENDING", amount: -50, liveTransactionId: null }),
    obs({ observedAt: T("2026-07-19T10:00:00Z"), lifecycle: "POSTED", amount: -54.25 }),
  ]);
  assert.equal(p.currentAmount, -54.25, "the latest observation reports the current amount");
  assert.equal(p.observationCount, 2, "the earlier amount is NOT rewritten — it is still an observation");
});

test("INV-10: a withdrawn pending event remains represented", () => {
  const p = projectEvent([
    obs({ lifecycle: "PENDING", liveTransactionId: null }), // tombstoned, never posted
  ]);
  assert.equal(p.lifecycle, "WITHDRAWN");
  assert.equal(p.currentTransactionId, null);
  assert.equal(p.observationCount, 1, "the authorization the provider took back is still on the record");
});

test("INV-11: a first-observed-posted row is a valid single-observation event", () => {
  const p = projectEvent([obs({ lifecycle: "POSTED", liveTransactionId: "tx1" })]);
  assert.equal(p.lifecycle, "POSTED");
  assert.equal(p.observationCount, 1);
  assert.equal(p.currentTransactionId, "tx1");
});

test("a live pending with no successor is PENDING, not WITHDRAWN", () => {
  const p = projectEvent([obs({ lifecycle: "PENDING", liveTransactionId: "tx_pending" })]);
  assert.equal(p.lifecycle, "PENDING");
});

test("projection is order-independent", () => {
  const a = obs({ observedAt: T("2026-07-17T10:00:00Z"), lifecycle: "PENDING", liveTransactionId: null });
  const b = obs({ observedAt: T("2026-07-19T10:00:00Z"), lifecycle: "POSTED", liveTransactionId: "tx2" });
  const p1 = projectEvent([a, b]), p2 = projectEvent([b, a]);
  assert.deepEqual(p1, p2);
});

test("an event with no observations is an error, not an empty projection", () => {
  assert.throws(() => projectEvent([]), /at least one observation/);
});

// ── 6. Replay idempotence ──────────────────────────────────────────────────

test("INV-6: the same provider payload yields the same observation key", () => {
  const base = {
    provider: "PLAID", financialAccountId: "acct", providerRowId: "p1", transactionId: "tx1",
    lifecycle: "POSTED" as const, amount: -50, postingDate: D("2026-07-17"), economicDate: D("2026-07-17"),
  };
  assert.equal(observationKey(base), observationKey({ ...base }));
  // ...and a genuine restatement does NOT.
  assert.notEqual(observationKey(base), observationKey({ ...base, amount: -54.25 }));
  assert.notEqual(observationKey(base), observationKey({ ...base, lifecycle: "PENDING" }));
  assert.notEqual(observationKey(base), observationKey({ ...base, postingDate: D("2026-07-19") }));
});

test("INV-6b: the key ignores OUR derivations, not the provider's facts", () => {
  // Merchant cleanup and re-classification change on 16% and 3% of chains. If
  // they minted observations, every enrichment pass would forge provider history.
  const material = read("lib/transactions/event-identity.ts")
    .slice(read("lib/transactions/event-identity.ts").indexOf("export function observationKeyMaterial"));
  for (const derived of ["merchant", "category", "flowType", "description", "counterparty"]) {
    assert.ok(!material.slice(0, 900).includes(derived),
      `the observation key must not include our derived field "${derived}"`);
  }
});

// ── 17. Crypto must not enter the banking tables ───────────────────────────

test("INV-17: WALLET and EXCHANGE are not event-eligible", () => {
  assert.equal(isEventEligibleProvider("PLAID"), true);
  assert.equal(isEventEligibleProvider("CSV"), true);
  assert.equal(isEventEligibleProvider("MANUAL"), true);
  assert.equal(isEventEligibleProvider("WALLET"), false, "a wallet transaction has no pending↔posted lifecycle");
  assert.equal(isEventEligibleProvider("EXCHANGE"), false);
});

test("INV-17b: the crypto writers never reach the event authority", () => {
  for (const f of ["lib/crypto/btc-sync.ts"]) {
    const src = read(f);
    assert.ok(!/event-write|recordTransactionObservation/.test(src),
      `${f} must not write banking event identity — crypto gets its own domain implementation`);
  }
});

// ── 1 / 2 / 5 — structural, from the schema ────────────────────────────────

test("INV-1/2/5: one observation → one event; one row → at most one event; observations immutable", () => {
  const schema = read("prisma/schema.prisma");
  // 1 — an observation has exactly one eventId, non-null.
  assert.match(schema, /eventId String\n\s*event\s+TransactionEvent @relation/);
  // 2 — a Transaction has at most one event link, and an event has at most one
  //     live row.
  assert.match(schema, /transactionEventId String\?/);
  assert.match(schema, /currentTransactionId String\? @unique/);
  // 5 — immutability is enforced by there being no updater. The write authority
  //     creates observations and never updates one.
  const writeSrc = read("lib/transactions/event-write.ts");
  assert.ok(!/transactionObservation\.update/.test(writeSrc),
    "an observation must never be updated — a restatement APPENDS");
  assert.ok(!/transactionObservation\.delete/.test(writeSrc),
    "an observation must never be deleted — history is not editable");
});

// ── 18. No consumer reads partial L8 state ─────────────────────────────────

test("INV-18: no BEHAVIOURAL reader consumes event identity — the cutover is a separate slice", () => {
  // ⚠️ `lib/data/transactions.ts` is deliberately ABSENT from this list. Its
  // detail read exposes an `eventIdentity` PROVENANCE block, which the L8 brief
  // explicitly permits for verification. The distinction is behaviour: nothing
  // in that block feeds a total, an ordering, a grouping, a classification or a
  // projection — the modules below are where such a read would change what a
  // user sees, and they must stay clean until the cutover.
  const CONSUMERS = [
    "lib/data/transaction-query-core.ts",
    "lib/data/transaction-query.ts",
    "lib/data/transaction-count.ts",
    "lib/transactions/cash-flow-projection.ts",
    "lib/transactions/serialize.ts",
    "lib/ai/assemblers/transactions.ts",
    "lib/export/csv.ts",
  ];
  for (const f of CONSUMERS) {
    const logic = read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
    assert.ok(!/transactionEventId|TransactionEvent|transactionObservation/.test(logic),
      `${f} already reads L8 state — the reader cutover must land as ONE slice, not piecemeal`);
  }
});

test("only the write authority touches the L8 tables", () => {
  // Any other writer would be a second identity authority.
  const ALLOWED = new Set([
    "lib/transactions/event-write.ts",
    "scripts/backfill-event-identity.ts",
    "scripts/audit-event-identity.ts",
  ]);
  const roots = ["lib", "app", "components", "jobs", "scripts"];
  const walk = (d: string, out: string[] = []): string[] => {
    let entries: string[] = [];
    try { entries = readdirSync(join(process.cwd(), d)); } catch { return out; }
    for (const e of entries) {
      if (e === "node_modules" || e.startsWith(".")) continue;
      const rel = `${d}/${e}`;
      if (statSync(join(process.cwd(), rel)).isDirectory()) walk(rel, out);
      else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(rel);
    }
    return out;
  };
  const offenders = roots.flatMap((r) => walk(r))
    .filter((f) => !f.startsWith("prototype/") && !ALLOWED.has(f))
    .filter((f) => /transactionObservation\.(create|update|delete)|transactionEvent\.(create|update|delete)/
      .test(read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "")));
  assert.deepEqual(offenders, [], "these modules write L8 tables directly instead of through event-write.ts");
});
