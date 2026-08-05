/**
 * lib/balances/balance-boundary.test.ts   (v2.6-L2)
 *
 * STANDING source-scan probes for the balance authority. Repo-wide, comments
 * stripped — a probe asserts on CODE, never on prose about code.
 *
 * Probe 1 is the load-bearing one: `FinancialAccount.availableBalance` carries
 * reachable cash, settled cash, and an unused CREDIT LINE in one column, and on
 * the Chase card a uniform reader is wrong by $32,460. This probe is what keeps
 * that column sealed behind lib/balances/account-balances.ts.
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

console.log(`Scanning ${FILES.length} source files\n`);

// ── 1. availableBalance is sealed ────────────────────────────────────────────

/** The ONE module allowed to interpret the column as a value. */
const AUTHORITY = path.join("lib", "balances", "account-balances.ts");
/** Provider WRITE paths — they set the column from Plaid; they never read it. */
const WRITE_PATHS = new Set([
  path.join("lib", "plaid", "refresh.ts"),
  path.join("lib", "plaid", "exchangeToken.ts"),
]);

console.log("PROBE 1 — availableBalance is readable ONLY by the balance authority");
{
  const offenders: string[] = [];
  const forwarders: string[] = [];

  for (const f of FILES) {
    if (f === AUTHORITY || WRITE_PATHS.has(f)) continue;
    const c = code(f);
    const hits = [...c.matchAll(/availableBalance/g)];
    if (hits.length === 0) continue;

    // Outside the authority a file may only NAME the column in order to select
    // it or hand it straight to the authority. Any other use — arithmetic, a
    // comparison, a nullish fallback, a local binding — is an interpretation,
    // and interpretation is exactly what this boundary exists to centralise.
    const allowedForms = [
      /availableBalance:\s*true\b/g,                    // Prisma select
      /availableBalance:\s*number\s*\|\s*null/g,        // a type declaration
      /availableBalance\??:\s*number\s*\|\s*null/g,
      /availableBalance:\s*[A-Za-z_$][\w$.]*(?:\s*\?\?\s*null)?,/g, // forward a field
      /availableBalance:\s*null,/g,                     // explicit "nothing to forward"
      /availableBalance\?:\s*number\s*\|\s*null;/g,
    ];
    let residue = c;
    for (const re of allowedForms) residue = residue.replace(re, "");
    if (/availableBalance/.test(residue)) {
      const line = residue.split("\n").find((l) => l.includes("availableBalance"))?.trim() ?? "";
      offenders.push(`${f}  →  ${line.slice(0, 90)}`);
    } else {
      forwarders.push(f);
    }
  }

  check("no file outside the authority INTERPRETS availableBalance",
    offenders.length === 0, offenders.join("\n      "));
  // The forwarders are a known, small set; growth here is fine (it means another
  // surface adopted the authority) but it must be visible.
  console.log(`      (${forwarders.length} file(s) forward the raw column into the authority: ${forwarders.join(", ") || "none"})`);

  const authority = code(AUTHORITY);
  check("the authority never falls back from available to the observed balance",
    !/availableBalance\s*\?\?\s*[\w.]*balance/.test(authority) &&
    !/available[\w.]*\s*\?\?\s*input\.balance/.test(authority));
}

// ── 2. Debt never uses available credit as amount owed ───────────────────────

console.log("\nPROBE 2 — available credit is never a debt figure");
{
  const authority = code(AUTHORITY);
  check("amount owed comes from the existing balance-semantics authority",
    /claim\("AMOUNT_OWED",\s*amountOwed\(input\.balance\)\)/.test(authority));
  check("AMOUNT_OWED is never built from the available figure",
    !/AMOUNT_OWED[^)]*available/.test(authority));
  check("AVAILABLE_CREDIT is only reachable on a debt row",
    /case "debt": \{[\s\S]*?AVAILABLE_CREDIT/.test(authority) &&
    (authority.match(/AVAILABLE_CREDIT/g) ?? []).length ===
      (authority.match(/availableClaim\("AVAILABLE_CREDIT"/g) ?? []).length +
      (authority.match(/quantity === "AVAILABLE_CREDIT"/g) ?? []).length);
  // The consumer accessor refuses everything that is not the named quantity.
  check("availableCredit() returns null for any other quantity",
    /quantity === "AVAILABLE_CREDIT"\s*\?\s*b\.available\.amount\s*:\s*null/.test(authority));
}

// ── 3. Liquidity never treats credit as cash ─────────────────────────────────

console.log("\nPROBE 3 — credit is never cash");
{
  const authority = code(AUTHORITY);
  // Slice the accessor's OWN body — a window measured in characters would run
  // into the next function and assert on the wrong code.
  const bodyOf = (fn: string): string => {
    const at = authority.indexOf(`export function ${fn}(`);
    if (at < 0) return "";
    const open = authority.indexOf("{", authority.indexOf(")", at));
    let depth = 0;
    for (let i = open; i < authority.length; i++) {
      if (authority[i] === "{") depth++;
      else if (authority[i] === "}" && --depth === 0) return authority.slice(open, i + 1);
    }
    return "";
  };
  const reach = bodyOf("reachableCash");
  check("reachableCash() has a body to assert on", reach.length > 20);
  check("reachableCash() admits ONLY AVAILABLE_CASH",
    reach.includes('"AVAILABLE_CASH"') && /:\s*null/.test(reach));
  check("reachableCash() does not admit AVAILABLE_CREDIT", !reach.includes("AVAILABLE_CREDIT"));
  check("reachableCash() does not admit SETTLED_CASH", !reach.includes("SETTLED_CASH"));
  // The liquidity lens must not have started consuming the raw column.
  const liq = code("lib/perspective-engine/lenses/liquidity.core.ts");
  check("the liquidity core reads no available column", !liq.includes("availableBalance"));
}

// ── 4. Investment value never becomes available cash ─────────────────────────

console.log("\nPROBE 4 — an account's value is never its available cash");
{
  const authority = code(AUTHORITY);
  check("the investment branch returns SETTLED_CASH or refuses — never the balance",
    /case "investment":[\s\S]{0,240}PROVIDER_DID_NOT_REPORT[\s\S]{0,120}SETTLED_CASH/.test(authority));
  const settledBody = (() => {
    const at = authority.indexOf("export function settledCash(");
    const open = authority.indexOf("{", authority.indexOf(")", at));
    let depth = 0;
    for (let i = open; i < authority.length; i++) {
      if (authority[i] === "{") depth++;
      else if (authority[i] === "}" && --depth === 0) return authority.slice(open, i + 1);
    }
    return "";
  })();
  check("settledCash() admits ONLY SETTLED_CASH",
    settledBody.includes('"SETTLED_CASH"') &&
    !settledBody.includes("AVAILABLE_CASH") && !settledBody.includes("AVAILABLE_CREDIT"));
}

// ── 5. Null available stays unknown ──────────────────────────────────────────

console.log("\nPROBE 5 — a refusal carries no amount at all");
{
  const q = code("lib/balances/quantities.ts");
  // The UNAVAILABLE arm must not declare an `amount` — that is what makes
  // `claim.amount ?? balance` unwriteable rather than merely discouraged.
  const unavailArm = q.slice(q.indexOf("export type AvailableClaim"));
  const arm = unavailArm.slice(0, unavailArm.indexOf("export function"));
  check("the UNAVAILABLE arm declares no `amount` field",
    /status:\s+"UNAVAILABLE"/.test(arm) && !/UNAVAILABLE[\s\S]*?amount/.test(arm));
  check("three distinct refusal reasons are modelled",
    q.includes("PROVIDER_DID_NOT_REPORT") && q.includes("SEMANTICS_UNATTESTED") && q.includes("NOT_APPLICABLE"));
  // A consumer that has the converted figure must carry null through as null.
  const ledger = code("components/space/widgets/accounts/AccountsLedger.tsx");
  check("the ledger carries a refused available through as null, not 0",
    /status === "AVAILABLE"[\s\S]{0,160}:\s*null;/.test(ledger));
}

// ── 6. Freshness travels with every balance claim ────────────────────────────

console.log("\nPROBE 6 — freshness is composed, never re-derived");
{
  const authority = code(AUTHORITY);
  check("AccountBalances carries the freshness answer",
    /freshness:\s*AccountFreshness;/.test(authority));
  check("the input REQUIRES a freshness answer (not optional)",
    /freshness:\s*AccountFreshness;/.test(authority.slice(authority.indexOf("AccountBalanceInput"))));
  check("the authority does not re-derive ages",
    !/86_?400_?000/.test(authority) && !/getTime\(\)/.test(authority));
  check("the authority holds no clock of its own",
    !/new Date\(\)/.test(authority.slice(0, authority.indexOf("resolveRowBalances"))));
  const route = code("app/api/spaces/[id]/accounts/detail/route.ts");
  check("the detail read resolves freshness ONCE and composes it",
    route.includes("freshness:           fullFreshness") &&
    route.includes("freshness:          fullFreshness"));
}

// ── 7. The two clocks never merge ────────────────────────────────────────────

console.log("\nPROBE 7 — provider and ingestion clocks stay separate");
{
  const substitution = FILES.filter((f) =>
    /balanceLastUpdatedAt\s*[:?]{0,2}\s*\?\?\s*[\w.]*lastUpdated/.test(code(f)) ||
    /balanceLastUpdatedAt\s*\|\|\s*[\w.]*lastUpdated/.test(code(f)),
  );
  check("no file substitutes our write clock for the institution's",
    substitution.length === 0, substitution.join(", "));
  const liqCore = code("lib/perspective-engine/lenses/liquidity.core.ts");
  const debtCore = code("lib/perspective-engine/lenses/debt.core.ts");
  for (const [name, c] of [["liquidity", liqCore], ["debt", debtCore]] as const) {
    check(`the ${name} core degrades dataAsOfBasis to INGESTION unless EVERY row is attested`,
      /every\(\(r\) => r\.balanceLastUpdatedAt != null\)/.test(c) &&
      /\?\s*"PROVIDER_ATTESTED"\s*:\s*"INGESTION"/.test(c));
  }
  const types = code("lib/perspective-engine/types.ts");
  check("dataAsOfBasis is REQUIRED on LensProvenance (every site must state it)",
    /dataAsOfBasis:\s*FreshnessBasis;/.test(types));
}

// ── 8. Every current-balance surface labels its quantity ─────────────────────

console.log("\nPROBE 8 — every section widget is classified, and balance cards disclose");
{
  // Read the registry's actual key list and require a classification for each.
  const registrySrc = src("components/space/sections/SectionRegistry.tsx");
  const body = registrySrc.slice(registrySrc.indexOf("export const SectionRegistry"));
  const keys = [...body.matchAll(/^\s{2}"([a-z_0-9]+)":/gm)].map((m) => m[1]);
  check(`the registry exposes a readable key list (${keys.length} keys)`, keys.length > 30);

  const mapSrc = code("lib/balances/section-quantity.ts");
  const missing = keys.filter((k) => !new RegExp(`\\b${k}:\\s`).test(mapSrc));
  check("EVERY SectionRegistry key is classified in SECTION_QUANTITY",
    missing.length === 0, `unclassified: ${missing.join(", ")}`);

  const card = code("components/space/sections/SectionCard.tsx");
  check("the card asks the map for its quantity", card.includes("sectionQuantityNote("));
  // Every shell must render the wrapper, not the bare body — otherwise a card
  // family silently loses its label.
  check("no card shell renders the bare body",
    !/\{renderBody\(\)\}/.test(card.replace(/function renderBodyWithQuantity\(\)[\s\S]*?\n  \}/, "")));
  check("all four card shells render the labelled body",
    (card.match(/\{renderBodyWithQuantity\(\)\}/g) ?? []).length === 4);

  // The account panel names both quantities.
  const panel = code("components/space/widgets/accounts/AccountDetail.tsx");
  check("the account panel headline is the NAMED quantity, not 'Current balance'",
    panel.includes("{headline.label}") && !panel.includes("Current balance"));
  check("the account panel renders the available quantity's own label",
    panel.includes("balances.available.label"));
  check("the account panel takes the debt headline from the authority",
    /balances\.debt \? balances\.debt\.owed : balances\.observed/.test(panel));

  // The AI payload names the quantity instead of shipping a bare number.
  const ai = code("lib/ai/assemblers/accounts.ts");
  check("the AI payload sends a NAMED available quantity", ai.includes("availableQuantity:"));
  check("...at BOTH visibility tiers",
    (ai.match(/\.\.\.balanceFacts\(fa, now\),/g) ?? []).length === 2);
  check("the AI payload does not send the raw column",
    !/availableBalance:\s*fa\.availableBalance\.toString|availableBalance:\s*fa\.availableBalance\s*\?\?\s*null,\s*\n\s*syncStatus/.test(ai));
}

// ── 9. Read-only slice ───────────────────────────────────────────────────────

console.log("\nPROBE 9 — the balance authority writes nothing");
{
  for (const f of ["lib/balances/quantities.ts", "lib/balances/account-balances.ts", "lib/balances/section-quantity.ts"]) {
    const c = code(f);
    check(`${path.basename(f)} touches no database`,
      !c.includes("@/lib/db") && !/prisma|\.update\(|\.create\(|\.upsert\(/.test(c));
  }
}

if (failures > 0) { console.error(`\nbalance-boundary: ${failures} failure(s).`); process.exit(1); }
console.log("\nbalance-boundary: all passed.");
