/**
 * lib/transactions/transfer-authority.test.ts
 *
 * The canonical Transfer Resolution Authority — Phases 1–5.
 *
 * Pure and DB-free: runnable under `npx tsx lib/transactions/transfer-authority.test.ts`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  admitTransferCandidate, isTransferShaped, ADMISSION_LABEL, isAdmissionBacklog,
  ADMISSIBLE_FLOW_TYPES,
} from "./transfer-admission";
import {
  resolveDestinationEvidenceFor, buildTransferCorpusIndex, legsQualify,
  legsQualifyIgnoringOwner, maturityForEvidence, isUnresolvedMaturity,
  MATURITY_LABEL, UNRESOLVED_REASON_LABEL, EXTERNAL_MATURITIES, TERMINAL_MATURITIES,
  STRATIFIED_MATCH_TIERS, TRANSFER_MATCH_WINDOW_DAYS, TRANSFER_PREFILTER_FLOW_TYPES,
  isTransferPrefilterCandidate, impliedFlowType,
  type TransferLeg, type TransferMaturity,
} from "./transfer-maturation";
import { providerLinkKey, validateProviderLinkGroup } from "./provider-link";
import { extractProviderLinks } from "./provider-link-extract";

const DAY = 86_400_000;
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

function mk(o: Partial<TransferLeg> & { id: string }): TransferLeg {
  return {
    accountId: "a", accountType: "checking", ownerId: "u",
    amount: -100, currency: "USD", dateMs: 0, superseded: false,
    movementForm: null, providerLinkKey: null, maskedDestinationAccountId: null,
    ...o,
  };
}
const own = (o: Partial<Parameters<typeof maturityForEvidence>[1]> & { accountType: string; amount: number }) =>
  ({ railType: null, venueClass: null, counterpartyClass: null, ...o });

// ═══ PHASE 1 — canonical admission ══════════════════════════════════════════

test("P1: an UNCLASSIFIED row is a backlog, never a transfer candidate", () => {
  const r = admitTransferCandidate({
    flowType: null, amount: -100, accountType: "checking", accountId: "a",
    category: "Transfer", providerFamily: "TRANSFER_OUT",
  });
  // Transfer-shaped by BOTH category and family, and still refused: no
  // classifier has ruled, so the authority declines to act on a hypothesis
  // nobody formed. 352 live rows sit here.
  assert.equal(r, "NOT_CLASSIFIED");
  assert.equal(isAdmissionBacklog(r), true);
});

test("P1: the test is flowType === null, NOT classifierVersion === null", () => {
  // A FOREIGN-AUTHORITY row (btc-sync writes flowType, never classifierVersion)
  // IS classified. Excluding it would silently drop every on-chain transfer.
  assert.equal(admitTransferCandidate({
    flowType: "TRANSFER", amount: -1, accountType: "crypto", accountId: "a",
    category: "Transfer",
  }), "ADMITTED");
  const src = read("lib/transactions/transfer-admission.ts");
  assert.ok(!/classifierVersion/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "")),
    "admission must not branch on classifierVersion");
});

test("P1: a liability OUTFLOW is a charge and never enters the corpus", () => {
  assert.equal(admitTransferCandidate({
    flowType: "TRANSFER", amount: -68.4, accountType: "debt", accountId: "a",
    providerFamily: "TRANSFER_OUT",
  }), "LIABILITY_CHARGE");
  // ...while the INFLOW side still enters — that is the debt-payment path.
  assert.equal(admitTransferCandidate({
    flowType: "TRANSFER", amount: 68.4, accountType: "debt", accountId: "a",
    providerFamily: "LOAN_PAYMENTS",
  }), "ADMITTED");
});

test("P1: classified but shapeless is refused, and named as such", () => {
  assert.equal(admitTransferCandidate({
    flowType: "UNKNOWN", amount: -12, accountType: "checking", accountId: "a",
    category: "Other",
  }), "NOT_TRANSFER_SHAPED");
});

test("P1: shape is provider-AGNOSTIC — four independent sources", () => {
  const base = { flowType: "TRANSFER", amount: -1, accountType: "checking", accountId: "a" };
  assert.ok(isTransferShaped({ ...base, providerFamily: "TRANSFER_IN" }));
  assert.ok(isTransferShaped({ ...base, category: "Payment" }));
  assert.ok(isTransferShaped({ ...base, railType: "PAYMENT_APP" }));
  assert.ok(isTransferShaped({ ...base, venueClass: "BROKERAGE" }));
  // An institution supplying NONE of them yields an honest refusal, not a guess.
  assert.ok(!isTransferShaped({ ...base }));
});

test("P1: seed data is excluded BY PREDICATE — no owner or institution in the LOGIC", () => {
  // Comments stripped: the header explains WHY these never appear, and the probe
  // must not fire on its own explanation. (The inverse of the `logic()` trap —
  // here the evidence is in the code, not in the prose.)
  const src = read("lib/transactions/transfer-admission.ts").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  for (const forbidden of ["Demo Bank", "Beacon", "Alpha ", "Summit", "cmrr", "ownerUserId", "institution"]) {
    assert.ok(!src.includes(forbidden),
      `admission logic must not mention "${forbidden}" — a hard-coded exclusion generalizes to nothing`);
  }
});

test("P1: every admission verdict has a label and exactly one applies", () => {
  const verdicts = ["ADMITTED", "NOT_CLASSIFIED", "NOT_A_TRANSFER_FLOW", "LIABILITY_CHARGE",
    "NOT_TRANSFER_SHAPED", "ZERO_AMOUNT", "NO_ACCOUNT"] as const;
  for (const v of verdicts) assert.ok(ADMISSION_LABEL[v], `${v} needs a label`);
  // Precedence: structural impossibility outranks everything.
  assert.equal(admitTransferCandidate({ flowType: null, amount: 0, accountType: "debt", accountId: null }), "NO_ACCOUNT");
  assert.equal(admitTransferCandidate({ flowType: null, amount: 0, accountType: "debt", accountId: "a" }), "ZERO_AMOUNT");
});

test("P1: admitted ⊆ prefiltered — the query can never drop an admitted row", () => {
  // The one invariant that makes a broad DB prefilter safe alongside a precise
  // in-memory rule. If admission ever admitted a flowType the prefilter excludes,
  // the query would silently starve the authority.
  for (const ft of ADMISSIBLE_FLOW_TYPES) {
    assert.ok(isTransferPrefilterCandidate(ft), `prefilter must not drop ${ft}`);
    assert.ok(TRANSFER_PREFILTER_FLOW_TYPES.includes(ft));
  }
});

// ═══ PHASE 2 — the stratified structural ladder ═════════════════════════════

test("P2: same-day pairs are claimed FIRST, freeing the ±window tier", () => {
  // The measured mechanism: a Monday $1,000 and a Wednesday $1,000 defeat each
  // other under a single ±5 pass. Resolving day-0 first removes both legs of the
  // Monday pair, so Wednesday's pair becomes unique.
  const legs = [
    mk({ id: "outA", accountId: "chk", amount: -1000, dateMs: 0 }),
    mk({ id: "inA",  accountId: "sav", accountType: "savings", amount: 1000, dateMs: 0 }),
    mk({ id: "outB", accountId: "chk", amount: -1000, dateMs: 2 * DAY }),
    mk({ id: "inB",  accountId: "sav", accountType: "savings", amount: 1000, dateMs: 2 * DAY }),
  ];
  for (const id of ["outA", "inA", "outB", "inB"]) {
    const e = resolveDestinationEvidenceFor(legs.find((l) => l.id === id)!, legs);
    assert.equal(e.level, "ACCOUNT_CERTAIN", `${id} should resolve under stratification`);
  }
  // Sanity: a SINGLE ±5 tier cannot do this — every leg sees two rivals.
  const idx = buildTransferCorpusIndex(legs);
  assert.equal(idx.claimed.size, 4);
});

test("P2: the tiers are [0, window] and the window itself is unchanged", () => {
  assert.deepEqual([...STRATIFIED_MATCH_TIERS], [0, TRANSFER_MATCH_WINDOW_DAYS]);
  // ⚠️ Widening past the window is NOT a tier — the gap histogram rises again on
  // recurrence, so a wider tier manufactures cross-month pairs.
  assert.ok(Math.max(...STRATIFIED_MATCH_TIERS) === TRANSFER_MATCH_WINDOW_DAYS);
});

test("P2: stratification is deterministic and order-independent", () => {
  const build = (order: number[]) => {
    const legs = [
      mk({ id: "a", accountId: "c", amount: -50, dateMs: 0 }),
      mk({ id: "b", accountId: "s", accountType: "savings", amount: 50, dateMs: 0 }),
      mk({ id: "c", accountId: "c", amount: -50, dateMs: 3 * DAY }),
      mk({ id: "d", accountId: "s", accountType: "savings", amount: 50, dateMs: 3 * DAY }),
    ];
    return buildTransferCorpusIndex(order.map((i) => legs[i]));
  };
  const x = build([0, 1, 2, 3]), y = build([3, 2, 1, 0]), z = build([2, 0, 3, 1]);
  const norm = (i: ReturnType<typeof build>) =>
    [...i.claims.entries()].map(([k, v]) => `${k}->${v.mateId}:${v.tier}`).sort().join("|");
  assert.equal(norm(x), norm(y));
  assert.equal(norm(x), norm(z));
});

test("P2: every unresolved outcome carries a NAMED limitation", () => {
  const src = mk({ id: "s", accountId: "chk", amount: -100 });
  const e = resolveDestinationEvidenceFor(src, [src]);
  const m = maturityForEvidence(e, own({ accountType: "checking", amount: -100 }));
  assert.ok(isUnresolvedMaturity(m));
  assert.equal(e.unresolvedReason, "NO_COUNTERPART_EVIDENCE");
  assert.ok(UNRESOLVED_REASON_LABEL[e.unresolvedReason!], "a named limitation must be renderable");
});

test("P2: CROSS_OWNER is DETECTED and named, never matched", () => {
  const mine  = mk({ id: "mine", accountId: "chk", ownerId: "u1", amount: -500 });
  const yours = mk({ id: "yours", accountId: "joint", accountType: "savings", ownerId: "u2", amount: 500 });
  const e = resolveDestinationEvidenceFor(mine, [mine, yours]);
  assert.equal(e.level, "NO_DESTINATION_EVIDENCE");
  assert.equal(e.accountId, null, "the ownership boundary must still hold");
  assert.equal(e.unresolvedReason, "CROSS_OWNER_BOUNDARY");
  assert.equal(e.crossOwnerCandidateCount, 1);
  // And the predicate itself still refuses to pair them.
  assert.equal(legsQualify(mine, yours), false);
  assert.equal(legsQualifyIgnoringOwner(mine, yours), true);
});

// ═══ PHASE 3 — ACCOUNT_CERTAIN_LEG_AMBIGUOUS ════════════════════════════════

test("P3: two legs in ONE account ⇒ account certain, leg refused", () => {
  const s  = mk({ id: "s", accountId: "chk", amount: -2000 });
  const l1 = mk({ id: "l1", accountId: "card", accountType: "debt", amount: 2000, dateMs: 1 * DAY });
  const l2 = mk({ id: "l2", accountId: "card", accountType: "debt", amount: 2000, dateMs: 2 * DAY });
  const e = resolveDestinationEvidenceFor(s, [s, l1, l2]);
  assert.equal(e.level, "ACCOUNT_CERTAIN_LEG_AMBIGUOUS");
  assert.equal(e.accountId, "card");
  assert.equal(e.legId, null, "the leg is unknowable and must never be invented");
  assert.equal(e.persistableCounterparty, true);
  assert.equal(e.persistableLeg, false);
});

test("P3: pigeonhole — MORE sources than legs refuses the rung", () => {
  const s1 = mk({ id: "s1", accountId: "chk", amount: -1000 });
  const s2 = mk({ id: "s2", accountId: "chk2", amount: -1000 });
  const l  = mk({ id: "l", accountId: "sav", accountType: "savings", amount: 1000, dateMs: 1 * DAY });
  const e = resolveDestinationEvidenceFor(s1, [s1, s2, l]);
  assert.equal(e.level, "TYPE_CERTAIN_ACCOUNT_AMBIGUOUS");
  assert.equal(e.accountId, null, "one of the two sources did not land here, and nothing says which");
  assert.equal(e.persistableCounterparty, false);
});

test("P3: the account claim survives; only the row is lost", () => {
  const s  = mk({ id: "s", accountId: "chk", amount: -2000 });
  const l1 = mk({ id: "l1", accountId: "sav", accountType: "savings", amount: 2000, dateMs: 1 * DAY });
  const l2 = mk({ id: "l2", accountId: "sav", accountType: "savings", amount: 2000, dateMs: 2 * DAY });
  const e = resolveDestinationEvidenceFor(s, [s, l1, l2]);
  const m = maturityForEvidence(e, own({ accountType: "checking", amount: -2000 }));
  assert.equal(m, "SAVINGS_TRANSFER", "the movement is fully named");
  assert.equal(isUnresolvedMaturity(m), false);
});

// ═══ PHASE 4 — external terminal states ════════════════════════════════════

test("P4: a payment-app rail with no owned leg is a COMPLETED fact", () => {
  const s = mk({ id: "s", accountId: "chk", amount: -100 });
  const e = resolveDestinationEvidenceFor(s, [s]);
  const m = maturityForEvidence(e, own({ accountType: "checking", amount: -100, railType: "PAYMENT_APP" }));
  assert.equal(m, "EXTERNAL_PERSON_TRANSFER");
  assert.equal(isUnresolvedMaturity(m), false, "an external movement is not an unresolved one");
  assert.equal(MATURITY_LABEL[m], "Sent to someone else");
});

test("P4: venue outranks rail, mirroring deriveTransferDisposition", () => {
  const s = mk({ id: "s", accountId: "chk", amount: -100 });
  const e = resolveDestinationEvidenceFor(s, [s]);
  assert.equal(maturityForEvidence(e, own({
    accountType: "checking", amount: -100, railType: "PAYMENT_APP", venueClass: "BROKERAGE",
  })), "EXTERNAL_VENUE_TRANSFER");
  assert.equal(maturityForEvidence(e, own({
    accountType: "checking", amount: -100, venueClass: "DEPOSITORY",
  })), "EXTERNAL_DEPOSITORY_TRANSFER");
});

test("P4: NO attestation ⇒ still UNRESOLVED — absence is not externality", () => {
  const s = mk({ id: "s", accountId: "chk", amount: -100 });
  const e = resolveDestinationEvidenceFor(s, [s]);
  // The other side may simply not be synced yet. Claiming "external" here would
  // be the manufactured certainty this whole arc removes.
  assert.equal(maturityForEvidence(e, own({ accountType: "checking", amount: -100 })), "UNRESOLVED_TRANSFER");
});

test("P4: FINANCIAL_INSTITUTION is NOT external evidence", () => {
  const s = mk({ id: "s", accountId: "chk", amount: -100 });
  const e = resolveDestinationEvidenceFor(s, [s]);
  // Your own bank is a financial institution — the class is consistent with an
  // internal transfer whose other leg has not arrived.
  assert.equal(maturityForEvidence(e, own({
    accountType: "checking", amount: -100, counterpartyClass: "FINANCIAL_INSTITUTION",
  })), "UNRESOLVED_TRANSFER");
  assert.equal(maturityForEvidence(e, own({
    accountType: "checking", amount: -100, counterpartyClass: "MERCHANT",
  })), "EXTERNAL_UNKNOWN_TRANSFER");
});

test("P4: external leaves are terminal but NOT vetoed — a real leg still corrects them", () => {
  for (const m of EXTERNAL_MATURITIES) {
    assert.ok(TERMINAL_MATURITIES.has(m));
    assert.equal(isUnresolvedMaturity(m), false);
    assert.ok(MATURITY_LABEL[m], `${m} needs a label`);
    // They must imply TRANSFER, so naming them triggers no reclassification.
    assert.equal(impliedFlowType(m), "TRANSFER");
  }
  const src = read("lib/transactions/transfer-maturation.ts");
  const guard = src.slice(src.indexOf("export function adoptIfMonotonic"));
  assert.ok(!/EXTERNAL_/.test(guard),
    "no external leaf may carry a cash-style veto — it must stay correctable");
});

test("P4: ACH and WIRE are deliberately NOT maturities", () => {
  const src = read("lib/transactions/transfer-maturation.ts");
  for (const rail of ["\"ACH\"", "\"WIRE\"", "ACH_TRANSFER", "WIRE_TRANSFER"]) {
    assert.ok(!src.includes(rail),
      `${rail} is a RAIL (how), not a destination (where) — mixing the axes is forbidden`);
  }
});

// ═══ PHASE 5 — provider evidence ═══════════════════════════════════════════

test("P5: a link key is opaque, institution-scoped and extractor-scoped", () => {
  const raw = "30039468383";
  const a = providerLinkKey({ institutionId: "ins_56", extractorId: "chase/online-transfer", rawToken: raw });
  const b = providerLinkKey({ institutionId: "ins_10", extractorId: "chase/online-transfer", rawToken: raw });
  const c = providerLinkKey({ institutionId: "ins_56", extractorId: "other/x", rawToken: raw });
  assert.notEqual(a, b, "two institutions sharing a numeral must not collide");
  assert.notEqual(a, c, "a new extractor must not retroactively merge old groups");
  assert.equal(a, providerLinkKey({ institutionId: "ins_56", extractorId: "chase/online-transfer", rawToken: raw }));
  assert.ok(!a.includes(raw), "the raw provider token must never survive into the key");
  assert.match(a, /^[0-9a-f]{32}$/);
});

test("P5: a provider group must survive EVERY validation or produce nothing", () => {
  const base = { legId: "x", accountId: "a", ownerId: "u", amount: -100, currency: "USD", dateMs: 0, superseded: false };
  const bounds = { windowDays: 5, amountEpsilon: 0.005 };
  const ok = validateProviderLinkGroup(
    [base, { ...base, legId: "y", accountId: "b", amount: 100 }], bounds);
  assert.equal(ok.valid, true);
  const cases: [string, Parameters<typeof validateProviderLinkGroup>[0]][] = [
    ["CARDINALITY_NOT_TWO", [base]],
    ["SAME_ACCOUNT",  [base, { ...base, legId: "y", amount: 100 }]],
    ["CROSS_OWNER",   [base, { ...base, legId: "y", accountId: "b", ownerId: "v", amount: 100 }]],
    ["SAME_SIGN",     [base, { ...base, legId: "y", accountId: "b" }]],
    ["CURRENCY_MISMATCH", [base, { ...base, legId: "y", accountId: "b", amount: 100, currency: "EUR" }]],
    ["AMOUNT_MISMATCH",   [base, { ...base, legId: "y", accountId: "b", amount: 101 }]],
    ["OUTSIDE_WINDOW",    [base, { ...base, legId: "y", accountId: "b", amount: 100, dateMs: 9 * DAY }]],
    ["SUPERSEDED_LEG",    [base, { ...base, legId: "y", accountId: "b", amount: 100, superseded: true }]],
  ];
  for (const [refusal, members] of cases) {
    const v = validateProviderLinkGroup(members, bounds);
    assert.equal(v.valid, false, `${refusal} must refuse`);
    assert.equal(v.valid === false && v.refusal, refusal);
  }
});

test("P5: a provider link claims BOTH legs and outranks structural matching", () => {
  const key = providerLinkKey({ institutionId: "ins_56", extractorId: "chase/online-transfer", rawToken: "1" });
  const a = mk({ id: "a", accountId: "chk", amount: -1000, providerLinkKey: key });
  const b = mk({ id: "b", accountId: "sav", accountType: "savings", amount: 1000, providerLinkKey: key });
  // A decoy that would defeat plain mutual uniqueness.
  const decoy = mk({ id: "d", accountId: "card", accountType: "debt", amount: 1000, dateMs: DAY });
  const e = resolveDestinationEvidenceFor(a, [a, b, decoy]);
  assert.equal(e.level, "PROVIDER_LINKED");
  assert.equal(e.accountId, "sav");
  assert.equal(e.legId, "b");
});

test("P5: an INVALID provider group produces NO evidence, never weaker evidence", () => {
  const key = providerLinkKey({ institutionId: "ins_56", extractorId: "chase/online-transfer", rawToken: "2" });
  // Three rows share a key — a pattern collision, not a movement.
  const legs = [
    mk({ id: "a", accountId: "chk", amount: -1000, providerLinkKey: key }),
    mk({ id: "b", accountId: "sav", accountType: "savings", amount: 1000, providerLinkKey: key }),
    mk({ id: "c", accountId: "sav2", accountType: "savings", amount: 1000, providerLinkKey: key }),
  ];
  const idx = buildTransferCorpusIndex(legs);
  for (const l of legs) {
    assert.notEqual(idx.claims.get(l.id)?.tier, "PROVIDER_LINKED",
      "a cardinality-3 group must fall through to the structural tiers, not claim");
  }
});

test("P5: a MASK restricts candidates and can never create a pairing", () => {
  const s   = mk({ id: "s", accountId: "chk", amount: -1000, maskedDestinationAccountId: "sav" });
  const sav = mk({ id: "sav", accountId: "sav", accountType: "savings", amount: 1000 });
  const card = mk({ id: "card", accountId: "card", accountType: "debt", amount: 1000 });
  // Without the mask, two candidates of different types → TYPE_AMBIGUOUS.
  const noMask = resolveDestinationEvidenceFor(mk({ ...s, maskedDestinationAccountId: null }), [
    mk({ ...s, maskedDestinationAccountId: null }), sav, card]);
  assert.equal(noMask.level, "TYPE_AMBIGUOUS");
  // With it, the descriptor names the account and the pairing closes.
  const withMask = resolveDestinationEvidenceFor(s, [s, sav, card]);
  assert.equal(withMask.level, "ACCOUNT_CERTAIN");
  assert.equal(withMask.accountId, "sav");
  // And a mask naming an account with NO leg resolves nothing — it cannot invent.
  const orphan = mk({ id: "o", accountId: "chk", amount: -7, maskedDestinationAccountId: "nowhere" });
  assert.equal(resolveDestinationEvidenceFor(orphan, [orphan, sav]).level, "NO_DESTINATION_EVIDENCE");
});

test("P5: mask restriction keeps legsQualify SYMMETRIC", () => {
  const a = mk({ id: "a", accountId: "x", amount: -10, maskedDestinationAccountId: "y" });
  const b = mk({ id: "b", accountId: "y", accountType: "savings", amount: 10 });
  const c = mk({ id: "c", accountId: "z", accountType: "savings", amount: 10 });
  for (const [p, q] of [[a, b], [a, c], [b, c]] as const) {
    assert.equal(legsQualify(p, q), legsQualify(q, p), "asymmetry would make mutual uniqueness meaningless");
  }
  assert.equal(legsQualify(a, b), true);
  assert.equal(legsQualify(a, c), false, "the mask names y, so z cannot be the other side");
});

test("P5: extraction ABSTAINS on an ambiguous mask, never picks", () => {
  const ctx = {
    institutionId: null,
    maskToAccountIds: new Map([["1234", ["accA", "accB"]]]),
    selfAccountId: "self",
  };
  const r = extractProviderLinks("Online Transfer to SAV ...1234", ctx);
  assert.equal(r.maskedAccountId, null);
  assert.equal(r.maskAmbiguous, true);
});

test("P5: a BARE four-digit token is never a mask", () => {
  const ctx = {
    institutionId: null,
    maskToAccountIds: new Map([["2058", ["accA"]]]),
    selfAccountId: "self",
  };
  // Dates, store numbers and amounts are full of four-digit runs.
  assert.equal(extractProviderLinks("STARBUCKS STORE 2058", ctx).maskedAccountId, null);
  assert.equal(extractProviderLinks("PURCHASE 2058 MAIN ST", ctx).maskedAccountId, null);
  // Only an explicit account-reference marker qualifies.
  assert.equal(extractProviderLinks("Online Transfer from CHK ...2058", ctx).maskedAccountId, "accA");
  assert.equal(extractProviderLinks("card ending in 2058", ctx).maskedAccountId, "accA");
});

test("P5: an institution with no registered extractor yields nothing, silently", () => {
  const ctx = { institutionId: "ins_10", maskToAccountIds: new Map(), selfAccountId: "s" };
  // American Express: 147 measured transfer rows, 0 correlation tokens. The
  // reference case for graceful degradation.
  assert.equal(extractProviderLinks("MOBILE PAYMENT - THANK YOU", ctx).correlation, null);
  assert.equal(extractProviderLinks("transaction#: 30039468383", ctx).correlation, null,
    "a Chase pattern must not fire for a different institution");
});

test("P5: the raw provider token never leaves the extractor", () => {
  const ctx = { institutionId: "ins_56", maskToAccountIds: new Map(), selfAccountId: "s" };
  const r = extractProviderLinks("Online Transfer to SAV ...9516 transaction#: 30039468383", ctx);
  assert.ok(r.correlation, "Chase IS registered and should extract");
  assert.ok(!JSON.stringify(r).includes("30039468383"), "the raw token must not appear anywhere in the output");
  assert.ok(!JSON.stringify(r).includes("9516"), "mask digits must not appear anywhere in the output");
});

test("P5: SELF and COUNTERPARTY are distinct scopes, not confidence levels", () => {
  const src = read("lib/transactions/provider-link.ts");
  assert.match(src, /"SELF"/);
  assert.match(src, /"COUNTERPARTY"/);
  // A correlation id is COUNTERPARTY-scope by construction; it must never be
  // emitted as SELF, which is L8's lifecycle question.
  const ctx = { institutionId: "ins_56", maskToAccountIds: new Map(), selfAccountId: "s" };
  const r = extractProviderLinks("transaction#: 12345678", ctx);
  assert.equal(r.correlation?.scope, "COUNTERPARTY");
});

test("P5: the deny-listed Plaid fields are never read", () => {
  for (const f of ["lib/transactions/provider-link.ts", "lib/transactions/provider-link-extract.ts"]) {
    const src = read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
    for (const denied of ["ppd_id", "reference_number", "by_order_of", "account_numbers", "account_owner", "payment_meta"]) {
      assert.ok(!src.includes(denied), `${f} must never read the deny-listed ${denied}`);
    }
  }
});

// ═══ Cross-cutting invariants ═══════════════════════════════════════════════

test("the vocabularies are complete — no maturity lacks a label or a rank", () => {
  const all: TransferMaturity[] = [
    "UNRESOLVED_TRANSFER", "INTERNAL_TRANSFER", "SAVINGS_TRANSFER", "CASH_TRANSFER",
    "DEBT_PAYMENT", "INVESTMENT_TRANSFER", "CASH_MOVEMENT", "ISSUER_CREDIT",
    "UNRESOLVED_LIABILITY_INFLOW", "EXTERNAL_PERSON_TRANSFER",
    "EXTERNAL_DEPOSITORY_TRANSFER", "EXTERNAL_VENUE_TRANSFER", "EXTERNAL_UNKNOWN_TRANSFER",
  ];
  for (const m of all) assert.ok(MATURITY_LABEL[m], `${m} needs a label`);
});

test("no consumer may re-implement leg matching", () => {
  // Every module that reasons about transfers must go through the authority.
  const consumers = [
    "lib/transactions/RelationshipResolver.ts",
    "lib/transactions/transfer-resolution.ts",
    "lib/transactions/transfer-chain.ts",
    "lib/data/transactions.ts",
  ];
  for (const f of consumers) {
    const src = read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
    assert.ok(!/Math\.abs\(\s*Math\.abs\([^)]*\)\s*-\s*Math\.abs\(/.test(src),
      `${f} appears to re-implement amount matching; it must call the authority`);
    // ⚠️ A day-length constant is NOT by itself a second window. transfer-chain.ts
    // legitimately measures the CONTINUATION gap — a different, separately-derived
    // bound — and transfer-resolution.ts pads the DB gather range. What must never
    // recur is a second ±TRANSFER_MATCH_WINDOW comparison, so that is what is
    // checked: a day computation that is compared against anything but the
    // authority's own exported constants.
    const legWindowClone = /Math\.abs\([^)]*dateMs[^)]*\)\s*\/\s*86_?400_?000\s*<=?\s*\d/.test(src);
    assert.ok(!legWindowClone,
      `${f} appears to re-implement the LEG match window with a literal bound`);
  }
});
