/**
 * lib/crypto/wallet-chain-facts-boundary.test.ts  (PERF-3)
 *
 * Reading a wallet's current value must not compile every chain adapter.
 *
 * lib/crypto/wallet-current-value.ts — on every /dashboard render through
 * lib/space/mount-composition.ts — asked one FACT question
 * (`usesLegacyColumnForCurrentValue`) of lib/crypto/wallet-sync-dispatch.ts.
 * The dispatcher statically imports every chain syncer and the refresh
 * envelope, whose import() of lib/plaid/refresh brings the Plaid SDK; the
 * bundler compiled all of it into the dashboard. Measured (isolated A/B, Node
 * 24, dashboard-first session): Plaid's 20.6 MB vendor chunk and the
 * plaid/refresh async chunk leave the session, server module instances
 * 2,882 → 2,668, .next/dev 262 → 197 MB, heapUsed max ~1,350–1,400 →
 * ~1,190–1,245 MB.
 *
 * The forbidden set is DERIVED, not listed: the dispatcher; every module the
 * dispatcher imports that exports a chain syncer (`sync…Wallet`); and every
 * module in the dispatcher's closure that itself reaches the Plaid SDK. A new
 * adapter is covered the day the dispatcher imports it. Modules the read and
 * the dispatcher legitimately share (quotes, native assets) are not forbidden.
 *
 * Run:  npx tsx lib/crypto/wallet-chain-facts-boundary.test.ts
 */

import { readFileSync } from "node:fs";
import { importClosure } from "../../scripts/lib/import-closure";
import { REGISTERED_ADAPTER_CHAINS, walletChainSupport } from "@/lib/crypto/wallet-sync-dispatch";
import { SYNCABLE_CHAINS, WALLET_CHAIN_FACTS } from "@/lib/crypto/wallet-sync-dispatch.core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const DISPATCHER = "lib/crypto/wallet-sync-dispatch.ts";
const FACTS = "lib/crypto/wallet-sync-dispatch.core.ts";
const graph = importClosure();

// ── 1. The forbidden set, derived from the dispatcher ───────────────────────
console.log("1. what only the dispatcher may compile: itself, chain syncers, anything reaching Plaid");
const dispatcherClosure = graph.closure([DISPATCHER]);
const syncers = graph.edgesOf(DISPATCHER).local.filter((f) =>
  /export\s+(async\s+)?function\s+sync\w*Wallet\b/.test(readFileSync(f, "utf8")));
// Modules in the dispatcher's closure from which the Plaid SDK is reachable:
// reverse-walk the closure's own edges from the files that import "plaid".
const parents = new Map<string, string[]>();
const importsPlaid: string[] = [];
for (const f of dispatcherClosure.via.keys()) {
  const e = graph.edgesOf(f);
  if (e.packages.includes("plaid")) importsPlaid.push(f);
  for (const l of e.local) parents.set(l, [...(parents.get(l) ?? []), f]);
}
const reachesPlaid = new Set<string>();
for (const todo = [...importsPlaid]; todo.length > 0;) {
  const f = todo.pop()!;
  if (reachesPlaid.has(f)) continue;
  reachesPlaid.add(f);
  todo.push(...(parents.get(f) ?? []));
}
check("the dispatcher imports chain syncers (else this guard is vacuous)",
  syncers.length >= 4, syncers.join(", "));
check("…and reaches the Plaid SDK through its closure (the cost that made this a defect)",
  dispatcherClosure.packages.has("plaid") && reachesPlaid.has(DISPATCHER));
const FORBIDDEN = new Set([DISPATCHER, ...syncers, ...reachesPlaid]);

// ── 2. The read paths never reach them ──────────────────────────────────────
console.log("\n2. the facts and the current-value read reach no adapter, no dispatcher, no Plaid");
for (const root of [FACTS, "lib/crypto/wallet-current-value.ts", "lib/space/mount-composition.ts"]) {
  const c = graph.closure([root]);
  const hits = [...c.via.keys()].filter((f) => FORBIDDEN.has(f));
  check(`${root} reaches no wallet adapter or dispatcher`, hits.length === 0,
    hits.map((h) => graph.chain(c, h)).join("; "));
  check(`${root} reaches no Plaid SDK`, !c.packages.has("plaid"),
    c.packages.has("plaid") ? graph.chain(c, c.packages.get("plaid")!) : undefined);
}

// ── 3. One authority, fully composed ────────────────────────────────────────
console.log("\n3. every chain with facts has exactly one adapter, and the predicates answer from the facts");
{
  check("adapter chains = fact chains (no fact without an adapter, no adapter without facts)",
    REGISTERED_ADAPTER_CHAINS.join() === SYNCABLE_CHAINS.join(),
    `adapters ${REGISTERED_ADAPTER_CHAINS.join()} vs facts ${SYNCABLE_CHAINS.join()}`);
  check("the dispatcher's re-exported predicate answers from the facts for every chain",
    SYNCABLE_CHAINS.every((c) => walletChainSupport(c) === WALLET_CHAIN_FACTS[c].support));
  const core = graph.edgesOf(FACTS);
  check("the facts value-import only the chain identities (lib/crypto/native-asset.ts)",
    core.local.every((f) => f === "lib/crypto/native-asset.ts") && core.packages.length === 0,
    [...core.local, ...core.packages].join(", "));
}

if (failures > 0) {
  console.error(`\nwallet-chain-facts-boundary: ${failures} FAILED`);
  process.exit(1);
}
console.log("\nwallet-chain-facts-boundary: all checks passed");
