# D2.x — Connections Provider Actions Polish — Investigation + Checklist

**Status:** Investigation only. No implementation until approved.
**Goal:** Connections is the single entry point for all financial sources. Add a page-level action cluster (Connect institution + Add wallet) that (a) doesn't truncate at narrow width and (b) reads as an Atlas Liquid/Glass action belonging to the Liquid Connections page — reusing existing primitives only.

---

## 1. Current `ConnectAccountButton` (Q1)

`components/dashboard/ConnectAccountButton.tsx` — client; `usePlaid().openLink(onDone)`, surfaces `isLoading` ("Opening Plaid…") and `error`. Props: `variant?: "button" | "card" | "row"`, `onDone?`. Rendered by the Connections page today as `<ConnectAccountButton />` (header, default `button` = a `GlassButton`) and `<ConnectAccountButton variant="card" />` (empty state).

**Truncation cause (Q2/Q4):** the header is `flex items-center justify-between` with the title and the button competing on one row; at narrow width the button shrinks and "Connect Account" clips. It's a **layout** problem, not a label problem.

## 2. Add Wallet action today (Q2/Q3)

`components/dashboard/AddWalletModal.tsx` — a **self-contained** modal: `<AddWalletModal onClose onAdd? zIndex? />`, owns all fields, the `WalletChain` selection, and the `POST /api/accounts/wallet` call. It's opened everywhere by the same pattern (e.g. `UserButton.tsx`): a local `walletOpen` state + `{walletOpen && <AddWalletModal onClose={() => setWalletOpen(false)} />}`.

**So Add Wallet drops in with zero wallet-logic change** — render a button that flips `walletOpen`, and mount the existing modal. (Note: wallets are not `PlaidItem`s, so a wallet won't appear as a `ConnectionCard` yet — wallet-as-connection is future provider work and out of scope. Add Wallet here is the *entry action*; the wallet still shows on Accounts/Dashboard as today.)

## 3. Reusable action primitives (Q5/Q6)

- **`AtlasLiquidCta`** (`components/atlas/AtlasLiquidCta.tsx`) — first-class Liquid CTA (button-shaped). Supports `onClick` (button mode) and `fullWidth` (default true → `w-full sm:w-auto`, exactly the mobile-full/desktop-auto behavior we want). Does **not** self-gate; the caller picks Liquid vs Glass via `useAtlasLiquid()`.
- **`GlassButton`** (`components/atlas/GlassButton.tsx`) — Glass fallback; props `tone` (`meridian`/`neutral`), `size`, `fullWidth`, plus standard button attrs (`onClick`, `className`).
- **Established cluster pattern — `BriefHero`:** `const liquid = useAtlasLiquid(); return <div className="flex flex-col sm:flex-row gap-2.5">{ liquid ? <AtlasLiquidCta/> ×2 : <GlassButton/>-family ×2 }</div>`. This is exactly the responsive, primitive-reusing cluster we need — copy it.

No new primitive, no new material — the Liquid CTA already exists and is used this way in the Brief.

## 4. Making the action Liquid/Glass + non-truncating (Q4/Q6)

Reuse the BriefHero recipe verbatim:
- **Responsive container:** `flex flex-col gap-2.5 sm:flex-row` → on mobile the actions **stack full-width** (no truncation); on `sm+` they sit inline at content width.
- **Primary — Connect institution:** `AtlasLiquidCta` (Liquid) with `GlassButton tone="meridian"` fallback via `useAtlasLiquid()`; `fullWidth` so it's full on mobile / auto on desktop; label `whitespace-nowrap`.
- **Secondary — Add wallet:** same treatment (`AtlasLiquidCta` Liquid / `GlassButton tone="neutral"` fallback), or kept as Glass for hierarchy — see §8 decision.
- The header row itself becomes responsive: `flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between` so the title and the action cluster stack on mobile and split on desktop.

Truncation is solved structurally (full-width stack on mobile, auto width on desktop) — no icon-only fallback needed, though each CTA keeps its leading icon.

## 5. Performance / WebGL context budget (Q — carried from prior slice)

Each `AtlasLiquidCta`/`AtlasLiquidCard` mounts one WebGL context (browsers cap ~16). The Connections page already caps Liquid **cards** at `LIQUID_CAP = 6`. Adding the action cluster:
- Both actions Liquid → up to **6 + 2 = 8** contexts. Within budget, and matches BriefHero (2 Liquid CTAs).
- Conservative option: only the **primary** action Liquid, secondary as `GlassButton` → 7 max and a cleaner primary/secondary hierarchy.
Either is safe; see §8.

## 6. Files affected (Q7)

| File | Change | Type |
|------|--------|------|
| `components/connections/ConnectionsActions.tsx` | **New** client cluster: Connect institution (`usePlaid().openLink`) + Add wallet (`walletOpen` → existing `AddWalletModal`); `useAtlasLiquid()` picks `AtlasLiquidCta` vs `GlassButton`; responsive `flex-col sm:flex-row`; surfaces `usePlaid()` `isLoading`/`error`. | New |
| `app/(shell)/dashboard/connections/page.tsx` | Header → responsive stack; replace `<ConnectAccountButton />` with `<ConnectionsActions />`; empty state uses `<ConnectionsActions />` (centered) instead of `<ConnectAccountButton variant="card" />`. | Edit (small) |
| `ConnectAccountButton`, `AddWalletModal`, `AtlasLiquidCta`, `GlassButton`, `useAtlasLiquid`, wallet API, Plaid, schema | **None.** | None |

## 7. One decision for approval (Q8)

**Both actions Liquid, or primary-Liquid / secondary-Glass?**
- **Recommend: both `AtlasLiquidCta` (Liquid) with `GlassButton` fallback** — matches BriefHero exactly, gives the "single entry point" equal footing, stays within the context budget (8 ≤ 16).
- Alternative: primary Liquid + secondary `GlassButton neutral` (7 contexts, stronger hierarchy). Pick one.

Also confirm: on successful Add Wallet, `router.refresh()` the page (harmless — wallet won't yet render as a card) or just close the modal. Recommend a refresh for future-proofing.

## 8. Smallest implementation checklist

1. **New `components/connections/ConnectionsActions.tsx`** (`"use client"`):
   - `const { openLink, isLoading, error } = usePlaid();` `const liquid = useAtlasLiquid();` `const [walletOpen, setWalletOpen] = useState(false);` (`useRouter` if refreshing on add).
   - Container: `flex flex-col gap-2.5 sm:flex-row` (optionally `sm:justify-end`).
   - Connect institution: `liquid ? <AtlasLiquidCta onClick={() => openLink()} ariaLabel="Connect a bank or institution"> <Building2/> Connect institution </AtlasLiquidCta> : <GlassButton tone="meridian" fullWidth className="sm:w-auto" onClick={() => openLink()}> … </GlassButton>`; reflect `isLoading` ("Opening…").
   - Add wallet: same shape → `onClick={() => setWalletOpen(true)}`, label "Add wallet".
   - `{error && <p className="text-xs text-[var(--coral-400)]">{error}</p>}` under the cluster.
   - `{walletOpen && <AddWalletModal onClose={() => setWalletOpen(false)} onAdd={() => router.refresh()} />}` (onAdd optional per §7).
   - Labels `whitespace-nowrap`.
2. **`app/(shell)/dashboard/connections/page.tsx`:**
   - Header: `flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between`; keep the title block; replace the button with `<ConnectionsActions />`.
   - Empty state: replace `<ConnectAccountButton variant="card" />` with a centered `<ConnectionsActions />` (or keep the card + add the cluster — minimal is to use the cluster).
3. Leave `ConnectAccountButton`, `AddWalletModal`, wallet API, Plaid, and all Atlas primitives untouched.

**No schema / wallet-logic / Plaid-logic / provider-picker / new-primitive / new-effect changes.**

## 9. Validation plan (Q9)

- `npx tsc --noEmit` — 0 source errors.
- `npm run lint` — no new errors in scoped files.
- Visual:
  - `/dashboard/connections?atlasLiquid=1` — Connect institution + Add wallet render as Liquid CTAs matching the Brief hero CTAs, aligned with the Liquid cards.
  - `?atlasLiquid=0` — both fall back to `GlassButton` cleanly.
  - Narrow width (mobile) — actions **stack full-width**, no text truncation; desktop — inline at content width.
  - Add wallet opens the existing `AddWalletModal`; submitting still hits `/api/accounts/wallet` unchanged; Connect institution still opens Plaid Link and routes to `/dashboard/connections`.
  - Context budget: with 6 Liquid cards + the cluster, no "too many active WebGL contexts" warning.
- `git diff` limited to the two scoped files.

**Rollback:** additive/presentational — revert the commit; the new component and the two page-layout edits are self-contained. No data/logic impact.

**Stop — investigation/checklist only. Await approval (incl. §7 decisions) before implementation.**
