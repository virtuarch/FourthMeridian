# Fourth Meridian — Onboarding → Accounts Tab Retarget: Plan

**Date:** 2026-07-13
**Scope:** Retarget new-user onboarding links (Daily Brief's `ob_*` CTAs + `BriefNewUser`) from the old standalone `/dashboard/accounts` page to the redesigned `AccountsPerspective` tab, then retire the old page.

---

## 1. Gap the ask didn't account for

The new `AccountsPerspective` is **deliberately management-only** — it has no connect/Plaid flow and, per its own doc comment and a passing test (`AccountsPerspective.test.ts:94`, "no link to /dashboard/accounts"), never links to the old accounts page. It defers "add an account" entirely to `/dashboard/connections` (its footer "Manage Connections →" link).

The old `/dashboard/accounts/page.tsx` is the *only* place today where the actual connect action (`PlaidLinkButton`) lives for this flow. So a straight retarget to `AccountsPerspective` **loses the connect action for new users** — the exact users these links exist to onboard — unless it's paired with a path to `/dashboard/connections`.

## 2. Full inbound surface (10 links, not 8)

`app/api/brief/route.ts`:
| Line | id | current href |
|---|---|---|
| 135 | `ob_bank` | `/dashboard/accounts` |
| 136 | `ob_invest` | `/dashboard/accounts` |
| 137 | `ob_crypto` | `/dashboard/accounts` |
| 138 | `ob_manual` | `/dashboard/accounts` |
| 247 | `NEEDS_REAUTH` signal | `/dashboard/accounts` |
| 257 | `STALE_CONNECTION` signal | `/dashboard/accounts` |
| 282 | per-account sync-error loop | `/dashboard/accounts` |
| 290 | `sync_error_accounts` | `/dashboard/accounts` |

`components/brief/BriefNewUser.tsx`: line 35 ("Connect an Account"), line 48 ("Add Manual Asset").

(The other 2 of the original "8" — `pending_invites`→`/dashboard/spaces` and `insight.actionHref`→`/dashboard/analyze` — are unrelated to this retarget, not accounts links.)

## 3. Recommended split (not one uniform retarget)

These 10 links fall into two different intents — don't collapse them into the same destination:

- **Connect intent** (`ob_bank`, `ob_invest`, `ob_crypto`, `ob_manual`, `BriefNewUser`'s two CTAs) → retarget to **`/dashboard/connections`** (where the actual connect flow lives today), not to `AccountsPerspective`. This preserves the action these links exist to trigger.
- **Manage/fix intent** (`NEEDS_REAUTH`, `STALE_CONNECTION`, sync-error signals — these point at an *existing* account with a problem, not "go add a new one") → retarget to the **Accounts tab**, since `AccountsPerspective` already surfaces health chips (Synced/Needs reconnection/Sync error) per row and is the right place to land someone fixing a specific account.

This means "point onboarding at the Accounts tab" is correct for roughly half these links and wrong for the other half — worth confirming this split matches your intent before implementation, since it changes the destination for 6 of the 10.

## 4. Exact changes (pending confirmation of §3's split)

**`app/api/brief/route.ts`**
- Lines 135–138 (`ob_bank/ob_invest/ob_crypto/ob_manual`) → `/dashboard/connections`.
- Lines 247, 257, 282, 290 (reauth/stale/sync-error) → the Accounts tab's URL shape (likely `?tab=ACCOUNTS`, consistent with whatever convention the banking-retarget plan settles on for tab-targeted links — reuse it, don't invent a second one).

**`components/brief/BriefNewUser.tsx`**
- Lines 35, 48 → `/dashboard/connections`.

**`AccountsPerspective.test.ts:94`** — this test currently asserts the *absence* of a link to `/dashboard/accounts`. It should still pass unchanged (nothing here adds that link back) — re-run it as a regression check, not something to edit.

**Delete** (after retargeting + re-verifying zero remaining inbound edges):
- `app/(shell)/dashboard/accounts/page.tsx`

## 5. Slice plan

1. **S1** — Confirm the connect-vs-manage split with Chris (this is a product call, not a default).
2. **S2** — Retarget the 4 `ob_*` links + 2 `BriefNewUser` CTAs to `/dashboard/connections`.
3. **S3** — Retarget the 4 reauth/stale/sync-error links to the Accounts tab.
4. **S4** — Delete `app/(shell)/dashboard/accounts/page.tsx` after re-verifying zero remaining inbound edges (including the passing `AccountsPerspective.test.ts:94` assertion as a regression guard).

## 6. Validation gate

```bash
npx tsc --noEmit
npm test
npm run dev   # manual: as a new user, Daily Brief's connect CTAs land on the
              # actual connect flow; a sync-error/reauth signal lands on the
              # Accounts tab showing that account's health chip
```

## 7. Stop conditions

1. §3's split isn't confirmed before implementation starts.
2. Any link gets pointed at `AccountsPerspective` expecting a connect action to be available there — it isn't, and won't be added as part of this retarget.
