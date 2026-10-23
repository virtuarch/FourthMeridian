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
import { usesLegacyColumnForCurrentValue } from "./wallet-sync-dispatch";

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
  // ── W6d — BITCOIN IS A REGISTRY ANSWER, NOT AN EXCEPTION IN THIS FILE ──────
  //
  // This used to assert `!needsSpineValuation("BTC")` outright. That is a fact
  // about the REGISTRY, not about this predicate, and pinning it here meant the
  // one-line registry change that retires Bitcoin's balance column also had to
  // edit a test to match — which is exactly how a test stops guarding anything
  // and starts recording whatever the code last did.
  //
  // So what is pinned is the DERIVATION: whatever the registry says about a
  // chain's net-worth participation is what this predicate answers, in both
  // directions. Flip BTC in the registry and this still holds; special-case BTC
  // here and it does not.
  for (const chain of ["BTC", "SOL", "ETH", "BNB", "AVAX"]) {
    check(`${chain}'s current authority is derived from the registry, not restated`,
      needsSpineValuation({ id: "a", walletChain: chain }) === !usesLegacyColumnForCurrentValue(chain),
      "chain policy belongs to wallet-sync-dispatch; a second copy is a drift");
  }
  check("a non-wallet account is untouched",
    !needsSpineValuation({ id: "a", walletChain: null }) &&
    !needsSpineValuation({ id: "a", walletChain: undefined }) &&
    !needsSpineValuation({ id: "a", walletChain: "" }));
  check("chain matching is case/whitespace tolerant, as everywhere else",
    needsSpineValuation({ id: "a", walletChain: " btc " }) === !usesLegacyColumnForCurrentValue("BTC"));
  check("no chain is named in the predicate's own source",
    !/["']BTC["']|["']SOL["']|["']ETH["']/.test(SRC),
    "a chain literal here is the exception the registry exists to remove");
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
  check("the state vocabulary is declared, so a consumer cannot receive a bare number",
    /"VALUED"\s*\|\s*"STALE"\s*\|\s*"NO_PRICE"\s*\|\s*"NO_OBSERVATION"/.test(SRC));
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
    // W6b — the predicate moved into ONE authority (`hasKnownValue`), which
    // admits VALUED and STALE alike: falling back for staleness would swap a
    // dated last-known figure for an unwritten column that always reads zero.
    check(`${name} displaces the column only when a real number exists`,
      /hasKnownValue\(/.test(src),
      "substituting on NO_PRICE/NO_OBSERVATION would publish an invented number as money");
    check(`${name} does NOT re-derive that predicate locally`,
      !/state === "VALUED"/.test(src),
      "a second copy of the rule is how VALUED and STALE start disagreeing");
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
  // W6b — a stale reading is disclosed, never discarded.
  check("a STALE wallet keeps its number rather than falling back to the column",
    /state === "VALUED" \|\| v\.state === "STALE"/.test(code(read("lib", "crypto", "wallet-current-value.ts"))),
    "hasKnownValue must admit STALE, or staleness silently becomes a zero");
  check("freshness travels to the consumer alongside the number",
    /freshness:\s*walletValue\.freshness/.test(ACCOUNTS) && /observedAt/.test(ACCOUNTS));
  check("the FULL row carries the spine quantity rather than the unwritten column",
    /nativeBalance: walletValue\?\.quantity \?\? r\.nativeBalance/.test(ACCOUNTS));
  check("…and the tri-state travels with it, so a surface can refuse to show money",
    /cryptoPosition/.test(ACCOUNTS));
}

// ══ W6d — ONE FRESHNESS AUTHORITY, ONE PRICE AUTHORITY ════════════════════════
//
// Bitcoin arrives with a habit the other chains never had: its own sync-time
// spot quote, undated and unreproducible. Moving it onto this path is only worth
// anything if the answer comes from the SAME two authorities every other chain
// already uses — otherwise the column is not retired, it is renamed.
{
  check("freshness is the canonical band authority, not a local TTL",
    /from "@\/lib\/freshness\/observation"/.test(SRC) && /bandForAge\(/.test(SRC));
  check("…and no threshold is restated here",
    !/STALE_AFTER_DAYS\s*=|LIVE_WITHIN_DAYS\s*=|>\s*\d+\s*\*\s*86_?400/.test(SRC),
    "a second TTL is a second definition of 'current'");
  // The price is a DATED close resolved by the canonical service, and the date
  // must reach the consumer — a current claim priced at an older close is only
  // honest if the reader can see which close it was.
  check("the close actually used travels to every consumer",
    /priceDate/.test(SRC) && /priceDate:\s*walletValue\.priceDate/.test(ACCOUNTS));
  check("the value is never quantity × a locally fetched quote",
    !/fetchBtcUsdPrice|btc-explorer|computeUsdBalance/.test(SRC),
    "the undated sync-time spot is exactly what this path replaces");
}

// ══ W6d — TODAY'S SNAPSHOT IS THE FOURTH CONSUMER, AND IT IS THE ONE THAT ═════
// ══        TURNS A DISPLAYED NUMBER INTO PERSISTED WEALTH             ═════════
//
// The three surfaces above only SHOW a value. `readSpaceAccountsForSnapshot`
// feeds `regenerateSpaceSnapshot`, which writes today's SpaceSnapshot row — the
// number every net-worth chart, Space card and AI answer reads back. If it were
// left on the column while the surfaces moved, the chart and the card would
// disagree about the same wallet on the same day, which is the two-chains-of-
// custody defect the whole program is unwinding.
{
  const SNAP = code(read("lib", "snapshots", "space-accounts.ts"));
  check("the snapshot writer consults the same authority",
    /loadWalletCurrentValues\(/.test(SNAP));
  check("…and uses the SAME predicate, not its own idea of a usable value",
    /hasKnownValue\(/.test(SNAP) && !/state === "VALUED"/.test(SNAP));
  check("…and selects walletChain and lastUpdated, or freshness cannot be resolved",
    /walletChain/.test(SNAP) && /lastUpdated/.test(SNAP));
  check("…and names no chain",
    !/walletChain === ["']/.test(SNAP) && !/["']BTC["']/.test(SNAP));
  // W6b — a stale reading must reach the persisted row as a stale reading.
  check("staleness is DISCLOSED onto the snapshot rather than discarded",
    /isFreshCurrentValue\(/.test(SNAP) && /cryptoStale/.test(SNAP));
  check("the snapshot writer stamps that disclosure onto the row it persists",
    /cryptoStale === true/.test(code(read("lib", "snapshots", "regenerate.ts"))));
  // The CURRENT writer must not be reachable from the historical one: today's
  // evidence may not back-paint a prior date. (regenerate-history owns those.)
  check("the historical regenerator does NOT consult the current authority",
    !/loadWalletCurrentValues/.test(code(read("lib", "snapshots", "regenerate-history.ts"))),
    "current evidence back-painting history is the inverse of the W6 defect");
}

// ══ W6d — THE SPINE WRITE IS NOW LOAD-BEARING FOR BITCOIN ═════════════════════
//
// Once the current value comes from the spine, a swallowed capture failure costs
// the wallet its worth rather than costing the spine a row. btc-sync's write
// must therefore be able to REFUSE — and must do so before any column is
// written, so the two stores can never disagree about the same instant.
{
  const BTCSYNC = code(read("lib", "crypto", "btc-sync.ts"));
  check("btc-sync can refuse at the capture stage",
    /stage: "capture"/.test(BTCSYNC) && /"capture"/.test(BTCSYNC));
  check("the capture severity is read from the registry, not decided locally",
    /usesLegacyColumnForCurrentValue/.test(BTCSYNC),
    "hard-coding the severity re-creates the exception the registry removes");
  check("a disabled observation gate is caught too, not just a thrown error",
    /!written/.test(BTCSYNC),
    "captureWalletPosition returns written:false when the gate is off — that is "
    + "silence, and silence is fatal once the spine is the authority");
  // ORDER. The refusal must precede the row update, or a failed run leaves a
  // balance column written against an empty spine.
  const b = body(BTCSYNC);
  check("the capture refusal is evaluated BEFORE the balance columns are written",
    b.indexOf("captureRefusal") >= 0
      && b.indexOf("captureRefusal") < b.indexOf("balance: balanceUsd"));
  // COMPATIBILITY, deliberately kept: `nativeBalance` is still what
  // regenerate-history reads to decide a wallet ever held anything material, and
  // the pair is the last-resort fallback for a wallet with no spine evidence.
  check("btc-sync still WRITES both legacy columns (write compat ≠ read authority)",
    // (2026-09-21: the USD pair is written only by a PRICED run; the quantity always.)
    /nativeBalance,[\s\S]{0,300}balance:\s*balanceUsd/.test(BTCSYNC));
  // The current path may not be sourced from the replay, in either direction.
  check("btc-sync derives nothing current from the historical reconstruction",
    !/resolvePositionAsOf|regenerateSpace|btc-history-sync|replay/i.test(BTCSYNC));
}

// ══ NO CHAIN IS SPECIAL-CASED IN A READ SURFACE ═══════════════════════════════
{
  check("no consumer special-cases a chain by name",
    ![ACCOUNTS, MOUNT, DETAIL].some((s) => /walletChain === ["']/.test(s)),
    "chain policy belongs to the dispatch registry, never to a read surface");
  // W6c — the CURRENT authority asks whether the chain writes the balance
  // column, which is a different question from where its HISTORY comes from.
  // Bitcoin now answers differently to each, which is exactly why they split.
  check("participation is decided by the registry predicate, in one place",
    /usesLegacyColumnForCurrentValue/.test(SRC) && !/feedsLegacyWealthHistory/.test(SRC),
    "keying the current path on the historical predicate would have dragged "
    + "Bitcoin's live balance onto the spine as a side effect of W6c");
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
