/**
 * lib/crypto/wallet-card-truth.test.ts
 *
 * UI-C1 — what a wallet card is allowed to say.
 *
 *     npx tsx lib/crypto/wallet-card-truth.test.ts
 *
 * Three defects met here, and none of them was in the code that renders.
 *
 * A successfully reconstructed Ethereum wallet rendered SYNC ERROR because a
 * CASE-SENSITIVE connection credential split one wallet across two Connection
 * rows: the create route stored the checksummed address, the sync adapter the
 * lower-cased one. The AccountConnection landed on the first, every success
 * stamp on the second. The state authority read the linked row, found
 * `lastSyncedAt: null`, and correctly concluded from that input that the wallet
 * had never synced.
 *
 * The card then described the failure in Bitcoin's vocabulary — "we couldn't
 * complete address discovery" — for a chain that derives no addresses at all.
 *
 * And its history span came from the earliest `Transaction` row, which Bitcoin
 * writes and no other chain does, so Solana and Ethereum reported "No historical
 * data yet" while holding four and nine years of proven coverage.
 */

import { readFileSync } from "fs";
import { join } from "path";
import {
  canonicalWalletAddress, isCaseInsensitiveAddressChain,
  walletConnectionCredential, walletExternalConnectionId,
} from "@/lib/accounts/wallet-connection-format";
import { licensedHistoryStart, walletActivityStart, type WalletHistoryMetadata } from "./wallet-history-metadata";
import { deriveWalletConnectionState } from "@/lib/sync/status";
import { chainSupportsHistory } from "./wallet-sync-dispatch";

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const read = (...s: string[]) => readFileSync(join(process.cwd(), ...s), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

const CHECKSUMMED = "0x910Eb431e27A4ADf555a59D8E11cEB81C645bA2D";
const LOWER       = "0x910eb431e27a4adf555a59d8e11ceb81c645ba2d";

// ══ ONE WALLET, ONE IDENTITY ══════════════════════════════════════════════════
{
  check("an EVM address is case-folded — the checksum is not part of the identity",
    canonicalWalletAddress(CHECKSUMMED, "ETH") === canonicalWalletAddress(LOWER, "ETH"));
  check("…so both spellings produce the SAME credential",
    walletConnectionCredential(CHECKSUMMED, "ETH") === walletConnectionCredential(LOWER, "ETH"),
    "a case-sensitive credential is what created a second Connection two seconds "
    + "after the first, splitting the wallet's identity across both");
  check("…and the same debug id",
    walletExternalConnectionId("ETH", CHECKSUMMED) === walletExternalConnectionId("ETH", LOWER));
  check("every EVM chain inherits it from the CAIP-2 namespace, not a list",
    ["ETH", "BNB", "AVAX", "MATIC"].every((c) => isCaseInsensitiveAddressChain(c)));

  // Base58 and bech32 are NOT case-foldable — folding them would merge distinct
  // addresses, which is a worse bug than the one being fixed.
  check("Bitcoin and Solana addresses are left exactly as given",
    !isCaseInsensitiveAddressChain("BTC") && !isCaseInsensitiveAddressChain("SOL"));
  const b58 = "9nPLXXQoRR9RS7bhj5R66u9WgvXmx7DxnjyAjWvAijER";
  check("…so a base58 address keeps its case",
    canonicalWalletAddress(b58, "SOL") === b58);
  check("an unknown chain is left alone too", canonicalWalletAddress("AbC", "NOPE") === "AbC");
  check("whitespace is still trimmed", canonicalWalletAddress("  0xAB  ", "ETH") === "0xab");
}

// ══ A STALE LINK IS RE-POINTED, NOT LEFT ══════════════════════════════════════
{
  const wc = code(read("lib", "accounts", "wallet-connection.ts"));
  check("the linker moves a link that points at another row for the same wallet",
    /connectionId: \{ not: params\.connectionId \}/.test(wc),
    "filling only NULL links leaves an already-split wallet split forever");
  check("…and never touches a Plaid row",
    /plaidItemDbId:\s+null,/.test(wc));
  check("the credential is canonicalised per chain",
    /walletConnectionCredential\(params\.address, params\.chain\)/.test(wc));
}

// ══ ERROR AND SYNCING CANNOT BOTH BE TRUE ═════════════════════════════════════
//
// The state authority returns ONE state. A card showing "Sync error" beside a
// disabled "Syncing…" is that authority being asked twice, or fed the wrong row.
{
  const ready   = { status: "ACTIVE" as const, lastSyncedAt: new Date(), errorCode: null, discoveryCursor: null };
  const errored = { status: "ACTIVE" as const, lastSyncedAt: null, errorCode: "X", discoveryCursor: null };
  const importing = { status: "ACTIVE" as const, lastSyncedAt: null, errorCode: null, discoveryCursor: "{...}" };
  const never   = { status: "ACTIVE" as const, lastSyncedAt: null, errorCode: null, discoveryCursor: null };

  check("a stamped lastSyncedAt is READY — the ETH case, once linked correctly",
    deriveWalletConnectionState(ready) === "ready");
  check("a stale error does NOT survive a success",
    deriveWalletConnectionState({ ...ready, errorCode: "OLD" }) === "ready",
    "lastSyncedAt is checked first, so a superseded code cannot pin the card");
  check("an error with no success is error", deriveWalletConnectionState(errored) === "error");
  check("importing requires a resumable cursor, not silence",
    deriveWalletConnectionState(importing) === "importing"
      && deriveWalletConnectionState(never) === "error");
  check("the states are mutually exclusive — one call, one answer",
    new Set([ready, errored, importing, never].map((i) => deriveWalletConnectionState(i))).size === 3);
}

// ══ FAILURE COPY COMES FROM THE ERROR, NOT THE PROVIDER ═══════════════════════
{
  const card = read("components", "connections", "ConnectionCard.tsx");
  const generic = card.slice(card.indexOf("const walletDetail"));
  check("the generic wallet fallback no longer mentions address discovery",
    !/isWallet\s*\n?\s*(\/\/[^\n]*\n\s*)*\?\s*"We couldn’t complete address discovery/.test(generic),
    "ETH/SOL/BNB/AVAX derive no addresses; telling them to retry discovery is "
    + "an instruction to repeat an operation their wallet never performs");
  check("…and the fallback names no chain-specific operation",
    /We couldn’t sync this wallet\. Press Refresh to try again\./.test(generic));
  check("xpub wording survives ONLY for the xpub error",
    /INVALID_XPUB"\s*\?\s*"this doesn’t look like a valid extended public key/.test(generic));
  check("discovery wording survives ONLY for the discovery error",
    /DISCOVERY_FAILED"\s*\?\s*"address discovery could not be completed"/.test(generic));
  check("the rate-limit message no longer says 'Bitcoin explorer'",
    !/Bitcoin explorer/.test(generic));
  check("chain-neutral codes have chain-neutral copy",
    /NO_PROVIDER_CONFIGURED/.test(generic) && /POSITION_CAPTURE_UNAVAILABLE/.test(generic));
}

// ══ HISTORY DURATION COMES FROM COVERAGE ══════════════════════════════════════
{
  const meta = (
    from: string | null, claims: boolean, activity: string | null = from,
  ): WalletHistoryMetadata =>
    ({ accountId: "a", activityFromISO: activity, licensedFromISO: from,
       licensedToISO: "2026-08-27", claimsHistory: claims });

  check("a licensed interval yields its START",
    licensedHistoryStart(meta("2017-10-16", true))?.toISOString().slice(0, 10) === "2017-10-16");
  check("no licence yields NULL — rendered as silence, not as zero history",
    licensedHistoryStart(meta(null, false)) === null
      && licensedHistoryStart(undefined) === null);
  check("a chain that cannot claim history yields null even with an interval",
    licensedHistoryStart(meta("2020-01-01", false)) === null,
    "a licensed interval on an unpromoted chain is evidence we have not promised "
    + "to stand behind");

  // ── UI-C2 — THE PROOF FLOOR IS NOT THE WALLET'S HISTORY ───────────────────
  // Ethereum's licence reaches 2017-10-16 (the Byzantium block the proof floors
  // at) and proves the account held exactly nothing until 2021-04-27. Both are
  // true; only one of them is "history".
  const eth = meta("2017-10-16", true, "2021-04-27");
  check("the card measures from ACTIVITY, not from the proof floor",
    walletActivityStart(eth)?.toISOString().slice(0, 10) === "2021-04-27");
  check("…while the proof itself is preserved and still readable",
    licensedHistoryStart(eth)?.toISOString().slice(0, 10) === "2017-10-16",
    "coverage must never be truncated to fix presentation");
  check("a wallet proven EMPTY has coverage and nothing to say about history",
    walletActivityStart(meta("2017-10-16", true, null)) === null);
  check("an unpromoted chain yields no activity bound either",
    walletActivityStart(meta("2020-01-01", false, "2020-06-01")) === null);

  const src2 = code(read("lib", "crypto", "wallet-history-metadata.ts"));
  check("activity is the earliest NON-ZERO observation",
    /NOT: \{ quantity: 0 \}/.test(src2),
    "a zero is a real fact about a date and is not evidence the wallet was in use");
  check("…resolved in ONE grouped read, not per account",
    /positionObservation\.groupBy/.test(src2));
  check("…and clamped inside the licence",
    /clampToInterval\(/.test(src2),
    "evidence outside a proven interval is not a claim we may make");

  const src = code(read("lib", "crypto", "wallet-history-metadata.ts"));
  // Capability is decided per ACCOUNT and short-circuits before the interval is
  // read — compared inside the loop body, since the coverage LOAD is hoisted
  // above it and a raw file offset would compare the wrong two things.
  const loop = src.slice(src.indexOf("for (const a of accounts)"));
  check("capability is asked BEFORE the interval, per account",
    loop.indexOf("chainSupportsHistory") < loop.indexOf("licensedInterval"));
  check("the authority is PositionCoverage and nothing else",
    /loadPositionCoverage/.test(src)
      && !/\btransaction\.|createdAt|rowsWritten|derivedRows/i.test(src),
    "not the transaction count, the creation date, or the reconstruction row count");

  // Both card loaders must ask the same authority.
  for (const f of ["lib/connections/space-data.ts", "lib/platform/connection-diagnostics.ts"]) {
    const l = code(read(...f.split("/")));
    check(`${f} measures wallet history from ACTIVITY`,
      /walletActivityStart\(/.test(l) && /loadWalletHistoryMetadata\(/.test(l));
    check(`${f} does not measure it from the proof floor`,
      !/licensedHistoryStart\(/.test(l));
  }
}

// ══ QUANTITY COVERAGE IS NOT PRICE COVERAGE ═══════════════════════════════════
//
// Ethereum is proven back to 2017 while the price vendor serves a rolling year.
// Shortening the span to the price window under-reports proven evidence;
// implying the whole span is valued over-reports it.
{
  const src = read("lib", "crypto", "wallet-history-metadata.ts");
  check("the module states that history availability is a QUANTITY claim",
    /PROVEN QUANTITY COVERAGE/.test(src));
  check("…and that it does not mean every day carries a USD price",
    /does NOT mean every one of those days carries a\s*\n \* historical USD price/.test(src));
  check("the metadata carries no price concept at all",
    !/price|valuation|usd/i.test(code(src).replace(/\bpriceDate\b/g, "")),
    "valuation coverage has its own authority (cryptoValuationStatus)");
}

// ══ CAPABILITY GATES THE CLAIM ════════════════════════════════════════════════
{
  check("BTC, SOL and ETH may claim history",
    ["BTC", "SOL", "ETH"].every((c) => chainSupportsHistory(c)));
  check("BNB and AVAX may not — a current balance is not a past",
    !chainSupportsHistory("BNB") && !chainSupportsHistory("AVAX"));
  check("nor may an unsupported chain", !chainSupportsHistory("MATIC"));
}

console.log(`\nwallet-card-truth: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
