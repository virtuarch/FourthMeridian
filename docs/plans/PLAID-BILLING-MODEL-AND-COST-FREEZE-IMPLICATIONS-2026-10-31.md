# Plaid billing model and Cost Freeze implications (2026-10-31)

> **Status (added at commit, 2026-10-31):** the owner ruled "investigate before proposing any disconnection", and nothing was disconnected. The gating it recommends (refuse paths that start a subscription while frozen; refuse repairs; never disconnect) shipped in #169 (`bc2e8ae`).

**Owner question.** "Investigate Plaid's actual billing model. Do not assume stopping synchronization eliminates account-level fees. Report the implications before proposing disconnections."

**Scope.** Web research on Plaid's official pages plus a read-only look at the repo (main worktree, branch `v2.6` at the time of reading). No code changed, no commits, no Plaid API calls, no Production access. This document **proposes no disconnections**. §4 lists options and their trade-offs only.

**Authority.** Plaid's public docs describe the billing *model*. The prices, minimums and any deviations from the public terms are in the owner's Plaid agreement and invoices. Plaid says as much on the billing page. Nothing below overrides the contract. Items marked **UNVERIFIED** could not be confirmed from an official Plaid source.

---

## 0. Answer in one paragraph

Fourth Meridian's Plaid cost comes from **monthly subscriptions per Item** (Transactions, and Investments where it has been started). **API calls do not drive it.** Plaid charges a subscription for every UTC calendar month in which the Item holds a valid access token. That holds "even if no API calls are made for the Item", and it holds while the Item is in an error state such as `ITEM_LOGIN_REQUIRED`. Partial months are not prorated. Only two things end the subscription: `/item/remove`, or the end user depermissioning the Item through my.plaid.com. Plaid says "it is not possible to end the subscription and leave the Item in place." **So a Cost Freeze that stops syncs saves $0 on the Plaid subscriptions of Items that already exist.** It can still prevent *new* Plaid charges: new Items, Investments subscriptions starting for the first time on consented Items, and duplicate Items. It also stops the non-Plaid costs (OpenAI, crypto and price providers, compute).

---

## 1. What the app actually uses (repo evidence, read-only)

| Plaid surface | Where | Billing class (§2) |
|---|---|---|
| `products: [Transactions]` on every fresh Link, `transactions.days_requested: 730` | `app/api/plaid/link-token/route.ts:183,268` | Subscription. Starts when Link creates the Item |
| `additional_consented_products: [Investments]` (fresh Link always; update mode only when explicitly requested) | `link-token/route.ts:193-206,251` | Consent only. Billed once the Investments endpoint is first called |
| `/transactions/sync` | `lib/plaid/syncTransactions.ts:211,420`, `lib/plaid/exchangeToken.ts:661` | Included in the Transactions subscription |
| `/investments/holdings/get` | `lib/plaid/sync-investments.ts:131` | Starts the Investments **Holdings** subscription |
| `/investments/transactions/get` (gated by `investmentEventsEnabled()`) | `lib/investments/investment-event-ingest.ts:274`, called from `sync-investments.ts:210` | Starts the Investments **Transactions** *and* **Holdings** subscriptions |
| `/accounts/get` | 3 call sites (refresh, exchange, build-intelligence) | Free |
| `/item/public_token/exchange`, `/link/token/create`, `/item/remove`, `/webhook_verification_key/get` | exchange-token, link-token, `lib/plaid/disconnect.ts`, `lib/account-deletion/purge.ts`, webhook verify | Free (Item / Link / management) |
| **Not used:** `/accounts/balance/get`, `/transactions/refresh`, `/investments/refresh`, Liabilities, Identity, Auth | zero call sites (`grep` over `lib/`, `app/`) | (would be per-request or one-time if added) |
| Webhooks handled: `TRANSACTIONS/{SYNC_UPDATES_AVAILABLE, HISTORICAL_UPDATE, INITIAL_UPDATE, DEFAULT_UPDATE}`, `HOLDINGS/DEFAULT_UPDATE` → sync. Everything else (`ITEM/ERROR`, `PENDING_EXPIRATION`, `USER_PERMISSION_REVOKED`, …) is recorded as ACKNOWLEDGED. Non-ACTIVE Items are REFUSED_ITEM_STATUS. | `lib/plaid/webhook-receiver.ts:46-99` | Webhooks are not billed. Receiving or refusing them changes no fee |

The repo already models this correctly. `lib/usage/pricing.ts:89-133` and `lib/platform/plaid/item-months.ts` price Plaid per **Item × product × billing cycle**, never per call. They use rates derived from invoice `S-J7Y5657ZK0-2607` (July 2026): Transactions **$0.30 / Item-month** (40 Item-months = $12.00), Investments **$0.35 / Item-month**. The Investments rate was derived by subtraction. These figures are **repo-recorded evidence from the owner's invoice**, not public Plaid prices. Whether the July "Investments" line combines Holdings and Transactions or itemises them is **UNVERIFIED** (the invoice itself is the authority).

---

## 2. Plaid's billing model, per product (official sources)

Primary source: **Plaid docs, "Plaid pricing and billing"**, https://plaid.com/docs/account/billing/

| Product (as used here) | Billing type | Starts | Stops | Calls / webhooks change the fee? |
|---|---|---|---|---|
| **Transactions** (incl. `/transactions/sync`) | Monthly subscription per Item | When the product is added to the Item. For a product in `products`, that is Item creation at Link | `/item/remove`, or end-user depermission via my.plaid.com | **No.** Billed "even if no API calls are made for the Item" |
| **Investments Holdings** | Monthly subscription per Item | `/investments/holdings/get` (or Investments listed in `products` at Link) | same | No |
| **Investments Transactions** | Monthly subscription per Item | `/investments/transactions/get`, which "adds both" the Transactions and Holdings subscriptions | same | No |
| Transactions Refresh / Investments Refresh | Per successful request | each call | — | Yes, per call (app has **0** call sites) |
| Balance (`/accounts/balance/get`) | Per successful request | — | — | not used |
| Liabilities | Monthly subscription | — | — | not used |
| Auth, Identity | One-time per Item | — | — | not used |
| `/accounts/get`, Item and Institutions endpoints | Free | — | — | — |

### 2.1 Lifecycle facts (all from https://plaid.com/docs/account/billing/ unless noted)

- **Calendar month, no proration.** Billing runs on UTC calendar months. "Fees for Items created or removed in the middle of the month are not pro-rated." An Item that exists on any day of a month costs that whole month.
- **No calls still means a charge.** The subscription is charged "even if no API calls are made for the Item." That includes the case where calls *cannot* succeed because the Item is in an error state. **`ITEM_LOGIN_REQUIRED` / NEEDS_REAUTH / ERROR Items are still billed.**
- **Only removal ends it.** "It is not possible to end the subscription and leave the Item in place." `/item/remove` ends it. So does end-user depermission via my.plaid.com. A revocation made at the bank's own portal may **not** end it, because not every institution notifies Plaid.
- **`/item/remove`** (https://plaid.com/docs/api/items/) invalidates the access token and any processor tokens. Plaid documents no undo, so treat removal as permanent. It is required to end billing for the subscription products. Plaid's docs advise starting bulk removals early enough to finish before the next billing month, allowing for rate limits.
- **Optional products are not billed until called.** Per the billing page, `optional_products` (Auth and Identity only) are not billed until their endpoint is called. Per the update-mode page (https://plaid.com/docs/link/update-mode/), products added through `additional_consented_products` "will only be billed once the related API endpoints are called." For this app, Investments consent alone costs nothing until `/investments/holdings/get` or `/investments/transactions/get` runs.
- **Update mode** (https://plaid.com/docs/link/update-mode/) reuses the Item: "An Item's `access_token` does not change." It creates no new Item and no new subscription. Plaid does not explicitly say whether update mode itself is billed (**UNVERIFIED**). Nothing in the billing model suggests a charge.
- **Re-linking through fresh Link creates a new Item** (https://plaid.com/docs/link/duplicate-items/). Duplicate Items "may cause you to be charged multiple times for the same Item." The new Item gets new `account_id`s: "the new `account_id` will be different from the old `account_id`" (https://plaid.com/docs/api/accounts/).
- **Sandbox** is free: "usage of Sandbox is always free."

### 2.2 Plans and free allowances

- **Docs billing page (current):**
  - **Trial** plan for new US/CA teams created on or after 2026-04-15: "You can create 10 Production Items on a Trial plan." Removing an Item does not free a slot, and subscription products begin billing on upgrade.
  - **Pay-as-you-go**: "No minimum spend or commitment."
  - **Growth**: minimum spend and an annual commitment, at lower unit rates.
  - **Custom/Scale**: higher minimum and annual commitment, at the lowest unit rates. "Minimums can apply across the entire Plaid account or by product."
  - Growth plan changes take effect only after the existing commitment period ends.
- **Marketing pricing page** (https://plaid.com/pricing/) still describes a "Free trial (Limited Production)" capped at 200 API calls per product, not a count of Items. **The two official pages disagree.** The docs billing page is the more specific and current one. Which applies to this team is **UNVERIFIED** and depends on when the team was created and on the contract.
- **Public price list: none.** Neither page publishes per-product dollar amounts. Prices are shown during the Production access request or set by sales.
- **This team's plan:** the July 2026 invoice shows paid Production Items, so the team is past any trial. Whether it is on Pay-as-you-go or Growth/Custom (and therefore whether a **minimum spend** applies) is **UNVERIFIED** and lives in the owner's contract. *This matters:* if a minimum applies and actual usage is below it, removing Items saves nothing until usage exceeds the minimum.

---

## 3. Implications for a Cost Freeze

### 3.1 Costs that stop when syncs stop

- **Plaid: none of the existing subscriptions.** `/transactions/sync` is included in the subscription, and `/accounts/get` is free. The app makes no per-request Plaid calls (no Balance, no Refresh). Skipping syncs or refusing webhooks saves **$0** in Plaid fees on existing Items.
- **Plaid charges that are prevented (not "stopped"), provided the freeze also gates the paths that start them** (see the enforcement audit, `docs/plans/BETA-COST-FREEZE-ENFORCEMENT-AUDIT-2026-10-31.md`, P2/P3):
  - **New Items.** `POST /api/plaid/exchange-token` (fresh Link) and the admin Expand-History exchange each create a new Item with the Transactions subscription.
  - **Investments subscriptions starting for the first time** on Items that have Investments consent but have never called `/investments/holdings/get` or `/investments/transactions/get`. Once either endpoint has been called on an Item, that Item's Investments subscription is already running, and skipping later calls saves nothing.
  - **Duplicate Items.** `lib/plaid/exchangeToken.ts:248-261` detects a duplicate *after* the exchange and best-effort removes it. Transactions is in `products`, so the duplicate's subscription has already started. Because there is no proration, that Item is billed for its creation month even though it was removed seconds later.
- **Non-Plaid costs stop:** OpenAI, Esplora/Alchemy/Solana RPC, CoinGecko/Tiingo, and Vercel/DB compute. Most of these are per-call.

### 3.2 Costs that continue while the Item exists

- Transactions subscription per Item per UTC month. Repo-evidenced rate: $0.30.
- Investments subscription(s) per Item per month, on Items where they were started. Repo-evidenced rate: $0.35.
- These are billed regardless of health. Items the app shows as **NEEDS_REAUTH / ERROR** (`ITEM_LOGIN_REQUIRED`, `PENDING_EXPIRATION`) are still billed.
- **App REVOKED ≠ removed at Plaid.** `disconnectPlaidItemIfOrphaned` (`lib/plaid/disconnect.ts`) marks an Item REVOKED even when `itemRemove` fails, and records `PLAID_ITEM_REVOCATION_UNCONFIRMED`. Each such Item **is still billed** until a provider cleanup confirms removal (Platform Ops provider-cleanup, `scripts/cleanup-orphaned-plaid-items.ts`). The repo already records "9 orphans, ~$2.70/mo" as a historical example.

### 3.3 What `/item/remove` does to this app's data (read-only code review)

The user-facing disconnect paths are `POST /api/connections/[id]/disconnect` and `DELETE /api/accounts/[id]`. Both go through `lib/accounts/disconnect.ts`, the "Model A — stop syncing, preserve history" path:

- **Data is kept.** `FinancialAccount` and `AccountConnection` are **soft-deleted**. SpaceAccountLinks are **revoked, not deleted**. Historical snapshots are untouched, and **transactions are not deleted**.
- **Plaid side.** `itemRemove` is called **only when the Item is orphaned** (zero live AccountConnections remain). The Item is then marked REVOKED and the access token is permanently gone.
- **Restore without a relink.** `POST /api/accounts/[id]/restore` revives soft-deleted rows. If the Item was removed at Plaid, the data comes back **read-only (stale)**: the restore "does NOT re-establish a revoked PlaidItem", so the user must relink to resume syncing.
- **Reconnect later = a NEW Item.** `exchange-token` and its fingerprint resolution (`exchangeToken.ts:432-462`) revive the same `FinancialAccount` rows, because Plaid issues new `account_id`s. Transactions dedupe on `plaidTransactionId` with a fingerprint fallback (`syncTransactions.ts:38-80`). Whether every re-delivered historical transaction folds onto the existing row across a *new* Item was not re-verified in this pass (**UNVERIFIED in code**). Cost consequences:
  - The new Item starts a new Transactions subscription for its whole creation month. If the old Item was billed in that same month, **that month is billed twice**.
  - The 730-day history re-pull does **not** add a per-call Plaid fee, because it is covered by the subscription. It does add compute and DB load, plus the duplicate-risk surface above.
  - Investments subscriptions restart on the first holdings or transactions call.
  - The user must go through Link again, and through OAuth for Chase, BoA and similar banks. That is beta friction, and some will not come back.
  - On a Trial plan, a removed Item still counts toward the 10-Item cap (not believed to apply to this team; see §2.2).
- **Account deletion** (`lib/account-deletion/purge.ts`) is a different path. It is destructive by design and is not part of any freeze.

### 3.4 What "pause without disconnect" can and cannot save

| | Can save | Cannot save |
|---|---|---|
| Plaid | New-Item subscriptions; first-time Investments subscriptions; duplicate-Item months; any future per-request product (Balance or Refresh, currently 0 call sites) | **Every existing Item's Transactions and Investments subscription, every month**, including Items that are broken, paused or REVOKED in the app but still live at Plaid |
| Other providers | OpenAI, crypto RPC and price APIs, compute: essentially all of it | — |
| Data | Keeps the Item and access token, so a resume is instant (one `/transactions/sync` catches up from the cursor) with no Link friction and no new `account_id`s | — |
| Side effects | — | Items may drift into `ITEM_LOGIN_REQUIRED` / `PENDING_EXPIRATION` while paused, which still costs money and needs an update-mode repair on resume. Plaid keeps preparing updates whether or not the app pulls them. |

**Order of magnitude (repo-evidenced rates, UNVERIFIED against the current contract).** A frozen beta user with 2 Transactions Items and 1 Investments Item costs about 2 × $0.30 + 1 × $0.35 = **$0.95/month** in Plaid subscriptions whether or not they are synced.

---

## 4. Options (trade-offs only, no recommendation to disconnect anyone)

1. **Freeze = pause syncs and AI only (status quo design).**
   - Saves: all per-call, non-Plaid spend.
   - Plaid subscription savings: $0.
   - Zero user friction, instant resume.
2. **Option 1 plus gating every Plaid charge-*starting* path under freeze.** These paths are fresh `exchange-token`, admin Expand-History exchange, the first `/investments/holdings/get` or `/investments/transactions/get` on an Item that has not yet started Investments, and the post-exchange duplicate path (move the duplicate check before the exchange where possible, or accept the cost).
   - Caps the frozen cohort's Plaid bill at its current Item count.
   - Trade-off: a frozen user cannot add or repair-into-new connections, and investments data for newly consented Items stays absent.
   - Update-mode repair of an existing Item is not a new charge, so it could be allowed.
3. **Clear the existing billing leak independent of the freeze.** Confirm removal at Plaid for Items the app already treats as REVOKED but whose latest marker is `REVOCATION_UNCONFIRMED`.
   - These Items are billed and deliver nothing.
   - This is not a disconnection: the user already disconnected them.
   - It is a Production action and the owner's call.
4. **User-initiated disconnect (the user's choice, not ours).**
   - Ends the subscription from the **next** UTC month, so removing Items mid-month saves nothing in the current month.
   - History is preserved in-app (soft-delete).
   - Reconnecting creates a new Item: possible double-billed month, new `account_id`s, Link/OAuth friction, history re-pull.
   - Not proposed here.
5. **Contract lever.**
   - If the plan has a minimum spend (Growth/Custom), removing Items below the minimum saves nothing. Check the contract before weighing any Item removal.
   - If the plan is Pay-as-you-go, savings are linear in Item-months.
   - Either way, the invoice is the authority for rates (the repo rates come from one invoice cycle).
6. **Measure before deciding.**
   - `lib/platform/plaid/item-months.ts` already derives Item-months per product and cycle.
   - Scoping it to the frozen cohort gives the exact monthly exposure (Option 1 vs Option 4) without any provider call.

---

## 5. UNVERIFIED / owner-held

- Contract plan type, unit prices, minimums, and whether the team is affected by the 2026-04-15 Trial terms. These are in the owner's Plaid agreement and invoices.
- Whether update mode itself incurs any charge. The docs are silent; the model implies no charge.
- Whether the July invoice's "Investments" line combines the Holdings and Transactions subscriptions.
- Whether end-user depermissioning at a bank portal (not my.plaid.com) ends billing for a given institution. Plaid says it may not.
- Cross-Item transaction dedupe on reconnect (code path not re-verified in this pass).
- The pricing page and the docs disagree on the free tier ("200 API calls per product" vs "10 Production Items").

## Sources

- https://plaid.com/docs/account/billing/: billing models, subscription start and stop, no proration, error-state billing, Trial/PAYG/Growth/Custom, Sandbox free
- https://plaid.com/docs/api/items/: `/item/remove` ends subscription billing and invalidates the token
- https://plaid.com/docs/link/update-mode/: same access token; added consented products billed only on first endpoint call
- https://plaid.com/docs/link/duplicate-items/: duplicate Items may be charged multiple times
- https://plaid.com/docs/api/accounts/: `account_id` changes when an Item is re-created
- https://plaid.com/docs/transactions/ and https://plaid.com/docs/investments/: subscription model; Refresh endpoints per request
- https://plaid.com/pricing/: plan tiers; no public per-product prices
