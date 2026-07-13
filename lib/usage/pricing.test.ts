/**
 * lib/usage/pricing.test.ts  (Wave 2 S7)
 *
 * Pure guards for the optional pricing map. Confirms the SHIPPED-EMPTY default
 * (no estimate) and the per-unit math when a price IS configured. Standalone
 * tsx script:
 *
 *     npx tsx lib/usage/pricing.test.ts
 *
 * Exits 0 on pass / 1 on failure. No DB, no network.
 */

import { UNIT_PRICES_USD, isPricingConfigured, estimateUnitSpendUsd } from "@/lib/usage/pricing";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("usage/pricing");

// Ships empty → no estimate at all (the honest default).
check("UNIT_PRICES_USD ships empty", Object.keys(UNIT_PRICES_USD).length === 0);
check("isPricingConfigured() is false by default", isPricingConfigured() === false);
check("estimateUnitSpendUsd returns null for an unpriced tuple", estimateUnitSpendUsd("OPENAI", "chat.completions:gpt-4o-mini", "prompt_tokens", 1000) === null);

// Per-unit math when a price is injected (does not mutate the shipped default's meaning).
UNIT_PRICES_USD["OPENAI:chat.completions:test-model:prompt_tokens"] = 0.000002;
check("isPricingConfigured() true once a price exists", isPricingConfigured() === true);
check(
  "estimateUnitSpendUsd multiplies price × count",
  Math.abs((estimateUnitSpendUsd("OPENAI", "chat.completions:test-model", "prompt_tokens", 1_000_000) ?? 0) - 2) < 1e-9,
  String(estimateUnitSpendUsd("OPENAI", "chat.completions:test-model", "prompt_tokens", 1_000_000)),
);
delete UNIT_PRICES_USD["OPENAI:chat.completions:test-model:prompt_tokens"];

console.log(failures === 0 ? "\nAll usage/pricing checks passed." : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
