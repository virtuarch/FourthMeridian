/**
 * lib/accounts/wallet-connection.test.ts
 *
 * Wallet Provider v1.5 — provider-spine alignment tests.
 *
 * Runnable with the already-installed `tsx`:
 *     npx tsx lib/accounts/wallet-connection.test.ts
 * Auto-discovered by scripts/run-tests.ts. No network, no DB, no secrets.
 *
 * PART A runtime-tests the pure formatters (lib/accounts/wallet-connection-format.ts,
 * DB-free). PART B source-scans the DB-touching modules — which pull @/lib/db and
 * can't import under bare tsx — for the creation/linkage invariants this slice
 * must guarantee.
 */

import { readFileSync } from "fs";
import { join } from "path";
import {
  walletConnectionCredential,
  walletExternalConnectionId,
} from "@/lib/accounts/wallet-connection-format";

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

// ── PART A — pure formatters ───────────────────────────────────────────────────

check("credential is the trimmed address", walletConnectionCredential("  1Cn7RXTTd5aN1ys32GfXVdXUzTyDxdpS1D  ") === "1Cn7RXTTd5aN1ys32GfXVdXUzTyDxdpS1D");
check("externalConnectionId is CHAIN:address", walletExternalConnectionId("btc", " 1Cn7RX ") === "BTC:1Cn7RX");
check("externalConnectionId upper-cases the chain", walletExternalConnectionId(" eth ", "0xABC") === "ETH:0xABC");

// ── PART B — source-scan the spine modules ─────────────────────────────────────

const wc = code(read("lib", "accounts", "wallet-connection.ts"));
check("ensureWalletConnection dedupes by (userId, WALLET, credential)",
  /provider:\s*ProviderType\.WALLET/.test(wc) && wc.includes("findFirst") && wc.includes("connection.create"));
check("ensureWalletConnection stores credential + externalConnectionId",
  wc.includes("credential") && wc.includes("externalConnectionId"));
check("link points AccountConnection.connectionId (only when still null)",
  /accountConnection\.updateMany/.test(wc) && /connectionId:\s*null/.test(wc));
check("touch stamps lastSyncedAt + ACTIVE on success", /lastSyncedAt/.test(wc) && /ConnectionStatus\.ACTIVE/.test(wc));
check("touch does NOT flip status to ERROR on transient failure",
  !/status:\s*ConnectionStatus\.ERROR/.test(wc));
check("alignWalletProviderSpine is non-fatal (try/catch → null)",
  wc.includes("catch") && wc.includes("return null"));
check("alignWalletProviderSpine links identity to the Connection",
  wc.includes("dualWriteProviderAccountIdentity") && /connection\.id/.test(wc));
check("spine module never alters account visibility (no FinancialAccount / SAL writes)",
  !/financialAccount\./.test(wc) && !/spaceAccountLink/i.test(wc));

const pai = code(read("lib", "accounts", "provider-identity.ts"));
check("dualWriteProviderAccountIdentity accepts a connectionId param",
  /connectionId\?:\s*string\s*\|\s*null/.test(pai));
check("identity create sets connectionId (?? null)", /connectionId:\s*connectionId\s*\?\?\s*null/.test(pai));
check("identity update repoints connectionId on drift", /needsConnection/.test(pai));

const walletRoute = code(read("app", "api", "accounts", "wallet", "route.ts"));
check("wallet route aligns the spine on all three branches (active/reactivate/create)",
  (walletRoute.match(/alignWalletProviderSpine\(/g) || []).length >= 3);
check("wallet route no longer calls the raw identity dual-write directly",
  !walletRoute.includes("dualWriteProviderAccountIdentity"));

const sync = code(read("lib", "crypto", "btc-sync.ts"));
check("btc-sync records the Connection on a successful sync (markSynced)",
  sync.includes("alignWalletProviderSpine") && /markSynced:\s*true/.test(sync));
check("btc-sync selects ownerUserId for spine alignment", /ownerUserId:\s*true/.test(sync));

const backfill = code(read("scripts", "backfill-wallet-connections.ts"));
check("backfill script reuses alignWalletProviderSpine", backfill.includes("alignWalletProviderSpine"));

// ── PART C — v1.5 cleanup: AccountConnection mirror + schema doctrine ───────────

check("markWalletAccountConnectionSynced writes AccountConnection sync fields",
  /accountConnection\.updateMany/.test(wc) &&
  /syncStatus:\s*["']synced["']/.test(wc) &&
  /lastSyncedAt:\s*new Date\(\)/.test(wc));
check("AccountConnection mirror is wallet-scoped (plaidItemDbId null, never a Plaid row)",
  /plaidItemDbId:\s*null/.test(wc));
check("spine mirrors to AccountConnection on markSynced (called from a successful sync)",
  wc.includes("markWalletAccountConnectionSynced"));

const schema = read("prisma", "schema.prisma");
check("schema marks wallet columns TRANSITIONAL",
  /TRANSITIONAL \(v1 \/ v1\.5 wallet columns\)/.test(schema));
check("schema names PAI + Connection the canonical provider identity path",
  /CANONICAL provider identity path/.test(schema));
check("schema notes nativeBalance/balance become derived from Holdings in v2",
  /DERIVED from Holding rows in/.test(schema));
check("schema marks Connection as provider-sync TRUTH",
  /Provider-sync TRUTH/.test(schema));
check("schema marks AccountConnection sync fields as a compatibility MIRROR",
  /MIRROR \(compatibility\)/.test(schema));

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\nwallet-connection: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
