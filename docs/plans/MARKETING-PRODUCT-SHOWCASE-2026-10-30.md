# Marketing website — product showcase pass (2026-10-30)

Scope: `site/` (fourthmeridian.com, static export) and a capture harness under
`scripts/marketing-showcase/`. No application behaviour, schema, auth, provider,
worker or Platform Space code changed.

## 1. Section inventory — before → after

| # | Section (id) | Before | After |
|---|---|---|---|
| 1 | Hero | Earth image, headline, CTA, "One financial context" glass card | Unchanged; CTA now scrolls to §2 |
| 2 | **Your Personal Space** (`#personal-space`) | — | NEW. Net Worth loop: *Last 12 months* → *Last 90 days* (period picker is the story) |
| 3 | Philosophy | Text + 3-step diagram | Unchanged |
| 4 | How it works (`#product`) | Abstract "4M" orbit + 6-item list | Connections page capture: 3 Plaid connections, a watch-only Bitcoin wallet, a home valued by its owner. Copy names the connection types precisely |
| 5 | **Cash Flow** (`#cash-flow`) | — | NEW. Loop: *Cash in & out* (month, net-by-day calendar) → *Spending* (90 days, spending heat map) |
| 6 | Daily Brief | Labelled illustrative card | Unchanged (see §8) |
| 7 | Spaces | 3 text cards | Unchanged |
| 8 | Conversations (`#vision`) | Abstract "Context" rings | Loop: question (thinking) → answer from the household's own figures; labelled as an example |
| 9 | About, CTA | — | Unchanged |

No visual is used twice: Net Worth appears only in §2, Connections only in §4.

## 2. Source of every frame

All 14 WebP frames in `site/public/showcase/` are screenshots of the
application's **real React components** rendered by the app's own engines over a
**synthetic household** (`scripts/marketing-showcase/fixture.ts`, seeded PRNG,
fixed date 2026-10-15, invented institution/merchant names, no addresses):

| Frames | Components | Engine |
|---|---|---|
| net-worth-* | `PerspectiveShell`, `WealthHero`, `WealthTrendChart` | `computeWealthTimeMachine` over 400 synthetic snapshots |
| cash-flow-month*, spending-quarter* | `PerspectiveShell`, full `CashFlowWorkspace` (view cashFlow / spending) | `buildCashFlowSpaceData` over 6 months of synthetic transactions |
| conversation-* | `AiShell`, `ConversationView`, `Composer` | Answer wording is an example; every figure in it is read from the same `computeWealthTimeMachine` result |
| connections* | Full `ConnectionsList` (inert router context) | `summarizeConnection` / real-assets core |

Reproduce: `node scripts/marketing-showcase/build.mts && node scripts/marketing-showcase/capture.mts`
(Node 24, repo root; headless Chrome over CDP, no Playwright). Verified
deterministic: a second run produced 14/14 byte-identical files. No database,
session, network or provider is touched; `ConnectionsActions` (loads Plaid Link
from Plaid's CDN) is deliberately not rendered.

Crops: the Spending frame hides `#spending-distribution` and `#spending-insights`
(display:none at capture time) — see the limitation in §7.

## 3. Presentation

`site/components/ProductShowcase.tsx` (client island, no dependencies): stacked
`<picture>` frames (mobile crop ≤600px) in one fixed-aspect box; cross-fade
700ms; advances every 4.2s only while ≥35% on screen and the tab is visible;
holds while pointer/focus is inside; Pause/Play button; step buttons (44px
targets, `aria-pressed`) with a progress bar; under `prefers-reduced-motion`
never auto-advances and hides Pause. Every window carries a
"Product UI · demo data" badge. `loading="lazy"`, explicit width/height.

## 4. Desktop/mobile verification (local static export, headless Chrome)

Widths 375 / 390 / 430 / 768 / 1280 / 1440, plus reduced-motion at 390 and 1280:

- horizontal overflow: none (scrollWidth == viewport at every width)
- CLS: 0 at every width
- images: 7/7 loaded per viewport; ≤600px loads only `-m` crops, ≥601px only desktop
- loop: advanced after one interval normally; did **not** advance under reduced motion
- console: only 6 prefetch 404s from the local test server, identical on the develop baseline (not served that way by Vercel)
- before/after full-page screenshots: `tmp/marketing-showcase/evidence/` in the worktree (gitignored)

## 5. Asset sizes

14 frames, 632 KB total on disk. Per visitor: desktop ≈ 360 KB, mobile ≈ 270 KB,
all below the fold and lazy-loaded. Hero image and above-the-fold payload unchanged.
Largest single frame 75 KB. JS: one small island (no new packages).

## 6. Product-claim review

| Claim | Basis |
|---|---|
| Period choices "last 90 days, the year so far, the last twelve months" | `PERIOD_OPTIONS` (PAST_QUARTER, YTD, PAST_YEAR) |
| Bank, card, loan and investment accounts through Plaid | Plaid provider; investments capability on `SyncConnection` |
| Self-custody wallets by public address, watch-only | Wallet connections are address-based; row reads "Holdings current", never a history-completeness claim |
| Real assets valued by the owner | `MANUAL_ASSET_SOURCE_LABEL = "Valued by you"` |
| "In Spending, a card purchase counts once…" | Spending hero copy: "card payments aren't counted again" |
| Conversation | Labelled example; figures computed; the app's own disclaimer line is visible in the frame |

Not claimed: complete crypto/token history, reconstruction, Business/Property Spaces.

## 7. Product limitation found (documented, not changed)

**Spending "Where it went": donut colours disagree with the list.** The donut
colours categories with `assignStableColors` (`components/space/widgets/cashflow/spending-distribution.ts:48`),
the category ledger beneath it with an index palette
(`CashFlowCategoryLedger.tsx:125`), so e.g. Groceries is pink in the ring and
blue in the list. Reproduced with the demo data; it applies to the live app.
The marketing frame omits that block until it is fixed.

## 8. Remaining marketing polish (not done — scope stop)

- Daily Brief section still uses the hand-made illustrative card; a real Brief capture would fit the pattern.
- Open Graph image could use a product frame.
- Optional hover-tooltip frame for the Net Worth chart (harness supports interactions; dropped for simplicity).
