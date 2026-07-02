# Plaid Investments Consent Handling — Investigation & Minimal Implementation

**Date:** 2026-07-02
**Branch:** feature/phase-2-architecture
**Status:** Investigated → minimal implementation approved scope (this doc) → implemented

---

## 1. Problem

`refreshPlaidItem()` (lib/plaid/refresh.ts) calls `investmentsHoldingsGet` for every
PlaidItem that has at least one investment-type account. In Production this returns:

```
error_type:  ITEM_ERROR
error_code:  ADDITIONAL_CONSENT_REQUIRED
"client does not have user consent to access the PRODUCT_INVESTMENTS product"
```

The call fails on **every refresh**, and the catch block logs the entire AxiosError
(config, headers, request internals) — a giant dump for an expected condition.

## 2. Root cause

Link tokens are created with `products: [Products.Transactions]` **only**
(app/api/plaid/link-token/route.ts, intentional — AmEx and other credit-only
institutions reject link tokens that include `investments`). Under Plaid's Data
Transparency Messaging (DTM), the user consents only to the products requested at
Link time. So every Item linked this way has `consented_products = [transactions, …]`
**without** `investments`, and any `/investments/holdings/get` call is rejected with
`ADDITIONAL_CONSENT_REQUIRED`. This is expected behavior, not an application error.

## 3. Correct Plaid flow for adding Investments consent to an existing Item

Per Plaid docs (Update Mode, "How do I add a product to an existing Item?"):

1. Create a link token in **update mode**: `/link/token/create` with the Item's
   existing `access_token`, and the new product in **`additional_consented_products`**
   (NOT the `products` array — that is omitted in update mode):

   ```ts
   plaidClient.linkTokenCreate({
     user: { client_user_id: user.id },
     client_name: "Fourth Meridian",
     country_codes, language: "en",
     access_token: itemAccessToken,               // update mode
     additional_consented_products: [Products.Investments],
     ...(redirectUri && { redirect_uri: redirectUri }),
   });
   ```

2. User completes Link update mode (a consent confirmation, not a full re-auth).
3. **No token exchange needed** — the existing `access_token` stays valid; the
   Item's `consented_products` now includes `investments`.
4. `investmentsHoldingsGet` succeeds on the next call.
5. Billing: products in `additional_consented_products` are **not billed until their
   endpoints are used**.

Our existing update-mode plumbing (`?plaidItemId=` reconnect flow in
app/api/plaid/link-token/route.ts) is exactly the right insertion point for the
future UI hook — see §6.

## 4. Where consent state comes from — zero extra API calls

`AccountsGetResponse.item` (already fetched as step 1 of every refresh AND at
exchange-token time) carries everything needed (verified in installed SDK,
plaid@42.x, `dist/api.d.ts`):

| Field                | Meaning |
|----------------------|---------|
| `consented_products?` | Products the user consented to via DTM. Absent/empty on pre-DTM legacy Items. |
| `available_products`  | Products the Item supports but hasn't accessed. |
| `billed_products`     | Products already in use. |

Derivation (authoritative for DTM Items):

- `investments ∈ consented_products` → **ENABLED**
- `consented_products` non-empty, no `investments`, but `investments` ∈ available/billed → **CONSENT_REQUIRED**
- `consented_products` non-empty, `investments` in neither list → **UNSUPPORTED**
- `consented_products` absent/empty (pre-DTM Item) → **unknown** → probe once; a
  thrown `ADDITIONAL_CONSENT_REQUIRED` persists **CONSENT_REQUIRED**.

Because the status is re-derived from fresh `accountsGet` data on every refresh, it
**self-heals**: after the user grants consent via update mode, the next refresh sees
`investments ∈ consented_products`, flips the flag back to ENABLED, and resumes
holdings sync — no manual reset needed.

## 5. Minimal implementation (what was changed)

### 5.1 Schema (additive only)

```prisma
enum PlaidInvestmentsConsent {
  ENABLED           // consent present (or legacy probe succeeded)
  CONSENT_REQUIRED  // supports investments; user must grant consent via Link update mode
  UNSUPPORTED       // Plaid Investments not available for this Item
}

model PlaidItem {
  ...
  investmentsConsent PlaidInvestmentsConsent?  // null = unknown / never derived
}
```

Hand-written migration (same pattern as D2-7B / D4 migrations):
`prisma/migrations/20260702000000_plaid_item_investments_consent/migration.sql`.
Nullable, additive, no backfill — all existing rows start at null (unknown) and get
populated by their next refresh.

### 5.2 New module: `lib/plaid/investmentsConsent.ts`

`deriveInvestmentsConsent(item)` — pure function implementing §4, shared by
refresh and exchange-token. Returns `PlaidInvestmentsConsent | null`.

### 5.3 `lib/plaid/errors.ts` (additive exports only)

- `getPlaidErrorCode(err)` — extract `error_code` from an Axios-shaped error.
- `plaidErrorSummary(err)` — one-line `"CODE: message"` summary for logs.
  Replaces raw AxiosError dumps in the two holdings catch blocks.

No change to `classifyPlaidErrorForHealth` / `isRetryablePlaidError`:
`ADDITIONAL_CONSENT_REQUIRED` never reaches them (holdings errors are caught before
the per-item catch), and it is correctly non-retryable already (not in
TRANSIENT_CODES).

### 5.4 `lib/plaid/refresh.ts` — holdings step gating

1. After `accountsGet`, derive consent from `accountsRes.data.item`;
   effective = derived ?? stored (`item.investmentsConsent`).
2. Persist on change (one clean log line when the status transitions).
3. Call `investmentsHoldingsGet` only when effective is `ENABLED` or unknown (probe).
4. Catch: `ADDITIONAL_CONSENT_REQUIRED` → persist CONSENT_REQUIRED, single-line
   warn, no dump. Everything else → existing non-fatal warn, now via
   `plaidErrorSummary` (compact).
5. On success from an unknown probe → persist ENABLED.

Result: steady state makes **zero** doomed API calls and logs nothing per refresh.

### 5.5 `lib/plaid/exchangeToken.ts` — same failure path at link time

Identical gating using its own `accountsRes.data.item` (already fetched), seeding
`investmentsConsent` at link time, plus the same compact catch handling. Without
this, every new link with investment accounts makes one guaranteed-failing call and
dumps an AxiosError. (~15 lines, same shared helpers.)

### Impact map

| Area | Change |
|------|--------|
| prisma/schema.prisma | +1 enum, +1 nullable column on PlaidItem (additive) |
| prisma/migrations/…investments_consent | new hand-written SQL (1 CREATE TYPE, 1 ADD COLUMN) |
| lib/plaid/investmentsConsent.ts | new, pure derivation helper |
| lib/plaid/errors.ts | +2 exported helpers, nothing modified |
| lib/plaid/refresh.ts | holdings step gated + clean logging |
| lib/plaid/exchangeToken.ts | holdings step gated + clean logging |
| UI / API routes / other tables | **untouched** |

### Rollback plan

- Code: revert the commit — all application changes are contained in the four files
  above; no callers depend on the new column.
- Schema: column + enum are nullable/additive; a down migration is
  `ALTER TABLE "PlaidItem" DROP COLUMN "investmentsConsent"; DROP TYPE "PlaidInvestmentsConsent";`
- Data: no backfill was performed, nothing to restore.

### Validation checklist

- [x] `prisma generate` — client generated successfully against the new schema
      (sandbox can't write node_modules, so generation ran to a temp dir; this
      also confirms the schema parses). **Run `npx prisma generate` locally** to
      refresh the real client before `npm run dev`.
- [ ] `npx prisma migrate dev` — **must be run locally**; DB is not reachable from
      this sandbox (verified via `prisma db execute` → connection failure). SQL is
      hand-written to match what `migrate dev` would generate, same pattern as the
      D2-7B and D4 migrations.
- [x] `npx tsc --noEmit` — clean (0 errors), run against the freshly generated client.
- [x] `npm run lint` — clean (0 errors; 4 pre-existing warnings in components/ui/CoinIcon.tsx, unrelated).
- [ ] Manual: refresh an Item with investment accounts in Production — expect one
      `investmentsConsent → CONSENT_REQUIRED` transition log, then silent skips.

## 6. Future UI hook — "Enable Investment Holdings" (design only, NOT implemented)

**Where the state lives:** `PlaidItem.investmentsConsent === CONSENT_REQUIRED` is the
exact render condition for the button (per Item / institution card).

**Flow:**

1. Extend `GET /api/plaid/link-token` with `?plaidItemId=X&consent=investments`
   (reusing the existing D2-7E update-mode branch). When `consent=investments` is
   present, add `additional_consented_products: [Products.Investments]` to the
   update-mode `linkTokenCreate` call. Ownership check already exists on that path.
2. Frontend opens Plaid Link with that token (existing `react-plaid-link` plumbing).
3. `onSuccess` → **no exchange-token call** (access token unchanged). Instead POST
   the existing `/api/plaid/refresh` for that Item: the refresh re-derives consent
   from `consented_products`, flips the flag to ENABLED, and imports holdings in the
   same pass.
4. `onExit` (user declined) → nothing to do; flag stays CONSENT_REQUIRED.

No new tables, no new endpoints — one query param on an existing route plus a button.

## 7. Explicitly out of scope (per task rules)

- Investment transactions (`/investments/transactions/get`).
- Any UI implementation.
- Requesting `investments` at initial Link time (would regress AmEx et al.).
- Plaid architecture changes (retry, health classification, Connection layer).

---

### Sources

- [Plaid — Link Update Mode](https://plaid.com/docs/link/update-mode/)
- [Plaid — How do I add a product to an existing Item?](https://support.plaid.com/hc/en-us/articles/14976875990551-How-do-I-add-a-product-to-an-existing-Item)
- [Plaid — Choosing when to initialize products](https://plaid.com/docs/link/initializing-products/)
- [Plaid — Data Transparency Messaging migration guide](https://plaid.com/docs/link/data-transparency-messaging-migration-guide/)
- [Plaid — API: Items (`consented_products`, `available_products`)](https://plaid.com/docs/api/items/)
- Installed SDK ground truth: `node_modules/plaid/dist/api.d.ts` (plaid@^42.2.0) —
  `AccountsGetResponse.item`, `Item.consented_products`, `LinkTokenCreateRequest.additional_consented_products`.
