# Fourth Meridian — Banking → Transactions Retarget: Plan

**Date:** 2026-07-13
**Scope:** Retarget `AccountsPerspective`'s "View transactions" link from `/dashboard/banking?account=` to the Transactions tab, scoped to that account, then retire `/dashboard/banking`.

---

## 1. Correction to the starting assumption

The ask assumed the Transactions tab's account filter ("Phase 1") already supports deep-linking by account. **It doesn't — verified against the current source.**

- `SpaceTransactionsPanel.tsx` (mounted at `SpaceDashboard.tsx:3384` under `activeTab === "TRANSACTIONS"`) has an account filter, but it's **local component state only**: `const [accountFilter, setAccountFilter] = useState<string | null>(null)` (line 161), applied at line 241, exposed via a `<select>` (lines 514–521).
- No `accountId`/`initialAccountFilter` prop exists on its `Props` interface (lines 121–135). No `useSearchParams` read anywhere in the file.

So "reusing the account filter Phase 1 already shipped" is half true: the *filtering UI* exists, but the *pre-selection/deep-link* mechanism does not. This plan includes adding it — it's small, but it's real work, not a pure link swap.

---

## 2. Exact changes

**`components/dashboard/widgets/SpaceTransactionsPanel.tsx`**
- Add `initialAccountFilter?: string | null` to `Props`.
- Seed `accountFilter` state from it: `useState<string | null>(initialAccountFilter ?? null)`.

**`components/dashboard/SpaceDashboard.tsx`**
- Read `?account=` from the URL (`useSearchParams`, consistent with how other tabs already read query state — check `lib/space-nav.ts`/existing tab-switch query handling for the established pattern before adding a new one).
- When `?tab=TRANSACTIONS&account=<id>` is present: switch `activeTab` to `TRANSACTIONS` and pass `initialAccountFilter={account}` into `SpaceTransactionsPanel`.

**`components/space/widgets/accounts/AccountsPerspective.tsx`** (line 259–264)
- Change the href from `/dashboard/banking?account=${row.id}` to `?tab=TRANSACTIONS&account=${encodeURIComponent(row.id)}` (same-page query params, since Transactions is a tab within the same Space dashboard shell, not a separate route — confirm this is how tab-switch links are expressed elsewhere in the codebase before inventing a new convention).

**`AccountsPerspective.test.ts:90`** — update the assertion from `/dashboard/banking?account=` to the new target.

**Delete** (after the above lands and is verified with zero remaining inbound edges):
- `app/(shell)/dashboard/banking/page.tsx`
- `components/dashboard/BankingClient.tsx`

Confirmed exclusive to this route — no other importer found repo-wide.

---

## 3. Slice plan

1. **S1** — `initialAccountFilter` prop + seeding in `SpaceTransactionsPanel`. Tested in isolation.
2. **S2** — `SpaceDashboard` query-param read + tab-switch + prop-pass wiring.
3. **S3** — `AccountsPerspective` link retarget + test update.
4. **S4** — Delete `banking/page.tsx` + `BankingClient.tsx` after re-verifying zero inbound edges.

## 4. Validation gate (per slice)

```bash
npx tsc --noEmit
npm test
npm run dev   # manual: click "View transactions" on an account row → lands on
              # Transactions tab, pre-filtered to that account, filter select
              # reflects the pre-selection and remains changeable
```

## 5. Stop conditions

1. No established query-param/tab-switch convention exists in `SpaceDashboard.tsx` to reuse — if so, confirm the right pattern before inventing one, don't guess.
2. Any other inbound edge to `/dashboard/banking` turns up during S4's re-verification that the earlier audit missed.
