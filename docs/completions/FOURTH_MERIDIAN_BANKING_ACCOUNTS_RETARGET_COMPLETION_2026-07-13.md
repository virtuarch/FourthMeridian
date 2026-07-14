# Fourth Meridian — Banking & Accounts Retarget-then-Delete: Completion Summary

**Date:** 2026-07-13
**Branch:** `feature/v2.5-spaces-completion` (directly on primary — no worktree)
**Plans:**
- `FOURTH_MERIDIAN_BANKING_RETARGET_PLAN_2026-07-13.md` (S1–S4)
- `FOURTH_MERIDIAN_ACCOUNTS_ONBOARDING_RETARGET_PLAN_2026-07-13.md` (S2–S4; S1 was the human-confirmation of the connect-vs-fix split, given up front)

Banking was implemented first because it settles the tab-targeted query-param convention that accounts' fix-intent links reuse. **Convention confirmed against current source (not guessed):** lowercase `?tab=<tab>` (the shell's `URL_TAB_ALIAS` map + the `.toLowerCase()` mirror-write), read via **`window.history` / `window.location` on mount** — deliberately not the search-params hook, which the `space-shell-seams` contract forbids in the shell (it would force a Suspense boundary). Accounts' S3 links therefore use `/dashboard?tab=accounts`, the same shape.

One commit per slice; `npx tsc --noEmit` + `npm test` run after every commit (the gate each plan specifies). **All gates passed clean — tsc exit 0 and 200/200 tests on every slice.**

---

## Banking → Transactions (`/dashboard/banking` retired)

| Slice | Commit | What changed |
|---|---|---|
| S1 | `45c24c4` | `SpaceTransactionsPanel` gains `initialAccountFilter?: string \| null`, seeding the `accountFilter` useState. Seeds initial state only; the filter select stays changeable. |
| S2 | `f2429d9` | `SpaceDashboard` reads `?account=<id>` once on mount from `window.location` and passes it as `initialAccountFilter`. Paired `?tab=transactions` opens the tab via the existing `readUrlTabState` initial-tab logic. Uses the window.history channel (not the search-params hook) per the seam contract. |
| S3 | `2ce0979` | `AccountsPerspective`'s per-account "View transactions" retargeted from `/dashboard/banking?account=` to `/dashboard?tab=transactions&account=`. Converted from a soft-nav `<Link>` to a plain `<a>` (full navigation) so the shell's mount read fires — a soft nav wouldn't switch the tab under the window.history convention. `AccountsPerspective.test.ts:90` assertion updated to the new target; the `no link to /dashboard/accounts` guard stays green. |
| S4 | `e144d7a` | **Deleted** `app/(shell)/dashboard/banking/page.tsx` (46 LOC) + `components/dashboard/BankingClient.tsx` (591 LOC) = **637 LOC removed.** |

**Correction to the plan's starting assumption (plan §1):** the Transactions tab's account filter was local component state with no deep-link seam — S1/S2 added the pre-selection mechanism, as the plan anticipated (real work, not a pure link swap).

**S4 re-verification (verified against current source, not just the plan's numbers):**
- Route string `dashboard/banking`: no live edge — only comments remain (AccountsPerspective's rationale note; two `lib/data/transactions` privacy-test comments that describe the *data read path* in `lib/data/transactions.ts`, not the route/page).
- `BankingClient` importers: only `banking/page.tsx` (deleted). Remaining matches are comments (SpaceTransactionsPanel lineage note, `flow-predicates.ts` provenance).
- No `router.push`/`replace`/`redirect` to the route; no server-side / notification-registry / Brief edge.
- Per the route-reachability audit's explicit flag, `TransactionDetailDrawer.test.ts` read `BankingClient.tsx` source directly (would `ENOENT` on deletion). Updated in the **same** S4 commit: Banking dropped as a transaction surface; the keyboard-accessibility assertion retargeted to the live `SpaceTransactionsPanel` (verified it has `role="button"` + `onKeyDown`).

---

## Accounts onboarding → Connections / Accounts tab (`/dashboard/accounts` retired)

The split in the plan's §3/§4 is honored exactly — **connect-intent and fix-intent are not collapsed onto one destination:**

| Slice | Commit | What changed |
|---|---|---|
| S2 | `ca15c99` | **6 connect-intent links → `/dashboard/connections`** (where the actual connect/Plaid flow lives; `AccountsPerspective` is management-only). `app/api/brief/route.ts`: `ob_bank`, `ob_invest`, `ob_crypto`, `ob_manual`; `components/brief/BriefNewUser.tsx`: "Connect an Account", "Add Manual Asset". |
| S3 | `363e73b` | **4 fix-intent links → `/dashboard?tab=accounts`** (existing account with a problem → the Accounts tab, which surfaces per-account health chips). `app/api/brief/route.ts`: `NEEDS_REAUTH`, `STALE_CONNECTION`, per-account sync-error loop, `sync_error_accounts`. |
| S4 | `ac40700` | **Deleted** `app/(shell)/dashboard/accounts/page.tsx` (44 LOC) = **44 LOC removed.** |

All 10 links from the plan's §2 table were found at their stated call sites (line numbers had drifted slightly; matched by context). The connect/fix intent count is exactly 6/4 as specified.

**S4 re-verification (against current source):**
- Exact route string `/dashboard/accounts`: no live edge — only comments (this route's own retired-note, the Connections-page header, `RemoveAccountButton`'s doc) plus `AccountsPerspective.test.ts:94`, which scans `AccountsPerspective.tsx` source (not the deleted page) and passes as the plan's regression guard (re-run, not edited).
- No `router.push`/`replace`/`redirect` to the route.

**⚠ Flagged follow-up — orphaned component cluster (deliberately not deleted).** The plan scopes S4 to `page.tsx` **only**. Deleting it orphans a cluster that was imported *solely* by the page (verified by import-path grep — and note the route-reachability audit's "shared" claim for `AccountCard` is stale; nothing else imports it now):
- `components/dashboard/AccountCard.tsx`
- `components/plaid/PlaidLinkButton.tsx`
- `components/dashboard/RemoveAccountButton.tsx`
- `components/dashboard/RemoveAccountModal.tsx` (via `RemoveAccountButton`)

These are now dead code but left in place per the plan's explicit page-only scope (tsc does not error on unused files). Recommend a small follow-up commit to remove the cluster (~250+ LOC) once you confirm nothing external is planned to reuse the standalone `PlaidLinkButton` connect flow.

---

## Totals & validation

| Route retired | Files deleted | LOC removed |
|---|---|---|
| `/dashboard/banking` | `page.tsx` + `BankingClient.tsx` | **637** |
| `/dashboard/accounts` | `page.tsx` | **44** |
| | | **681 LOC** |

- **`npx tsc --noEmit`** — exit 0 after every one of the 8 commits (clean baseline confirmed first).
- **`npm test`** — 200/200 passed after every commit. One transient failure during banking S2 (the `space-shell-seams` guard, which forbids the search-params hook in the shell) was the guard doing its job — resolved by switching to the sanctioned `window.history` mount-read, which is what the banking convention ultimately landed on.
- Deleting App Router routes left Next's git-ignored generated validators (`.next/types`, `.next/dev/types`) transiently referencing the removed `page.js`; regenerated with `npx next typegen` + dev-cache clear so each `tsc` gate reflected true source, not a stale build artifact.
- Each commit made with an explicit pathspec (concurrent-branch commit discipline). Both plans and this summary are untracked root docs, consistent with the repo's other planning/completion docs.

**Net:** two dead routes retired behind fully retargeted inbound links, **681 LOC removed**, connect-vs-fix intent split preserved, both validation gates green throughout.
