/**
 * components/connections/connections-actions.test.ts  (PB-2, owner addendum 2026-11-01)
 *
 * The Connections header carries TWO actions — "+ Connect" (a menu of the
 * provider flows) and "+ Add Manual Asset" — instead of three buttons, and every
 * workflow behind them is the one that existed before.
 *
 *   npx tsx components/connections/connections-actions.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const raw = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
const code = (rel: string) => raw(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "").replace(/^\s*\/\/.*$/gm, "");

const SRC = code("components/connections/ConnectionsActions.tsx");
const buttons = SRC.match(/<GlassButton\b/g) ?? [];

console.log("Connections actions (PB-2)");
check("exactly two header buttons: + Connect and + Add Manual Asset", buttons.length === 2, String(buttons.length));
check("the Connect trigger comes first (ConnectionsList's 'Add another connection' focuses the first button)",
  SRC.indexOf("data-connect-trigger") > 0 && SRC.indexOf("data-connect-trigger") < SRC.indexOf("data-add-manual-asset"));
check("labels: Connect and Add Manual Asset, each with a + icon", />\{isLoading \? "Opening…" : "Connect"\}</.test(SRC) && />Add Manual Asset</.test(SRC) && (SRC.match(/<Plus size=\{16\}/g) ?? []).length === 2);
check("the old three labels are gone", !/Connect institution|Add wallet \(address or xpub\)|>Add asset</.test(SRC));
check("the trigger announces a menu and its state", /aria-haspopup="menu"/.test(SRC) && /aria-expanded=\{menuOpen\}/.test(SRC));
check("the menu is a role=menu with two menuitems", /role="menu"/.test(SRC) && (SRC.match(/role="menuitem"/g) ?? []).length === 2);

console.log("workflows preserved");
check("Bank or brokerage → Plaid Link (usePlaid().openLink), closing the menu first", /const connectBank = \(\) => \{\s*setMenuOpen\(false\);\s*openLink\(\);\s*\};/.test(SRC) && /onClick=\{connectBank\}/.test(SRC));
check("Crypto wallet → the existing AddWalletModal", /const connectWallet = \(\) => \{\s*setMenuOpen\(false\);\s*setWalletOpen\(true\);\s*\};/.test(SRC) && /<AddWalletModal\b/.test(SRC));
check("Add Manual Asset → the existing AddManualAssetModal", /onClick=\{\(\) => setAssetOpen\(true\)\}/.test(SRC) && /<AddManualAssetModal\b/.test(SRC));
check("both modals refresh the page on add, as before", (SRC.match(/onAdd=\{\(\) => router\.refresh\(\)\}/g) ?? []).length === 2);
check("PO-5A: with Plaid unavailable the bank item is disabled with the honest notice (never a dead end)",
  /disabled=\{!plaidEnabled\}/.test(SRC) && /Bank connections are being set up — check back soon\./.test(SRC));
check("the Plaid error still renders", /\{error && \(/.test(SRC));
check("no wallet/Plaid logic and no Liquid WebGL here", !/fetch\(|AtlasLiquid|useAtlasLiquid/.test(SRC));

console.log("responsive + accessible");
check("below sm: a bottom sheet portalled to <body>, with a backdrop that closes it",
  /window\.matchMedia\("\(max-width: 639\.98px\)"\)/.test(SRC) && /createPortal\(/.test(SRC) && /document\.body/.test(SRC)
  && /onClick=\{\(\) => setMenuOpen\(false\)\}/.test(SRC) && /fixed inset-x-0 bottom-0/.test(SRC));
check("sm+: an anchored popover under the trigger", /\{menuOpen && !sheet && menuPanel\}/.test(SRC) && /sm:absolute[^"]*sm:top-full/.test(SRC));
check("outside click closes (trigger root or the portalled menu count as inside)", /!root\.current\?\.contains\(t\) && !menu\.current\?\.contains\(t\)/.test(SRC));
check("Escape closes and returns focus to the trigger", /e\.key === "Escape"[\s\S]{0,80}setMenuOpen\(false\);\s*trigger\.current\?\.focus\(\);/.test(SRC));
check("Tab / Shift+Tab close the menu WITHOUT trapping: no preventDefault, no refocus (Escape owns refocus)",
  /if \(e\.key === "Tab"\) \{ setMenuOpen\(false\); return; \}/.test(SRC)
  && !/e\.key === "Tab"[^\n]*preventDefault/.test(SRC) && !/e\.key === "Tab"[^\n]*trigger\.current\?\.focus/.test(SRC));
check("focus moving to a focusable outside root/menu closes it; a null relatedTarget does not (Safari tap-to-select)",
  /onBlur=\{\(e\) => \{[\s\S]{0,600}if \(to && !root\.current\?\.contains\(to\) && !menu\.current\?\.contains\(to\)\) setMenuOpen\(false\);/.test(SRC));
check("below sm the two actions stack full-width so labels never truncate; inline on sm+",
  /<div className="flex flex-col gap-2\.5 sm:flex-row">/.test(SRC) && (SRC.match(/fullWidth\s+className="sm:w-auto"/g) ?? []).length === 2);
check("opening focuses the first enabled item; arrows move between items", /\[role=menuitem\]:not\(\[disabled\]\)"\)\?\.focus\(\)/.test(SRC) && /ArrowDown/.test(SRC) && /ArrowUp/.test(SRC));
check("the page host is unchanged: header actions only when connections exist",
  /headerActions=\{hasConnections \? <ConnectionsActions plaidEnabled=\{plaidEnabled\} \/> : undefined\}/.test(code("components/connections/ConnectionsSpaceDashboard.tsx")));

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
