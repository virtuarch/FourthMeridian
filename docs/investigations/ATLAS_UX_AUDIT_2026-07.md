# Atlas UX Audit — First-Time-User Walkthrough

**Date:** 2026-07-03
**Scope:** Investigation only. No implementation, no schema, no code changes.
**Method:** Code-level walkthrough of the Atlas UI layer (`app/`, `components/`) tracing runtime interaction behavior — routing, scroll, overlays, loading, feedback, and AI latency. Findings are grouped into implementation families; each cites the source that establishes it.
**Frame:** "Every interaction that feels broken even if it technically works." Nothing here is a crash; all of it is friction a first-time user would feel.

---

## Walkthrough path

Root (`app/page.tsx`) redirects every entry to `/dashboard/brief`, so a first-time user lands on the **Daily Brief**, then moves through the Sidebar/BottomNav into Spaces, a Space dashboard, Banking, Investments, Debt, Credit, AI (Analyze), Advice, and Settings. The chrome is `DashboardChrome` (sticky glass headers + Sidebar + BottomNav); overlays are a mix of the canonical Atlas `OverlaySurface` and several legacy inline modals. The observations below follow that path but are organized by the underlying implementation concern, since most issues recur across screens.

---

## Family A — Overlay & Modal System (split-brain)

This is the single largest cluster. The codebase is **mid-migration**: a canonical overlay primitive exists and is documented (`components/atlas/OverlaySurface.tsx`, `docs/design-system/ATLAS_GLASS_MODAL_DOCTRINE.md`), several modals have moved onto it, and a comparable number have **not** — so the same defect classes the doctrine says it fixed are still live in the un-migrated surfaces.

**Migrated (correct behavior):** `AccountModal`, `AddWalletModal`, `AddManualAssetModal`, `CreateSpaceModal`, `ManageSpaceModal`, `RemoveAccountModal`, `TotpSection`, `SpaceDashboard` (partial).

**Still legacy inline `fixed inset-0` overlays:** `charts/NetWorthChartModal.tsx`, `dashboard/AssetDrawer.tsx`, `dashboard/AdviceBanner.tsx`, `dashboard/widgets/GlassModal.tsx` (still consumed by `DashboardClient`, `SpaceDashboard`, `widgets/TimelineModal`), `space/sections/DebtPayoffSection.tsx`, `admin/ProviderDiagnosticsDrawer.tsx`, `app/admin/security/page.tsx`.

What feels broken in the legacy set:

- **Modal position can anchor to a card instead of the viewport.** `NetWorthChartModal.tsx:118` and `AssetDrawer.tsx:46` use inline `fixed inset-0` *without portaling to `document.body`*. `OverlaySurface`'s own header comment documents exactly this: a `position: fixed` overlay resolves against the nearest ancestor with `transform`/`backdrop-filter` as its containing block, and glass panels (backdrop-filter) are pervasive — so a non-portaled modal lands relative to a glass card, not the screen. This is the "Add Wallet opens pinned to the top" defect, still reproducible in the un-migrated modals.
- **Background jumps to top / scrolls behind the modal on open.** The canonical path uses `useBodyScrollLock` (`components/atlas/useBodyScrollLock.ts`), which saves and restores `window.scrollY` precisely because the app's `min-h-full flex flex-col` body collapses to viewport height when overflow is hidden, forcing `scrollY` to 0. Legacy overlays don't use that hook — only `DebtPayoffSection.tsx` hand-rolls its own lock; the rest lock nothing, so the page scrolls underneath the modal, and any that do a naive overflow toggle jump the page to the top.
- **Hardcoded z-index ladder competing with the token system.** Overlays hardcode `z-[100]` (×10), `z-[9999]` (×3), `z-[200]` (×2), `z-[110]` (×2), `z-[150]`, `z-[1]` — instead of the `--z-modal*` tokens `OverlaySurface` reads from `globals.css`. A modal-over-modal (e.g. an add flow opened from another overlay) can land under its own scrim; the primitive already needed an explicit `zIndex` escape hatch to sit above the "still-legacy CreateSpaceModal at z-[200]" (documented in `OverlaySurface.tsx`).
- **Inconsistent dismissal contract.** Migrated modals get Escape-to-close, guarded backdrop click, focus trap, and focus restore for free. Legacy inline modals implement these ad hoc or not at all, so keyboard/focus behavior varies per surface.

The doctrine intended `Drawer` (edge-anchored) as a future variant; `AssetDrawer` and `ProviderDiagnosticsDrawer` are drawers built inline in the meantime, which is why they diverge most.

## Family B — Route-level Loading & Error transitions

- **No route-segment loading states anywhere.** There are zero `loading.tsx` files in `app/`. Dashboard tabs are `async` server components that `await` data (e.g. `advice/page.tsx` awaits `getLatestAdvice()`; the shell pages await Prisma reads). With no `loading.tsx` and no global navigation indicator, clicking a Sidebar/BottomNav item produces **no visible response until the server component resolves** — the old screen just sits there, then swaps. First-time users read that as a dead click.
- **No error boundaries.** Zero `error.tsx` and zero `not-found.tsx`. Any thrown server error or bad route falls through to Next.js's default unstyled error page — no branded Atlas empty/error surface, breaking continuity.
- **No global route-transition progress.** No `nprogress`/`useLinkStatus` anywhere; `usePathname` is only used for active-state styling. Nothing bridges the gap between click and paint on server-rendered navigations.
- **Suspense is used sparingly and only for `useSearchParams` boundaries** (`login`, `reset-password`, `brief`, `dashboard`, `SettingsClient`, `SpacesClient`), not for data streaming — so it doesn't cover the navigation-wait gap above.

## Family C — Asynchronous feedback & optimistic state

- **Success fires before the data actually updates.** `RefreshButton.tsx` sets status `"done"` ("Synced" + green check) *immediately after* the `fetch` resolves, then calls `router.refresh()`. But `router.refresh()` is an async server re-fetch — the balances/holdings on screen are still the old ones for the duration of that refetch, while the button already says "Synced." There's no pending state covering the re-render, and the check resets on a fixed `setTimeout(2500)` regardless of whether the refresh finished.
- **No shared toast/notification system.** No `sonner`/toast library. Confirmation feedback is bespoke and rare: `SpacesClient.tsx:772–881` hand-rolls a one-shot "You left {space}" banner off a URL param with a `setTimeout(3500)` dismiss. Most mutations across the app confirm *only* by `router.refresh()` re-rendering — a silent data swap with no explicit "saved"/"done" acknowledgement. `router.refresh()` is called from ~15 call sites this way.
- **Uneven action-button states.** `RefreshButton` and the Sidebar space-switch row (`Sidebar.tsx:152` `setSwitching`) show inline spinners; many other mutating controls rely on the silent refresh, so the perceived responsiveness of "did my click work?" varies screen to screen.

## Family D — AI latency experience

- **No streaming, anywhere.** No `ReadableStream`/`getReader`/`text/event-stream`/`EventSource`/`streamText` in the codebase. The Analyze chat (`AnalyzeClient.tsx sendMessage`) does a single `fetch('/api/ai/chat')` and `await res.json()` for the *entire* completion, then renders it at once. For a finance assistant that reviews accounts and knowledge gaps, that's a multi-second wait represented only by three bouncing dots (`AnalyzeClient.tsx:494–503`). No partial tokens, no progress, no "reviewing your accounts…" staging — just a typing indicator that runs the full generation.
- **Advice freshness is faked with static copy.** `advice/page.tsx` hardcodes "Next advice run: **Today at 4:00 PM**" and "Runs 2× daily" as literal strings under a pulsing dot. These don't reflect the actual scheduler state, so the "live" indicator can be wrong.
- **Brief generation is a client fetch behind a skeleton** (see Family E) — the AI-heavy landing screen re-fetches every visit rather than arriving with content.

## Family E — Scroll & focus continuity

- **Deep-link scroll relies on a magic delay.** `BankingClient.tsx:107` and `InvestmentsClient.tsx:321` scroll a preselected account into view via `setTimeout(120ms)` → `scrollIntoView({behavior:"smooth"})`, in a mount-only effect (`[]`, eslint-disabled). If layout/data isn't settled in 120ms the target is wrong or missed; the smooth animation also means arriving at a deep link visibly slides the page rather than starting there.
- **Chat auto-scroll animates on every message mutation.** `AnalyzeClient.tsx:158` runs `scrollIntoView({behavior:"smooth"})` on `[messages]`, which also fires when the loading indicator mounts/unmounts — smooth-scroll jank on each turn instead of a settled pin-to-bottom.
- **scrollY preservation is only as good as the migration.** The precise save/restore lives in `useBodyScrollLock`, so opening a *migrated* modal is jump-free but opening a *legacy* one is not (Family A) — the continuity is inconsistent depending on which modal you happen to open.

## Family F — First-run / empty states

- **The Brief has a real first-run state** (`brief/BriefNewUser.tsx`, `visitState === "new_user"`), which is good — but it's the exception.
- **No shared empty-state primitive.** Empty conditions are handled inline and per-component across many surfaces (`DashboardClient`, `BankingClient`, `InvestmentsClient`, `DebtClient`, `RecentTransactionsPanel`, the Space widgets, etc.), so tone, iconography, and whether an empty state even exists vary by screen. A first-time user with no linked accounts will see different "nothing here" treatments (or bare zeros) as they move between tabs.

## Family G — Progressive disclosure & reveal timing

- **The landing screen is always a client fetch + staged reveal.** `DailyBriefClient.tsx` mounts with `loading=true` → renders `BriefSkeleton`, `fetch('/api/brief')`, then on data does `setTimeout(50ms)` → `setVisible(true)` to trigger a CSS stagger fade-in. So the home screen never arrives SSR'd with content; every visit is skeleton → 50ms delay → pop-in, even on repeat visits where the brief may be unchanged. The stagger is a nice touch but the whole surface is gated behind a client round-trip.
- **Collapse/expand state is local and non-persistent.** Institution collapse (`BankingClient` `collapsed`), holdings expansion (`InvestmentsClient` `holdingsExpanded`), etc. are `useState`, reset on every navigation/refresh — a user who collapses a section returns to find it re-expanded.

## Family H — Repo hygiene (not user-facing, but noise in the audit surface)

- **21 `.fuse_hidden*` files** are committed under `components/` (dashboard, charts). These are FUSE filesystem tombstones from files edited while open — dead weight in the tree that also pollutes greps/reviews. Not a UX defect; flagged so it isn't mistaken for live code during any follow-up.

---

## Severity read (for triage, not a plan)

- **Highest perceived-breakage:** Family A (mispositioned/jumpy legacy modals — visible and jarring) and Family B (dead-feeling navigation with no loading/error states).
- **High:** Family C (success-before-truth on Refresh; no confirmation vocabulary) and Family D (AI waits with no streaming).
- **Medium:** Families E and G (scroll timing, always-client landing).
- **Low / polish:** Family F (empty-state consistency), Family H (cruft).

## What this audit did not cover

Live visual/timing behavior (real network latency, animation feel, keyboard/screen-reader runs, mobile sheet behavior on-device) — this was a static read of the source. A live browser spot-check of Families A, B, and D would confirm the felt severity. Admin surfaces (`app/admin/*`) were scanned only for shared patterns, not walked as a user flow.
