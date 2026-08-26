/**
 * lib/crypto/wallet-current-value.test.ts
 *
 * W-M3a — the wallet that held a verified position and rendered $0.00.
 *
 *     npx tsx lib/crypto/wallet-current-value.test.ts
 *
 * The defect: since W-M1c a native adapter writes its evidence to the position
 * spine and deliberately writes NO `FinancialAccount.balance`. That column is
 * `NOT NULL DEFAULT 0`, and the whole account read path composes displayed money
 * from it — so "withheld" was published as the number zero. A Solana wallet
 * holding 0.751600602 SOL showed $0.00 on every account surface while the
 * Investments workspace, reading the spine, showed it correctly.
 *
 * What is pinned here is the boundary, not the arithmetic: WHICH accounts are
 * re-sourced, WHEN a spine value may displace the column, and — the part that
 * matters most — that nothing in the path can turn an unknown into a zero.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { needsSpineValuation } from "./wallet-current-value";

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const read = (...s: string[]) => readFileSync(join(process.cwd(), ...s), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
/** Everything AFTER the import block. Ordering assertions must compare CALL
 *  SITES; import specifiers all sit near offset 0, so comparing raw offsets
 *  silently compares the import order instead and proves nothing. */
const body = (s: string) => { const m = [...s.matchAll(/^import[\s\S]*?;$/gm)]; 
  return m.length ? s.slice(m[m.length - 1].index! + m[m.length - 1][0].length) : s; };

const SRC       = code(read("lib", "crypto", "wallet-current-value.ts"));
const ACCOUNTS  = code(read("lib", "data", "accounts.ts"));
const MOUNT     = code(read("lib", "space", "mount-composition.ts"));
const DETAIL    = code(read("app", "api", "spaces", "[id]", "accounts", "detail", "route.ts"));

// ══ WHICH ACCOUNTS ARE RE-SOURCED ═════════════════════════════════════════════
//
// Exactly the wallets whose chain writes no balance column. Widening this would
// silently move BTC off the authority net worth composes from; narrowing it
// re-opens the bug for the next chain.
{
  check("SOL needs the spine (writes no column)",  needsSpineValuation({ id: "a", walletChain: "SOL" }));
  check("ETH needs the spine",                     needsSpineValuation({ id: "a", walletChain: "ETH" }));
  check("BNB needs the spine",                     needsSpineValuation({ id: "a", walletChain: "BNB" }));
  check("AVAX needs the spine",                    needsSpineValuation({ id: "a", walletChain: "AVAX" }));
  check("BTC does NOT — it writes the column and keeps it",
    !needsSpineValuation({ id: "a", walletChain: "BTC" }));
  check("a non-wallet account is untouched",
    !needsSpineValuation({ id: "a", walletChain: null }) &&
    !needsSpineValuation({ id: "a", walletChain: undefined }) &&
    !needsSpineValuation({ id: "a", walletChain: "" }));
  check("chain matching is case/whitespace tolerant, as everywhere else",
    !needsSpineValuation({ id: "a", walletChain: " btc " }));
  // An unregistered chain has no adapter, so it cannot write the column either —
  // it belongs on the spine path, where the honest answer is NO_OBSERVATION.
  check("an unregistered chain is re-sourced (and will answer NO_OBSERVATION)",
    needsSpineValuation({ id: "a", walletChain: "MATIC" }));
}

// ══ UNKNOWN IS NEVER ZERO ═════════════════════════════════════════════════════
//
// The single rule the whole module exists for.
{
  check("every wallet is SEEDED as NO_OBSERVATION before any read",
    /state:\s*"NO_OBSERVATION"/.test(SRC) &&
    SRC.indexOf('state:     "NO_OBSERVATION"') < SRC.indexOf("groupBy"),
    "a wallet that fails to resolve must stay unknown, not fall through to a value");
  check("the seed carries NULL quantity and NULL value — not 0",
    /quantity:\s*null,\s*\n\s*value:\s*null,/.test(SRC));
  check("no early return substitutes a zero",
    !/return\s+0\b/.test(SRC) && !/value:\s*0\b/.test(SRC) && !/quantity:\s*0\b/.test(SRC));
  check("an unpriceable holding reports NO_PRICE with a null value, keeping its quantity",
    /value: null, state: "NO_PRICE"/.test(SRC));
  check("the tri-state is declared, so a consumer cannot receive a bare number",
    /"VALUED"\s*\|\s*"NO_PRICE"\s*\|\s*"NO_OBSERVATION"/.test(SRC));
  // A CONFIRMED zero is a different fact and must survive as one.
  check("a confirmed zero balance is a real observation, so it stays VALUED",
    /CONFIRMED ZERO/.test(read("lib", "crypto", "wallet-current-value.ts")));
  check("accounts that do not need the spine are ABSENT from the map, never present at 0",
    /ABSENT from the map rather than[\s*]*present with a zero/.test(read("lib", "crypto", "wallet-current-value.ts")));
}

// ══ NOT A SECOND VALUATION AUTHORITY ══════════════════════════════════════════
{
  check("values through the canonical valuePositionRows path",
    /await valuePositionRows\(/.test(SRC));
  check("computes no price, FX or staleness of its own",
    !/priceObservation|fxRate|staleDays\s*=|\*\s*price\b/i.test(SRC));
  check("reads the spine through the shared valuation select",
    /POSITION_VALUATION_SELECT/.test(SRC) && /RECONSTRUCTION_VALUATION_SELECT/.test(SRC));
  check("honours the same superseded/deleted guards as the canonical read",
    (SRC.match(/supersededById:\s*null/g) ?? []).length >= 2 &&
    (SRC.match(/deletedAt:\s*null/g) ?? []).length >= 2);
  // Reusing the FULL-only detail seam would have zeroed BALANCE_ONLY wallets —
  // the same bug one visibility tier down.
  check("does NOT reuse getCurrentPositions (FULL-detail only)",
    !/getCurrentPositions/.test(SRC));
  check("makes no visibility decision of its own — it is given authorized ids",
    !/visibilityLevel|TRANSACTION_DETAIL_VISIBILITY|spaceAccountLink/.test(SRC));
  // Quantities across different instruments are not summable; values are.
  check("refuses to invent a quantity when an account holds more than one asset",
    /components\.length === 1 \? components\[0\]\.quantity : null/.test(SRC));
}

// ══ THE CONSUMERS ═════════════════════════════════════════════════════════════
//
// Three independent selects fed the three account surfaces, and all three read
// the column. Each must now consult the authority, and each must displace the
// column ONLY on VALUED.
{
  for (const [name, src] of [["accounts.ts", ACCOUNTS], ["mount-composition.ts", MOUNT], ["detail route", DETAIL]] as const) {
    check(`${name} consults the wallet-value authority`, /loadWalletCurrentValues\(/.test(src));
    check(`${name} selects walletChain, without which no wallet can be identified`,
      /walletChain/.test(src));
    check(`${name} displaces the column ONLY when the state is VALUED`,
      /state === "VALUED"/.test(src),
      "substituting on any other state would publish a null or an invented number as money");
    check(`${name} guards against a null value even on VALUED`,
      /value !== null/.test(src));
  }
  // The aggregate is composed from member balances; substituting after it would
  // sum the zeros.
  const mountBody = body(MOUNT);
  check("the mount substitutes BEFORE privacy aggregation",
    mountBody.indexOf("loadWalletCurrentValues(") < mountBody.indexOf("normalizeSharedAccounts("));
  // Every claim in the detail route composes from one number.
  const detailBody = body(DETAIL);
  check("the detail route substitutes ONCE, before freshness/balances/reconciliation",
    detailBody.indexOf("loadWalletCurrentValues(") < detailBody.indexOf("fullFreshness = resolveAccountFreshness(")
      && (detailBody.match(/loadWalletCurrentValues\(/g) ?? []).length === 1);
  // A wallet's value IS a balance, so the tier that discloses balances gets it.
  check("BALANCE_ONLY receives the corrected balance, not the zero column",
    /balance:     displayBalance\(r\.balance, walletValue\)/.test(ACCOUNTS));
  check("the FULL row carries the spine quantity rather than the unwritten column",
    /nativeBalance: walletValue\?\.quantity \?\? r\.nativeBalance/.test(ACCOUNTS));
  check("…and the tri-state travels with it, so a surface can refuse to show money",
    /cryptoPosition/.test(ACCOUNTS));
}

// ══ BTC IS UNTOUCHED ══════════════════════════════════════════════════════════
{
  check("no consumer special-cases a chain by name",
    ![ACCOUNTS, MOUNT, DETAIL].some((s) => /walletChain === ["']/.test(s)),
    "chain policy belongs to the dispatch registry, never to a read surface");
  check("participation is decided by the registry predicate, in one place",
    /feedsLegacyWealthHistory/.test(SRC));
  check("no consumer writes back to the balance column",
    ![ACCOUNTS, MOUNT, DETAIL, SRC].some((s) => /financialAccount\.update|\.updateMany/.test(s)),
    "the fix is a read correction — writing the column would fabricate the evidence");
}

// ══ THE DOCTRINE THIS RESTORES ════════════════════════════════════════════════
{
  const doc = read("docs", "systems", "crypto-networks.md");
  check("the doctrine names withheld-rendered-as-zero as a violation",
    /A WITHHELD value must never be published as zero/.test(doc));
}

console.log(`\nwallet-current-value: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
