/**
 * lib/spaces/reporting-currency.test.ts
 *
 * MC1 Phase 3 Slice 1 — allowlist + copy-once tests (pure, no DB). House-style
 * standalone tsx script, auto-discovered by scripts/run-tests.ts.
 */

import { parseReportingCurrencyInput, reportingCurrencyForNewSpace } from "./reporting-currency";
import { FX_BASE, SUPPORTED_QUOTES } from "@/lib/fx/config";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

// ── PATCH allowlist ───────────────────────────────────────────────────────────

{
  const usd = parseReportingCurrencyInput("USD");
  check("allowlist: USD (FX_BASE) accepted", usd.ok && usd.value === FX_BASE);

  let allQuotesAccepted = true;
  for (const q of SUPPORTED_QUOTES) {
    const r = parseReportingCurrencyInput(q);
    if (!r.ok || r.value !== q) { allQuotesAccepted = false; break; }
  }
  check(`allowlist: every supported quote accepted (${SUPPORTED_QUOTES.length})`, allQuotesAccepted);

  const lower = parseReportingCurrencyInput("eur");
  check("allowlist: lowercase normalized to upper", lower.ok && lower.value === "EUR");
  const padded = parseReportingCurrencyInput("  sar ");
  check("allowlist: whitespace trimmed", padded.ok && padded.value === "SAR");
}

{
  const cases: unknown[] = ["XXX", "usd2", "", "   ", "BTC", 42, null, undefined, {}, ["EUR"], "US"];
  const allRejected = cases.every((c) => parseReportingCurrencyInput(c).ok === false);
  check("allowlist: invalid values rejected (unknown codes, non-strings, empties, crypto)", allRejected);
  const r = parseReportingCurrencyInput("XXX");
  check("allowlist: rejection carries an error message (→ HTTP 400 in the route)",
    !r.ok && typeof r.error === "string" && r.error.length > 0);
}

// ── copy-once seed for new Spaces ─────────────────────────────────────────────

{
  check("copy-once: creator default copied", reportingCurrencyForNewSpace({ reportingCurrency: "EUR" }) === "EUR");
  check("copy-once: lowercase creator value normalized", reportingCurrencyForNewSpace({ reportingCurrency: "sar" }) === "SAR");
  check("copy-once: absent creator → USD", reportingCurrencyForNewSpace(null) === "USD");
  check("copy-once: missing field → USD", reportingCurrencyForNewSpace({}) === "USD");
  check("copy-once: null field → USD", reportingCurrencyForNewSpace({ reportingCurrency: null }) === "USD");
  check("copy-once: corrupt/unsupported creator value degrades to USD (never propagates)",
    reportingCurrencyForNewSpace({ reportingCurrency: "DOGE" }) === "USD");
}

// ── Report ────────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`\nMC1 P3 reporting-currency: ${failures.length} FAILURE(S) (${passed} checks passed):`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`MC1 P3 reporting-currency: all ${passed} checks passed.`);
process.exit(0);
