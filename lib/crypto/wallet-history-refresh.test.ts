/**
 * lib/crypto/wallet-history-refresh.test.ts
 *
 * W6f — a sync that does not refresh history leaves history wrong.
 *
 *     npx tsx lib/crypto/wallet-history-refresh.test.ts
 *
 * Two failures met here, and the second is the one that hid the first.
 *
 * `reconstructSolHistory` and `reconstructBtcHistory` had ZERO production
 * callers: written, tested, run by hand once, wired to nothing. And the sync
 * route's bounded regeneration — which WOULD have redrawn the chart — was gated
 * on `feedsLegacyWealthHistory`, a predicate W6c emptied for every chain when
 * Bitcoin's historical authority moved onto the spine. From that commit until
 * this one, pressing Sync imported movements, updated the balance, and left both
 * the reconstructed timeline and the chart exactly as they were.
 *
 * Nothing looked broken. That is the shape of this defect: a wallet could receive
 * a hundred BTC and the year chart would go on drawing the old quantity —
 * correctly labelled, coverage-licensed, and stale.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { refreshWalletHistory } from "./wallet-history-refresh";
import { chainSupportsHistory } from "./wallet-sync-dispatch";

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const read = (...s: string[]) => readFileSync(join(process.cwd(), ...s), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
const body = (s: string) => {
  const m = [...s.matchAll(/^import[\s\S]*?;$/gm)];
  return m.length ? s.slice(m[m.length - 1].index! + m[m.length - 1][0].length) : s;
};

// ══ THE RECONSTRUCTIONS NOW HAVE A CALLER ═════════════════════════════════════
{
  const dispatch = code(read("lib", "crypto", "wallet-sync-dispatch.ts"));
  // CRYPTO-PARALLEL-1 — this used to pin the exact line
  //   `const historyRefresh = result.ok ? await refreshWalletHistory(...) : null;`
  // The refresh is now awaited inside a Promise.all alongside the independent
  // CURRENT_QUOTE stage, so the LITERAL changed while the two properties it was
  // really protecting did not. They are asserted directly below, which is
  // stronger: the old regex would have passed for any `await` anywhere.
  check("a successful sync refreshes the chain's history",
    /refreshWalletHistory\(accountId, key\)/.test(dispatch),
    "without this the reconstructions have zero production callers and history goes stale");
  check("…and it is the dispatcher that calls it (one production caller, not a route)",
    /const \[quote, historyRefresh\] = await Promise\.all\(\[/.test(dispatch));

  const refresh = code(read("lib", "crypto", "wallet-history-refresh.ts"));
  check("…dispatching to the reconstruction that belongs to the chain",
    /reconstructBtcHistory/.test(refresh) && /reconstructSolHistory/.test(refresh));
  check("…and to nothing for a chain without one",
    /: null;/.test(refresh) && /chain has no reconstruction/.test(refresh));
  // ETH-H2 — Ethereum joined the dispatch. Capability is NOT promoted by this:
  // the reconstruction runs and persists evidence, and the product claim waits
  // on real-wallet acceptance.
  check("Ethereum is dispatched too",
    /reconstructEthHistory/.test(refresh));

  // ONLY on success: re-running against a failed acquisition is how a provider
  // outage turns into a narrower history.
  // Still gated on `result.ok`, now as the ternary's condition inside the join.
  // Re-running against a failed acquisition is how a provider outage turns into
  // a narrower history, so this gate is the load-bearing part — not the `await`.
  check("a FAILED sync refreshes nothing",
    /result\.ok\s*\n?\s*\?\s*refreshWalletHistory\(accountId, key\)/.test(dispatch));
  check("…and a FAILED sync re-quotes nothing either",
    /result\.ok\s*\n?\s*\?\s*refreshCurrentQuotesForChains\(\[key\]\)/.test(dispatch));
  check("the refresh is never fatal to the sync",
    /reconstruction threw/.test(refresh),
    "a history step must not turn a balance we DID read into a 502");
}

// ══ THE GATE THAT WAS DEAD ════════════════════════════════════════════════════
//
// The regeneration existed and asked the wrong question.
{
  // P1 REFRESH ALL — the manual route's post-sync body (snapshot scope, capability-
  // gated history regen, the canonical planner) now lives in
  // lib/refresh/wallet-post-sync.ts `finalizeWalletSync`, shared with the
  // customer's Refresh All. The route is scanned TOGETHER with that module so
  // every invariant below still pins the real post-sync body, unweakened.
  const POST_SYNC_BODY: Record<string, string[]> = { "app/api/accounts/[id]/sync/route.ts": ["lib/refresh/wallet-post-sync.ts"] };
  for (const route of ["app/api/accounts/[id]/sync/route.ts", "app/api/accounts/wallet/route.ts"]) {
    const s = [route, ...(POST_SYNC_BODY[route] ?? [])].map((f) => code(read(...f.split("/")))).join("\n");
    check(`${route} gates regeneration on CAPABILITY`,
      /chainSupportsHistory\(/.test(s));
    check(`${route} no longer gates on the emptied storage predicate`,
      !/feedsLegacyWealthHistory\(/.test(s),
      "W6c emptied it for every chain, silently disabling every one of these call sites");
  }
  // And the capability answer is the one that makes those gates fire.
  check("BTC, SOL and ETH are the chains that fire it",
    chainSupportsHistory("BTC") && chainSupportsHistory("SOL") && chainSupportsHistory("ETH"));
  check("ETH joined them on its own acceptance", chainSupportsHistory("ETH"));
  check("…and the current-only chains still do not",
    !chainSupportsHistory("BNB") && !chainSupportsHistory("AVAX"));
}

// ══ A REFUSAL MUST NOT DESTROY WHAT IS ALREADY PROVEN ═════════════════════════
{
  const refresh = code(read("lib", "crypto", "wallet-history-refresh.ts"));
  check("a refusal reports `refreshed: false` and writes nothing itself",
    /if \(!result\.ok\)/.test(refresh) && !/deleteMany|createMany/.test(refresh));

  // The property it depends on, asserted at the source: both reconstructions
  // refuse BEFORE opening their write transaction.
  for (const [chain, file] of [["BTC", "lib/crypto/btc-history-sync.ts"], ["SOL", "lib/crypto/sol-history-sync.ts"]] as const) {
    const s = body(code(read(...file.split("/"))));
    const tx = s.indexOf("$transaction");
    const refusals = [...s.matchAll(/ok: false/g)].map((m) => m.index!);
    check(`${chain}: every refusal returns before the write transaction`,
      refusals.length > 0 && refusals.every((i) => i < tx),
      "a refusal that reached the delete would replace proven history with nothing");
  }
}

// ══ THE WINDOW MUST NOT TRUNCATE ══════════════════════════════════════════════
//
// A reconstruction rewrites the rows it owns across the window it is given, so a
// short lookback would silently cut four years of proven history to one month.
{
  const refresh = code(read("lib", "crypto", "wallet-history-refresh.ts"));
  check("the window starts at the account's OWN earliest evidence",
    /earliestEvidenceISO/.test(refresh));
  check("…considering movements AND dated positions, whichever is older",
    /transaction\.findFirst/.test(refresh) && /positionObservation\.findFirst/.test(refresh));
  check("no fixed lookback appears",
    !/30|90|365|days?Ago/.test(refresh.replace(/slice\(0, 10\)/g, "")),
    "a fixed window is how a re-run truncates history it did not acquire");
  check("an account with no evidence is skipped rather than reconstructed from nothing",
    /no dated evidence to reconstruct from/.test(refresh));
}

// ══ SKIP IS NOT FAILURE ═══════════════════════════════════════════════════════
async function skipIsNotFailure(): Promise<void> {
  // ETH-H2 — ETH is no longer in this set: it has a reconstruction now, so it
  // proceeds to look for evidence rather than being skipped at the dispatch.
  // BNB and AVAX are the current-only chains left, and they must still be
  // SKIPPED rather than failed — a chain that never claimed history has not
  // gone wrong by lacking it.
  const bnb = await refreshWalletHistory("no-such-account", "BNB");
  check("a current-only chain is skipped, not failed",
    bnb.refreshed === false && bnb.reason === "chain has no reconstruction");
  check("…and reports the chain it was asked about",
    bnb.chain === "BNB");
  const avax = await refreshWalletHistory("no-such-account", "AVAX");
  check("AVAX likewise", avax.refreshed === false && avax.reason === "chain has no reconstruction");
  const none = await refreshWalletHistory("no-such-account", null);
  check("a null chain is skipped too", none.refreshed === false);
}

// ══ THE OUTCOME TRAVELS, SO THE CALLER CAN BOUND ITS REGENERATION ═════════════
{
  const dispatch = code(read("lib", "crypto", "wallet-sync-dispatch.ts"));
  check("the sync outcome carries what the refresh did",
    /historyRefresh\?: WalletHistoryRefresh;/.test(dispatch)
      && /historyRefresh: historyRefresh \?\? undefined/.test(dispatch));
  // P1 REFRESH ALL — the route's post-sync body is lib/refresh/wallet-post-sync.ts
  // (shared with Refresh All); scanned together so the pins hold the real body.
  const route = code(read("app", "api", "accounts", "[id]", "sync", "route.ts")) + "\n" + code(read("lib", "refresh", "wallet-post-sync.ts"));
  check("the route still plans a BOUNDED window rather than rebuilding everything",
    /resolveHistoricalWorkWindow/.test(route) && /regenerateWealthHistoryForAccounts\(\[(id|accountId)\]/.test(route),
    "scoped to this account; no unrelated Space is rebuilt");
  check("…and a regeneration failure stays non-fatal to the sync",
    /wealth-history regen failed \(non-fatal\)/.test(read("lib", "refresh", "wallet-post-sync.ts")));
}

void (async () => {
  await skipIsNotFailure();
  console.log(`\nwallet-history-refresh: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
