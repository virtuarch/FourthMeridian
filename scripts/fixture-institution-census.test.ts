/**
 * scripts/fixture-institution-census.test.ts — public-repo hygiene: test and
 * fixture files use obviously fake institution names ("Example Bank",
 * "Example Card", "Example Brokerage", "Example Exchange", "Institution A"…),
 * never a real bank, card issuer, broker or crypto exchange — and neutral card
 * product names ("Card Product A", "Example Rewards"), never a real issuer's
 * card product or rewards programme.
 *
 * SCOPE — every TRACKED file (git ls-files) that is a test or a fixture:
 *   - basename ends in `.test.ts` / `.test.tsx`;
 *   - path has a `__fixtures__/` or `fixtures/` directory segment;
 *   - basename is `fixture(s).{ts,tsx,json}` or `*.fixture(s).{ts,tsx,json}`
 *     (e.g. `valuation.fixtures.ts`, `platform-fixtures.json`).
 * Production code is out of scope: it may legitimately name an institution
 * (an import profile, a provider-specific extractor, a fee rule).
 *
 * MATCHING RULE — each name in INSTITUTION_NAMES and CARD_PRODUCT_NAMES matches:
 *   - CASE-SENSITIVELY, as written OR in ALL CAPS ("Chase" and "CHASE", never
 *     "chase"), so ordinary lowercase words ("chase the cursor", "discover",
 *     "ally") and provider descriptor casing are told apart;
 *   - on a WORD BOUNDARY: the character before and after must not be a letter,
 *     digit or underscore ("Purchase", "Citizen", "SCHWAB_STALE" do not match).
 * Lowercase identifiers (`chaseCard`, `csv:schwab`) are deliberately not
 * matched: lowercase is where the false positives live.
 *
 * ALLOWLIST — a test may keep a real name only when the production behaviour
 * under test is itself keyed on that name. Each entry names the file, the exact
 * names it may contain, and why. An entry that no longer matches anything fails
 * the census, so the allowlist can only shrink honestly.
 *
 * Hermetic: reads the working tree only.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const INSTITUTION_NAMES: readonly string[] = [
  "JPMorgan Chase", "JPMorgan", "J.P. Morgan", "Chase", "Bank of America", "BofA", "Wells Fargo",
  "Citibank", "Citigroup", "Citi", "U.S. Bank", "U.S. Bancorp", "PNC", "Truist", "Capital One",
  "TD Bank", "Goldman Sachs", "Marcus by Goldman Sachs", "Ally Bank", "Ally", "Citizens Bank",
  "Fifth Third", "KeyBank", "Huntington Bank", "Regions Bank", "M&T Bank", "BMO Harris", "Santander",
  "HSBC", "Barclays", "First Citizens", "Synchrony", "USAA", "Navy Federal", "PenFed", "Discover",
  "American Express", "Amex", "AmEx", "SoFi", "Chime", "Varo", "Comerica", "Zions Bank", "Frost Bank",
  "First Republic", "Silicon Valley Bank", "Axos", "Webster Bank", "East West Bank",
  "Charles Schwab", "Schwab", "Fidelity Investments", "Fidelity", "Vanguard", "E*TRADE", "E-Trade",
  "TD Ameritrade", "Robinhood", "Merrill Lynch", "Merrill Edge", "Merrill", "Morgan Stanley",
  "Interactive Brokers", "Webull", "Edward Jones", "Raymond James", "Ameriprise", "LPL Financial",
  "Wealthfront", "Betterment", "Acorns", "M1 Finance", "Firstrade", "tastytrade", "TIAA", "Stifel",
  "Ally Invest",
  "Coinbase", "Kraken", "Binance", "Binance.US", "Gemini", "Crypto.com", "Bitstamp", "KuCoin",
  "Bitfinex", "OKX", "Bybit", "Bittrex", "Huobi", "Gate.io", "Bitget", "Uphold", "eToro",
];

const CARD_PRODUCT_NAMES: readonly string[] = [
  "Sapphire Reserve", "Sapphire Preferred", "Sapphire", "Freedom Unlimited", "Freedom Flex", "Freedom",
  "Ultimate Rewards", "Ink Business", "Ink Cash", "Ink Preferred", "United Explorer", "MileagePlus",
  "Rapid Rewards", "Prime Visa", "Amazon Prime Visa", "Platinum Card", "Gold Card", "Green Card",
  "Blue Cash Preferred", "Blue Cash Everyday", "Blue Cash", "Membership Rewards", "Delta SkyMiles",
  "SkyMiles", "Hilton Honors", "Marriott Bonvoy", "Bonvoy", "Centurion", "Double Cash", "Custom Cash",
  "Strata Premier", "ThankYou Points", "ThankYou Rewards", "ThankYou", "Diamond Preferred", "AAdvantage",
  "Venture X", "VentureOne", "Venture", "Quicksilver", "QuicksilverOne", "SavorOne", "Savor", "Spark Cash",
  "Discover it", "Cashback Match", "Active Cash", "Autograph", "Bilt", "Customized Cash Rewards",
  "Unlimited Cash Rewards", "Premium Rewards", "Preferred Rewards", "BankAmericard", "Altitude Reserve",
  "Altitude Connect", "Apple Card", "Costco Anywhere Visa", "World of Hyatt", "IHG One Rewards", "Slate Edge",
];

type AllowEntry = { file: string; names: readonly string[]; reason: string };
const ALLOWLIST: readonly AllowEntry[] = [
  {
    file: "lib/imports/investments/import-validation.test.ts",
    names: ["Schwab", "SCHWAB", "Charles Schwab", "Coinbase", "COINBASE"],
    reason: "exercises the branded import profiles (csv:schwab, coinbase) whose detection and compatibility check match these institution names",
  },
  {
    file: "lib/investments/investment-import-preview.test.ts",
    names: ["Schwab", "Charles Schwab", "Coinbase"],
    reason: "exercises the branded import profiles (csv:schwab, coinbase) through the preview; the blocking reason names both profiles",
  },
  {
    file: "lib/imports/investments/pipeline.test.ts",
    names: ["Schwab"],
    reason: "describes the csv:schwab import profile's sign conventions",
  },
  {
    file: "lib/transactions/merchant-rules.test.ts",
    names: ["Amex", "AMEX", "American Express"],
    reason: "exercises the card-fee merchant rule whose production tokens name this issuer",
  },
  {
    file: "lib/transactions/plaid-category.test.ts",
    names: ["Amex", "AMEX"],
    reason: "exercises the card-fee merchant rule (via categorisation) whose production tokens name this issuer",
  },
  {
    file: "lib/transactions/transfer-authority.test.ts",
    names: ["Chase", "Amex"],
    reason: "a source-scan VETO list: asserts production transfer code does NOT name these institutions",
  },
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function institutionMatcher(names: readonly string[]): RegExp {
  const forms = [...new Set(names.flatMap((n) => [n, n.toUpperCase()]))].sort((a, b) => b.length - a.length);
  return new RegExp(`(?<![A-Za-z0-9_])(?:${forms.map(escapeRe).join("|")})(?![A-Za-z0-9_])`, "g");
}

function isTestOrFixture(file: string): boolean {
  const base = path.posix.basename(file);
  return /\.test\.tsx?$/.test(base)
    || /(^|\/)(__fixtures__|fixtures)\//.test(file)
    || /(^|\.|-)fixtures?\.(ts|tsx|json)$/.test(base);
}

const RE = institutionMatcher([...INSTITUTION_NAMES, ...CARD_PRODUCT_NAMES]);
const hits = (text: string) => [...text.matchAll(RE)].map((m) => m[0]);

console.log("1. the matcher");
check("matches a name as written", hits("institution: \"Chase\"").join() === "Chase");
check("matches the ALL-CAPS form", hits("CHASE CREDIT CRD AUTOPAY").join() === "CHASE");
check("ignores the lowercase word", hits("we chase the cursor; discover; an ally").length === 0);
check("respects word boundaries", hits("Purchase · Citizen · SCHWAB_STALE · twoChase · Amexico").length === 0);
check("prefers the longest name", hits("Charles Schwab").join() === "Charles Schwab" && hits("Sapphire Reserve").join() === "Sapphire Reserve");
check("matches card product names, as written and in ALL CAPS", hits("Ultimate Rewards® · PLATINUM CARD").join() === "Ultimate Rewards,PLATINUM CARD");
check("punctuated names match literally", hits("E*TRADE and Crypto.com").join() === "E*TRADE,Crypto.com" && hits("CryptoXcom").length === 0);
check("scope: tests, fixtures dirs and fixture modules only",
  isTestOrFixture("lib/a/b.test.ts") && isTestOrFixture("lib/x/__fixtures__/y.ts") && isTestOrFixture("lib/imports/fixtures/a.csv")
  && isTestOrFixture("lib/ai/brief/fixtures.ts") && isTestOrFixture("lib/investments/valuation.fixtures.ts")
  && isTestOrFixture("scripts/ui-hardening/platform-fixtures.json")
  && !isTestOrFixture("lib/a/b.ts") && !isTestOrFixture("lib/admin/provider-lifecycle.ts") && !isTestOrFixture("docs/fixtures-notes.md"));
check("the list is broad (≥ 90 names) and has no duplicates",
  INSTITUTION_NAMES.length >= 90 && new Set(INSTITUTION_NAMES).size === INSTITUTION_NAMES.length);
check("the card product list is broad (≥ 50 names), has no duplicates and does not overlap the institutions",
  CARD_PRODUCT_NAMES.length >= 50 && new Set(CARD_PRODUCT_NAMES).size === CARD_PRODUCT_NAMES.length
  && CARD_PRODUCT_NAMES.every((n) => !INSTITUTION_NAMES.includes(n)));

console.log("2. this checkout");
{
  const SELF = "scripts/fixture-institution-census.test.ts";
  let tracked: string[] = [];
  try {
    tracked = execFileSync("git", ["ls-files", "-z"], { cwd: process.cwd(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
      .split("\0").filter(Boolean);
  } catch (e) {
    check("git ls-files is readable (a census that sees no files guards nothing)", false, String(e));
  }
  const inScope = tracked.filter((f) => f !== SELF && isTestOrFixture(f));
  check("the census sees test files", inScope.length > 100, `${inScope.length} files`);

  const allow = new Map(ALLOWLIST.map((e) => [e.file, e]));
  const violations: string[] = [];
  const seen = new Map<string, Set<string>>();
  for (const file of inScope) {
    let text: string;
    try { text = readFileSync(path.join(process.cwd(), file), "utf8"); } catch { continue; } // deleted in the working tree
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const name of hits(lines[i])) {
        const entry = allow.get(file);
        if (entry?.names.includes(name)) { (seen.get(file) ?? seen.set(file, new Set()).get(file)!).add(name); continue; }
        violations.push(`${file}:${i + 1}: "${name}"`);
      }
    }
  }
  check("no test or fixture names a real institution or card product (use Example Bank / Example Card / Example Brokerage / Example Exchange / Institution B… / Card Product A…)",
    violations.length === 0, `\n      ${violations.slice(0, 40).join("\n      ")}${violations.length > 40 ? `\n      … ${violations.length - 40} more` : ""}`);

  const stale = ALLOWLIST.flatMap((e) => e.names.filter((n) => !seen.get(e.file)?.has(n)).map((n) => `${e.file}: "${n}"`));
  check("every allowlist entry is still needed (shrink the allowlist when a name goes)", stale.length === 0, stale.join("; "));
  check("every allowlist entry carries a reason", ALLOWLIST.every((e) => e.reason.trim().length > 20));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
