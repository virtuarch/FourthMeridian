/**
 * lib/transactions/read-boundary-authority.test.ts   (v2.6-TRUTH-2)
 *
 * Standing source-scan probes: no READ path may act as a second transfer
 * authority.
 *
 * The defect these exist to prevent, verbatim from the corpus: the database held
 * 7 counterparties while the API displayed 310, because
 * `matchTransferCandidate` re-implemented leg matching with neither the cash veto
 * nor mutual uniqueness. 303 counterparties were invented during reads. Unit
 * tests could not catch it — both modules passed their own tests. Only a
 * structural rule does.
 *
 * These are lexical probes and are deliberately conservative: they assert the
 * SHAPE of the dependency (who imports whom, who re-declares what), which is the
 * property that actually decays, rather than trying to re-derive behaviour.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Source with comments and string literals stripped — so prose ABOUT a rule is
 *  never mistaken for the rule. This exact trap has bitten twice before. */
function logic(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ")
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

const AUTHORITY = "lib/transactions/transfer-maturation.ts";

/** Every module that performs transfer reasoning on a READ path. */
const READERS = [
  "lib/transactions/RelationshipResolver.ts",
  "lib/transactions/transfer-resolution.ts",
];

test("the read-time matcher CONSUMES the canonical authority", () => {
  const src = logic(read("lib/transactions/RelationshipResolver.ts"));
  assert.ok(
    src.includes("resolveDestinationEvidenceFor"),
    "matchTransferCandidate must delegate to the canonical resolver, not re-derive matching",
  );
  assert.ok(
    src.includes("maturityForEvidence"),
    "the maturity must come from the authority",
  );
});

test("no reader re-declares the match predicate", () => {
  // The five clauses the authority's `legsQualify` owns. A reader that writes
  // any of them again has forked the rule, which is how the two boundaries came
  // to disagree. Comparing signs of two amounts is the signature.
  for (const f of READERS) {
    const src = logic(read(f));
    assert.ok(
      !/Math\.sign\([^)]*\)\s*!==\s*-/.test(src),
      `${f} re-implements the opposite-direction clause; use legsQualify`,
    );
    assert.ok(
      !/Math\.abs\(\s*Math\.abs\([^)]*\)\s*-/.test(src),
      `${f} re-implements the equal-magnitude clause; use legsQualify`,
    );
  }
});

test("no reader declares its own match window or amount epsilon", () => {
  for (const f of READERS) {
    const src = logic(read(f));
    // Importing/aliasing the authority's constant is fine; declaring a NUMBER is not.
    assert.ok(
      !/(WINDOW_DAYS|windowDays)\s*[:=]\s*\d/.test(src),
      `${f} declares a numeric transfer window; the authority owns TRANSFER_MATCH_WINDOW_DAYS`,
    );
    assert.ok(
      !/(EPSILON|amountEpsilon|eps)\s*[:=]\s*\d*\.\d/.test(src),
      `${f} declares a numeric amount epsilon; the authority owns TRANSFER_AMOUNT_EPSILON`,
    );
  }
});

test("the cash veto and mutual matching live ONLY in the authority", () => {
  // DECLARATIONS are checked against RAW source: a union member like
  // `| "CASH_NO_COUNTERPARTY"` IS a string literal, and `logic()` would strip the
  // very thing being asserted. (Asserting a declaration against stripped source
  // is a mistake this repo has now made three times; hence the note.)
  const authRaw = read(AUTHORITY);
  assert.ok(authRaw.includes("CASH_NO_COUNTERPARTY"), "the authority declares the cash level");
  assert.ok(authRaw.includes("competingSourceCount"), "the authority declares mutual matching");

  // PROHIBITIONS are checked against stripped source, so prose about the rule is
  // never mistaken for the rule.
  for (const f of READERS) {
    const src = logic(read(f));
    assert.ok(
      !/movementForm\s*===/.test(src),
      `${f} re-implements the cash veto; the authority applies it`,
    );
    assert.ok(
      !/competingSourceCount\s*(===|>|<|!==)/.test(src),
      `${f} re-implements mutual matching; the authority applies it`,
    );
  }
});

test("a read path never writes counterpartyAccountId", () => {
  for (const f of [...READERS, "lib/data/transactions.ts"]) {
    const src = logic(read(f));
    assert.ok(
      !/\b(update|updateMany|create|createMany|upsert)\s*\(\s*\{[\s\S]{0,600}?counterpartyAccountId\s*:/.test(src),
      `${f} appears to WRITE counterpartyAccountId; read-time resolution is projection only`,
    );
  }
});

test("the DTO's counterparty can only come from a persisted id or the authority's own persistability verdict", () => {
  const src = logic(read("lib/transactions/transfer-resolution.ts"));
  // Financial Truth — the gate was `status === "RESOLVED"`, which was a PROXY for
  // persistability and stopped being equivalent to it. At
  // ACCOUNT_CERTAIN_LEG_AMBIGUOUS the destination ACCOUNT is a fact while the LEG
  // is unknowable, so the row is RESOLVED and carries no `transactionId`; a gate
  // on the status alone cannot express that, and a gate that re-derives it would
  // be a second authority. The read boundary now consults the authority's own
  // verdict instead of inferring one.
  assert.match(
    src,
    /match\.persistableCounterparty\s*&&\s*match\.counterpartyAccountId/,
    "the resolved-id map must be gated on the authority's persistableCounterparty verdict",
  );
  assert.ok(
    !/status\s*===\s*""/.test(src),
    "the read boundary must not re-derive persistability from the status string",
  );
});

test("a persistable LEG and a persistable ACCOUNT are separate claims", () => {
  const src = logic(read("lib/transactions/transfer-maturation.ts"));
  // The two booleans must never be assigned from one another, or the missing
  // rung collapses back into the defect it was created to fix.
  assert.ok(
    !/persistableLeg\s*:\s*persistableCounterparty/.test(src) &&
      !/persistableCounterparty\s*:\s*persistableLeg/.test(src),
    "persistableLeg and persistableCounterparty must be decided independently",
  );
  // ACCOUNT_CERTAIN_LEG_AMBIGUOUS must be the one level that grants the account
  // and refuses the leg. If that stops being true the rung means nothing.
  //
  // ⚠️ Located in RAW source, not in `logic()`. The level name IS a string
  // literal, and `logic()` strips string literals — the fourth time this
  // repository has hit that trap, and the reason the note is here rather than in
  // a commit message.
  const raw = read("lib/transactions/transfer-maturation.ts");
  const rung = raw.slice(raw.indexOf('level: "ACCOUNT_CERTAIN_LEG_AMBIGUOUS"'));
  const block = rung.slice(0, rung.indexOf("};"));
  assert.match(block, /legId:\s*null/, "the leg-ambiguous rung must never carry a leg id");
  assert.match(block, /persistableCounterparty:\s*true,\s*persistableLeg:\s*false/,
    "the leg-ambiguous rung must persist the account and refuse the leg");
});

test("cross-owner detection can never become cross-owner MATCHING", () => {
  const src = logic(read("lib/transactions/transfer-maturation.ts"));
  // `legsQualifyIgnoringOwner` exists to NAME a limitation, not to relax the
  // ownership boundary. It may only ever be counted.
  const uses = [...src.matchAll(/legsQualifyIgnoringOwner\s*\(/g)].length;
  assert.ok(uses >= 1, "the cross-owner probe should exist");
  // Every call site must feed a COUNT, never a candidate set or a claim.
  assert.match(
    src,
    /corpus\.filter\(\(c\) => legsQualifyIgnoringOwner\(source, c\)\)\.length/,
    "cross-owner qualification may only be counted, never turned into candidates",
  );
  assert.ok(
    !/claim\([^)]*legsQualifyIgnoringOwner/.test(src),
    "a cross-owner pair must never become a claim",
  );
});

test("the detail read admits the SAME leg population as the list read", () => {
  // These diverged: the detail read filtered candidates to `flowType: TRANSFER`
  // alone while the list read used the full transfer-candidate set, so the drawer
  // and the list could disagree about one row.
  const src = logic(read("lib/data/transactions.ts"));
  assert.ok(
    !/flowType:\s*FlowType\.TRANSFER\s*\}/.test(src),
    "the detail candidate query must admit DEBT_PAYMENT/UNKNOWN/null legs too",
  );
});
