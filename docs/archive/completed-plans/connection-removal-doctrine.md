# CONN-4 — Connection Removal Doctrine: Investigation & Recommendation

**Status:** INVESTIGATION + DOCTRINE ONLY. **No code changes.** This document defines Fourth Meridian's connection-removal philosophy and recommends a direction; a future CONN-4 implementation slice would build from it.
**Date:** 2026-07-19.

---

## 0. The question

When a user removes a connection ("Remove Chase"), does that mean:
- **Model A** — *Disconnect:* stop syncing, revoke provider access, **preserve** all historical data; or
- **Model B** — *Sever + delete:* remove the relationship **and** delete all financial data that originated from that connection?

**Recommendation (summary):** the ambiguity is the actual problem. Offer **two explicitly-labeled actions**, not one "Remove" button that silently does one thing. Default to **Disconnect (Model A)** — reversible, matches the shipped infrastructure and the codebase's ratified revoke-don't-delete doctrine — and offer a deliberate, consent-gated **"Delete data from this connection" (Model B)** for the privacy expectation and right-to-deletion. **Neither model is honest today**, because the current "Remove" preserves everything while being worded like a deletion, and **neither reflects the removal in historical charts** without a separate regeneration step (§4). Details below.

---

## 1. Current state — today's "Remove" is already Model A (and there is no connection-level control)

- **There is no connection-level "Remove Chase" control.** The Connections surface (`ConnectionsActions`, `ConnectionCard`) only adds/refreshes. Removal happens **per `FinancialAccount`** via `DELETE /api/accounts/[id]` (reached from `AccountsPerspective` / `AccountDetail` / `FinancesPanel`).
- **`DELETE /api/accounts/[id]` is pure Model A**, in one transaction: soft-delete `FinancialAccount` (`deletedAt=now`), soft-delete `AccountConnection` rows, **revoke** the account's ACTIVE `SpaceAccountLink`s (`status=REVOKED`). Then, outside the tx: `regenerateSpaceSnapshot` (**today's row only**), `disconnectPlaidItemIfOrphaned` per item, and an `ACCOUNT_REMOVE` audit.
- **`disconnectPlaidItemIfOrphaned`** (`lib/plaid/disconnect.ts`) is the only provider-severance primitive: orphan-gated (no-op if any live `AccountConnection` remains), else `plaidClient.itemRemove()` (revoke at Plaid, best-effort) + `PlaidItem.status=REVOKED`. **It deletes no rows.**
- **Restore** (`POST /api/accounts/[id]/restore`) reverses the soft-delete (un-deletes account + connections, REVOKED→ACTIVE), but does **not** re-establish a REVOKED Plaid item — that needs a relink.
- **Model B exists only out-of-band:** `scripts/purge-plaid-connection.ts` (CLI, hard-deletes one connection's accounts) and `lib/account-deletion/purge.ts` (the ratified full-user GDPR purge). Neither is wired to product UI.

**Conclusion:** the product already *implements* Model A; it just doesn't *name* it, and doesn't expose it at the connection level.

---

## 2. Dependency graph (Prisma `onDelete` + soft-delete/status)

`FinancialAccount` is the **cascade hub**. A real row DELETE cascades to: `Transaction`, `Holding`, `PositionObservation`, `InvestmentEvent`, `PositionReconstruction`, `DebtProfile`, `AccountConnection`, `ProviderAccountIdentity`, `SpaceAccountLink`, `GoalContribution`.

Critical structural facts:
- **Cascade fires only on a real DELETE, never on soft-delete (`deletedAt`).** Today's removal is soft-delete, so *none* of this cascade fires — data is fully preserved.
- `PlaidItem → AccountConnection` is **SetNull, not Cascade**. Deleting a PlaidItem orphans (nulls) the join, it does not delete accounts.
- `FinancialAccount.ownerUserId` / `ownerSpaceId` are **SetNull** — deleting a user does *not* delete their accounts; they must be deleted explicitly (why `purge.ts` has a dedicated step).
- `Instrument` and `PriceObservation` are **GLOBAL** parents referenced by `Restrict` FKs — a cascade can never reach them (shared market data is sacred; asserted unchanged before/after any purge).
- **Dangling-by-design (no FK):** `AuditLog` (`SetNull` on user/space; IDs live in `metadata` JSON) is append-only and never cascade-deleted; `SyncIssue` (`plaidItemId`/`financialAccountId`/`plaidAccountId` are plain strings) **dangles** after a hard delete and needs an explicit cleanup pass; `SnapshotAmendment[Day]` reference the account by soft ref (no FK) **deliberately**, so history stays true even after a hard delete; `PositionObservation/InvestmentEvent/Instrument.supersededById` are self-ref strings, not FKs.

---

## 3. Derived data — what needs cleanup vs what self-cleans

| Derived data | Stored? | Cleanup on removal |
|---|---|---|
| **Cash flow / "DayFacts"** | **No model** — read-time projection over `Transaction` | **Self-cleans**: soft-deleting transactions removes them from every read path (`deletedAt: null`). Nothing dangles. |
| **AI context / intelligence** | Only `AiAdvice` + `AiAgent`, both **space-scoped** (cascade on space) | No per-account/transaction AI persistence; nothing dangles on connection removal. |
| **Exports / reports** | None stored | Nothing. |
| **AuditLog / Notifications** | Append-only, no FK to account | Dangle **by design** (forensic trail). Keep. |
| **SyncIssue** | Forensic side-table, no FK | **Dangles** — Model B needs an explicit purge pass. |
| **SpaceSnapshot** | **Space-level aggregate**, one row per (space, date), **no per-account column** | **The hard problem** — see §4. |

---

## 4. The cross-cutting blocker: `SpaceSnapshot` history (true under BOTH models)

`SpaceSnapshot` stores per-day space totals (netWorth/cash/debt/…) with **no per-account column**, so a removed account's contribution **cannot be subtracted arithmetically** from historical rows. The only correct fix is a **full space-range regeneration** over the current active-account set (which naturally excludes the removed account) — the `SnapshotAmendment` flow (`regenerateWealthHistory`).

Two facts make this the central doctrine constraint:
1. **Removal does not trigger it today.** `DELETE /api/accounts/[id]` regenerates only **today's** snapshot. So after removing a connection, the removed account's money **stays baked into every historical snapshot** (net-worth timeline, wealth charts) until the user *manually* runs a Rebuild/amendment. This is a pre-existing honesty gap independent of the model choice.
2. **Shared-space amendment is deferred (Phase 3).** `applyAmendment` throws `SharedSpaceAmendmentError` for any non-PERSONAL space. So a removed account's contribution **cannot currently be corrected out of a shared space's history at all** — a hard blocker for Model B (and for an honest Model A) in shared spaces.

**Implication:** any "make it truly gone" story (Model B, or an honest Model A that says "we removed your history") depends on wiring removal → consent-gated historical regeneration, and on shipping shared-space amendment. Until then, "your Chase data is gone" cannot be truthfully claimed for historical charts, especially in shared spaces.

---

## 5. Shared-Spaces implications

- `SpaceAccountLink` doctrine is **ratified revoke-don't-delete** (schema header): a REVOKED link makes the account invisible to that space; the FK nulls harmlessly; re-sharing reactivates.
- **Blast radius:** today's account DELETE revokes **all** ACTIVE SALs for that account across **every** space (no per-space filter). So removing the connection **immediately pulls the account out of every other member's shared space**. Their *today* snapshot excludes it; their *historical* snapshots retain it (§4), and cannot yet be amended (Phase 3).
- A Model-B "delete provider data" by the owner would **destroy data other members were relying on** in their shared spaces — a strong argument that connection removal should be **revoke/soft-delete by default**, with hard-delete reserved for accounts the user solely owns (or gated on shared-space impact disclosure).

---

## 6. Reconnect behavior (decides the two models' UX)

`exchange-token` relink resolves each account via `ProviderAccountIdentity` → legacy `plaidAccountId` → **fingerprint** (institution + mask + type + name, matches even when Plaid reissues account IDs), and **revives the same soft-deleted `FinancialAccount` row** (`deletedAt=null`), folding any duplicate.

- **Under Model A:** reconnect is **seamless** — the same rows revive, all history intact, no duplicate.
- **Under Model B:** the identity/fingerprint match finds nothing → reconnect is a **fresh import** with new rows and a re-fetched history (exactly what `purge-plaid-connection.ts` exists to force — "come back clean").

---

## 7. Model A vs Model B — evaluation

| Dimension | **Model A — Disconnect (stop sync, preserve)** | **Model B — Sever + delete provider data** |
|---|---|---|
| **Privacy / user expectation** | ❌ Violates "FM no longer has my Chase info" if labeled "Remove". ✅ Honest if labeled "Disconnect / stop syncing". | ✅ Matches "delete my data" expectation and right-to-deletion. ⚠️ With principled exceptions (global market data, anonymized audit trail, amendment records). |
| **UX clarity** | ✅ Reversible, low-stakes, "reconnect anytime". Ambiguous only if mis-labeled. | ✅ Clear *if* framed as irreversible deletion with a confirmation; ❌ dangerous if it looks like a normal remove. |
| **Reconnect** | ✅ Seamless — same rows, full history, no duplicate. | ➖ Fresh import; history re-fetched (bounded by provider window); loses any manual edits/reconciliation. |
| **Shared Spaces** | ✅ Safe — revoke-don't-delete; other members lose visibility but the data substrate survives; re-share reactivates. | ❌ Destroys data other members rely on; **blocked** on shared-space snapshot amendment (Phase 3). |
| **Historical charts reflect removal** | ❌ Not today (snapshots retain contribution) — needs consent-gated regen wired in. | ❌ Same gap — hard-deleting the account still doesn't touch historical snapshots; needs regen/amendment. |
| **Implementation complexity** | ✅ **Already built** — just needs a connection-level surface + honest labeling. | ❌ High — hard-delete + `SyncIssue` cleanup + orphan handling + **consent-gated historical regeneration** + shared-space amendment (Phase 3) + irreversibility guardrails. |
| **Alignment with codebase doctrine** | ✅ Revoke-don't-delete, soft-delete-preserves-history, never-hard-delete-`FinancialAccount`, append-only audit/prices. | ➖ Only the GDPR user-purge and a CLI script hard-delete today; runs against the default preservation posture. |

---

## 8. Recommendation

**Adopt a two-action doctrine; do not overload one "Remove" button.**

1. **Primary action — "Disconnect" (Model A), reversible, the default.**
   - Wording, honestly: *"Disconnect Chase — we'll stop pulling new data. Your existing history stays in Fourth Meridian. Reconnect anytime to resume."* Never label this "Remove" or "Delete".
   - Mechanics already exist: soft-delete account/connection, revoke SALs, `itemRemove` + `PlaidItem→REVOKED` when orphaned. Add a **connection-level** entry point (the Connections card currently has none — this is the real UX gap) that disconnects all of an institution's accounts together.
   - This is the safe default: it honors the user's control ("stop having my Chase live") without destroying shared-space data or breaking clean reconnect.

2. **Secondary action — "Delete data from this connection" (Model B), explicit + irreversible + consent-gated.**
   - For the genuine privacy expectation and right-to-deletion. Framed as a distinct, confirmed, irreversible action (mirroring the account-deletion grace/confirm pattern).
   - Requires (new build): hard-delete the connection's owned accounts (cascade), explicit `SyncIssue` cleanup, **and a consent-gated historical snapshot regeneration** so the money actually leaves the charts. Reconnect becomes a fresh import.
   - **Principled, disclosed exceptions** (state them in the UI): global market data (`Instrument`/`PriceObservation`) is shared and untouched; the audit trail persists (anonymized where it names the user); `SnapshotAmendment` records survive so corrected history stays true.
   - **Gate on shared-space impact:** disallow (or require additional confirmation for) deleting an account other members rely on until shared-space amendment (Phase 3) ships — otherwise Model B silently corrupts other members' history.

3. **Fix the honesty gap that affects BOTH models first (or alongside):** removal should offer to regenerate historical snapshots so charts reflect the removal. Today they don't, which makes *any* removal wording misleading about history. This is the highest-value, model-independent fix, and it is gated on the deferred shared-space amendment for shared spaces.

**Net:** the codebase already stands firmly on *revoke-don't-delete*; the product should adopt that as the default and name it honestly ("Disconnect"), while offering a separate, deliberate deletion path for privacy — and must, in either case, wire removal to the consent-gated historical regeneration that currently only runs manually.

---

## 9. Open decisions for a future CONN-4 implementation (not decided here)

1. **Default label + granularity:** "Disconnect" at the connection level (all institution accounts) vs per-account. (Recommend connection-level Disconnect + keep per-account remove.)
2. **Does "Delete data" ship now or after shared-space amendment (Phase 3)?** (Recommend: gate Model B on Phase 3 for shared accounts; allow it for solely-owned/PERSONAL accounts sooner.)
3. **Retroactive snapshot regeneration on removal:** opt-in prompt vs automatic; PERSONAL-only until Phase 3.
4. **`SyncIssue` cleanup:** add to the deletion order (dangles today).
5. **Legal/GDPR wording:** align "Delete data from this connection" with the existing account-deletion purge doctrine; document the principled exceptions.

**No code was written. This document is the CONN-4 deliverable.**
