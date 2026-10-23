/**
 * lib/transactions/crypto-separation.test.ts
 *
 * v2.6-CRYPTO-1 — banking and on-chain are separate domains, and stay separate.
 *
 * ── The doctrine, as executable statements ──────────────────────────────────
 *
 *   An on-chain receipt is not automatically INCOME.
 *   An on-chain send is not automatically SPENDING.
 *   A wallet-to-wallet movement is not automatically a banking TRANSFER.
 *
 * Fees, swaps, staking and mining rewards, airdrops and exchange movements are
 * real events with real meanings, and every one of those meanings belongs to a
 * crypto-domain authority that does not exist yet. Until it does the banking
 * domain REFUSES rather than guesses — and refusal has to be enforced, because
 * the failure mode is a plausible-looking number nobody questions.
 *
 * Measured before separation: 28 live BTC rows in the banking population, all
 * INCOME, all attributed UNRESOLVED_INCOME → OTHER_INCOME (an INCLUDED class),
 * at their NATIVE BTC magnitude read as dollar-like, reaching Cash Flow, the AI
 * summaries, the explorer, the count and the exports. `FxRate` being empty was
 * the only thing between that and a real number on an income headline.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { carriesBankingSemantics, FLOW_AUTHORITIES } from "@/lib/transactions/flow-authority";
import { isBankingRow, isBankingPopulation } from "@/lib/transactions/flow-predicates";
import { attributeIncome } from "@/lib/transactions/income-source";

const ROOT = process.cwd();

// ── 1. CRYPTO_LEDGER rows cannot enter the banking population ───────────────
test("CRYPTO-1: a crypto-owned row is outside the banking population, whatever its flowType", () => {
  const FLOWS = ["INCOME", "SPENDING", "TRANSFER", "DEBT_PAYMENT", "REFUND", "FEE",
                 "INTEREST", "ADJUSTMENT", "UNKNOWN", null] as const;
  for (const flowType of FLOWS) {
    assert.equal(
      isBankingRow({ flowType, flowAuthority: "CRYPTO_LEDGER" }), false,
      `a CRYPTO_LEDGER row with flowType=${flowType} entered the banking population`,
    );
  }
  // …and every OTHER authority, including "unowned", stays in. Absence of an
  // owner means "no banking authority has classified this yet", never "on-chain".
  for (const a of [...FLOW_AUTHORITIES.filter((x) => x !== "CRYPTO_LEDGER"), null]) {
    assert.equal(
      isBankingRow({ flowType: "SPENDING", flowAuthority: a }), true,
      `authority ${a} was wrongly excluded from the banking population`,
    );
  }
  // The flow-type half is unchanged: INVESTMENT is still the only excluded flow.
  assert.equal(isBankingPopulation("INVESTMENT"), false);
  assert.equal(isBankingPopulation(null), true);
});

// ── 2. Income attribution refuses crypto-owned rows ─────────────────────────
test("CRYPTO-2: income attribution refuses an on-chain row and NAMES the refusal", () => {
  const a = attributeIncome({
    flowType: "INCOME", flowAuthority: "CRYPTO_LEDGER",
    accountType: "checking", amount: 0.0086,
  });
  assert.equal(a.incomeClass, "NOT_INCOME");
  assert.equal(a.subtype, "ON_CHAIN_MOVEMENT", "the refusal must be NAMED, never lumped");
  assert.ok(/crypto-domain authority/.test(a.reason), "the refusal must say WHY");
});

// ── 3. FX data cannot turn a crypto receipt into banking income ─────────────
test("CRYPTO-3: no evidence combination makes an on-chain receipt banking income", () => {
  // The structural guarantee. Populating FxRate — which is the ONLY reason the
  // native-BTC magnitudes were not already dollars on a headline — must not be
  // able to reintroduce the defect, and neither must any provider label.
  const evidences = [
    { providerFamily: "INCOME", providerDetail: "INCOME_WAGES" },
    { providerFamily: "INCOME", providerDetail: "INCOME_DIVIDENDS" },
    { providerFamily: "TRANSFER_IN", providerDetail: null },
    { providerFamily: null, providerDetail: null },
  ] as const;
  for (const e of evidences) {
    for (const accountType of ["checking", "savings", "debt", "investment", "crypto", "other"]) {
      for (const amount of [0.0086, 1_000_000]) {
        const a = attributeIncome({
          flowType: "INCOME", flowAuthority: "CRYPTO_LEDGER",
          providerFamily: e.providerFamily, providerDetail: e.providerDetail,
          accountType, amount,
        });
        assert.equal(
          a.incomeClass, "NOT_INCOME",
          `on-chain row became ${a.incomeClass} under ${JSON.stringify({ ...e, accountType, amount })}`,
        );
      }
    }
  }
});

// ── 4. The predicate itself ─────────────────────────────────────────────────
test("CRYPTO-4: carriesBankingSemantics is false ONLY for CRYPTO_LEDGER", () => {
  assert.equal(carriesBankingSemantics("CRYPTO_LEDGER"), false);
  assert.equal(carriesBankingSemantics("CLASSIFIER"), true);
  assert.equal(carriesBankingSemantics("TRANSFER_AUTHORITY"), true);
  assert.equal(carriesBankingSemantics(null), true, "unowned is a banking row awaiting classification");
  assert.equal(carriesBankingSemantics(undefined), true, "a read that omitted the column must not get a crypto verdict");
});

// ── 5–6. Source guards ──────────────────────────────────────────────────────

function walk(rel: string): string[] {
  const abs = path.join(ROOT, rel);
  let entries: string[];
  try { entries = readdirSync(abs); } catch { return []; }
  const out: string[] = [];
  for (const e of entries) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const childRel = path.join(rel, e);
    if (statSync(path.join(ROOT, childRel)).isDirectory()) { out.push(...walk(childRel)); continue; }
    if (!/\.(ts|tsx)$/.test(e) || /\.test\.tsx?$/.test(e)) continue;
    out.push(childRel);
  }
  return out;
}
const codeOf = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

/** Where the separation is allowed to be SPELLED. Everywhere else must consume it. */
const SEPARATION_OWNERS = new Set([
  path.join("lib", "transactions", "flow-authority.ts"),   // the predicate
  path.join("lib", "data", "banking-population.ts"),       // the SQL fragment + crypto entry point
  path.join("lib", "transactions", "flow-predicates.ts"),  // the row-level twin
]);

test("CRYPTO-5: nothing re-derives the crypto exclusion", () => {
  // A component, assembler or route naming CRYPTO_LEDGER is writing a second
  // definition of the separation. There must be exactly one, and the rest must
  // consume `carriesBankingSemantics` / `BANKING_POPULATION`.
  const offenders: string[] = [];
  for (const root of ["lib", "app", "components", "jobs"]) {
    for (const file of walk(root)) {
      if (SEPARATION_OWNERS.has(file)) continue;
      // btc-sync legitimately STAMPS the authority on rows it writes; the seed
      // does the same for its crypto fixture. Writing an authority is not
      // re-deriving the exclusion — reading it to filter is.
      if (/foreignFlowOwnershipFields\(/.test(codeOf(file))) continue;
      if (/["']CRYPTO_LEDGER["']/.test(codeOf(file))) offenders.push(file);
    }
  }
  assert.deepEqual(
    offenders, [],
    `The crypto exclusion is spelled outside its authority in:\n${offenders.map((f) => `  ${f}`).join("\n")}\n\n` +
    `Consume carriesBankingSemantics() or BANKING_POPULATION. A second definition ` +
    `is how the separation drifts — and a heuristic one (account name, wallet ` +
    `address, currency) is how it breaks on the first non-BTC chain.`,
  );
});

test("CRYPTO-6: the separation is not inferred from a heuristic", () => {
  // The forbidden signals, in the files that own the separation. Guards against
  // a future "simplification" that swaps provenance for a symbol match.
  const forbidden = [
    /walletAddress/, /currency\s*===\s*["']BTC["']/, /type\s*===\s*["']crypto["']/,
    /institution\s*===/, /classifierVersion/,
  ];
  for (const file of SEPARATION_OWNERS) {
    const code = codeOf(file);
    // flow-authority.ts legitimately mentions classifierVersion (it clears it).
    const checks = file.endsWith("flow-authority.ts") ? forbidden.slice(0, 4) : forbidden;
    for (const re of checks) {
      assert.ok(
        !re.test(code),
        `${file} decides the banking/on-chain split using ${re} — the signal must be ` +
        `the AUTHORITY that wrote the row, which every future chain inherits for free.`,
      );
    }
  }
});

// ── 7. The crypto domain has an explicit path ───────────────────────────────
test("CRYPTO-7: a future crypto-domain reader has a named entry point", () => {
  const src = readFileSync(path.join(ROOT, "lib/data/banking-population.ts"), "utf8");
  assert.ok(
    /export const CRYPTO_LEDGER_POPULATION/.test(src),
    "separation is not concealment — a crypto-domain reader must have a named way to " +
    "reach these rows, or the first crypto surface will hand-roll its own predicate",
  );
});

// ── 8. Banking event identity is untouched ──────────────────────────────────
test("CRYPTO-8: the separation does not touch banking event identity", () => {
  // Event identity excludes crypto by PROVIDER eligibility (isEventEligibleProvider),
  // decided at write time and asserted corpus-wide by audit-event-identity INV-17.
  // This slice must not have introduced a second, competing crypto rule there.
  const eventSrc = codeOf(path.join("lib", "transactions", "event-identity.ts"));
  assert.ok(
    !/CRYPTO_LEDGER/.test(eventSrc),
    "event identity must keep deciding crypto scope by provider eligibility, not by flowAuthority — " +
    "two rules for one question is the defect this arc exists to remove",
  );
  const projSrc = codeOf(path.join("lib", "transactions", "event-projection.ts"));
  assert.ok(!/CRYPTO_LEDGER/.test(projSrc), "the event-projection filter must stay authority-agnostic");
});
