/**
 * lib/transactions/lifecycle-boundary.test.ts   (V27-L4)
 *
 * STANDING source-scan probes for the lifecycle / economic-date / maturation
 * authorities and the Space-card convergence. Repo-wide, comments stripped.
 *
 * Probe 1 is the one that matters most: `Transaction.date` is a posting-date
 * fact the historical engine depends on, and nothing in this slice may write it.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const src  = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const code = (rel: string) =>
  src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
/**
 * Comments AND string literals stripped. Some probes must assert on LOGIC, and
 * user-facing copy legitimately contains words like "pending" or "descriptor" —
 * matching those would be asserting on prose, which is exactly what these probes
 * exist to avoid.
 */
const logic = (rel: string) =>
  code(rel)
    .replace(/`(?:[^`\\]|\\.)*`/g, "``")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
}

function walk(dir: string, out: string[] = []): string[] {
  const abs = path.join(ROOT, dir);
  let entries: string[];
  try { entries = readdirSync(abs); } catch { return out; }
  for (const e of entries) {
    if (e === "node_modules" || e === ".next" || e.startsWith(".")) continue;
    const rel = path.join(dir, e);
    if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(rel);
  }
  return out;
}

const FILES = [...walk("lib"), ...walk("components"), ...walk("app"), ...walk("jobs")]
  .filter((f) => !f.startsWith("prototype/") && !f.startsWith(path.join("app", "prototype")));

const LIFECYCLE = path.join("lib", "transactions", "lifecycle.ts");
const ECON      = path.join("lib", "transactions", "economic-date.ts");
const MATURE    = path.join("lib", "transactions", "transfer-maturation.ts");
const SLICE4    = [LIFECYCLE, ECON, MATURE];

console.log(`Scanning ${FILES.length} source files\n`);

// ── 1. Transaction.date is never rewritten ──────────────────────────────────

console.log("PROBE 1 — Transaction.date is never written by Slice 4 code");
{
  for (const f of SLICE4) {
    const c = code(f);
    check(`${path.basename(f)} performs no write at all`,
      !/\.update\(|\.updateMany\(|\.create\(|\.upsert\(|\.delete\(|\$executeRaw/.test(c));
    check(`${path.basename(f)} never assigns a date field`,
      !/\bdate:\s*(?!string|Date|\|)/.test(c.replace(/postingDate|economicDate|fromDate|toDate|throughDate/g, "")));
  }
  // Nothing in the product may write Transaction.date outside the provider sync
  // and import paths that legitimately own it.
  const ALLOWED_DATE_WRITERS = new Set([
    path.join("lib", "plaid", "syncTransactions.ts"),
    path.join("lib", "crypto", "btc-sync.ts"),
  ]);
  const writers = FILES.filter((f) => {
    if (ALLOWED_DATE_WRITERS.has(f)) return false;
    const c = code(f);
    return /transaction\.update(Many)?\(\{[\s\S]{0,400}?data:\s*\{[\s\S]{0,200}?\bdate:/.test(c);
  });
  check("no unexpected writer of Transaction.date", writers.length === 0, writers.join(", "));
}

// ── 2. Economic date immutable across lifecycle transitions ─────────────────

console.log("\nPROBE 2 — the economic date cannot move when the lifecycle does");
{
  const e = code(ECON);
  // The resolver's inputs must not include any lifecycle signal: if `pending`
  // or `settlementState` cannot reach it, posting cannot change its answer.
  // Asserted on LOGIC — the explanation strings legitimately say "pending".
  check("the economic-date resolver reads NO lifecycle evidence",
    !/pending|settlementState|deletedAt/.test(logic(ECON)));
  check("authorizedAt outranks the posting date",
    e.indexOf("authorizedAt") < e.indexOf('basis: "POSTING"'));
  check("the credibility bound is a named constant, not a literal",
    /ECONOMIC_DATE_MAX_LAG_DAYS = \d+/.test(e) && /lag > ECONOMIC_DATE_MAX_LAG_DAYS/.test(e));
  check("out-of-bound evidence is CONTRADICTORY, not silently dropped",
    /state: "CONTRADICTORY"/.test(e) && /reason:/.test(e));
  check("period membership is a function of the ECONOMIC date",
    /economicPeriod[\s\S]{0,160}r\.economicDate\.slice\(0, 7\)/.test(e));
}

// ── 3 & 5. Pending evidence goes through the lifecycle authority ────────────

console.log("\nPROBE 3/5 — one lifecycle decision, consumed by pending evidence");
{
  const pe = code("lib/balances/pending-evidence.ts");
  check("loadPendingEvidence imports the lifecycle authority",
    pe.includes('from "@/lib/transactions/lifecycle"'));
  check("...and gates on contributesPendingEvidence",
    /if \(!contributesPendingEvidence\(lifecycle\)\) continue;/.test(pe));
  check("...and no longer forms its own opinion from the pending boolean",
    !/r\.pending\s*(===|!==|\?)/.test(pe));
  const lc = code(LIFECYCLE);
  check("the admission predicate is PENDING and not superseded, nothing else",
    /r\.state === "PENDING" && !r\.superseded/.test(lc));
  check("a superseded observation can never contribute",
    /superseded: true/.test(lc));
}

// ── 4. Closed periods ──────────────────────────────────────────────────────

console.log("\nPROBE 4 — a posting cannot move an event between periods");
{
  const e = code(ECON);
  check("crossesPeriodBoundary compares economic vs posting month",
    /r\.economicDate\.slice\(0, 7\) !== r\.postingDate\.slice\(0, 7\)/.test(e));
  check("the posting date is carried through, never substituted for the economic one",
    /postingDate: postingISO/.test(e));
}

// ── 6. Economic date never enters balance arithmetic ───────────────────────

console.log("\nPROBE 6 — the two engines stay disjoint");
{
  const balances = walk(path.join("lib", "balances")).filter((f) => !/\.test\.tsx?$/.test(f));
  check(`no lib/balances module (${balances.length}) imports the economic-date authority`,
    balances.every((f) => !code(f).includes("economic-date")));
  check("no lib/balances module reads an economicDate value",
    balances.every((f) => !/economicDate/.test(code(f))));
  // And the mirror: the economic-date authority knows nothing about balances.
  check("the economic-date authority imports no balance module",
    !code(ECON).includes("lib/balances"));
}

// ── 7 & 8. Classification is re-evaluable and admits the right candidates ──

console.log("\nPROBE 7/8 — DEBT_PAYMENT enters the resolver; classification re-evaluates");
{
  const m = code(MATURE);
  check("TRANSFER, DEBT_PAYMENT, UNKNOWN and null are all candidates",
    /"TRANSFER", "DEBT_PAYMENT", "UNKNOWN", null/.test(m));
  // Financial Truth — candidacy split into two named things, deliberately.
  // The broad list above is now the DATABASE PREFILTER (it admits every
  // unclassified row, which a `WHERE` clause cannot tell apart from a transfer);
  // real ADMISSION lives in transfer-admission.ts, which also reads the row's own
  // account type, category and attested axes. The invariant tying them together
  // — admitted ⊆ prefiltered — is asserted in transfer-authority.test.ts.
  check("the prefilter is a helper, not an inline flowType === TRANSFER gate",
    /export function isTransferPrefilterCandidate/.test(m));
  check("...and it is NAMED a prefilter, so no caller mistakes it for admission",
    /TRANSFER_PREFILTER_FLOW_TYPES/.test(m) && !/export function isTransferCandidate\b/.test(m));
  check("maturation takes the CURRENT flowType as input, never as a gate",
    /flowType: string \| null \| undefined;/.test(m) &&
    !/if \(input\.flowType !== "TRANSFER"\) return/.test(m));
  check("a monotonicity guard exists and refuses descents",
    /adoptIfMonotonic/.test(m) && /Would reduce specificity/.test(m));
  check("every result carries an audit reason", /reason: string;/.test(m));
}

// ── 9 & 10 & 11 & 12. Destination type decides; gaps never fabricate ───────

console.log("\nPROBE 9/10/11/12 — destination type is the discriminator");
{
  const m = code(MATURE);
  check("the leaf is chosen from the counterparty ACCOUNT TYPE",
    /function leafForAccountType\(t: string\)/.test(m));
  // Asserted on LOGIC — the audit reason legitimately explains that a
  // descriptor does NOT identify a destination, which is the opposite of
  // consulting one.
  check("the descriptor is never consulted",
    !/descriptor|merchant|description/i.test(logic(MATURE)));
  check("destination-before-source is supported (the matcher uses |distance|)",
    /TRANSFER_MATCH_WINDOW_DAYS = 5/.test(m));
  check("the window bound exceeds the observed 3-day skew",
    Number((m.match(/TRANSFER_MATCH_WINDOW_DAYS = (\d+)/) ?? [])[1]) > 3);
  check("balance-gap evidence alone yields UNRESOLVED",
    /cp\.evidence === "BALANCE_GAP_SUPPORT"[\s\S]{0,300}maturity: "UNRESOLVED_TRANSFER"/.test(m));
  check("...and is never persistable",
    /persistable: cp\.evidence === "PROVIDER_LINK" \|\| cp\.evidence === "MATCHED_LEG"/.test(m));
  check("a gap can never produce a counterparty id",
    /evidence: "BALANCE_GAP_SUPPORT",[\s\S]{0,200}counterpartyAccountId: null/.test(m) ||
    /counterpartyAccountId: null,[\s\S]{0,200}evidence: "BALANCE_GAP_SUPPORT"/.test(m));
}

// ── 13. Slice 3 reconciliation untouched ───────────────────────────────────

console.log("\nPROBE 13 — Slice 3 reachable balances are undisturbed");
{
  const a = code("lib/balances/account-balances.ts");
  check("the reconciliation identities are unchanged",
    /const unexplained = b\.observed\.amount \+ pending\.sum - avail\.amount;/.test(a) &&
    /const impliedCredit = creditLimit - \(owed \+ pendingCharges\);/.test(a));
  check("reconcileAccount reads no lifecycle or economic-date module",
    !a.includes("lifecycle") && !a.includes("economic-date"));
}

// ── 14 & 15. Space-card convergence ────────────────────────────────────────

console.log("\nPROBE 14/15 — one canonical 1M authority, one freshness authority");
{
  const snap = code("lib/data/snapshots.ts");
  check("the Space summary resolves its window through the canonical authority",
    snap.includes('compareToForPreset("PAST_MONTH"') &&
    snap.includes('from "@/lib/perspectives/time-range"'));
  check("...and does NOT derive a month of its own",
    !/setMonth|subMonths\(|30 \* 86_?400_?000|days: 30/.test(snap));
  check("the change carries BOTH endpoints so they can be compared",
    /fromDate: string;/.test(src("lib/data/snapshots.ts")) && /toDate: string;/.test(src("lib/data/snapshots.ts")));

  const client = code("components/dashboard/SpacesClient.tsx");
  check("the card no longer derives a percentage in React",
    !client.includes("trendDeltaPct") && /space\.change\?\.pct/.test(client));
  check("the card's freshness comes from the Slice 1 authority via the server",
    /space\.freshness/.test(client) && /function formatFreshness/.test(client));
  check("...and NOT from the snapshot date",
    !/formatActivity\(space\.lastUpdated/.test(client));
  check("no 'Updated' verb is hardcoded next to a snapshot date",
    !/verb = lastUpdated \? "Updated"/.test(client));

  const cardFresh = code("lib/freshness/space-card-freshness.ts");
  check("the card freshness loader uses resolveSpaceFreshness (anchored on the OLDEST)",
    cardFresh.includes("resolveSpaceFreshness("));
  check("...with ONE clock for the whole page",
    (cardFresh.match(/new Date\(\)/g) ?? []).length === 1);
}

// ── 16. No React financial arithmetic or date classification ──────────────

console.log("\nPROBE 16 — components format; they do not classify or derive");
{
  const componentFiles = FILES.filter((f) => f.startsWith("components/"));
  const offenders = componentFiles.filter((f) => {
    const c = code(f);
    return /resolveEconomicDate\(|matureClassification\(|resolveLifecycle\(/.test(c);
  });
  check("no component runs a Slice 4 authority itself", offenders.length === 0, offenders.join(", "));
  const client = code("components/dashboard/SpacesClient.tsx");
  check("the Spaces client computes no percentage",
    !/\/ Math\.abs\(|\* 100\b/.test(client));
}

// ── 17. No L8 persistence in this slice ───────────────────────────────────

console.log("\nPROBE 17 — no schema, no persistence");
{
  for (const f of SLICE4) {
    const c = code(f);
    check(`${path.basename(f)} imports no database client`, !c.includes("@/lib/db"));
  }
  const schema = src(path.join("prisma", "schema.prisma"));
  // L8-A — `economicDate` IS now a column, deliberately. This probe used to
  // assert its absence, which was the right guard while the value was
  // derive-only: persisting it before the authority was proven would have
  // frozen an unvalidated rule into the corpus.
  //
  // That gate is now satisfied. The authority shipped in V27-L4B, was replayed
  // across the whole corpus in the economic-date calibration, and the persisted
  // column is checked against it continuously by
  // `scripts/audit-economic-date-persistence.ts`. So the invariant changes shape
  // rather than disappearing: the column must exist, must be NULLABLE (null =
  // "not yet backfilled", never "same as posting"), and must remain the ONLY
  // chronology persistence in the schema.
  check("economicDate exists and is NULLABLE", /economicDate\s+DateTime\?\s+@db\.Date/.test(schema));
  check("...and `date` is still the untouched POSTING column",
    /\n\s*date\s+DateTime\s+@db\.Date/.test(schema));
  // ── L8 — event identity landed. These guards change shape, not disappear. ──
  //
  // "no observation log was added" was the right guard while L8-A was scoped to
  // chronology alone: an observation log is not needed to support the read
  // cutover, and adding it early would have widened a narrow slice. L8 proper
  // adds it deliberately, so the invariant becomes what the model must LOOK
  // like rather than that it must be absent.
  check("TransactionObservation exists", /model TransactionObservation/.test(schema));
  check("TransactionEvent exists", /model TransactionEvent/.test(schema));
  check("the observation key is UNIQUE (idempotence rests on it)",
    /observationKey\s+String\s+@unique/.test(schema));
  check("an event projects to AT MOST ONE live transaction row",
    /currentTransactionId\s+String\?\s+@unique/.test(schema));
  check("Transaction's event link is NULLABLE and additive",
    /transactionEventId\s+String\?/.test(schema));
  // ⚠️ Still absent, and must stay so: L8 is transaction event identity only.
  // A balance observation log is the broader observation platform, which this
  // slice explicitly does not begin.
  check("no BALANCE observation log was added", !/model BalanceObservation/.test(schema));
  check("no EconomicEvent model exists", !/model EconomicEvent/.test(schema));
  check("no ProviderObservation model exists", !/model ProviderObservation/.test(schema));
  check("SettlementState is still only PENDING | POSTED",
    /enum SettlementState \{\s*PENDING\s*POSTED\s*\}/.test(schema.replace(/\r/g, "")));
  // No Slice 4 module may write counterpartyAccountId either — that is the
  // separately-approved act, and this slice only decides persistability.
  const cpWriters = FILES.filter((f) =>
    /counterpartyAccountId:\s*[^,\n]*\n?[\s\S]{0,40}\}\s*,?\s*\}\s*\)/.test(code(f)) &&
    /transaction\.update/.test(code(f)));
  check("no module writes counterpartyAccountId in this slice",
    cpWriters.length === 0, cpWriters.join(", "));
}

if (failures > 0) { console.error(`\nlifecycle-boundary: ${failures} failure(s).`); process.exit(1); }
console.log("\nlifecycle-boundary: all passed.");
