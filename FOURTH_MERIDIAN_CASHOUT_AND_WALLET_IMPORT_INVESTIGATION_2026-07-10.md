# Fourth Meridian — Investigation: Cash Out Composition + BTC Wallet Import Strategy
**2026-07-10 · Investigation only — no implementation.**

---

## Part A — Cash Flow Summary: richer Cash Out composition

### Headline finding
The rich Cash Out composition is **already ~90% built** and shipping. It just isn't obvious because the breakdown lives *behind the expand chevron* on the Cash Out tile. The liquidity engine already classifies every row into an explainable reason, and the summary already renders every non-zero Cash Out reason as a line. The **only genuinely missing bucket is Taxes**, and that one is non-trivial because the client transaction DTO carries no tax signal today.

Pipeline that already exists:
`classifyLiquidity` (`lib/transactions/liquidity.ts`) → per-row `{effect, reason}` → `groupLiquidityByReason` (`lib/transactions/liquidity-breakdown.ts`) → expandable `AxisTile` lines in `CashFlowSummaryWidget.tsx`.

### Answers to the eight questions

**1. Which buckets are already computable from existing fields?** All but taxes:

| Requested bucket | Status | Source |
|---|---|---|
| Debt payments | ✅ Live | reason `DEBT_PAYMENT` (liquid→liability, or `isDebtPayment`) |
| Direct cash spending | ✅ Live | reason `REAL_COST` paid from the liquid tier |
| Credit card purchases (context) | ✅ Live | `creditCardPurchases` — `REAL_COST` charged to a liability account |
| Investments / asset deployment | ✅ Live | reason `ASSET_DEPLOYMENT` (liquid→asset tier crossing) |
| Transfers / unresolved movement | ✅ Live | `INTERNAL_TRANSFER` (neutral) + `UNRESOLVED` (shown as footnote) |
| **Taxes** | ❌ Not derivable | no `TAX` FlowType, no `Tax` category, no tax field on the DTO |

**2. Which require new classification helpers?** Only **Taxes**. Everything else is a rename/exposure of reasons the engine already emits.

**3. Can taxes be derived from category / merchant / FlowType today?**
- **FlowType — no.** The set is `SPENDING | INCOME | REFUND | DEBT_PAYMENT | TRANSFER | INVESTMENT | FEE | INTEREST | ADJUSTMENT | UNKNOWN`. No tax kind.
- **TransactionCategory — no.** `Income, Transfer, Groceries, Dining, Shopping, Travel, Subscriptions, Utilities, Interest, Payment, Other, Buy/Sell/Dividend/Split/Fee`. No tax category.
- **Merchant — weak/only.** The raw `merchant` descriptor (e.g. "IRS", "FRANCHISE TAX BD", "HMRC") is the only client-visible signal, via a string heuristic — low confidence, locale-specific.
- **Best real signal is server-side:** Plaid `personal_finance_category` (persisted raw, provider's opinion) has tax-adjacent categories, but it is **not plumbed to the client Transaction DTO** that the liquidity widget consumes. So a robust taxes bucket requires either (a) plumbing a tax signal to the DTO, or (b) a server-side sub-classification — not a client-only change.
- **Economically, taxes are a sub-type, not a new peer:** a tax payment is still `REAL_COST` (paid from checking) or a `TRANSFER`/`DEBT_PAYMENT` to a tax authority. It must **carve out of** an existing bucket, never add on top (see Q8).

**4. Can investments / asset deployment be derived from account-tier crossing today?** **Yes — already done.** `ASSET_DEPLOYMENT` is exactly a liquid→asset tier crossing (`classifyTransfer`, own=liquid, counterparty=asset), and it already renders as a Cash Out reason line. No new work.

**5. Credit card purchases: context or sibling disclosure row?** **Keep as context (sibling disclosure), NOT a Cash Out line.** Card purchases are liquidity-**neutral** at purchase time (no spendable cash moved); the cash leaves later as a Debt payment. Promoting them into Cash Out would **double-count** against Debt payments. The current dashed "context" box is the correct model — at most, relabel it a "sibling disclosure" but keep it out of the total.

**6. Neutral transfers vs unresolved transfers?**
- **Neutral** (`INTERNAL_TRANSFER`, liquid↔liquid or the non-liquid leg): correctly **excluded** from Cash Out. Optionally expose as a muted "Transfers (moved, not spent)" context row — never summed.
- **Unresolved** (`UNRESOLVED`, counterparty tier unknown): currently a faint footnote ("$X unclassified — counterparty not linked yet"). Recommend keeping it as **honest transparency, not an error**, and optionally promoting it to a faint sibling row labelled "Unresolved movement" so it reads as a first-class (but non-alarming) part of the composition. It self-heals when counterparty linking lands.

**7. Which helper should own this?** **Extend `liquidity-breakdown.ts`** — it already owns the effect-split, per-reason composition and is the pure consumer of the engine.
- ❌ Not a new `cash-flow-composition` helper (would duplicate `groupLiquidityByReason`).
- ❌ Not a summary-only adapter (the composition must stay shared with AI facts + other widgets; UI must never recompute).
- The tax *signal* (`isTaxCost`) belongs one layer down in the predicate/engine layer (near `flow-predicates.ts`) so it's shared and testable; `liquidity-breakdown` consumes it to split the line.

**8. How to avoid double-counting?** Already handled for the built buckets:
- The **anchoring rule** attributes a two-legged transfer's cash effect to the liquid leg only; the other leg is neutral.
- Credit-card purchases are neutral, so they never enter `cashOut`.
- **The rule for taxes:** it must **split an existing bucket** (carve "Taxes" out of `REAL_COST`/`DEBT_PAYMENT`), leaving `cashOutTotal` unchanged. Adding taxes as a new additive bucket would change the Cash Out total and double-count.

### Smallest useful slice (Part A)
1. **Ship the composition you already have.** Surface the existing Cash Out reason lines (Debt payments, Direct cash spending, Asset deployment) more prominently — e.g. render the top 2–3 inline instead of only on expand. **Zero engine work.**
2. **Transfers/Unresolved:** promote the unresolved footnote to a faint "Unresolved movement" sibling row; keep neutral transfers out. **UI-only.**
3. **Taxes = separate, later slice.** It needs a tax signal the DTO lacks. When taken: add an `isTaxCost(tx)` predicate (server-side Plaid PFC, or a merchant heuristic as a low-confidence fallback), and split a **"Taxes"** sub-line **out of** Direct cash spending in `liquidity-breakdown` — never additive.

**Do not build yet:** taxes as a new additive Cash Out bucket; any client-only tax heuristic presented as authoritative.

---

## Part B — BTC xpub / wallet import strategy

### 1. Current implementation
- **Raw xpub/ypub/zpub:** `detectExtendedKeyType` (SLIP-0132 prefix), `isExtendedKey` (base58check + 78-byte length), `parseExtendedKey` (rewrites version bytes → xpub so `@scure/bip32` accepts it, remembers script type from the prefix). Script type: `xpub→p2pkh`, `ypub→p2sh-p2wpkh`, `zpub→p2wpkh`.
- **Ledger JSON:** `normalizeExtendedKeyInput` parses `{xpub|extendedPublicKey|extended_public_key|key}` + `{freshAddressPath|derivationPath|path}`, reads the BIP purpose (`84/49/44`) from the path, and `reencodeExtendedKey`s the key to the prefix implied by the path — so an `xpub`-prefixed **native-segwit** Ledger export becomes a `zpub` and derives `bc1…` correctly.
- **Script-type inference:** prefix by default; path purpose overrides (the Ledger case).
- **Where normalization lives:** `lib/crypto/btc-address-derivation.ts` (`normalizeExtendedKeyInput` + `reencodeExtendedKey`), called once in `app/api/accounts/wallet/route.ts`. **There is no `WalletDescriptor` struct** — script type is carried *implicitly* via the re-encoded prefix.
- **Is it too Ledger-specific?** Partly. It handles Ledger's JSON field names and path, but there is **no BIP380 output-descriptor support** (`wpkh([fp/84h/0h/0h]xpub/0/*)`, `sh(wpkh(...))`, `tr(...)`) — Sparrow/Coldcard/Specter descriptor exports would fail (not a bare key, not JSON → treated as a plain address). No origin fingerprint, gap, or account metadata is captured.

### 2. UX language
- **"Paste xpub"** — too technical and too narrow; excludes plain addresses and future formats.
- **"Paste wallet export"** — format-agnostic and better, but "export" is mild jargon.
- **"Import watch-only wallet"** — clearest intent *and* sets the watch-only expectation up front.

**Recommendation:** lead with intent, keep the field permissive.
- CTA: **"Add wallet"** / **"Connect a watch-only wallet."**
- Field helper: *"Paste a Bitcoin address, xpub/ypub/zpub, or wallet export."*
- Keep the existing "Watch-only — we read your balance from the blockchain and never need spend access" reassurance (already present).

Current copy ("address or xpub", "Watch-only") is close; evolve "xpub" → "or wallet export" as descriptor support lands.

### 3. Import formats compared

| Format | Reliability | Metadata completeness | User friction | Future-proofing | Impl. complexity |
|---|---|---|---|---|---|
| Raw xpub/ypub/zpub | High | **Low** (prefix only — the wrong-type ambiguity we hit) | Low | OK | **Low** (done) |
| Ledger JSON | High | Med (path → script type) | Med (find the JSON) | Ledger-only | Low–Med (done) |
| **BIP380 output descriptor** | **Highest** | **Complete** (script type, origin fingerprint, path, ranges, multisig) | Med | **Best** (taproot/multisig) | Med (needs a parser) |
| Wallet-specific export (Sparrow/Coldcard/Electrum/BlueWallet JSON) | High | Varies | Med | Vendor-coupled | Med each |
| Direct wallet/device integration | Highest | Complete | **Highest** (device, permissions) | Strong but heavy | **High** (WebHID/WebUSB, security surface) |

**Descriptors are the strategic target:** they encode script type explicitly (eliminating the xpub-native-segwit guessing), carry origin metadata, and are the industry standard across modern wallets.

### 4. Descriptor-first design — recommended abstraction
Yes: introduce an internal `WalletDescriptor` as the single **normalization seam** every import form funnels into *before* derivation/discovery. Leaner than the proposed shape (drop fields no consumer needs yet), with **script type explicit** (the prefix-re-encode trick is single-sig-only and won't generalize):

```ts
WalletDescriptor {
  network:          "bitcoin";                                  // room for testnet/other chains
  scriptType:       "p2pkh" | "p2sh-p2wpkh" | "p2wpkh" | "p2tr"; // EXPLICIT, not implied by prefix
  extendedKey:      string;      // canonical xpub-versioned key material
  originFingerprint?: string;    // master fingerprint (from descriptor/JSON) — dedupe + verification
  accountPath?:     string;      // e.g. "m/84'/0'/0'"
  source:           "raw" | "ledger-json" | "descriptor" | "sparrow" | "coldcard" | …; // provenance
}
```
Deferred (add when a consumer needs them): `accountIndex`, `descriptorVersion`, multisig key-set/policy, change/receive derivation overrides. Persist the descriptor (or its canonical string) as the wallet's credential so re-derivation is deterministic. Derivation + discovery consume the **descriptor**, not the raw string.

### 5. Trezor / other wallets — do they normalize into one model?
**Single-sig: yes.** All of these emit an extended key and/or a descriptor that maps cleanly to `WalletDescriptor{scriptType, extendedKey, originFingerprint, accountPath}`:
- **Trezor Suite** — xpub/ypub/zpub; descriptors.
- **Sparrow** — BIP380 descriptors + xpub; wallet-export JSON.
- **Electrum** — master public key (xpub/zpub); descriptors in newer versions.
- **BlueWallet** — xpub/zpub; sometimes descriptors.
- **Coldcard** — descriptors; "Generic JSON" (xpub + path + fingerprint, Ledger-like); multisig configs.
- **Specter / Keystone** — descriptors (single + multisig).

**Multisig is a superset**, not a different model: Specter/Coldcard/Sparrow multisig exports are descriptors over a *key set + policy*. Keep `WalletDescriptor` extensible to multi-key, but **defer** multisig implementation.

### 6. Direct wallet connection — now or later?
**Defer.** Stabilize the import/export (descriptor) model first. Direct device connection (WebHID/WebUSB, vendor SDKs) adds a large security, permissions, and browser-compatibility surface for little marginal value over watch-only import (which already delivers balances + history). Sequence:
1. Descriptor import (stabilize) →
2. *Assisted export* ("Connect Ledger/Trezor" buttons that **guide** the user to export a descriptor) →
3. True device APIs — only much later, optional.

### 7. Failure modes — backend distinctions
Most are already implemented (previous slice); formalize them as one typed status union shared by route + card:

| Mode | Current handling | Recommendation |
|---|---|---|
| Malformed export | `INVALID_XPUB` (reject, permanent) | add `INVALID_DESCRIPTOR` for descriptor parse failures |
| Valid, no used addresses | `NO_USED_ADDRESSES` (guidance: wrong type / try zpub) | keep; a descriptor's explicit type makes this rarer |
| Wrong script type / path | surfaces *as* no-used-addresses today | with descriptors, detect declared-vs-derived mismatch and hint specifically |
| Explorer / network failure | `RATE_LIMITED` / `DISCOVERY_FAILED` (retryable) | keep |
| Partial discovery | discovering/pending, clears stale error | keep (fixed last slice) |
| Huge wallet still discovering | resumable checkpoint, stays "discovering" | keep |

Make these an explicit `WalletImportStatus` union (not ad-hoc error strings) so each has stable copy.

### 8. Product doctrine / naming
- **"xpub support"** — too technical, too narrow. Avoid.
- **"Wallet import"** — describes the one-time action, not the ongoing relationship.
- **"Watch-only wallet connection"** — accurate and sets expectations; slightly wordy.
- **"Self-custody provider adapter"** — the right *internal/architecture* framing: it's the `WALLET` provider on the same `Connection → ProviderAccountIdentity → FinancialAccount` spine as Plaid, with the `WalletDescriptor` as its credential and discovery as its "sync."

**Recommendation — two names for two audiences:**
- **UI/product doctrine:** *watch-only wallet* ("Connect a watch-only wallet" / "Add wallet"). It's honest, sets the no-spend-access expectation, and is format-agnostic.
- **Architecture doctrine:** *self-custody (watch-only) provider adapter* — a sibling to the Plaid provider on the existing spine. This is what keeps descriptors, discovery, and status modeling coherent as formats multiply.

---

## Recommendation summary

**Part A — shortest slice:** the composition already exists; surface the existing Cash Out reason lines (Debt payments / Direct cash spending / Asset deployment) more prominently and promote "Unresolved movement" to a faint sibling row (UI-only, no engine change). Treat **Taxes** as a separate later slice that (a) needs a tax signal the client DTO lacks and (b) must **split** Direct cash spending, never add to the total. Keep credit-card purchases as context. Owner: extend `liquidity-breakdown.ts`; put the tax predicate in the shared predicate layer.

**Part B:**
- **Shortest next slice:** introduce `WalletDescriptor` as the normalization seam + add **BIP380 single-sig descriptor parsing** (`wpkh/sh-wpkh/pkh/tr`) alongside raw + Ledger-JSON. This generalizes beyond Ledger, makes script type explicit (kills the wrong-type ambiguity), and is the foundation for Sparrow/Coldcard/Specter/Trezor. Small UI copy update ("address, xpub/ypub/zpub, or descriptor").
- **Long-term architecture:** every import form → `WalletDescriptor` → discovery/derivation → provider spine; descriptor persisted as the credential; script type explicit; extensible to multisig and more chains.
- **UI name:** "watch-only wallet" (product) / "self-custody provider adapter" (architecture).
- **Support now:** raw keys (done), Ledger JSON (done), single-sig descriptors (next).
- **Defer:** multisig policies, wallet-vendor-bespoke JSON parsers, direct device/browser wallet APIs.
- **Don't build yet:** device connection, multisig, or a `WalletDescriptor` over-modeled with fields no consumer reads.
