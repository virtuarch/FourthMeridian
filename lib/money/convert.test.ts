/**
 * lib/money/convert.test.ts
 *
 * MC1 Phase 2 Slice 1 — pure conversion engine tests (no DB, no network, no
 * fx service — fixture contexts only). House-style standalone tsx script,
 * auto-discovered by scripts/run-tests.ts:
 *
 *     npx tsx lib/money/convert.test.ts
 */

import { convertAndSum, convertMoney, identityContext } from "./convert";
import type { ConversionContext, DatedMoney } from "./types";
import type { Resolution } from "@/lib/fx/types";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

/**
 * Fixture context: a hand-built rate table keyed "from|date". Entries are
 * full Resolution values so staleness / effective dates are scriptable.
 */
function fixtureContext(target: string, table: Record<string, Resolution>): ConversionContext {
  return {
    target,
    resolve: (from, dateISO) =>
      table[`${from}|${dateISO}`] ?? { kind: "miss", quote: from, requestedDateISO: dateISO },
  };
}

const exact = (rate: number, dateISO: string): Resolution => ({
  kind: "rate", rate, requestedDateISO: dateISO,
  effectiveDates: { from: dateISO, to: dateISO }, staleness: "exact",
});

const walked = (rate: number, requestedISO: string, effISO: string): Resolution => ({
  kind: "rate", rate, requestedDateISO: requestedISO,
  effectiveDates: { from: effISO, to: requestedISO }, staleness: "walked-back",
});

const D = "2026-07-01";
const m = (amount: number, currency: string | null) => ({ amount, currency });

// ── identity ──────────────────────────────────────────────────────────────────
{
  const ctx = identityContext("USD");
  const r = convertMoney(m(1234.56, "USD"), D, ctx);
  check("identity: amount unchanged", r.amount === 1234.56);
  check("identity: not estimated", r.estimated === false);
  check("identity: no conversion metadata", r.conversion === null);
  check("identity: denominated in target", r.currency === "USD");

  // identityContext is rate-free: any non-target currency degrades honestly
  const eur = convertMoney(m(100, "EUR"), D, ctx);
  check("identityContext: non-target → native pass-through, estimated", eur.amount === 100 && eur.estimated === true && eur.conversion === null);
}

// ── null-residue (Phase 0 doctrine) ──────────────────────────────────────────
{
  const r = convertMoney(m(-42.5, null), D, identityContext("USD"));
  check("null-residue: native amount preserved", r.amount === -42.5);
  check("null-residue: estimated", r.estimated === true);
  check("null-residue: no conversion metadata", r.conversion === null);
  check("null-residue: denominated in target", r.currency === "USD");
}

// ── fixture-rate math ─────────────────────────────────────────────────────────
{
  const ctx = fixtureContext("USD", { [`EUR|${D}`]: exact(1.25, D) });
  const r = convertMoney(m(100, "EUR"), D, ctx);
  check("rate math: 100 EUR @ 1.25 = 125 USD", r.amount === 125);
  check("rate math: exact ⇒ not estimated", r.estimated === false);
  check("rate math: metadata rate + from", r.conversion?.rate === 1.25 && r.conversion?.from === "EUR");
  check("rate math: effective date = requested (exact)", r.conversion?.effectiveDateISO === D);
  check("rate math: negative amounts convert linearly", convertMoney(m(-100, "EUR"), D, ctx).amount === -125);
}

// ── walked-back rate marks estimated ─────────────────────────────────────────
{
  const eff = "2026-06-27";
  const ctx = fixtureContext("USD", { [`EUR|${D}`]: walked(1.2, D, eff) });
  const r = convertMoney(m(50, "EUR"), D, ctx);
  check("walk-back: converted", r.amount === 60);
  check("walk-back: estimated", r.estimated === true);
  check("walk-back: metadata staleness", r.conversion?.staleness === "walked-back");
  check("walk-back: effective date = older leg", r.conversion?.effectiveDateISO === eff);
}

// ── RateMiss passes native amount, estimated ─────────────────────────────────
{
  const r = convertMoney(m(3000, "SAR"), D, fixtureContext("USD", {}));
  check("miss: native amount passes through", r.amount === 3000);
  check("miss: estimated", r.estimated === true);
  check("miss: no metadata", r.conversion === null);
  check("miss: never throws, returns a value", true);
}

// ── convert-then-sum + per-row historical dates ───────────────────────────────
{
  const jan = "2026-01-15", jun = "2026-06-15";
  const ctx = fixtureContext("USD", {
    [`EUR|${jan}`]: exact(1.1, jan), // January row converts at the January rate…
    [`EUR|${jun}`]: exact(1.3, jun), // …even though a June rate exists (roadmap §4.4)
  });
  const items: DatedMoney[] = [
    { money: m(100, "EUR"), dateISO: jan },
    { money: m(100, "EUR"), dateISO: jun },
    { money: m(40, "USD"), dateISO: jun },
  ];
  const t = convertAndSum(items, ctx);
  check("sum: convert-then-sum (110 + 130 + 40)", t.amount === 110 + 130 + 40);
  check("sum: all-exact members ⇒ total not estimated", t.estimated === false);
  check("sum: denominated in target", t.currency === "USD");
  check("per-row dates: same currency, different dates, different rates",
    convertMoney(m(100, "EUR"), jan, ctx).amount !== convertMoney(m(100, "EUR"), jun, ctx).amount);
  check("sum: empty input → 0, not estimated", convertAndSum([], ctx).amount === 0 && !convertAndSum([], ctx).estimated);
}

// ── taint propagation ─────────────────────────────────────────────────────────
{
  const ctx = fixtureContext("USD", { [`EUR|${D}`]: exact(1.25, D) });
  const tainted = convertAndSum(
    [
      { money: m(100, "EUR"), dateISO: D },  // exact
      { money: m(10, null), dateISO: D },    // null-residue → estimated
    ],
    ctx,
  );
  check("taint: one estimated member taints the total", tainted.estimated === true);
  check("taint: tainted total still sums everything (never exclude)", tainted.amount === 125 + 10);

  const missTaint = convertAndSum([{ money: m(5, "SAR"), dateISO: D }], ctx);
  check("taint: miss member included at native value + taints", missTaint.amount === 5 && missTaint.estimated === true);
}

// ── determinism ───────────────────────────────────────────────────────────────
{
  const ctx = fixtureContext("USD", { [`EUR|${D}`]: walked(1.2, D, "2026-06-27") });
  const a = convertMoney(m(77.77, "EUR"), D, ctx);
  const b = convertMoney(m(77.77, "EUR"), D, ctx);
  check("determinism: byte-equal repeats", JSON.stringify(a) === JSON.stringify(b));
  const s1 = convertAndSum([{ money: m(77.77, "EUR"), dateISO: D }, { money: m(1, null), dateISO: D }], ctx);
  const s2 = convertAndSum([{ money: m(77.77, "EUR"), dateISO: D }, { money: m(1, null), dateISO: D }], ctx);
  check("determinism: byte-equal aggregate repeats", JSON.stringify(s1) === JSON.stringify(s2));
}

// ── no-rounding proof (plan D-4) ─────────────────────────────────────────────
{
  const third = 1 / 3;
  const ctx = fixtureContext("USD", { [`EUR|${D}`]: exact(third, D) });
  const r = convertMoney(m(1, "EUR"), D, ctx);
  check("no-rounding: full f64 precision preserved (1 × ⅓ = exactly ⅓)", r.amount === third);
  check("no-rounding: not coerced to 2dp", r.amount !== 0.33 && r.amount.toString().length > 8);

  // classic float fingerprint: 0.1 + 0.2 — survives only if nobody rounds
  const idCtx = identityContext("USD");
  const t = convertAndSum(
    [{ money: m(0.1, "USD"), dateISO: D }, { money: m(0.2, "USD"), dateISO: D }],
    idCtx,
  );
  check("no-rounding: sum is the exact float sum (0.30000000000000004)", t.amount === 0.1 + 0.2 && t.amount !== 0.3);
}

// ── Report ────────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`\nMC1 P2 money convert: ${failures.length} FAILURE(S) (${passed} checks passed):`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`MC1 P2 money convert: all ${passed} checks passed.`);
process.exit(0);
