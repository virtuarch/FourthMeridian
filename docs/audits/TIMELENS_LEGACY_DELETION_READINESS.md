# TimelineLens — Legacy Deletion Readiness Review

Status: **investigation complete. Nothing deleted.**
Date: 2026-07-19
Phase: 1 of the migration arc. Phase 2 is gated on §5.

---

## Phase 0 — current state, verified

| Check | Result |
|---|---|
| TimelineLens exists | ✅ `components/atlas/TimelineLens/` — 5 files |
| TIME-1A/B/C complete | ✅ `a0c47b5` |
| **Reducer semantics unchanged** | ✅ **`lib/perspectives/time-range.ts` has zero diff across the entire arc** (`05c7c80~1..HEAD`) |
| No workspace owns canonical time | ✅ 661 doctrine checks |
| All five render through the lens | ✅ wealth · cashFlow · investments · debt · liquidity allowlisted; 45 exclusivity checks |

Gate totals: **1309 checks passing** across six test files.

---

## Phase 1 — inventory and classification

### A. SAFE DELETE — unreachable legacy time UI

| Item | Lines | Sole importer | Note |
|---|---|---|---|
| `components/space/widgets/CashFlowPeriodSelector.tsx` | 64 | `PerspectiveShell.tsx:31,174` | The universal preset strip. Misnamed — never Cash-Flow-specific. |
| `ShellContextRow.tsx` — **time half** (As-of input, ⇄ swap, Compare-to + ✕) | ~50 | `PerspectiveShell.tsx:41,162` | Trust half already extracted to `ShellTrustRow` in Slice 0. |
| `ShellContextRow.tsx` — **the file** | 118 | same | Once the time half goes it is a bare wrapper around `ShellTrustRow`; `PerspectiveShell` should render `ShellTrustRow` directly. |
| `PerspectiveShell` props `asOf`, `compareTo`, `presetValue` | 3 | — | Display-only inputs to the legacy branch. |
| `components/space/shell/timeline-lens-rollout.ts` | 33 | `PerspectiveShell`, 2 tests | Vestigial once there is no second path to switch to. |

> ⚠️ **`onAsOfChange`, `onCompareToChange`, `onSwap`, `onSelectPreset` must NOT be deleted.** They look legacy but are load-bearing: `handleTimelineIntent` routes every lens intent back through them (`PerspectiveShell.tsx:101-107`). That routing is what preserves `handleSelectSlice`'s Cash-Flow-override clearing. Removing them would strand `cashFlowExplicitPeriod` — the exact failure Timeline-5 was designed to avoid.

### B. REQUIRES MIGRATION — tests that pin the old UI

These **fail** the moment legacy is removed. They must be rewritten, not deleted — each protects a property that outlives the legacy path.

| Test | Line | Currently asserts | Must become |
|---|---|---|---|
| `workspace-definition.test.ts` | 307-308 | *"the legacy control path is still present (rollback path intact)"* | **Invert** → the legacy path is gone |
| `workspace-definition.test.ts` | 245 | `SHELL_SELECTORS = ["<CashFlowPeriodSelector", "<TimelineLens"]` | Narrow to `<TimelineLens` only |
| `workspace-definition.test.ts` | 277 | `<CashFlowPeriodSelector` listed as a forbidden workspace marker | **Keep** — prevents resurrection |
| `timeline-lens-exclusivity.test.ts` | 68-89 | `legacyId` fallback fixture; `LEGACY_SLICER`/`LEGACY_DATES`/`LEGACY_SWAP`; "falls back to legacy" | Rewrite → *every* Perspective renders TimelineLens, unconditionally; no fallback exists |
| `timeline-lens-exclusivity.test.ts` | 113-128 | allowlist shape checks | Delete with the flag |

### C. INTENTIONAL NON-TIMELINE DATE INPUTS — **do not touch**

Each is data entry or a non-Perspective filter. None is a canonical time lens.

| File | What | Why it stays |
|---|---|---|
| `AddGoalModal.tsx` | goal target dates | Data entry. Already name-exempted in the doctrine test. |
| `AddManualAssetModal.tsx` | purchase date | Data entry. |
| `DebtClient.tsx:922` | promo-APR-ends | Data entry. |
| `(auth)/register/page.tsx` | DOB | Data entry. |
| `SpaceTransactionsPanel.tsx:513-549` | `all/90d/30d/7d/custom` + custom range | **Transactions is not a Perspective.** TX-3 territory. |
| `DebtClient.tsx:201,1049` | credit-tab `datePreset` | Local transaction filter, own vocabulary. |
| `SecurityHistory.tsx:34-40` | `24h/7d/30d/1y/all` | Security event log filter. |
| `admin/audit/page.tsx:457,470` | from/to | Audit log filter. |
| `RebuildHistoryButton.tsx:256,261` | from/to | An **operation input** (which window to rebuild), not a view. |
| `NetWorthChart` · `NetWorthChartModal` · `SectionRegistry:433` | `7D/1M/3M/6M/YTD/1Y` | **Chart zoom** — a different axis from canonical time. |
| `CashFlowHistoryWidget.tsx:328-330,373` | Month/Quarter/Year drills + `AllTimeYearNav` | **Load-bearing.** CF-local explicit periods; `viewYear` is the guard that stops the `ALL` sentinel (`0000-01-01`→`9999-12-31`) reaching `monthsInRange`. |

### D. DEAD — unrelated, found in passing

`usePerspectiveShellState` declares a `spaceId` parameter that is **never used** (noted in Slice 4). `onSelectAsOf` appears only in a comment at `usePerspectiveShellState.ts:9` — no component defines or passes it. Neither is part of this deletion; recording so they are not mistaken for legacy time UI later.

---

## 2. Classification summary

**No ambiguity in the classification itself.** Every item resolves cleanly into A, B, or C. The A-list is small (5 items, ~270 lines), the B-list is 5 test edits, and the C-list is explicitly protected.

---

## 3. Deletion would not change behavior

The A-list is unreachable: all five Perspectives are allowlisted, and `usesTimelineLens` is the only branch. Deletion removes the untaken branch. No reducer, URL, snapshot, loader, or calculation file is involved.

---

## 4. Required deletion tests (Phase 2)

1. No workspace imports `CashFlowPeriodSelector` or `ShellContextRow` — both remain in the forbidden-marker list, now unconditionally.
2. `PerspectiveShell` renders exactly one time selector and it is `TimelineLens` — no branch.
3. Every Perspective id renders the lens; there is no fallback path to assert against.
4. The intent→callback routing survives — `onSelectPreset` still reaches `handleSelectSlice` (protects the Cash-Flow override).

---

## 5. ⚠️ Gates before Phase 2 / 3 / 4

The classification is unambiguous. These are not classification problems — they are **prerequisites the phases assume are already satisfied**.

### 5.1 Phase 3 cannot pass as written — browser verification is blocked

Phase 3 requires live verification (URL behavior, five Perspectives, mobile 360×800 and 390×844). **Neither is currently possible in this environment:**

- The browser session became a `SYSTEM_ADMIN` account; mandatory admin MFA hard-redirects `/dashboard` → `/admin/security?setup2fa=true`. I will not alter the auth state to work around it.
- Chrome here clamps windows to a **500 px minimum** — 360 and 390 both resolve to 500. This was already recorded as an open gap in Slice 4.

TIME-1A/B/C therefore also carries an unverified surface: the Return-to-today click, the end-to-end deep-link flow, and mobile rendering of the new Anchor section are covered by SSR and unit tests but **never exercised interactively**.

**Deleting the legacy path removes the rollback route while that verification gap is open.** That is the wrong order. Either the gap closes first, or Phase 2 proceeds knowingly without a fallback.

### 5.2 The as-of empty-field decision is still open

Open since Slice 4, flagged three times. Legacy does `e.target.value || today`; the lens rejects with a message. Deleting legacy **removes the comparison baseline** for that decision permanently.

Lower-stakes now — TIME-1A means an emptied field no longer traps anyone — but it should be settled while both behaviors still exist to compare.

### 5.3 Phase 4 collides with a concurrent session

**TX-3 is already underway by another agent.**

```
537b817  TX-3.0 transaction explorer query contract
be836db  TX-2A transaction completeness awareness
b241cc2  TX-2 transaction read boundary hardening
```

Plus `TX3_QUERY_CONTRACT_IMPLEMENTATION.md`, `TX3_QUERY_CONTRACT_REVIEW.md`, `TX3_TRANSACTION_EXPLORER_AUDIT.md` — the very review findings Phase 4 says to respect were produced by that session, not this one. And `lib/data/transactions.ts` has been modified out from under this session **twice** during the TimelineLens work, each time turning a test red mid-edit.

Phase 4 as written (TX-3.1b → 3.2 → 3.3 → 3.4) would put two agents in the same files on the same branch. TX-3.1b in particular — cursor identity, query parser boundary, aggregate authority — is exactly what `TX-3.0` just established.

**Recommendation: do not start Phase 4 from this session** without first confirming the other session has stopped, or explicitly dividing the work. This is a coordination decision, not a technical one.

---

## 6. Recommendation

**Phase 2 is technically ready.** The classification is clean, the A-list is unreachable, and the test edits are known.

**But the arc's ordering should change:**

1. Close the browser-verification gap on a customer-account session *(§5.1)* — ten minutes, and it is the last thing standing between TimelineLens and "proven".
2. Settle the as-of decision *(§5.2)* — while a baseline still exists.
3. **Then** Phase 2 deletion, with the rollback route intentionally given up rather than accidentally lost.
4. Resolve the TX-3 collision *(§5.3)* before Phase 4 — separately from anything above.

Deleting legacy is cheap and reversible via git. Deleting it *while the replacement has an open verification gap and an unresolved behavioral difference* is what turns a cheap change into an expensive one.
