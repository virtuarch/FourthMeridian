/**
 * lib/balances/reconciliation-boundary.test.ts   (V27-L3)
 *
 * STANDING source-scan probes for current-state reconciliation. Repo-wide,
 * comments stripped — a probe asserts on CODE, never on prose about code.
 *
 * The load-bearing one is probe 1: a prediction whose inputs the provider did
 * not attest is a forecast wearing an accounting costume. These guards are what
 * keep recurrence, averages, and merchant patterns out of a "predicted balance".
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const src  = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const code = (rel: string) =>
  src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

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
const AUTHORITY = path.join("lib", "balances", "account-balances.ts");
const EVIDENCE  = path.join("lib", "balances", "pending-evidence.ts");

console.log(`Scanning ${FILES.length} source files\n`);

// ── 1. No predicted balance without provider-observed pending ────────────────

console.log("PROBE 1 — a prediction requires provider-observed pending evidence");
{
  const a = code(AUTHORITY);
  check("predicted is gated on pending.count > 0 (depository)",
    /pending\.count > 0\s*\?\s*claim\("PREDICTED_CASH"/.test(a));
  check("predicted is gated on pending.count > 0 (revolving credit)",
    /pending\.count > 0\s*\?\s*claim\("PREDICTED_AMOUNT_OWED"/.test(a));
  check("there is NO other way to construct a predicted claim",
    (a.match(/claim\("PREDICTED_/g) ?? []).length === 2);

  // The evidence reader must not reach for anything inferential.
  const e = code(EVIDENCE);
  const FORBIDDEN = [
    /recurr/i, /averag/i, /forecast/i, /projec/i, /expected/i,
    /habit/i, /seasonal/i, /extrapolat/i, /predictFrom/i,
  ];
  const hits = FORBIDDEN.filter((re) => re.test(e));
  check("the evidence reader contains no inference vocabulary in code",
    hits.length === 0, hits.map((h) => h.source).join(", "));
  check("the evidence reader gates on the pending flag, not on a pattern",
    /pending: true/.test(e));
  check("it reads Transaction rows and nothing else", (e.match(/db\.\w+\./g) ?? [])
    .every((m) => m === "db.transaction."));
}

// ── 2 & 3. Counted once; pending and posted cannot both contribute ───────────

console.log("\nPROBE 2/3 — each movement counts exactly once");
{
  const e = code(EVIDENCE);
  check("the reader excludes a pending row whose posted successor is live",
    e.includes("pendingTransactionRef") && e.includes("supersededRefs"));
  // V27-L4A — the skip moved INTO the lifecycle authority: a superseded row
  // resolves `superseded: true`, which `contributesPendingEvidence` refuses.
  // The intent is unchanged (skip, never net out); the decision now lives in
  // one place instead of being re-expressed here.
  check("...by skipping it, not by netting it out",
    /if \(!contributesPendingEvidence\(lifecycle\)\) continue;/.test(e));
  check("...and the supersession fact is handed to the lifecycle authority",
    /hasLivePostedSuccessor: r\.plaidTransactionId[\s\S]{0,80}supersededRefs\.has/.test(e));
  check("the contribution carries its row ids so single-counting is provable",
    /transactionIds: string\[\]/.test(src(EVIDENCE)));
  // The three-valued-logic trap: `NOT: { col = X }` drops NULL rows.
  check("the lifecycle filter uses an explicit OR-with-null, not a bare NOT",
    /OR: \[\s*\{ settlementState: null \}/.test(e) && !/NOT: \{ settlementState/.test(e));
  check("POSTED rows are excluded from pending evidence",
    /settlementState: \{ not: "POSTED" \}/.test(e));
}

// ── 4 & 5. The two identities ───────────────────────────────────────────────

console.log("\nPROBE 4/5 — two identities, and the card does NOT use the depository one");
{
  const a = code(AUTHORITY);
  check("depository: unexplained = observed + Σpending − available",
    /const unexplained = b\.observed\.amount \+ pending\.sum - avail\.amount;/.test(a));
  check("revolving credit: unexplained = (limit − owed − charges) − availableCredit",
    /const impliedCredit = creditLimit - \(owed \+ pendingCharges\);/.test(a) &&
    /const unexplained = impliedCredit - avail\.amount;/.test(a));
  check("the credit branch derives charges by flipping the stored sign",
    /const pendingCharges = -pending\.sum;/.test(a));
  check("the credit branch requires a USABLE limit",
    /creditLimit == null \|\| creditLimit <= 0/.test(a));
  check("the two identities are in separate branches, not one formula",
    (a.match(/basis: "DEPOSITORY"/g) ?? []).length >= 2 &&
    (a.match(/basis: "REVOLVING_CREDIT"/g) ?? []).length >= 2);
  check("the canonical four-state vocabulary is used, with no fifth state",
    /"EXACT"/.test(a) && /"PARTIALLY_ATTRIBUTED"/.test(a) &&
    /"UNAVAILABLE"/.test(a) && /"CONTRADICTORY"/.test(a) &&
    !/confidence|likelihood|probabilit/i.test(a));
}

// ── 6. Unexplained is surfaced, never absorbed ──────────────────────────────

console.log("\nPROBE 6 — an unexplained residual is an OUTPUT");
{
  const a = code(AUTHORITY);
  // Assert on ARITHMETIC, not on proximity: `predicted, unexplained, reachable`
  // sit next to each other in the returned object literal, which is co-location
  // and proves nothing either way. What matters is that no VALUE is built from
  // the residual — every reachable/predicted figure is constructed by claim(),
  // and the residual never appears inside one.
  const claimCalls = a.match(/claim\("(?:PREDICTED_CASH|PREDICTED_AMOUNT_OWED|REACHABLE_CASH)",[^)]*\)/g) ?? [];
  check("every predicted/reachable figure is built by claim()", claimCalls.length === 4, String(claimCalls.length));
  check("no predicted or reachable figure is computed from the residual",
    claimCalls.every((c) => !c.includes("unexplained")), claimCalls.join(" | "));
  check("the residual is never subtracted from a total anywhere in the authority",
    !/-\s*unexplained\b/.test(a) && !/unexplained\s*[-+]\s*(?:reachable|predicted)/.test(a));
  const panel = code("components/space/widgets/accounts/AccountDetail.tsx");
  check("the account panel renders the residual", panel.includes("unexplainedDisplay"));
  check("...only when the state says there IS one (no \"$0 unexplained\" noise)",
    /unexplainedDisplay !== null && recon\.state !== "EXACT"/.test(panel));
  check("...in the brief's own words",
    panel.includes("unavailable but not yet explained by transactions"));
  const adapters = code("components/space/widgets/liquidity-adapters.tsx");
  check("the liquidity surface discloses the hold beside the figure it reduces",
    adapters.includes("reachableDisclosure("));
  const reach = code("lib/balances/reachable.ts");
  check("a NEGATIVE residual is not netted against real holds",
    /r\.unexplained > 0\) unexplainedTotal/.test(reach));
}

// ── 7 & 10. Liquidity uses reachable; credit never becomes cash ─────────────

console.log("\nPROBE 7/10 — liquidity consumes reachable; credit is never cash");
{
  const core = code("lib/perspective-engine/lenses/liquidity.core.ts");
  check("the lens cash total consumes reachableCash", core.includes("r.reachableCash"));
  check("...and distinguishes ABSENT (no claim) from NULL (unknown)",
    /r\.reachableCash === undefined/.test(core) && /r\.reachableCash === null/.test(core));
  check("a cash account with an UNKNOWN reachable figure is excluded and counted",
    /cashUnreachableCount\+\+/.test(core));
  check("the lens no longer asserts holds are unreflected",
    !core.includes("pending activity and holds are not reflected") ||
    /usesReachable/.test(core));

  const adapters = code("components/space/widgets/liquidity-adapters.tsx");
  check("all four liquidity widgets go through reachableNow",
    (adapters.match(/reachableNow\(accounts, ctx\)/g) ?? []).length === 3 &&
    adapters.includes("function reachableNow"));
  check("the ladder's 'now' tier is the reachable total, not classifyAccounts' liquid sum",
    /id: "now",\s+label: "Available now",\s+value: reach\.total/.test(adapters));

  const a = code(AUTHORITY);
  check("a card never produces a reachable figure",
    /basis: "REVOLVING_CREDIT",[\s\S]{0,400}reachable: null/.test(a));
  check("reachableCash() still admits ONLY AVAILABLE_CASH",
    /quantity === "AVAILABLE_CASH"[\s\S]{0,60}:\s*null/.test(a));

  const sq = code("lib/balances/section-quantity.ts");
  check("the section ledger records the liquidity migration",
    (sq.match(/"REACHABLE_CASH"/g) ?? []).length === 4);
}

// ── 8. Debt stays observed ──────────────────────────────────────────────────

console.log("\nPROBE 8 — debt remains observed");
{
  const a = code(AUTHORITY);
  check("amount owed still comes from balance-semantics, untouched by reconciliation",
    /claim\("AMOUNT_OWED",\s*amountOwed\(input\.balance\)\)/.test(a));
  check("the predicted owed figure is a SEPARATE quantity, not a rewrite",
    /claim\("PREDICTED_AMOUNT_OWED"/.test(a) &&
    !/owed:\s*claim\("PREDICTED_AMOUNT_OWED"/.test(a));
  // Nothing downstream of debt may consume a predicted figure.
  const debtCore = code("lib/perspective-engine/lenses/debt.core.ts");
  check("the debt lens consumes no predicted or reachable quantity",
    !debtCore.includes("PREDICTED") && !debtCore.includes("reachable") && !debtCore.includes("unexplained"));
  const debtAdapters = code("components/space/widgets/debt-adapters.tsx");
  check("the debt adapters consume no predicted or reachable quantity",
    !debtAdapters.includes("PREDICTED") && !debtAdapters.includes("reachable"));
}

// ── 9. Freshness travels with the reconciliation claim ──────────────────────

console.log("\nPROBE 9 — freshness and reconciliation are separate, and both travel");
{
  const a = code(AUTHORITY);
  check("reconcileAccount takes the AccountBalances that already carries freshness",
    /export function reconcileAccount\(\s*b: AccountBalances,/.test(a));
  check("reconciliation never reads or re-derives an age",
    !/reconcileAccount[\s\S]{0,3000}freshness\.balance\.(ageDays|band)/.test(a));
  const routeSrc = src("app/api/spaces/[id]/accounts/detail/route.ts");
  check("the detail row carries BOTH freshness and reconciliation",
    /freshness:\s+AccountFreshness;/.test(routeSrc) && /reconciliation:\s+Reconciliation;/.test(routeSrc));
  const panel = code("components/space/widgets/accounts/AccountDetail.tsx");
  check("the panel shows reconciliation as its OWN row, beside freshness",
    panel.includes('label="Reconciliation"') && panel.includes("accountBalanceClaimLabel("));
}

// ── 11. Null available stays unavailable ────────────────────────────────────

console.log("\nPROBE 11 — nothing is reconciled against a figure that does not exist");
{
  const a = code(AUTHORITY);
  check("a missing available cash figure yields UNAVAILABLE, not a residual",
    /avail\.status !== "AVAILABLE" \|\| avail\.quantity !== "AVAILABLE_CASH"[\s\S]{0,400}state: "UNAVAILABLE"[\s\S]{0,200}unexplained: null/.test(a));
  check("a prediction may still exist there (pending evidence is independent)",
    /state: "UNAVAILABLE",\s*pending,\s*predicted,/.test(a));
}

// ── 12. React does no reconciliation arithmetic or pending filtering ────────

console.log("\nPROBE 12 — components format; they do not derive");
{
  const componentFiles = FILES.filter((f) => f.startsWith("components/"));
  const offenders = componentFiles.filter((f) => {
    const c = code(f);
    // Reading a `pending` flag off transactions inside a component is the shape
    // that would re-derive the evidence set outside the authority.
    return /\.filter\([^)]*\.pending\b/.test(c) ||
           /reconcileAccount\(/.test(c) && !f.includes("accounts/Accounts");
  });
  check("no component filters transactions by their pending flag",
    offenders.length === 0, offenders.join(", "));
  const adapters = code("components/space/widgets/liquidity-adapters.tsx");
  check("the liquidity adapters delegate the rule to lib/balances/reachable",
    adapters.includes("totalReachableCash(") && !/observed \+ .*pending/.test(adapters));
  const panel = code("components/space/widgets/accounts/AccountDetail.tsx");
  check("the account panel runs no identity of its own",
    !/observed[\s\S]{0,40}[+-][\s\S]{0,40}pending/.test(panel));
}

// ── 13. No raw availableBalance reads reintroduced ─────────────────────────

console.log("\nPROBE 13 — the Slice 2 boundary still holds");
{
  const WRITE_PATHS = new Set([
    path.join("lib", "plaid", "refresh.ts"),
    path.join("lib", "plaid", "exchangeToken.ts"),
  ]);
  const offenders: string[] = [];
  for (const f of FILES) {
    if (f === AUTHORITY || WRITE_PATHS.has(f)) continue;
    const c = code(f);
    if (!/availableBalance/.test(c)) continue;
    let residue = c;
    for (const re of [
      /availableBalance:\s*true\b/g,
      /availableBalance\??:\s*number\s*\|\s*null/g,
      /availableBalance:\s*[A-Za-z_$][\w$.]*(?:\s*\?\?\s*null)?,/g,
      /availableBalance:\s*null,/g,
    ]) residue = residue.replace(re, "");
    if (/availableBalance/.test(residue)) offenders.push(f);
  }
  check("still no file outside the authority INTERPRETS availableBalance",
    offenders.length === 0, offenders.join(", "));
}

// ── 14. No current-state result reaches a snapshot ─────────────────────────

console.log("\nPROBE 14 — current state never enters historical storage");
{
  const snapshotFiles = FILES.filter((f) => f.startsWith(path.join("lib", "snapshots")));
  check(`the snapshot engine (${snapshotFiles.length} files) imports no reconciliation`,
    snapshotFiles.every((f) => {
      const c = code(f);
      return !c.includes("lib/balances/") && !c.includes("reconcileAccount") &&
             !c.includes("PREDICTED_") && !c.includes("REACHABLE_CASH");
    }));
  const hist = FILES.filter((f) => f.startsWith(path.join("lib", "history")) || f.startsWith(path.join("lib", "wealth")));
  check(`the historical/wealth engines (${hist.length} files) import no reconciliation`,
    hist.every((f) => !code(f).includes("reconcileAccount")));
  // The as-of path must not attach a current-state claim.
  const asof = code("lib/data/accounts-asof-window.ts");
  check("the as-of reconstruction attaches no currentState",
    !asof.includes("currentState") && !asof.includes("reconcileAccount"));
  const lensBind = code("lib/perspective-engine/lenses/liquidity.ts");
  check("the lens reads currentState off the visibility-resolved Account only",
    lensBind.includes("account.currentState") && !lensBind.includes('from "@/lib/db"'));
}

// ── Read-only ───────────────────────────────────────────────────────────────

console.log("\nPROBE 15 — the reconciliation modules write nothing");
{
  for (const f of ["lib/balances/pending-evidence.ts", "lib/balances/reachable.ts",
                   "lib/balances/reconciliation-labels.ts", AUTHORITY]) {
    const c = code(f);
    check(`${path.basename(f)} performs no write`,
      !/\.update\(|\.create\(|\.upsert\(|\.delete\(|\.createMany\(|\$executeRaw/.test(c));
  }
}

if (failures > 0) { console.error(`\nreconciliation-boundary: ${failures} failure(s).`); process.exit(1); }
console.log("\nreconciliation-boundary: all passed.");
