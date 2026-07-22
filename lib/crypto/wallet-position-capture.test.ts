/**
 * lib/crypto/wallet-position-capture.test.ts
 *
 * P2-6 — the crypto wallet PositionObservation writer: pure fact-mapping tests +
 * source-scan invariants covering valuation doctrine (quantity-only, no anchor,
 * no invented cost basis), zero-balance closure, idempotency, gating, the
 * transitional Holding dual-write, and the "no synthetic InvestmentEvent" rule.
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

// btc-sync — transitional dual-write, not a cutover; documented deletion gate.
const syncRaw = read("lib", "crypto", "btc-sync.ts");
const sync = code(syncRaw);
check("btc-sync still writes the legacy Holding (transitional dual-write)",
  /db\.holding\.upsert/.test(sync));
check("btc-sync also writes the canonical PositionObservation",
  sync.includes("captureWalletPosition") || sync.includes("writeBtcObservation"));
check("btc-sync calls the spine write after the Holding write",
  sync.indexOf("writeBtcHolding(accountId") < sync.indexOf("writeBtcObservation(accountId"));
check("btc-sync writes NO synthetic InvestmentEvent from balance",
  !/investmentEvent\.(create|createMany|upsert)/i.test(sync));
check("dual-write carries an explicit DELETION CONDITION (not indefinite)",
  /DELETION CONDITION/.test(syncRaw));

// Backfill — safe by construction.
const backfill = code(read("scripts", "backfill-crypto-positions.ts"));
check("backfill is dry-run by default (writes only on --apply)",
  /APPLY\s*=\s*process\.argv\.includes\(["']--apply["']\)/.test(backfill));
check("backfill resolves the canonical BTC Instrument (no per-wallet identity)",
  backfill.includes("CRYPTO_PROVIDER") && /assetClass:\s*AssetClass\.CRYPTO/.test(backfill));
check("backfill writes quantity-only (no institution anchor, no cost basis)",
  /institutionValue:\s*null/.test(backfill) && /costBasis:\s*null/.test(backfill));
check("backfill uses the wallet source + OBSERVED origin",
  /source:\s*WALLET_SOURCE/.test(backfill) && /PositionOrigin\.OBSERVED/.test(backfill));

console.log(`\nwallet-position-capture: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
