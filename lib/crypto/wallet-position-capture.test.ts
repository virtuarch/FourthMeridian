/**
 * lib/crypto/wallet-position-capture.test.ts
 *
 * P2-6 — the crypto wallet PositionObservation writer: pure fact-mapping tests +
 * source-scan invariants covering valuation doctrine (quantity-only, no anchor,
 * no invented cost basis), zero-balance closure, idempotency, gating, the
 * spine-only position write (W5 — the Holding dual-write is retired), and the
 * "no synthetic InvestmentEvent" rule.
 *
 *     npx tsx lib/crypto/wallet-position-capture.test.ts
 *
 * PART A is pure. PART B source-scans the DB-touching modules (they pull @/lib/db
 * and can't import under bare tsx — the sibling btc-sync.test.ts constraint).
 */

import { readFileSync } from "fs";
import { join } from "path";
import {
  buildWalletObservedFacts,
  normalizeObservationDate,
  WALLET_POSITION_SOURCE,
} from "./wallet-position-capture";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; }
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
function read(...seg: string[]): string {
  return readFileSync(join(process.cwd(), ...seg), "utf8");
}
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
}

// ── PART A — pure fact mapping ────────────────────────────────────────────────

const facts = buildWalletObservedFacts(0.5, "USD");
check("quantity passthrough", facts.quantity === 0.5);
check("quote currency passthrough", facts.currency === "USD");

// Valuation doctrine: NO institution anchor — crypto is valued through the
// canonical RAW_CLOSE price series (Precedence 3), never a wallet-spot calculation.
check("no institution price anchor", facts.institutionPrice === null);
check("no institution value anchor", facts.institutionValue === null);
check("no institution price as-of", facts.institutionPriceAsOf === null);

// Never invent cost basis / vested from a balance observation.
check("cost basis null (never invented)", facts.costBasis === null);
check("vested quantity null (never invented)", facts.vestedQuantity === null);

// A wallet position is not cash.
check("isCash false", facts.isCash === false);

// Zero balance → an explicit quantity:0 closure row, still anchor-free.
const zero = buildWalletObservedFacts(0, "USD");
check("zero balance → quantity 0 closure (no anchor)",
  zero.quantity === 0 && zero.institutionValue === null && zero.costBasis === null);

// Date is truncated to a UTC day so all of a day's captures share one key.
check("date truncates to UTC midnight",
  normalizeObservationDate(new Date("2026-07-15T18:22:31.500Z")).toISOString() === "2026-07-15T00:00:00.000Z");

check("wallet source constant is 'wallet'", WALLET_POSITION_SOURCE === "wallet");

// ── PART B — source-scan invariants ───────────────────────────────────────────

const writer = code(read("lib", "crypto", "wallet-position-capture.ts"));

check("gated behind the A1 observation kill switch",
  writer.includes("investmentObservationsEnabled"));
check("writes OBSERVED origin, source 'wallet'",
  /PositionOrigin\.OBSERVED/.test(writer) && /source:\s*WALLET_POSITION_SOURCE/.test(writer));
check("idempotent upsert on the composite unique (no duplicate rows)",
  /positionObservation\.upsert/.test(writer)
    && writer.includes("financialAccountId_instrumentId_date_origin_source"));
check("resolves the ONE canonical asset Instrument (shared across wallets)",
  writer.includes("resolveCryptoInstrumentId"));
check("writes NO InvestmentEvent (a balance is not event-level evidence)",
  !/investmentEvent/i.test(writer));

// btc-sync — W5: the dual-write's own DELETION CONDITION was executed. The
// wallet position write is SPINE-ONLY; the legacy Holding mirror stays dead.
const syncRaw = read("lib", "crypto", "btc-sync.ts");
const sync = code(syncRaw);
check("btc-sync writes NO legacy Holding row (dual-write retired at W5)",
  !/db\.holding\.upsert/.test(sync) && !/\bdb\.holding\b/.test(sync));
check("btc-sync writes the canonical PositionObservation (spine-only)",
  sync.includes("captureWalletPosition") || sync.includes("writeBtcObservation"));
check("btc-sync still records the account balance (FA.balance write kept — recorded W5 follow-up)",
  /financialAccount\.update/.test(sync) || /nativeBalance/.test(sync));
check("btc-sync writes NO synthetic InvestmentEvent from balance",
  !/investmentEvent\.(create|createMany|upsert)/i.test(sync));
check("the retirement is documented at the write site (executed deletion condition)",
  /DELETION CONDITION/.test(syncRaw) && /W5/.test(syncRaw));

// Backfill: scripts/backfill-crypto-positions.ts (the P2-6 one-time Holding →
// PositionObservation bootstrap) completed its arc and was deleted in REVIEW-3
// wave 3; its safe-by-construction source checks went with it. The live wallet
// write path above is what these invariants now cover.

console.log(`\nwallet-position-capture: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
