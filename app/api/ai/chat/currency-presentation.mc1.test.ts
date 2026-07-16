/**
 * app/api/ai/chat/currency-presentation.mc1.test.ts
 *
 * MC1 Phase 4 Slice 7 — pinned-wording tests for the serializer's currency
 * presentation (plan D-9), in the KD-18 source-tripwire style
 * (attribution-guardrail.kd18.test.ts precedent): the wording is pinned
 * against the serializer source so a rewrite/removal fails a test before it
 * ships, and the single-insertion + conditional-emission structure is
 * asserted from the same source.
 *
 * AI-ARCH: serializeContextBlock was extracted from the chat route into
 * lib/ai/prompts/context-serializer.ts; the currency-presentation wording moved
 * with it verbatim, so this tripwire now reads the serializer module.
 *
 * Run from the repo root (source tripwires resolve paths from cwd).
 */

import { readFileSync } from "fs";
import { join } from "path";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

const routeSrc   = readFileSync(join(process.cwd(), "lib/ai/prompts/context-serializer.ts"), "utf8");
const builderSrc = readFileSync(join(process.cwd(), "lib/ai/context-builder.ts"), "utf8");

// ── the currency label: exact wording, single insertion, unconditional ───────
{
  const LABEL_A = "(this Space's reporting currency); ";
  const LABEL_B = "per-account values are shown in their native currency.";
  check("label: pinned wording present", routeSrc.includes(LABEL_A) && routeSrc.includes(LABEL_B));
  check("label: single insertion (exactly one emission site)",
    routeSrc.split(LABEL_B).length - 1 === 1);
  check("label: dynamic currency, not hardcoded USD",
    routeSrc.includes("All totals are in ${reportingCur}"));
  check("label: USD fallback for legacy/fixture contexts",
    routeSrc.includes("ctx.space.reportingCurrency ?? 'USD'"));
}

// ── the estimation disclosure: exact wording, single site, conditional ───────
{
  const DISCLOSURE =
    "Some converted totals are approximate (missing or dated exchange rates); " ;
  const DISCLOSURE_TAIL = "treat affected figures as estimates.";
  check("disclosure: pinned wording present",
    routeSrc.includes(DISCLOSURE) && routeSrc.includes(DISCLOSURE_TAIL));
  check("disclosure: single emission site", routeSrc.split(DISCLOSURE_TAIL).length - 1 === 1);

  // Conditional emission: the push must sit inside the flag check — assert the
  // guard exists and the disclosure follows it before any other lines.push.
  const guardIdx = routeSrc.indexOf("if (accountsEstimated || txnEstimated || holdingsEstimated)");
  const discIdx  = routeSrc.indexOf(DISCLOSURE_TAIL);
  check("disclosure: emitted ONLY behind the estimated-flags guard",
    guardIdx !== -1 && discIdx > guardIdx && discIdx - guardIdx < 300);

  // All three section flags participate (accounts, transactions summary, holdings).
  check("disclosure: accounts flag consulted", routeSrc.includes("?.totalsEstimated === true"));
  check("disclosure: transactions summary flag consulted", routeSrc.includes("getTransactionsSummary(ctx)?.estimated === true"));
  check("disclosure: holdings flag consulted", routeSrc.includes("HOLDINGS_SUMMARY"));
}

// ── no per-number disclaimers: the disclosure phrase appears nowhere else ────
{
  check("no repetition: 'treat affected figures' never used per-number/elsewhere",
    routeSrc.split("treat affected figures").length - 1 === 1);
}

// ── envelope plumbing: the builder threads the Space's currency ──────────────
{
  check("builder: reportingCurrency threaded into SpaceContext_AI.space",
    builderSrc.includes("reportingCurrency: spaceCtx.space.reportingCurrency"));
}

if (failures.length > 0) {
  console.error(`\nMC1 P4 currency presentation: ${failures.length} FAILURE(S) (${passed} checks passed):`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`MC1 P4 currency presentation: all ${passed} checks passed.`);
process.exit(0);
