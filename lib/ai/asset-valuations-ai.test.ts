/**
 * lib/ai/asset-valuations-ai.test.ts   (RWA-2A)
 *
 * The AI layer distinguishes a manual asset's RECORDED valuations (the user's
 * own dated estimates), the MODELED curve between them, and provider-observed
 * values — through DATA fields, never instruction text:
 *   - AccountSummaryItem carries `valuations`, `modeledHistory` (a descriptor,
 *     never points) and `valueChangeSinceFirstRecorded`;
 *   - the accounts assembler attaches them only to manual FULL rows (a dated value
 *     history discloses more than BALANCE_ONLY allows);
 *   - get_financial_snapshot passes them through;
 *   - the modeled descriptor says it is not an observed market price.
 *
 *   npx tsx lib/ai/asset-valuations-ai.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MODELED_HISTORY_MEANING } from "@/lib/assets/valuation-series.core";
import { readToolsSource } from "@/lib/test-support/tools-source";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const code = (...p: string[]) => strip(read(...p));

console.log("the type");
const TYPES = code("lib", "ai", "types.ts");
check("AccountSummaryItem.valuations — recorded anchors with their kind",
  /valuations\?: \{ date: string; value: number; kind: 'USER_VALUATION' \| 'PURCHASE_PRICE' \| 'LEGACY_BALANCE' \}\[\];/.test(TYPES));
check("AccountSummaryItem.modeledHistory — basis MODELED, a descriptor (no points array)",
  /modeledHistory\?: \{\s*basis:\s+'MODELED';/.test(TYPES) && !/modeledHistory\?: \{[^}]*points/.test(TYPES));
check("AccountSummaryItem.valueChangeSinceFirstRecorded", TYPES.includes("valueChangeSinceFirstRecorded?: { from: string; to: string; fromValue: number; toValue: number; change: number };"));

console.log("the assembler");
const ASM = code("lib", "ai", "assemblers", "accounts.ts");
check("one bulk history read through the phase's own client", /loadHistoriesFor\(\s*client,/.test(ASM));
check("…only for FULL-view manual assets",
  ASM.includes("grantsAccountDetail(l.visibilityLevel) && l.financialAccount.syncStatus === 'manual'"));
check("attached only on manual rows, in its own spread",
  ASM.includes("...(fa.syncStatus === 'manual' ? valuationFacts(historyByAccount.get(fa.id)) : {}),"));
check("the RWA-1B valuationSource spread is unchanged",
  ASM.includes("...(fa.syncStatus === 'manual' ? { valuationSource: 'USER_ESTIMATE' as const } : {}),"));
const aggStart = ASM.indexOf("nonDetailLinks");
check("the BALANCE_ONLY aggregate rows never receive valuation facts",
  aggStart > 0 && !ASM.slice(aggStart).includes("valuationFacts(historyByAccount"));
check("no modeled POINTS reach the model (descriptor only)", !/series:|buildValuationSeries/.test(ASM));
check("the model is shown at most 12 anchors", ASM.includes("const MAX_VALUATIONS_SHOWN = 12;"));

console.log("the tool");
const TOOLS = strip(readToolsSource()); // CQ-011: the tool layer (facade + lib/ai/conversation/tools/**)
for (const f of ["valuations", "modeledHistory", "valueChangeSinceFirstRecorded"]) {
  check(`get_financial_snapshot passes ${f} through`, TOOLS.includes(`...(a2.${f} ? { ${f}: a2.${f} } : {}),`));
}
check("find_in_balance_history still claims observed snapshots only (snapshot rows are unchanged by RWA-2A)",
  readToolsSource().includes("Observed daily snapshots only"));

console.log("the wording the model reads");
check("modeled meaning: not observed market prices", /not observed market prices/.test(MODELED_HISTORY_MEANING));
check("modeled meaning: carried forward, never projected", /carried forward unchanged, never projected/.test(MODELED_HISTORY_MEANING));

if (failures > 0) {
  console.error(`\nasset-valuations-ai: ${failures} failure(s).`);
  process.exit(1);
}
console.log("\nasset-valuations-ai: all passed.");
