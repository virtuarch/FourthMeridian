/**
 * lib/crypto/wallet-refresh-invariants.test.ts
 *
 * CRYPTO-REPAIR SLICES 5, 6, 8 — WHAT MUST NOT CHANGE, AND WHAT MUST.
 *
 * The 2026-10-01 investigation found BTC's partial-success architecture to be
 * the best-behaved part of the system: the position was written before the
 * history was fetched (caf2699), the valuation failure did not gate the
 * quantity, and the 28 stored movements survived a 10 s abort untouched. The
 * repair must not have cost any of that, so this file pins it.
 *
 * It also pins the two things the repair DID change:
 *   · the product-facing failure sentence (the user was shown undici's
 *     "network error: This operation was aborted" — the SERVER's own timeout,
 *     which reads as "your internet failed");
 *   · the concurrency of two independent non-gating stages, including that the
 *     outcome does NOT depend on which finishes first.
 *
 * Source-level where the invariant IS the ordering, behavioural where it is not.
 */

process.env.DATABASE_URL = "postgresql://stub@127.0.0.1:1/fintracker_unit_stub";

import { readFileSync } from "fs";
import { join } from "path";
import { walletSyncUserMessage } from "./wallet-sync-dispatch";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const read = (...seg: string[]) => readFileSync(join(process.cwd(), ...seg), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

async function main(): Promise<void> {
  const btc      = code(read("lib", "crypto", "btc-sync.ts"));
  const dispatch = code(read("lib", "crypto", "wallet-sync-dispatch.ts"));
  const evm      = code(read("lib", "crypto", "evm-native.ts"));
  const sol      = code(read("lib", "crypto", "sol-sync.ts"));

  // ── SLICE 5 — BTC PARTIAL SUCCESS IS INTACT (caf2699 NOT REGRESSED) ───────
  {
    const capture = btc.indexOf("writeBtcObservation(accountId, nativeBalance");
    const accountWrite = btc.indexOf("db.financialAccount.update({");
    const importCall = btc.indexOf("importBtcTransactions({ id: accountId");
    check("5. the position observation is written BEFORE the transaction import",
      capture > 0 && importCall > 0 && capture < importCall, `capture@${capture} import@${importCall}`);
    check("5. …and the legacy account write also precedes the import",
      accountWrite > 0 && accountWrite < importCall, `account@${accountWrite} import@${importCall}`);
    check("5. a capture refusal aborts BEFORE any column is written",
      /captureRefusal !== null\)\s*\{\s*return \{ accountId, ok: false, stage: "capture"/.test(btc));
    check("5. the import is complete-or-throw, so a failure writes no rows",
      /status: "FAILED", addresses, reason, startedAt/.test(btc));
    check("5. the import failure is NON-FATAL — the run still returns ok:true",
      /const transactionImport = await importBtcTransactions/.test(btc)
      && /ok:\s+true,/.test(btc));
    check("5. the valuation failure is non-fatal and reported UNAVAILABLE",
      /status: "UNAVAILABLE", reason: priceFailure \?\? "no BTC price"/.test(btc));
    check("5. an UNPRICED run still does NOT move the legacy pair or its clock",
      /balanceUsd !== null\s*\?\s*\{ nativeBalance, balance: balanceUsd, currency: "USD", lastUpdated: new Date\(\) \}\s*:\s*\{\}/.test(btc));
    check("5. a failed BALANCE read writes no position and returns failed",
      /recordWalletSyncIssue\(accountId, "balance", reason, \{ addresses: addresses\.length \}\);\s*return \{ accountId, ok: false, stage: "balance", reason \};/.test(btc));
  }

  // ── SLICE 6 — ETH/SOL STILL FAIL CLOSED ──────────────────────────────────
  {
    // The authoritative quantity read is the FIRST network call on both chains,
    // and the capture comes after it. A failure therefore has nothing to write.
    // The CALL sites, not the import lines at the top of the file.
    const ethFetch = evm.indexOf("await fetchEvmNativeWei(");
    const ethCapture = evm.indexOf("await captureWalletPosition(");
    check("6. ETH: the balance read precedes the position capture",
      ethFetch > 0 && ethCapture > 0 && ethFetch < ethCapture, `fetch@${ethFetch} capture@${ethCapture}`);
    check("6. ETH: a balance failure returns ok:false and writes no position",
      /return \{ accountId, ok: false, chain: config\.chain, stage, reason \}/.test(evm));
    check("6. ETH: lastUpdated is advanced only AFTER a successful capture",
      evm.indexOf("lastUpdated") > ethCapture);
    const solFetch = sol.indexOf("await fetchSolLamports(");
    const solCapture = sol.indexOf("await captureWalletPosition(");
    check("6. SOL: the balance read precedes the position capture",
      solFetch > 0 && solCapture > 0 && solFetch < solCapture, `fetch@${solFetch} capture@${solCapture}`);
    check("6. SOL: lastUpdated is advanced only AFTER a successful capture",
      sol.indexOf("lastUpdated") > solCapture);
    // No invented partial success: neither adapter reports a valuation stage.
    check("6. ETH/SOL invent NO valuation stage (they are read-time valued)",
      !/valuation:/.test(evm) && !/valuation:/.test(sol));
    check("6. …and the registry DECLARES them read-time valued",
      (dispatch.match(/valuationModel: "READ_TIME_VALUED"/g) ?? []).length >= 4);
  }

  // ── SLICE 6 — THE PRODUCT-FACING SENTENCE ────────────────────────────────
  {
    // The exact string the user saw on 2026-10-01, classified.
    const aborted = walletSyncUserMessage("BALANCE_UNAVAILABLE", "network error: This operation was aborted", "SOL");
    check("6. a provider abort becomes a stable product sentence",
      aborted === "Balance provider timed out. Existing position was kept.", aborted);
    check("6. …and never leaks the provider/implementation wording",
      !/aborted/i.test(aborted) && !/network error/i.test(aborted));
    check("6. every failure message states that the position SURVIVED",
      (["PROVIDER_NOT_CONFIGURED", "BALANCE_UNAVAILABLE", "ADAPTER_ERROR", "POSITION_CAPTURE_UNAVAILABLE"] as const)
        .every((c) => /unchanged|was kept|nothing was changed|stays recorded/i.test(walletSyncUserMessage(c, "x", "BTC"))));
    const rateLimited = walletSyncUserMessage("BALANCE_UNAVAILABLE", "rate limited by explorer (HTTP 429/503) after 5 attempts", "BTC");
    check("6. a rate limit is distinguished from a timeout",
      /rate-limiting/i.test(rateLimited) && rateLimited !== aborted, rateLimited);
    const badAddress = walletSyncUserMessage("INVALID_WALLET_ADDRESS", undefined, "BTC");
    check("6. a permanent input problem tells the user what to DO",
      /Edit the address/.test(badAddress), badAddress);
    check("6. the chain is named where it is the subject",
      walletSyncUserMessage("PROVIDER_NOT_CONFIGURED", undefined, "SOL").includes("SOL"));
    // The operator's evidence must still travel untouched.
    check("6. `reason` still carries the provider's own text alongside it",
      /reason:\s+result\.reason/.test(dispatch) || /reason,/.test(dispatch));
    check("6. userMessage is set on FAILURE only",
      /result\.ok \? \{\} : \{ userMessage: walletSyncUserMessage\(/.test(dispatch));
    const button = code(read("components", "dashboard", "SyncWalletButton.tsx"));
    check("6. the client prefers userMessage over the raw reason",
      /data\?\.userMessage \?\? data\?\.reason/.test(button));
  }

  // ── SLICE 8 — CONCURRENCY WITHOUT NONDETERMINISM ─────────────────────────
  {
    check("8. the quote and the history refresh are awaited together",
      /Promise\.all\(\[/.test(dispatch) && /refreshCurrentQuotesForChains\(\[key\]\)/.test(dispatch)
      && /refreshWalletHistory\(accountId, key\)/.test(dispatch));
    check("8. both remain gated on result.ok exactly as before",
      (dispatch.match(/result\.ok\s*\n?\s*\?\s*refresh/g) ?? []).length >= 2
      || (dispatch.match(/result\.ok$/gm) ?? []).length >= 1);
    check("8. each promise catches its OWN failure, so one cannot discard the other",
      (dispatch.match(/\.catch\(\(e\) =>/g) ?? []).length >= 2);
    // Determinism: the records are pushed AFTER the await, in a fixed textual
    // order — quote first, then history — so completion order cannot reorder
    // the ledger or the outcome.
    const awaitIdx   = dispatch.indexOf("await Promise.all([");
    const quoteIdx   = dispatch.indexOf('recordMeasured("CURRENT_QUOTE"');
    const historyIdx = dispatch.indexOf("recordHistoryStage(recorder, historyRefresh)");
    check("8. recording happens after the join, not inside the promises",
      awaitIdx > 0 && quoteIdx > awaitIdx && historyIdx > awaitIdx,
      `await@${awaitIdx} quote@${quoteIdx} history@${historyIdx}`);
    check("8. …in a FIXED order (quote, then history)", quoteIdx < historyIdx);
    check("8. the open HISTORY_BACKFILL stage is closed on the same condition it was opened",
      /result\.ok && historyRefresh === null\)\s*\{\s*recorder\.fail\("HISTORY_BACKFILL"/.test(dispatch));
    // NOT "the file contains no Promise.all" — it legitimately reads the two
    // earliest-evidence rows concurrently, which predates this work. The
    // invariant is that the RECONSTRUCTION ITSELF is awaited singly: its
    // dependencies are not proven independent, so it must not be fanned out.
    const histRefresh = code(read("lib", "crypto", "wallet-history-refresh.ts"));
    check("8. the reconstruction itself is awaited singly, never fanned out",
      /await run\(/.test(histRefresh) && !/Promise\.all\(\s*\[?\s*run/.test(histRefresh));
    check("8. …and the only concurrency there is the pre-existing evidence read",
      (histRefresh.match(/Promise\.all/g) ?? []).length === 1
      && /db\.transaction\.findFirst/.test(histRefresh));
  }

  // ── SLICE 7 — TIMEOUTS AND RETRIES DELIBERATELY UNCHANGED ────────────────
  {
    // The jitter observed during the incident was environmental (a phone
    // hotspot in a moving car), so tuning production around it would be
    // optimising for a degraded development network. Pinned so a later change
    // is a DECISION, not a drift.
    check("7. BTC keeps its 10 s default budget", /const DEFAULT_TIMEOUT_MS = 10_000;/.test(code(read("lib", "crypto", "btc-explorer.ts"))));
    check("7. ETH/EVM keeps its 10 s default budget", /const DEFAULT_TIMEOUT_MS = 10_000;/.test(evm));
    check("7. SOL keeps its 10 s default budget", /const DEFAULT_TIMEOUT_MS = 10_000;/.test(code(read("lib", "crypto", "sol-rpc.ts"))));
    check("7. no retry was added to the authoritative balance reads",
      !/retr/i.test(evm.replace(/rateLimitRetries/g, "")) && !/retr/i.test(sol));
  }

  console.log(`\nwallet-refresh-invariants: ${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

void main();
