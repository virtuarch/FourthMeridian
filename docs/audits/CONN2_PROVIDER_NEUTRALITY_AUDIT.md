# CONN-2 — Provider-Neutrality Terminology Audit

**Status:** AUDIT (closes CONN-2). Confirms CONN-2 did not accidentally become Plaid architecture.
**Date:** 2026-07-19.
**Test applied:** *"If tomorrow we add Coinbase, Gemini, CSV import, or another banking provider, does this still make sense?"*

---

## 1. Verdict

**CONN-2's own surfaces are provider-neutral.** Every concept CONN-2 introduced — the intelligence projection, the derived lifecycle phases, the customer timeline, the building-profile card, the restore tool, and the empty state — speaks in **source / data acquired / intelligence built / financial profile / action required**, never in Plaid concepts, item ids, tokens, "Link", or sync-job names. Provider-specific behavior stays behind the existing state-derivation adapters.

The only provider-named strings on the Connections surface are **pre-existing (D2.x) identity attribution**, not introduced by CONN-2 (§4).

---

## 2. CONN-2 surfaces — neutral by construction

| Surface | Vocabulary | Neutral? |
|---|---|---|
| `ConnectionIntelligenceStatus` phases | `IMPORTING` · `BUILDING_INTELLIGENCE` · `READY` · `ACTION_REQUIRED` | ✅ no provider term |
| Intelligence statuses | `transactionHistory: READY/IMPORTING/UNKNOWN`, `intelligence: READY/REBUILDING/NOT_READY` | ✅ |
| Building card (`BuildingProfileContent`) | "Building your financial profile", "Transactions available", "Accounts connected", "Building your timeline", "Generating insights" | ✅ |
| Ready card | "Financial profile ready", "Financial intelligence built", "Transaction history imported" | ✅ |
| Customer timeline (`ConnectionTimeline`, CONN-2D) | "Authorization / Connected", "Data acquisition / Transactions available", "Financial intelligence / Wealth timeline built · Cash flow available", "Current freshness / Last updated" | ✅ fully neutral |
| Recovery tool (`BuildIntelligencePanel`) | "Financial intelligence tools", "Restore Financial Intelligence", "Restore selected intelligence" | ✅ |
| Empty state (CONN-2H) | "Import your transactions · Build your financial timeline · Generate cash-flow insights · Create your wealth picture" | ✅ |

**No** Plaid item ids, access tokens, "Link", "Plaid sync complete", or "history rebuild" appear in any CONN-2 customer string.

---

## 3. Architecture is provider-agnostic

- **The projection keys on provider-agnostic truth.** `deriveConnectionIntelligence` consumes `SyncConnectionState` (already provider-agnostic — Plaid + wallet both normalize into it via `lib/sync/status.ts`) plus a reconstruction anchor. Adding a new provider (Coinbase / Gemini / CSV / another bank) requires only: (a) a state derivation into `SyncConnectionState` (the existing per-provider adapter pattern), and (b) a reconstruction anchor — either a `*_HISTORY_SYNCED`-style audit row or the wallet-style "reconstruction runs inline before `lastSyncedAt`" fallback. **No CONN-2 rewrite.**
- **The reconstruction authority is provider-neutral.** `regenerateWealthHistoryForAccounts(faIds, window)` + `maxAvailableWealthWindow(faIds)` operate on `FinancialAccount` ids, not on any provider. The initial-build and recovery paths are identical regardless of how the accounts were acquired.
- **The customer timeline is derived, not provider-shaped.** `deriveConnectionTimeline` reads only the neutral `ConnectionIntelligenceStatus` — it would render identically for a Coinbase or CSV source.
- **"Cash flow available" is honest for any provider** — cash-flow history is a read-time projection over `Transaction` rows, which every provider produces.

**Coinbase-tomorrow test: passes.** A Coinbase source would show "Connected → Transactions available → Financial profile built → Last updated" with no code change to CONN-2's projection or UI; only its state adapter + anchor are new, behind the provider seam.

---

## 4. Findings — pre-existing provider-naming (NOT CONN-2; recommend, out of scope)

These strings predate CONN-2 (D2.x / CONN-1) and are **provider identity attribution**, a deliberate earlier decision (`PROVIDER_LABEL`, "provider is part of a connection's identity"). They are borderline against the "prefer *data acquired* over *sync*" guidance but are **not** Plaid *architecture* (they name the aggregator as attribution; readiness is separately expressed by CONN-2's neutral "Financial profile ready"):

| Location | String | Note |
|---|---|---|
| `ConnectionCard.tsx` `providerLine` | "Connected via Plaid" / "Synced via Plaid" / "Previously synced via Plaid" | provider attribution; uses "sync" wording |
| `ConnectionCard.tsx` error eyebrow | "Sync error" | pre-existing error framing |
| `ConnectionCard.tsx` investments row | "Investments synced" | pre-existing |

**Recommendation (future, small, outside CONN-2's L2 scope):** if a fully neutral surface is desired, reword to attribution-without-"sync" — e.g. "Connected · Plaid" as a subtle source tag, and "Couldn't update this connection" for the error — keeping the provider name as honest attribution while removing "sync" as the readiness verb. **Not changed here:** it is a presentation decision on a CONN-1/D2.x surface, and CONN-2's readiness/intelligence vocabulary is already neutral and separate from provider attribution.

**Explicitly acceptable — operator surface:** `OpsConnectionDiagnosticsWidget` / `connection-diagnostics` shows `provider: PLAID | WALLET` as a **fact**. Operators troubleshooting a connection legitimately need the provider type; this is diagnostic metadata, not customer-facing product language.

---

## 5. Close-out

CONN-2 delivers the financial-source → financial-intelligence **trust layer** in provider-neutral language, with provider specifics confined behind the existing state-derivation seam. The one area of provider-named wording is pre-existing attribution on the CONN-1 card, documented above with a scoped future recommendation. CONN-2 is closed; CONN-3 (freshness), CONN-4 (removal), and PO-4B (authorization lifecycle) remain separate slices.
