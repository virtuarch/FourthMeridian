# Investigation — Since Last Visit Modal: Time Tabs → Data Tabs

**Status:** Investigation only. No code, schema, migration, or UI changes made.
**Goal:** Clicking the "In the Last Hour" / "Since Last Visit" card opens the existing detail modal, but with **data-focused tabs** instead of time-range tabs:
Tab 1 **Net Worth**, Tab 2 **Accounts Tracked** (distinct account roster), Tabs 3–4 reserved/blank.
**Constraint:** "Accounts Tracked" = distinct real `FinancialAccount` records visible across eligible Spaces — must align with the count fix already shipped (dedup by `FinancialAccount.id`, not `SpaceAccountLink` placements).

---

## 1. Current architecture map

```
GET /api/brief  (app/api/brief/route.ts)
  → BriefPayload { sections: BriefSection[] }
      section.type === "since_last_visit"
        title:  "In the last hour" / "Since yesterday" / …  (sinceLabel)
        items:  BriefItem[]  ← summary numbers ONLY
                  • nw_delta | nw_current   → "Net worth"
                  • account_count           → "Accounts tracked" = String(distinctCount)
                  • pending_invites         → "Space invite(s)"
  ↓ fetched client-side
DailyBriefClient.tsx  (fetch("/api/brief") → setPayload)
  → renders sections; since_last_visit routed to…
BriefSinceLastVisit.tsx        ← THE CARD
  • 4-column glass panel (title + items)
  • onClick / Enter / Space → setModalOpen(true)
  • renders <SinceLastVisitModal open onClose section={section} />
SinceLastVisitModal.tsx        ← THE MODAL
  • headerRight = <InlineFilter> over RANGES  ← THE TIME TABS
  • RANGES = [current(hasData), 1d, 1w, 1m, 1y, ytd]  (only "current" has data)
  • body: maps section.items → <SummaryItem> rows; other ranges → <ComingSoonState>
```

**Answers to the scoped questions 1–5:**

1. **Card component:** `components/brief/BriefSinceLastVisit.tsx`. Title comes from `section.title` (produced by `sinceLabel()` in the route — "In the last hour" etc.).
2. **Click/modal behavior:** local `useState` `modalOpen` in `BriefSinceLastVisit`. Both render paths (`AtlasLiquidCard` and `GlassPanel`) call `handleOpen` on click / Enter / Space. Renders `<SinceLastVisitModal open={modalOpen} onClose={handleClose} section={section} />`.
3. **Where the time tabs live:** `components/brief/SinceLastVisitModal.tsx`, the `RANGES` constant (lines ~43-50) rendered via `<InlineFilter>` in `headerRight` (lines ~153-160). `activeRange` state drives `hasData` → either `<SummaryItem>` rows or `<ComingSoonState>`.
4. **Data the modal currently receives:** exactly one prop of substance — `section: BriefSection`. From it, `section.items` (an array of `{ id, label, value?, detail?, tone?, href? }`). These are **rendered summary strings**, e.g. `account_count.value = "9"`.
5. **Does the modal have enough to render a distinct account list?** **No.** The payload carries only summary numbers. No per-account data (id, name, type, institution, mask) is serialized anywhere in `BriefPayload`. Additionally, the accounts assembler omits its per-account `accounts` array under `scopeHint='brief'` (route header + `accounts.ts` lines ~299-305), and even that array is **per-Space** (would duplicate shared accounts). So a new, additive, deduplicated data path is required.

---

## 2. Root data flow (where the roster must be built)

The account identities exist **server-side** inside the AI context: after the count fix, each Space's accounts domain exposes `accountIds: string[]` (`lib/ai/assemblers/accounts.ts`). But `accountIds` are bare strings and are **not** serialized into `BriefPayload` — the route only emits the `account_count` summary item.

Therefore the roster must be assembled on the server (route + assembler), deduped across eligible Spaces, and attached to the payload — mirroring exactly how the "Accounts Tracked" count is already computed. **The UI must not query financial tables** (rule honored: the modal reads from props only).

---

## 3. Are current props sufficient? — No

| Need | Available today? |
|---|---|
| Distinct count (header value) | ✅ `account_count.value` (already deduped) |
| Per-account id | ❌ not in payload |
| Display name (privacy-resolved) | ❌ not in payload |
| Type / subtype | ❌ not in payload |
| Institution | ❌ not in payload (and must be FULL-only) |
| Masked identifier (last 4) | ❌ not in payload (and must be FULL-only) |
| Visibility level | ❌ not in payload |

Conclusion: an **additive** data change is required. No existing prop can supply the roster.

---

## 4. Recommended data shape (`trackedAccounts`)

Two thin layers, both additive and optional. **No balances anywhere** (the roster is an identity list, not a valuation — Net Worth tab already carries totals).

**Assembler layer** — `lib/ai/types.ts`, add to `AccountsSectionData`:

```ts
export interface TrackedAccountLite {
  id:          string;                 // FinancialAccount.id — dedup key
  name:        string;                 // privacy-resolved (see below)
  type:        string;                 // AccountType
  subtype?:    string | null;          // debtSubtype when present
  institution?: string;               // FULL visibility only; omitted otherwise
  mask?:       string | null;          // last 4; FULL visibility only; omitted otherwise
  visibility:  'FULL' | 'BALANCE_ONLY' | 'SUMMARY_ONLY';
}
// AccountsSectionData:
trackedAccounts?: TrackedAccountLite[]; // populated regardless of scopeHint; NO balance
```

**Payload layer** — `lib/brief-types.ts`, add to `BriefSection` (reaches the modal via the existing `section` prop — zero new prop threading):

```ts
export interface TrackedAccount {
  id:          string;
  name:        string;
  type:        string;
  subtype?:    string | null;
  institution?: string;
  mask?:       string | null;
  visibility:  'FULL' | 'BALANCE_ONLY' | 'SUMMARY_ONLY';
}
// BriefSection:
trackedAccounts?: TrackedAccount[];   // only set on the since_last_visit section
```

**Privacy-resolved `name`** reuses existing helpers so no new leakage is introduced:
- FULL → `displayName ?? officialName ?? plaidName ?? name` (as `resolveDisplayName` already does), plus `institution` and `mask`.
- BALANCE_ONLY / SUMMARY_ONLY → `genericAccountName({ type, debtSubtype, ownerFirstName })`; **omit** `institution` and `mask`. This mirrors the existing per-account `accounts` array and `normalizeSharedAccounts()`.

This exposes only fields the user can already see today (mask/institution are shown in `AccountModal`), and never balances or credentials.

---

## 5. Dedup + multi-Space handling (questions 8–9)

The roster is built in `app/api/brief/route.ts` by flattening `trackedAccounts` from every eligible Space's accounts domain and **deduping by `id`**, so an account shared into multiple Spaces appears **once** — consistent with the count fix (the roster length will equal `account_count.value`).

**Visibility precedence when the same account appears at different levels across Spaces:** prefer the **highest-visibility** representation (FULL > BALANCE_ONLY > SUMMARY_ONLY). The user genuinely has FULL visibility of their own account in their personal Space; a more restricted shared-Space copy should not downgrade what they already own. All contexts are built for *this* user's own memberships, so this leaks nothing.

**"Used in X Spaces":** explicitly **deferred**. If wanted later, the dedup reducer can accumulate a `spaceCount` per id at zero extra query cost — not built or rendered now.

---

## 6. Exact files affected

| File | Change | Type |
|---|---|---|
| `lib/ai/types.ts` | Add `TrackedAccountLite`; add `trackedAccounts?` to `AccountsSectionData` | Additive |
| `lib/ai/assemblers/accounts.ts` | Build privacy-aware `trackedAccounts` (no balance); populate even in brief scope | Additive |
| `app/api/brief/route.ts` | Flatten + dedup `trackedAccounts` by id (visibility precedence); attach to the `since_last_visit` section | Additive |
| `lib/brief-types.ts` | Add `TrackedAccount`; add `trackedAccounts?` to `BriefSection` | Additive |
| `components/brief/SinceLastVisitModal.tsx` | Replace `RANGES` time tabs with data tabs (Net Worth / Accounts Tracked / 2 reserved); render roster in Tab 2 | Modal-internal only |

**Not changed:** `BriefSinceLastVisit.tsx` (still passes `section`), the card markup/styling, `DailyBriefClient.tsx`, `BriefModal.tsx`, net worth logic, schema, migrations, Spaces behavior. The `InlineFilter` component is reused for the new data tabs (same control, different options), so the modal's header layout is preserved.

---

## 7. Implementation checklist (DO NOT execute yet)

1. `lib/ai/types.ts`: add `TrackedAccountLite` + optional `trackedAccounts` on `AccountsSectionData` (doc: "identity roster, no balances; populated in all scopes").
2. `lib/ai/assemblers/accounts.ts`: from `links`, map a `trackedAccounts` array applying the FULL vs BALANCE_ONLY/SUMMARY_ONLY name/institution/mask rules (reuse `resolveDisplayName` + `genericAccountName`); include in returned `data` regardless of `scopeHint`. Ensure `mask`/`institution` are selected (mask is not currently in the assembler's select — add `mask: true` to the FinancialAccount select; additive, read-only).
3. `lib/brief-types.ts`: add `TrackedAccount` + optional `trackedAccounts` on `BriefSection`.
4. `app/api/brief/route.ts`: after the existing distinct-count block, build `trackedAccounts` by flattening `accounts(c)?.trackedAccounts` across `successfulContexts`, deduping by `id` with visibility precedence; pass into `buildSinceLastVisit`/attach to the `since_last_visit` section. Assert roster length === `totalAccountCount` (sanity invariant).
5. `components/brief/SinceLastVisitModal.tsx`:
   - Replace `RANGES` with `TABS = [netWorth, accounts, reserved3, reserved4]`; keep `<InlineFilter>` in `headerRight`.
   - Tab 1 (Net Worth): render existing `section.items` (current behavior) — no visual change.
   - Tab 2 (Accounts Tracked): render `section.trackedAccounts` as rows (name; small type/institution·mask subline; generic name + no institution for restricted visibility). Empty state if absent.
   - Tabs 3–4: neutral reserved/"coming soon" state (reuse `ComingSoonState`).
6. Run validation (section 9).

---

## 8. Rollback plan

- All new fields are **optional and additive**; the modal change is isolated to `SinceLastVisitModal.tsx`.
- **Revert:** `git revert <commit>` restores the time tabs and drops the payload fields. No data migration, nothing persisted — instant, stateless.
- **Forward-safe:** if `section.trackedAccounts` is absent (older payload, or a skipped no-AiAgent Space), Tab 2 shows an empty state rather than crashing (`?? []`). Net Worth tab is independent of the new data, so it is unaffected by any roster failure.
- Optionally gate Tab 2 behind a simple presence check (`trackedAccounts?.length`) so the tab only activates when data is present.

---

## 9. Validation plan

**Build gates**
- `npx tsc --noEmit` — verifies new optional types and the `InlineFilter` options change.
- `npm run lint`.
- `npx prisma generate` — no schema change; run to confirm no drift (note: sandbox blocks the engine download, so run in a networked env).

**Fixture (aligns with the count fix)**
Seed one user, 9 distinct `FinancialAccount` rows shared across multiple Spaces totalling ~44 `SpaceAccountLink` rows (Personal + shared Spaces; include at least one account at BALANCE_ONLY in a shared Space and FULL in Personal).

| Assertion | Expected |
|---|---|
| Tab 2 "Accounts Tracked" row count | **9** (not 44) |
| Row count === header `account_count.value` | equal (both 9) |
| Account shared into 3 Spaces | appears **once** |
| Account FULL in Personal + BALANCE_ONLY in a shared Space | shown once, at **FULL** representation (real name, institution, mask) |
| A BALANCE_ONLY-only account | generic name, **no** institution, **no** mask |
| Any balance shown in the roster | **none** |
| Net Worth tab | unchanged vs today |
| Reserved tabs 3–4 | neutral empty/coming-soon state |
| VIEWER Space accounts | excluded (memberships already filtered) |

**Privacy checks**
- Confirm payload JSON for a BALANCE_ONLY account contains no `institution`, no `mask`, and a generic `name`.
- Confirm no `balance` field is emitted in `trackedAccounts`.
- Confirm the UI issues no direct DB/financial query (data comes only from `/api/brief`).

**Layout checks**
- Card (`BriefSinceLastVisit`) markup and styling unchanged.
- Modal header (`InlineFilter`) unchanged in position/behavior; only tab labels differ.

---

## 10. Summary

The card (`BriefSinceLastVisit.tsx`) and modal (`SinceLastVisitModal.tsx`) are cleanly separated; the modal already receives `section`, but that section carries only summary numbers — **insufficient** for an account roster. The smallest correct change is additive server-side: expose a privacy-safe, balance-free `trackedAccounts` roster from the accounts assembler, dedupe it by `FinancialAccount.id` in the brief route (matching the shipped count fix), attach it to the `since_last_visit` section, and swap the modal's time tabs for data tabs — rendering the roster in Tab 2. Five files, all additive except the modal-internal tab swap. No schema, no UI-side queries, no balances, no Spaces changes. Awaiting approval before implementation.
