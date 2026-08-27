/**
 * lib/crypto/current-authority-convergence.test.ts
 *
 * W6e — one wallet, one current value, whoever asks.
 *
 *     npx tsx lib/crypto/current-authority-convergence.test.ts
 *
 * W6d moved four surfaces onto the canonical current authority and left the
 * readers that build their own account list behind. The same Bitcoin wallet then
 * reported $18,869.73 or $18,978.59 depending on which consumer asked — and the
 * consumer most likely to be quoted, the AI context, was on the wrong side of it.
 *
 * A financial authority with two answers is not an authority, and one with seven
 * implementations would not have been either. What is pinned here is that the
 * substitution has exactly ONE implementation, that every reader capable of
 * making a current claim calls it, and that converging them did not teach any of
 * them to carry a current quantity into history.
 */

import { readFileSync } from "fs";
import { join } from "path";

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const read = (...s: string[]) => readFileSync(join(process.cwd(), ...s), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
/** Everything after the import block — ordering must compare CALL SITES. */
const body = (s: string) => {
  const m = [...s.matchAll(/^import[\s\S]*?;$/gm)];
  return m.length ? s.slice(m[m.length - 1].index! + m[m.length - 1][0].length) : s;
};

const AUTHORITY = "lib/crypto/wallet-current-value.ts";
const READERS = [
  ["AI accounts assembler", "lib/ai/assemblers/accounts.ts"],
  ["accounts-asof",         "lib/data/accounts-asof.ts"],
  ["accounts-asof-window",  "lib/data/accounts-asof-window.ts"],
  ["accounts (card)",       "lib/data/accounts.ts"],
  ["mount composition",     "lib/space/mount-composition.ts"],
  ["accounts detail route", "app/api/spaces/[id]/accounts/detail/route.ts"],
  ["today snapshot reader", "lib/snapshots/space-accounts.ts"],
  ["share picker",          "app/api/accounts/route.ts"],
] as const;

// ══ ONE IMPLEMENTATION, NOT SEVEN ═════════════════════════════════════════════
{
  const src = read(...AUTHORITY.split("/"));
  check("the substitution has a single named authority",
    /export async function applyCanonicalWalletBalances/.test(src));
  check("…which substitutes for VALUED and STALE alike",
    /hasKnownValue\(v\) \? \{ balance: v\.value! \} : \{\}/.test(code(src)),
    "a stale reading is the last known position; the column is an unwritten zero");
  check("…and returns the state alongside, so a caller can disclose it",
    /cryptoPosition: v/.test(code(src)));
  check("…leaving NO_PRICE / NO_OBSERVATION on whatever the caller had",
    /there is no number to put in its place/.test(src));

  for (const [name, file] of READERS) {
    const s = code(read(...file.split("/")));
    check(`${name} consults the authority`, /applyCanonicalWalletBalances|loadWalletCurrentValues/.test(s));
    check(`${name} re-derives no value of its own`,
      !/\*\s*(unitPrice|price)\b/.test(s) && !/quantity\s*\*\s*/.test(s),
      "seven slightly different crypto substitutions is the failure this avoids");
  }
}

// ══ THE AI CONTEXT IS A FINANCIAL CONSUMER ════════════════════════════════════
//
// It produces the net worth a model can quote, so it may not receive a weaker
// authority than the screen.
{
  const ai = read("lib", "ai", "assemblers", "accounts.ts");
  const aiBody = body(code(ai));
  check("the AI assembler selects walletChain — without it a wallet is a brokerage",
    /walletChain:\s*true/.test(aiBody));
  check("the substitution runs BEFORE any figure is derived from the links",
    aiBody.indexOf("applyCanonicalWalletBalances") < aiBody.indexOf("disclosingLinks"),
    "landing it after the first consumer leaves every earlier figure legacy");
  check("…and before the account rows are built",
    aiBody.indexOf("applyCanonicalWalletBalances") < aiBody.indexOf("trackedAccounts"));
  check("the AI layer decides NO financial semantics",
    !/BTC|SOL|ETH\b/.test(aiBody) && !/feedsLegacyWealthHistory|usesLegacyColumn/.test(aiBody),
    "chain, legacy-vs-spine, fresh-vs-stale and price all belong downstream");
}

// ══ CONVERGING CURRENT DID NOT TEACH ANYONE HISTORY ═══════════════════════════
{
  for (const file of ["lib/data/accounts-asof.ts", "lib/data/accounts-asof-window.ts"]) {
    const s = code(read(...file.split("/")));
    check(`${file}: only the INPUT balance is canonical`,
      /canonicalBalance\.get\(/.test(s));
    check(`${file}: the as-of ladder itself is untouched`,
      !/applyCanonicalWalletBalances[\s\S]{0,400}asOfDay/.test(s),
      "the walk-backs and floors must resolve exactly as before");
  }
  const core = code(read("lib", "data", "accounts-asof.core.ts"));
  check("the pure as-of core still knows nothing about wallets",
    !/wallet|crypto|spine/i.test(core),
    "financial semantics belong to the authority, not to the ladder");

  // The historical snapshot path must remain on coverage, never on current.
  const regen = code(read("lib", "snapshots", "regenerate-history.ts"));
  check("historical regeneration still reads no current wallet authority",
    !/loadWalletCurrentValues|applyCanonicalWalletBalances/.test(regen));
  check("…and still gates every spine quantity on its coverage licence",
    /resolveLicensedQuantityAsOf\(/.test(regen));
}

// ══ VISIBILITY IS UNCHANGED ═══════════════════════════════════════════════════
//
// A wallet balance is a balance-level fact, disclosed at every tier a balance is.
// The FULL-detail position API is deliberately still not used.
{
  const src = code(read(...AUTHORITY.split("/")));
  check("the authority still refuses the FULL-only detail seam",
    !/getCurrentPositions/.test(src),
    "reusing it would zero every BALANCE_ONLY-shared wallet");
  check("…and still makes no visibility decision of its own",
    !/visibilityLevel|TRANSACTION_DETAIL_VISIBILITY/.test(src));
  const accounts = code(read("lib", "data", "accounts.ts"));
  check("BALANCE_ONLY still receives the corrected balance",
    /balance:     displayBalance\(r\.balance, walletValue\)/.test(accounts));
  const ai = code(read("lib", "ai", "assemblers", "accounts.ts"));
  check("the AI assembler still filters by balance disclosure AFTER substitution",
    /grantsBalanceDisclosure/.test(ai),
    "substituting first and filtering second keeps the tier rules intact");
}

// ══ THE LEGACY COLUMN CANNOT MOVE A CANONICAL VALUE ═══════════════════════════
{
  const src = code(read(...AUTHORITY.split("/")));
  check("the canonical value is composed from spine rows, never the column",
    /POSITION_VALUATION_SELECT/.test(src) && !/nativeBalance/.test(src));
  check("no chain reads the column for its current value",
    /usesLegacyColumnForCurrentValue/.test(code(read("lib", "crypto", "wallet-sync-dispatch.ts"))));
  // The one deliberate remnant.
  const archived = code(read("app", "(shell)", "dashboard", "settings", "archived-assets", "page.tsx"));
  check("archived assets deliberately keep the column",
    !/applyCanonicalWalletBalances/.test(archived),
    "an archived account's value is a record of what it held, not a live claim");
}

// ══ DOCTRINE ══════════════════════════════════════════════════════════════════
{
  const doc = read("docs", "systems", "crypto-networks.md");
  check("doctrine: an authority is not converged until every consumer reads it",
    /not converged until every consumer/i.test(doc));
  check("doctrine: AI context is a financial consumer",
    /model-visible figures do not receive a weaker authority/i.test(doc));
}

console.log(`\ncurrent-authority-convergence: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
