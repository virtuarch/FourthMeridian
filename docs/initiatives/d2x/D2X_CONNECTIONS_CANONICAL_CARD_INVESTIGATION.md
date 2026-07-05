# D2.x — Connections Canonical Card — Investigation + Checklist

**Status:** Investigation only. No implementation until approved.
**Vision:** ONE canonical `ConnectionCard` for every provider/institution, on the same premium Liquid Glass language across all states. The card **settles in content** as sync completes — it does not switch to a different visual component. Connections shows provider health / sync state / account inventory — **no dollar balances** (those belong on Accounts/Spaces/Dashboard).

---

## 1. Current states — why ready is still "plain" (Q1)

`ConnectionCard` has two visual languages by construction:
- **importing** → `useAtlasLiquid() ? AtlasLiquidCard : DataCard` with the flagship body (eyebrow, heading, stepper, min-height).
- **ready / needs_reauth / error** → a bare `return <DataCard>…</DataCard>` (never `AtlasLiquidCard`) with `Header` + `AccountsList`, and **`AccountsList` renders `fmtBalance` (dollar amounts)**.

So settled cards are plain glass **and** carry dollars — two problems the vision corrects. The Liquid material was only ever wired into the importing branch.

## 2. Can all states use `AtlasLiquidCard` with `DataCard` fallback? (Q2) — Yes.

The render shell becomes **state-independent**: always `liquid ? <AtlasLiquidCard> : <DataCard>`, wrapping **state-specific content**. This unifies the language: the card family is constant, only the inner content changes (stepper while importing → status rows when ready → reconnect when broken). `DataCard`/`GlassPanel` is the documented, same-family fallback for `AtlasLiquidCard`, so a capped/low-capability card still "belongs."

## 3. Performance with multiple Liquid cards (Q3) — real risk; cap it.

Evidence from the vendored material (`components/atlas/vendor/liquid-glass/LiquidGlassCard.tsx`):
- **No continuous render loop.** `requestAnimationFrame(animateMotion)` fires only on pointer interaction, only when `draggable` (which `AtlasLiquidCard` does **not** enable), and self-terminates once motion settles (`> .001` threshold). Idle CPU cost is ~zero.
- **But one WebGL context per card.** Each mounts `new LiquidGlassRenderer(canvas, backgroundImage, …)` — a dedicated WebGL context that loads/samples `/oval-world.png` and holds GPU resources (textures/framebuffers) for the card's lifetime. Browsers cap **active WebGL contexts (~16 in Chrome)**; exceeding it drops the oldest with warnings and thrashes the GPU.

Implication: 1–6 institutions (the common case) = fine, all-Liquid. Heavy users (8–16+ institutions) risk the context ceiling.

**Recommendation (two layers, both reuse existing gating):**
1. **Capability gate (already exists):** `useAtlasLiquid()` returns false on no-WebGL / `prefers-reduced-transparency` / SSR → `DataCard`. Keep.
2. **Count cap (new, tiny):** cap the number of Liquid cards, e.g. `LIQUID_CAP = 6`, prioritizing importing cards, then the first ready cards; everything beyond the cap uses the `DataCard` (glass) fallback — same family, no context. The list computes an `allowLiquid` boolean per card; the card renders Liquid only when `useAtlasLiquid() && allowLiquid`.

No shared-canvas trickery, no new primitive — just "don't mount more than N renderers."

## 4. Removing balances without touching Accounts (Q4) — trivial and isolated.

Balances appear only in `ConnectionCard`'s `AccountsList` via `fmtBalance`. Removing them is local to the Connections components:
- Stop rendering the balance span in `AccountsList` (account **names only**).
- Drop `balance`/`currency` from the `AccountLite` type and from the `page.tsx` mapping so **no balance data even reaches the client** on this route.
- `getAccounts` and the Accounts page are **untouched** — this only changes what the Connections page selects into its own view model.

## 5. Is there enough data without balances? (Q5) — Yes.

Already available on the page today (no API/schema change):
- **Account names + count** — `getAccounts` grouped by institution (`accountsByInstitution`).
- **State** (importing/ready/needs_reauth/error) — from `buildSyncStatus` (`cursor`-derived).
- **`lastSyncedAt`** — on `SyncConnection`.
- **Provider/source type** — `SyncConnection.provider` ("PLAID").
- **Reconnect target** — `connection.id` (PlaidItem id) for `ReconnectAccountButton`.

Nothing else is needed for the canonical card.

## 6. Exact content per state (Q6) — provider-aware, one evolving card

**Core principle (reaffirmed by product direction):** the `ConnectionCard` is the product unit. Importing / ready / error are **state transitions of the same card**, not different cards. The visual shell (Liquid/Glass, hierarchy, spacing, typography) is **constant**; only the inner content evolves: Building → Connected → Synced → Needs Attention. The card feels like it matures over time, never like it's replaced.

**Provider is part of identity, not hidden implementation.** Every card states **where the data came from** using provider-aware language, not just when it synced. `SyncConnection.provider` is already present (`"PLAID"` today), so this needs only a small display map — see §6a. Verb + label vary by provider type and scale naturally:

- Plaid → "via Plaid" · Coinbase → "via Coinbase" · Schwab → "via Schwab API" · CSV → "Imported via CSV" · Hardware wallet → "Connected via Hardware Wallet" · QuickBooks → "Imported via QuickBooks".

**Shared shell (all states):** `liquid ? AtlasLiquidCard : DataCard`, Brief geometry (`relative z-10 px-6 md:px-8 py-6 md:py-7`), flagship `min-h`, eyebrow + institution heading. **No dollar amounts anywhere. Account names only.**

- **importing** (Building)
  - Eyebrow: "Building your profile"; institution heading.
  - Provider line: **"Connected via Plaid"**.
  - Stage stepper (unchanged): Institution connected · Accounts discovered (N) · Balances imported · **Transaction history importing…** · Ready.
  - Forward markers: Timeline / Daily Brief / AI — "ready next" (never ✓).
  - Discovered **account names**.
- **ready** (Connected → Synced)
  - Eyebrow: institution heading.
  - Status: **"Connected"**; provider line **"Synced via Plaid"**; **"Last synced: Jul 4 • 11:35 PM"**.
  - Inventory: "N accounts"; **account names** (no balances).
  - Honest status row: **"Transaction history imported ✓"** (true — cursor is set at ready). *Daily Brief / AI rows OPTIONAL and only if honestly derivable — see §8.*
- **needs_reauth** (Needs Attention)
  - Same shell; status **"Needs reauthentication"**; provider line **"Previously synced via Plaid"**; **"Reconnect required"** + `ReconnectAccountButton` (existing); account names. No balances.
- **error** (Needs Attention)
  - Same shell; status **"Sync error"** (+ `errorCode` if present); provider line **"Previously synced via Plaid"**; "we'll keep retrying"; account names. No balances. (Glass fallback may use `DataCard accent="negative"`.)

### 6a. Provider label map (provider-agnostic, no API change)

A tiny pure helper maps `SyncProvider → { name, verb }`, e.g. `PLAID → { name: "Plaid", verb: "Synced via" }`, with entries stubbed for future providers (Coinbase/Schwab/CSV/Wallet/QuickBooks) so adding a provider is a one-line map entry, not a card rewrite. The card composes the provider line from `state` + this map: importing → "Connected via {name}", ready → "Synced via {name}", needs_reauth/error → "Previously synced via {name}". Lives as a small const (in `ConnectionCard` or alongside `SyncProvider` in `lib/sync/status.ts` — a display map, not an API change).

## 7. Files affected (Q7)

| File | Change | Type |
|------|--------|------|
| `components/connections/ConnectionCard.tsx` | Unify shell (all states → `liquid && allowLiquid ? AtlasLiquidCard : DataCard`); state-specific **provider-aware** content per §6; provider label map (§6a); **remove balances** (names only); add ready status rows; accept an `allowLiquid` prop; **remove the TEMP `[D2x-debug]` log**. | Edit |
| `lib/sync/status.ts` (optional) | Optionally house the `SyncProvider → {name,verb}` display map next to `SyncProvider` (pure const; not an API change). Otherwise inline in the card. | Optional edit |
| `components/connections/ConnectionsList.tsx` | Compute `allowLiquid` per card (importing first, then ready up to `LIQUID_CAP`); pass to each `ConnectionCard`; **remove the TEMP `[D2x-debug]` log**. | Edit |
| `app/(shell)/dashboard/connections/page.tsx` | Drop `balance`/`currency` from the `accountsByInstitution` mapping (view-model only; not the Accounts page). | Edit (small) |
| `AtlasLiquidCard`, `useAtlasLiquid`, `DataCard`, vendored material | **None.** | None |
| API / `/api/sync/status` / `lib/sync/status.ts` / schema / sync engine / Accounts page / PlaidContext | **None.** | None |

## 8. One decision for approval

- **Daily Brief / AI status rows on the ready card:** we have **no cheap honest signal** that those surfaces are actually "ready" (they depend on multi-day snapshot history — the Snapshot Backfill / Ambient Intelligence tracks). **Recommend:** on the ready card show only **"Transaction history imported ✓"** (verifiable), and either omit Brief/AI rows or keep them as forward-looking "preparing" markers — never a fake ✓. Confirm which.

## 9. Smallest implementation checklist (for approval)

1. **Remove** the two temporary `[D2x-debug]` console logs (ConnectionCard, ConnectionsList).
2. **`AccountLite` + `AccountsList`:** drop `balance`/`currency`; render account **names only** (optionally a small type/icon). Update `page.tsx` mapping to stop selecting balance/currency.
3. **Unify the shell in `ConnectionCard`:** one render path — `const canLiquid = useAtlasLiquid() && allowLiquid;` → `canLiquid ? <AtlasLiquidCard ariaLabel=…><div className="relative z-10 px-6 md:px-8 py-6 md:py-7">{content}</div></AtlasLiquidCard> : <DataCard>{content}</DataCard>`. Same shell for importing / ready / needs_reauth / error.
4. **State-specific, provider-aware content** per §6: add the provider label map (§6a) and compose the provider line ("Connected via Plaid" / "Synced via Plaid" / "Previously synced via Plaid") from `state` + `connection.provider`. Reuse the existing eyebrow/heading/stepper for importing; add the ready status rows (honest per §8). Keep flagship `min-h` on all states so the family reads consistently.
5. **Performance cap:** add `LIQUID_CAP` (propose 6) in `ConnectionsList`; compute `allowLiquid` (importing prioritized, then ready by index) and pass to each card.
6. No API/schema/sync/engine/Accounts/PlaidContext changes; no provider picker; no percentages; no balances.

## 10. Validation plan (Q9)

- `npx tsc --noEmit` — 0 source errors.
- `npm run lint` — no new errors in scoped files.
- Visual: `/dashboard/connections?atlasLiquid=1` — every card (importing **and** ready) renders the same Liquid family; `?atlasLiquid=0` — all fall back to `DataCard` cleanly; no dollar amounts in any state; account names present.
- Performance: with >`LIQUID_CAP` connections, confirm only `LIQUID_CAP` WebGL contexts mount (cards beyond use `DataCard`); no "too many active WebGL contexts" warning.
- State coverage: force `importing` (clear a `cursor`), `ready`, `needs_reauth`, `error` — each renders the canonical card with correct content and no balances.
- `git diff` limited to the three scoped files.

**Rollback:** additive/presentational — revert the commit; no data/engine/schema impact. Removing balances is display-only; the Accounts page still shows them.

**Stop — investigation/checklist only. Await approval (incl. the §8 decision) before implementation.**
