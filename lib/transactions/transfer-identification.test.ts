/**
 * lib/transactions/transfer-identification.test.ts
 *
 * v2.6-XFER-1 — identification outranks silence, and can do nothing else.
 *
 * ── The gap ─────────────────────────────────────────────────────────────────
 *
 * `legsQualify` used the extracted account mask SUBTRACTIVELY: a leg naming an
 * account that is not the other side is disqualified. It could not PREFER a leg
 * that names the right one, so among survivors "names the counterparty" and
 * "names nothing" counted the same — a tie where the evidence had a winner.
 *
 * Live, three AMEX savings→checking transfers ($6,500), all refused:
 *
 *   source  AMEX High Yield Savings (mask 5336)  −500
 *           "Requested transfer to AMEX checking account"
 *   cand A  AMEX Rewards Checking  +500  "Internal Transfer Credit: Savings -5336"
 *   cand B  AMEX Platinum Card®    +500  "MOBILE PAYMENT - THANK YOU"
 *
 * A names the source account. B is a genuine card payment coinciding in amount,
 * day and institution. Candidates spanned checking + debt ⇒ TYPE_AMBIGUOUS.
 *
 * ── What the rung may and may not do ────────────────────────────────────────
 *
 * It NARROWS a qualifying set; it is not a new level. Everything below it runs
 * unchanged, so the claim reached is still one the surviving evidence supports.
 * These probes pin the boundaries: it must break a tie, and it must be incapable
 * of inventing a candidate, outranking a contradiction, or firing when there is
 * no tie to break.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  narrowByIdentification,
  resolveDestinationEvidence,
  type DestinationCandidate,
} from "@/lib/transactions/transfer-maturation";

/** A qualifying candidate leg. `names` = the account its descriptor identified. */
const cand = (o: {
  legId: string; accountId: string; accountType: string;
  competing?: number; identifies?: boolean;
}): DestinationCandidate => ({
  legId: o.legId, accountId: o.accountId, accountType: o.accountType,
  competingSourceCount: o.competing ?? 1, superseded: false,
  identifiesSource: o.identifies ?? false,
});

// ── 1. The live case ────────────────────────────────────────────────────────
test("XFER-1: an identified leg outranks a silent rival of another type", () => {
  const checking = cand({ legId: "chk-leg", accountId: "chk", accountType: "checking", identifies: true });
  const card     = cand({ legId: "card-leg", accountId: "card", accountType: "debt" });
  const e = resolveDestinationEvidence([checking, card], { competingSourceCount: 1 });
  assert.equal(e.level, "ACCOUNT_CERTAIN", "the identified leg must win the tie");
  assert.equal(e.accountId, "chk");
  assert.equal(e.legId, "chk-leg");
  assert.ok(e.persistableCounterparty);

  // Without identification the SAME pair is correctly refused — proving the
  // change comes from the evidence and not from a loosened rung.
  const blind = resolveDestinationEvidence(
    [{ ...checking, identifiesSource: false }, card], { competingSourceCount: 1 });
  assert.equal(blind.level, "TYPE_AMBIGUOUS");
  assert.equal(blind.unresolvedReason, "CANDIDATES_SPAN_TYPES");
});

// ── 2. It only breaks TIES ──────────────────────────────────────────────────
test("XFER-1: no narrowing when every candidate identifies, or none does", () => {
  const a = cand({ legId: "a", accountId: "chk", accountType: "checking", identifies: true });
  const b = cand({ legId: "b", accountId: "sav", accountType: "savings", identifies: true });
  // Both identify — there is no tie to break, so the set is unchanged and the
  // existing rungs decide (two accounts, two types ⇒ ambiguous).
  const both = resolveDestinationEvidence([a, b], { competingSourceCount: 1 });
  assert.equal(both.level, "TYPE_AMBIGUOUS");

  // None identifies — unchanged behaviour.
  const none = resolveDestinationEvidence(
    [{ ...a, identifiesSource: false }, { ...b, identifiesSource: false }], { competingSourceCount: 1 });
  assert.equal(none.level, "TYPE_AMBIGUOUS");
});

// ── 3. It cannot invent a candidate ─────────────────────────────────────────
test("XFER-1: narrowing can only ever REMOVE candidates", () => {
  const pool = [
    cand({ legId: "a", accountId: "chk", accountType: "checking", identifies: true }),
    cand({ legId: "b", accountId: "card", accountType: "debt" }),
    cand({ legId: "c", accountId: "sav", accountType: "savings" }),
  ];
  const kept = narrowByIdentification(
    pool.map((c) => ({ ...c, maskedDestinationAccountId: c.identifiesSource ? "src" : null })), "src");
  assert.ok(kept.length <= pool.length, "narrowing must never grow the set");
  assert.ok(kept.every((k) => pool.some((p) => p.legId === k.legId)), "every survivor was already a candidate");
  assert.equal(kept.length, 1);
  assert.equal(kept[0].legId, "a");
});

// ── 4. An empty or total identified set changes nothing ─────────────────────
test("XFER-1: narrowByIdentification is identity when there is no strict subset", () => {
  const legs = [
    { legId: "a", maskedDestinationAccountId: "src" },
    { legId: "b", maskedDestinationAccountId: "src" },
  ];
  assert.equal(narrowByIdentification(legs, "src").length, 2, "all identified ⇒ no narrowing");
  assert.equal(narrowByIdentification(legs, "other").length, 2, "none identified ⇒ no narrowing");
  assert.equal(narrowByIdentification([], "src").length, 0);
});

// ── 5. It cannot outrank a CONTRADICTION ────────────────────────────────────
test("XFER-1: a leg naming a DIFFERENT account is not silent, and is never outranked here", () => {
  // `legsQualify` removes a leg that names some other account, so such a leg can
  // never reach this rung. Asserting it means a future change to that predicate
  // degrades to "no narrowing" rather than to "prefer over a contradiction".
  const legs = [
    { legId: "identified", maskedDestinationAccountId: "src" },
    { legId: "contradicts", maskedDestinationAccountId: "someone-else" },
  ];
  assert.equal(
    narrowByIdentification(legs, "src").length, 2,
    "a contradicting leg is not silent — with one present, nothing is preferred",
  );
});

// ── 6. Mutual uniqueness still governs the level ────────────────────────────
test("XFER-1: identification does not bypass the pigeonhole rungs", () => {
  // Identified, but the leg is itself contested by two sources ⇒ the account is
  // a fact and the leg is not. Identification firms up WHICH ACCOUNT, never
  // WHICH ROW, and must not manufacture ACCOUNT_CERTAIN.
  const contested = cand({
    legId: "x", accountId: "chk", accountType: "checking", identifies: true, competing: 2,
  });
  const silentRival = cand({ legId: "y", accountId: "card", accountType: "debt" });
  const e = resolveDestinationEvidence([contested, silentRival], { competingSourceCount: 2 });
  // 1 surviving leg, 2 competing sources ⇒ pigeonhole fails (2 > 1), so neither
  // the leg NOR the account is established. Identification narrowed the field;
  // it did not and must not manufacture certainty the arithmetic denies.
  assert.notEqual(e.level, "ACCOUNT_CERTAIN", "a contested leg must not reach mutual certainty");
  assert.equal(e.level, "TYPE_CERTAIN_ACCOUNT_AMBIGUOUS");
  assert.equal(e.legId, null, "the leg is unknowable and must never be claimed");
  assert.equal(e.persistableCounterparty, false, "nothing may be persisted from a refused pigeonhole");
});

// ── 7. Supersession still wins ──────────────────────────────────────────────
test("XFER-1: a superseded identified leg is dropped before the rung runs", () => {
  const superseded = { ...cand({ legId: "old", accountId: "chk", accountType: "checking", identifies: true }), superseded: true };
  const live = cand({ legId: "new", accountId: "card", accountType: "debt" });
  const e = resolveDestinationEvidence([superseded, live], { competingSourceCount: 1 });
  assert.equal(e.accountId, "card", "a superseded leg must not win on identification");
});
