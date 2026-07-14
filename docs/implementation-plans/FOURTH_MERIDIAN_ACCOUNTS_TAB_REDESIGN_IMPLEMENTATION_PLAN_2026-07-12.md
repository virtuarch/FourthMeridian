# Fourth Meridian — Accounts Tab Redesign: Phase 1 Implementation Plan

**Date:** 2026-07-12
**Branch of record:** `feature/v2.5-spaces-completion`
**Scope:** Phase 1 only, per `FOURTH_MERIDIAN_ACCOUNTS_TAB_REDESIGN_INVESTIGATION_2026-07-12.md` §8 — Bucket 1 (identity, connection health, actions, imports count) plus extracting `AccountsCard` out of `SpaceDashboard.tsx`. **No schema migration, no new writes.** Historical Coverage (Bucket 2), the `SpaceAccountLink` participation-control columns (Bucket 3), and Account Intelligence + the Space Coverage percentage (Bucket 4) are explicitly out of scope — each deferred for a distinct, already-documented reason.

---

## 1. Repository findings (see the investigation doc for full citations — summarized here)

- **Current component:** `AccountsCard`, inline at `SpaceDashboard.tsx:382–422`. Groups `accounts` (the shared `SpaceAccount` type, `:151–162`) by `type`; renders name/institution/balance only.
- **Mount:** `lib/space-presets.ts:77–83` (`ACCOUNTS_SECTION`, key `accounts_overview`) → `WIDGET_RENDERERS["accounts_overview"]` (`SpaceDashboard.tsx:1385`) → `<AccountsCard accounts={p.accounts} />`. **Important structural fact, verified:** ACCOUNTS is a top-level rail tab (`TAB_ORDER`), rendered through the DB-backed section/`WIDGET_RENDERERS` mechanism — a completely different code path from the `activePerspectiveId === "X"` branch chain Wealth/Cash Flow/Liquidity/Investments/Debt use inside the PERSPECTIVES tabpanel. **This plan never touches that branch chain at all.** The `SpaceDashboard.tsx` footprint is one line (the `WIDGET_RENDERERS["accounts_overview"]` entry), not a new branch — meaningfully lower risk than every perspective redesign this week.
- **`business_accounts`** (`SpaceDashboard.tsx:1386`) also renders `AccountsCard` today, for a different Space category. **Leave it on the old `AccountsCard` — do not swap it.** Out of scope; not part of this vision.
- **Real data verified:** `FinancialAccount.mask` (last 4 digits), `FinancialAccount.connectionId → Connection` (the same join `ConnectionCard` uses), `lib/sync/status.ts`'s pure `deriveConnectionState()`, `ImportBatch` (reuse the same `spaceAccountLinks` join pattern already designed for the Activity Tab plan), `ACCOUNT_RENAMED` write site (`app/api/accounts/[id]/route.ts`), the revoke route (`app/api/spaces/[id]/accounts/share/route.ts`).
- **The shared `SpaceAccount` type must not be extended for this.** It's consumed by Wealth/Cash Flow/Liquidity/Debt widgets across the dashboard — bloating it with Accounts-tab-specific fields (mask, connection state, import count) risks unrelated regressions. Build a dedicated read instead, the same architectural call already made for Investments (its own route rather than overloading `current-holdings`).

---

## 2. Exact implementation design

### 2.1 New dedicated read — no schema change, new query only

`GET /api/spaces/[id]/accounts/detail` — membership-gated (VIEWER+, same pattern as every other Space read this week). For each account visible via `SpaceAccountLink` (reuse `app/api/spaces/[id]/accounts/route.ts`'s existing join, don't reinvent it):

```ts
interface AccountDetailRow {
  id: string; spaceAccountLinkId: string;
  name: string; institution: string; type: string; mask: string | null;
  balance: number; currency: string;
  isManual: boolean;                         // connectionId === null
  connectionState: SyncConnectionState | null; // deriveConnectionState() — null for manual accounts, never fabricated
  importBatchCount: number;                    // COUNT(ImportBatch) for this account, status = COMPLETED
}
```

`connectionState` reuses `deriveConnectionState()` from `lib/sync/status.ts` verbatim — do not reimplement the state derivation, import and call it. `importBatchCount` reuses the exact `spaceAccountLinks.some({spaceId, status: "ACTIVE"})` join pattern already verified for the Activity Tab plan's `ImportBatch` producer (§1.3 of that plan) — same query shape, second consumer, not a second implementation.

### 2.2 Extract the composition

`components/space/widgets/accounts/AccountsPerspective.tsx` (new) — replaces the inline `AccountsCard` for the `accounts_overview` mount only. Self-fetches `/api/spaces/${spaceId}/accounts/detail` on mount (same self-fetch shape as `InvestmentConnectionsCard`/`useInvestmentsTimeMachine` — loading/error/retry states, not a new pattern). Groups by type (preserve the existing grouping behavior — it's the one part of today's UI worth keeping as-is), each row shows:
- Identity: name, institution, type label, `••••{mask}` when present.
- Balance (unchanged from today).
- Health chip: reuses the existing three-state visual language already established by `ConnectionCard`/`InvestmentConnectionsCard` for `needs_reauth`/`error`/`ready` — do not invent new copy or a new visual treatment; manual accounts show no chip (there's nothing to report — never show a fake "healthy" state for something that was never connected).
- Imports: "N historical imports" only when `importBatchCount > 0` (the same zero-count-clause discipline as the Activity Tab plan — never render "0 imports").
- Actions row: View (nav to account detail, if one exists — verify the route before assuming it), View transactions (nav to `/dashboard/transactions?account=...` or the Space-scoped equivalent — verify exact existing route), Rename (reuses `PATCH /api/accounts/[id]`, same mutation `ACCOUNT_RENAMED` already writes), Remove from Space (reuses the existing revoke route/confirmation pattern — check whether a confirmation dialog already exists for this action elsewhere and reuse it rather than building a new one).

**Explicitly not building:** a "Manage Connections →" link is real and cheap (pure navigation to the existing Connections page) — include it. Everything else Bucket 2–4 named is out of scope for this file.

### 2.3 Host wiring — the smallest footprint of any redesign this week

`SpaceDashboard.tsx` — ONE line change: `"accounts_overview": (p) => <AccountsPerspective spaceId={p.spaceId} accounts={p.accounts} />` (replacing the `<AccountsCard>` call). `"business_accounts"` stays on `<AccountsCard>`, untouched. The old `AccountsCard` function itself stays in the file (still used by `business_accounts`) — do not delete it.

---

## 3. Files

**Add:**
- `app/api/spaces/[id]/accounts/detail/route.ts`
- `components/space/widgets/accounts/AccountsPerspective.tsx`
- `components/space/widgets/accounts/AccountsPerspective.test.ts` (colocated source-scan/fixture test per house convention)

**Modify:**
- `components/dashboard/SpaceDashboard.tsx` — the one `WIDGET_RENDERERS["accounts_overview"]` line.

**Explicitly untouched:** `AccountsCard` (stays, still serves `business_accounts`), `lib/sync/status.ts` (consumed, not modified), `components/connections/**` (consumed for visual-language precedent only, never imported directly — Accounts must not import Connections components, matching the doctrine that these are separate surfaces), `SpaceAccount` type, every perspective redesign file, the `activePerspectiveId` branch chain (never touched — this plan doesn't need it), `SpaceAccountLink` schema (Bucket 3, deferred).

---

## 4. Slice plan

- **S1 — Dedicated read + extraction + identity/balance.** The new route, the new component with basic identity/balance rendering (parity with today's `AccountsCard` grouping), the one host-wiring line. Functional parity checkpoint: every account that showed before still shows, grouped the same way.
- **S2 — Connection health + manual/connected distinction.** `connectionState` wired in, health chips, "Manage Connections →" link.
- **S3 — Imports count.** `importBatchCount`, zero-count-clause discipline.
- **S4 — Actions.** Rename, Remove from Space, View, View transactions — verify each target route exists before wiring it; do not invent a route.
- **S5 — Tests + polish + STATUS.md.**

Each independently shippable; S1 alone is already a strict improvement (same data, better structure, ready for the rest).

---

## 5. Risks

- **Extending the shared `SpaceAccount` type by mistake** — the single most important thing to avoid; the new detail route must be a genuinely separate read, not a modification to the type every other widget depends on.
- **`connectionState` fabrication for manual accounts** — must be `null`, never a fake "healthy" default; a manual asset was never connected, so "connected" language doesn't apply to it at all.
- **Route existence assumptions** — "View" and "View transactions" actions must link to real, verified routes; if a per-account detail view doesn't actually exist as a page, cut that action rather than link to a 404.
- **Duplicating Connections management** — this is the doctrine risk named throughout the investigation. If implementation finds itself wanting to add reauth/credential/provider-settings actions here, stop — that's Connections' job, not Accounts'.

## 6. Overengineering check

Confirmed feasible as: one new route (reusing an existing join pattern verbatim) + one new component (reusing existing visual/state language verbatim) + one host line. Rejected: extending the shared account type, a new Connections-adjacent management surface, any schema change, any coverage/intelligence computation (both explicitly Phase 2+/deferred).

## 7. Testing expectations

`AccountsPerspective.test.ts`: grouping preserved, zero-count import clause omitted, manual accounts render no health chip, health chip states map correctly from `connectionState`, actions row only shows verified-real actions. Route-level: a fixture/source-scan test confirming the query reuses the same `spaceAccountLinks` join shape as the Activity Tab's `ImportBatch` producer (consistency across the two initiatives, not two different joins).

## 8. Validation gate

```bash
npx tsc --noEmit
npx eslint
npm test
git diff --name-only   # must match §3 exactly
npm run dev             # manual pass: Accounts tab parity check against today's list;
                         # health chips correct for a needs_reauth/error/manual account;
                         # imports count correct against real ImportBatch data;
                         # rename + remove-from-space actually work; business_accounts
                         # (a different Space category) still renders via the OLD
                         # AccountsCard, completely unaffected
```

## 9. Stop conditions

1. Any action would require importing from `components/connections/**` directly, or adding reauth/credential/provider-settings UI — that's Connections' job.
2. A "View" or "View transactions" target route doesn't actually exist — cut the action, don't invent a destination.
3. Implementation drifts toward Historical Coverage, Space participation controls, or Account Intelligence — all three are explicitly out of scope for this plan (Buckets 2–4 of the investigation).
4. The shared `SpaceAccount` type needs modification to make this work — stop, the dedicated detail route is the correct fix, not the shared type.
