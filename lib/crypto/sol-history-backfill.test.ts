/**
 * lib/crypto/sol-history-backfill.test.ts  (Connections pass PR 5 — Solana history RCA)
 *
 * The two defects that kept a newly connected Solana wallet from ever getting
 * history (docs/plans/SOLANA-HISTORY-RCA-2026-10-28.md):
 *   1. a v0 transaction using Address Lookup Tables threw in the parser, so the
 *      whole reconstruction was refused as PROVIDER_FAILED;
 *   2. the replay window was the caller's evidence floor — for Solana, which
 *      stores no Transaction rows, the day the wallet was connected — so history
 *      collapsed to one day, permanently.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { deriveNativeMovements, type SolTransactionView } from "@/lib/crypto/sol-history";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const code = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const OWNER = "OwnerWa11et1111111111111111111111111111111";
const POOL  = "Poo1FromLookupTab1e11111111111111111111111";
const RO    = "ReadOn1yLookup111111111111111111111111111";
const LAMPORTS = 1_000_000_000;

console.log("1. v0 transaction with lookup-table addresses");
{
  // Static keys: owner + program. Loaded: one writable (the pool), one readonly.
  // Balances cover all four, in the RPC's order: static, writable, readonly.
  const v0: SolTransactionView = {
    slot: 10, blockTime: Math.floor(Date.parse("2025-06-01T12:00:00Z") / 1000),
    transaction: { message: { accountKeys: [OWNER, "Program1111111111111111111111111111111111"] } },
    meta: {
      err: null, fee: 5000,
      preBalances:  [5 * LAMPORTS,        1, 10 * LAMPORTS,        1],
      postBalances: [4 * LAMPORTS - 5000, 1, 11 * LAMPORTS,        1],
      loadedAddresses: { writable: [POOL], readonly: [RO] },
      preTokenBalances: [], postTokenBalances: [],
    },
  };
  let threw: unknown = null;
  let movements: ReturnType<typeof deriveNativeMovements> = [];
  try { movements = deriveNativeMovements(v0, "sigV0", new Set([OWNER])); } catch (e) { threw = e; }
  check("no longer throws on balances longer than the static keys", threw === null, String(threw));
  const net = movements.reduce((s, m) => s + m.baseUnitsDelta, BigInt(0));
  check("owner's movements sum exactly to its delta (fee + transfer)", net === BigInt(-LAMPORTS - 5000), net.toString());
  check("the loaded writable account is named as the counterparty", movements.some((m) => m.counterparties.includes(POOL)));

  const legacyMisaligned: SolTransactionView = { ...v0, meta: { ...v0.meta!, loadedAddresses: null } };
  let refused = false;
  try { deriveNativeMovements(legacyMisaligned, "sigBAD", new Set([OWNER])); } catch { refused = true; }
  check("a genuinely misaligned transaction is still refused (no invented keys)", refused);
}

console.log("2. the replay window follows the licence, not the connection date");
{
  const s = code("lib/crypto/sol-history-sync.ts");
  check("replay window is the UNION of the licence and the caller's floor",
    /licensed\.kind === "COMPLETE" \? licensed\.fromISO/.test(s) && /licensed\.kind === "PARTIAL" \? licensed\.coveredFromISO/.test(s)
      && /licenceFromISO && licenceFromISO < args\.windowFromISO \? licenceFromISO : args\.windowFromISO/.test(s)
      && /windowFromISO: replayFromISO/.test(s));
  check("…and the caller's floor no longer reaches the replay directly", !/replayQuantityTimeline\(\{[\s\S]{0,120}windowFromISO: args\.windowFromISO/.test(s));
}

if (failures > 0) {
  console.error(`\nsol-history-backfill: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nsol-history-backfill: all checks passed.");
