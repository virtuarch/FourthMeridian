# D2.x — Connections UI Polish — Investigation

**Status:** Investigation only. No implementation.
**Goal:** Smallest safe polish slice to make the importing state of the Connections page feel premium and alive, using **existing** Atlas primitives only, with **honest** progress (no fake percentages).

---

## 1. Current Connections components

- `components/connections/ConnectionCard.tsx` — presentational; wraps content in **`DataCard`** (Atlas Glass via `GlassPanel`). Importing state shows a flat checklist (✓ rows + one `Loader2` active row + muted "ready next" markers). Settled state shows a summary + accounts.
- `components/connections/ConnectionsList.tsx` — `"use client"` poller (4s while `building`), renders one card per connection.
- `app/(shell)/dashboard/connections/page.tsx` — server page; SSR-seeds `{ building, connections[] }` from `buildSyncStatus` + accounts grouped by institution.

Observation is correct: cards use `DataCard` (Glass), progress is binary (`importing`/`ready`), no progress presentation beyond a spinner, no recent-progress stats beyond the discovered-accounts list.

## 2. Existing Atlas Liquid primitives + fallback (reuse targets)

- **`AtlasLiquidCard`** (`components/atlas/AtlasLiquidCard.tsx`) — first-class Liquid material (vendored WebGL `LiquidGlassCard`). Zeroes its own content padding (caller supplies padding), fills its column, supports `href`/`onClick`/static, optional `tint`. Doctrine note in its own header: "a rare premium accent (Daily Brief flagship cards only)… does NOT replace GlassPanel/DataCard."
- **`useAtlasLiquid()`** (`components/atlas/useAtlasLiquid.ts`) — SSR-safe capability gate: server snapshot `false` (renders Glass), upgrades to Liquid on the client only when WebGL is present and `prefers-reduced-transparency` is not set; `?atlasLiquid=0/1` overrides.
- **Established consumer pattern** (`components/dashboard/SpacesClient.tsx`): `const liquid = useAtlasLiquid(); return liquid ? <AtlasLiquidCard …>…</AtlasLiquidCard> : <GlassPanel …>…</GlassPanel>;` — Liquid with a Glass fallback, same crisp children in both.

**Fallback behavior:** every Liquid usage MUST ship a Glass fallback (no-WebGL / reduced-transparency / SSR). Reusing this pattern is *reuse*, not design-system extension.

## 3. Can `ConnectionCard` reuse `AtlasLiquidCard` safely? — **Yes, via the gated ternary.**

Safe if and only if it follows the existing pattern: `useAtlasLiquid()` decides, `AtlasLiquidCard` when true, Glass (`DataCard`) fallback when false, identical children. `ConnectionCard` is already `"use client"`, so `useAtlasLiquid()` is available. No new material, no new primitive — the same building blocks `SpacesClient` already ships.

## 4. Should Liquid be scoped to importing, and DataCard kept for settled? — **Recommended: yes.**

Reserve Liquid for the **importing** card only (the live first-run "moment"); keep **`DataCard` (Glass)** for `ready`/`needs_reauth`/`error`. Rationale:
- Honors the scarcity doctrine (Liquid is a rare accent) — it appears only while a connection is actively building, then the card **settles** to Glass. A steady-state list of many Liquid cards would both dilute the accent and cost N WebGL canvases.
- Matches the product intent ("alive while importing"): the premium material *is* the aliveness, transient by design.
- One caveat for the approver: this is the first Liquid usage outside the Daily Brief. It's reuse (not a new primitive), but it does widen where Liquid appears. If preferred to keep Liquid strictly Brief-only, the conservative fallback is Glass-everywhere + a stage stepper (below) for the "alive" feel — still a real improvement. **Primary recommendation: Liquid for importing, gated + fallback.**

## 5. What progress data is honestly available today

| Signal | Available now? | Source | Honest to show? |
|--------|----------------|--------|-----------------|
| Institution connected | ✅ | PlaidItem exists | Yes (✓) |
| Accounts discovered (count) | ✅ | `getAccounts` grouped (already on the page) | Yes (✓ + count) |
| Balances imported | ✅ | fast-path guarantees balances before page load | Yes (✓) |
| Transaction history importing vs done | ✅ | `cursor === null` ⇒ importing (existing derivation) | Yes (binary) |
| `lastSyncedAt` | ✅ | PlaidItem field (already in `/api/sync/status`) | Yes (on ready) |
| **% complete** | ❌ | Plaid gives no total; engine persists no mid-loop progress | **No — would be fake** |
| **transaction count** | ⚠️ derivable | count `Transaction` where `financialAccountId ∈ item's accounts` (new query) | Only honest once ready; partial/misleading mid-import |
| **imported years span** | ⚠️ derivable | `min(Transaction.date)` for item's accounts (new query) | Only honest once ready; partial mid-import |

**Bottom line:** stage state, account count, and `lastSyncedAt` are free and honest today. Percentage is impossible without faking. Transaction count / imported-years are derivable but require new queries and are only meaningful *after* history completes.

## 6. Stage-based progress instead of percentage — **Yes; this is the recommended presentation.**

A discrete **stepper** (not a filled percentage bar) is fully honest with data we already have:

```
● Institution connected      ✓ done
● Accounts discovered (N)     ✓ done
● Balances imported           ✓ done
◐ Transaction history         … importing (active, animated)
○ Ready                        pending
```

- Each node is a real, observable state — no interpolation, no invented %.
- The "bar" is the connector between discrete nodes filling as stages complete (0→ready), which is honest because the stages themselves are discrete and true.
- The active node carries the existing `Loader2` spin; combined with the Liquid material this delivers "alive" without inventing effects.
- When `cursor` lands (ready), the stepper completes and the card settles to Glass.

This replaces the current flat checklist with a clearer staged visual, reusing existing tokens/icons only.

## 7. Recent-progress stats available today

- **Include now (free):** *accounts discovered* (count — already grouped on the page) and *lastSyncedAt* (already returned). Both honest at all times.
- **Defer (needs new queries + only honest post-completion):** *transaction count* and *imported-years span*. Recommend NOT adding to the smallest slice — they require enriching `/api/sync/status` (or the page query) with per-item `Transaction` aggregates (`count`, `min(date)`), and mid-import they are partial. Natural home is the SyncJob/backfill track (§8), where durable progress state exists.

## 8. Defer to historical snapshot backfill / SyncJob

- **% complete / "X of Y pages" / live imported-transaction counter** — needs durable mid-loop progress; only a **`SyncJob`** model (deferred) can hold it without touching the engine.
- **Imported-years span + 30-day chart population** — belongs to the **Snapshot Backfill** initiative (multi-day `SpaceSnapshot` history); out of scope here.
- **Transaction count as a headline stat** — fold in with SyncJob progress or a post-completion enrichment, not this slice.

## 9. Files affected (smallest slice)

| File | Change | Type |
|------|--------|------|
| `components/connections/ConnectionCard.tsx` | Importing → `useAtlasLiquid()` gated `AtlasLiquidCard` (Glass/`DataCard` fallback) + stage stepper; settled → keep `DataCard`. Add account-count/`lastSyncedAt` copy. | Edit |
| `components/connections/ConnectionsList.tsx` | None expected (card owns material choice). Touch only if a shared `liquid` read is cleaner. | None/tiny |
| `app/(shell)/dashboard/connections/page.tsx` | None (data already present). | None |
| `/api/sync/status`, `lib/sync/status.ts` | **None** — no new fields; percentage/tx-count explicitly excluded. | None |
| schema / engine / Accounts page | **None.** | None |

Net: effectively a **one-file** change (`ConnectionCard.tsx`), reusing `AtlasLiquidCard` + `useAtlasLiquid` + `DataCard` exactly as they exist.

## 10. Recommended smallest implementation checklist (for approval)

1. In `ConnectionCard.tsx`, add `const liquid = useAtlasLiquid();` (already a client component).
2. **Importing state:** render `liquid ? <AtlasLiquidCard ariaLabel={…}> … </AtlasLiquidCard> : <DataCard> … </DataCard>` with identical children; supply inner padding for the Liquid case (it zeroes its own). Children = the **stage stepper** (§6): discrete nodes Institution connected → Accounts discovered (N) → Balances imported → Transaction history (active/animated) → Ready, plus the existing muted "ready next" markers (Timeline/Brief/AI) kept as forward-looking, never ✓.
3. **Settled states** (`ready`/`needs_reauth`/`error`): keep `DataCard` exactly as today (Liquid stays scarce); show account count + `lastSyncedAt`; `needs_reauth` keeps `ReconnectAccountButton`; `error` keeps the quiet line.
4. Stage stepper is a small local presentational block using existing tokens/lucide icons — **no new Liquid primitive, no new material effect, no design-system token added**.
5. No endpoint/schema/engine/page changes. No transaction-count/percentage/imported-years.

**Validation (for the eventual implementation):** `npx tsc --noEmit` (0 errors); `npm run lint` (no new errors in scoped file); visual check with `?atlasLiquid=1` (Liquid) and `?atlasLiquid=0` (Glass fallback) — both render the same stage stepper; importing card shows Liquid + animated active stage; on sync completion the card settles to `DataCard` ready; reduced-transparency / no-WebGL falls back to Glass; `git diff` limited to `ConnectionCard.tsx` (+ optional tiny `ConnectionsList.tsx`).

**Rollback:** single-file presentational edit → revert the commit to restore the current `DataCard` checklist. No data/engine/schema impact.

**Stop — investigation/checklist only. Await approval before implementation.**
