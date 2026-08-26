/**
 * lib/sync/connection-copy.test.ts
 *
 * W-M2b — CONNECTED ≠ SYNCED, made structurally impossible to contradict.
 *
 *     npx tsx lib/sync/connection-copy.test.ts
 *
 * A real wallet produced the contradiction: a Solana wallet on a deployment with
 * no Solana RPC endpoint rendered "Previously synced via Self-custody" one line
 * above "This wallet has not been synced." The exhaustive sweep below is the
 * point — it walks EVERY (provider × state × synced?) combination and asserts
 * that no combination without a `lastSyncedAt` can claim a past synchronization.
 * A future state, provider or copy change cannot reintroduce the contradiction
 * without failing here.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { providerLine, hasEverSynced } from "./connection-copy";
import type { SyncConnection, SyncConnectionState, SyncProvider } from "./status";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { passes++; }
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
function code(src: string): string { return src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, ""); }

const STATES: SyncConnectionState[] = ["importing", "sync_deferred", "ready", "needs_reauth", "error"];
const PROVIDERS: SyncProvider[] = ["PLAID", "WALLET"];
const SYNCED_AT = "2026-08-26T12:00:00.000Z";

const C = (
  provider: SyncProvider, state: SyncConnectionState, lastSyncedAt: string | null,
): Pick<SyncConnection, "provider" | "state" | "lastSyncedAt"> => ({ provider, state, lastSyncedAt });

// ══ THE INVARIANT, SWEPT EXHAUSTIVELY ═════════════════════════════════════════
{
  const violations: string[] = [];
  let combos = 0;
  for (const provider of PROVIDERS) {
    for (const state of STATES) {
      combos++;
      const line = providerLine(C(provider, state, null));
      // With no record of a successful sync, no wording may imply one.
      if (/previously synced|^Synced via/i.test(line)) violations.push(`${provider}/${state} → "${line}"`);
    }
  }
  check(`no unsynced connection claims a past sync, across all ${combos} provider×state combinations`,
    violations.length === 0, violations.join(" · "));
}

// ══ THE EXACT OBSERVED CONTRADICTION ══════════════════════════════════════════
{
  // A wallet whose chain this deployment cannot reach: terminal, never synced.
  const line = providerLine(C("WALLET", "error", null));
  check("the reported contradiction is gone — a never-synced wallet reads 'Connected'",
    line === "Connected via Self-custody", line);
  check("…and specifically does NOT say 'Previously synced'",
    !line.includes("Previously synced"));
  // The card body it sits above says "This wallet has not been synced." Both
  // lines now agree, which is the whole fix.
  check("…so the sub-line and the body no longer contradict each other",
    !/synced/i.test(line.replace("Self-custody", "")));
}

// ══ THE POSITIVE CASES STILL READ CORRECTLY ═══════════════════════════════════
{
  check("a synced wallet reads 'Synced via Self-custody'",
    providerLine(C("WALLET", "ready", SYNCED_AT)) === "Synced via Self-custody");
  check("a wallet that synced and then failed reads 'Previously synced'",
    providerLine(C("WALLET", "error", SYNCED_AT)) === "Previously synced via Self-custody");
  check("a Plaid item needing reauth that HAD synced reads 'Previously synced'",
    providerLine(C("PLAID", "needs_reauth", SYNCED_AT)) === "Previously synced via Plaid");
  check("a Plaid item needing reauth that NEVER synced reads 'Connected'",
    providerLine(C("PLAID", "needs_reauth", null)) === "Connected via Plaid");
  check("an importing connection reads 'Connected' either way",
    providerLine(C("PLAID", "importing", null)) === "Connected via Plaid"
      && providerLine(C("PLAID", "importing", SYNCED_AT)) === "Connected via Plaid");
  check("a deferred connection reads 'Connected' — the connection is healthy",
    providerLine(C("PLAID", "sync_deferred", null)) === "Connected via Plaid");
}

// ══ ready WITHOUT EVIDENCE DOES NOT OVERCLAIM EITHER ══════════════════════════
// `ready` normally implies a successful sync, but the claim is derived from the
// evidence rather than from the state's usual meaning — so a `ready` that
// somehow lacks a timestamp still cannot assert one.
check("even 'ready' will not claim a sync it has no record of",
  providerLine(C("WALLET", "ready", null)) === "Connected via Self-custody");

// ══ THE EVIDENCE PREDICATE ════════════════════════════════════════════════════
{
  check("hasEverSynced is exactly 'is there a recorded successful sync'",
    hasEverSynced({ lastSyncedAt: SYNCED_AT }) && !hasEverSynced({ lastSyncedAt: null }));
}

// ══ GENERIC — NO CHAIN OR PROVIDER BRANCH ═════════════════════════════════════
{
  const src = code(readFileSync(join(process.cwd(), "lib", "sync", "connection-copy.ts"), "utf8"));
  check("the copy authority names no chain",
    !/\bSOL\b|\bETH\b|\bBTC\b|Solana|Ethereum|Bitcoin|walletChain/.test(src));
  check("…and branches on STATE and EVIDENCE only, never on the provider",
    !/provider ===/.test(src));

  // The component must consume the authority, not keep a private copy.
  const card = code(readFileSync(join(process.cwd(), "components", "connections", "ConnectionCard.tsx"), "utf8"));
  check("ConnectionCard has no private providerLine implementation",
    !/function providerLine/.test(card));
  check("…and imports the one authority",
    card.includes('from "@/lib/sync/connection-copy"'));
  check("no 'Previously synced' literal survives outside the authority",
    !card.includes("Previously synced"));
}

console.log(`\nconnection-copy: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
