> Runtime verification deliverable · HEAD cde8fa0 (v2.6) · 2026-10-21 · isolated throwaway stack (synthetic data, OpenAI mocked, Plaid Items set REVOKED, no Preview/Production access). Classifications: CONFIRMED / SUPPORTED / REFUTED / PARTIAL / UNVERIFIED. This is the verifying workstream's report; the coordinator independently reproduced SEC-001 and cross-checked every promoted claim (see 09-STATIC-RUNTIME-RECONCILIATION.md).

# 06 — Spaces functionality (Phase 6)

_Observability (Phase 7) is in 07-OBSERVABILITY.md; both were produced by one workstream against the live isolated server via HTTP + code + DB fixtures. No browser was connected, so all visual/focus/screen-reader/mobile behaviour is UNVERIFIED._

## PHASE 6 — SPACES FUNCTIONALITY

### 6.1 Customer page inventory (as jane)

Method: `GET` each page with jane's cookie + `X-Forwarded-For: 10.5.0.10`, record status / bytes / redirect / `<title>`.

| Page | Status | Bytes | Note |
|---|---|---|---|
| /dashboard (My Space) | 200 | 39,047 | renders; FicoCard/credit refs present |
| /dashboard/brief | 200 | 36,983 | `<title>Daily Brief · Fourth Meridian</title>` |
| /dashboard/analyze (AI) | 200 | 43,648 | renders |
| /dashboard/connections | 200 | 42,690 | renders |
| /dashboard/credit | 200 | 111,735 | renders (orphaned page, FICO/utilization markers present) |
| /dashboard/spaces | 200 | 69,325 | "Create Space" marker present |
| /dashboard/settings | 307 → /dashboard/settings/account | — | correct redirect |
| /dashboard/settings/account | 200 | — | |
| /dashboard/settings/security | 200 | 55,743 | |
| /dashboard/settings/preferences | 200 | 45,978 | |
| /dashboard/settings/notifications | 200 | 45,578 | |
| /dashboard/settings/data (Data & Privacy) | 200 | — | real route is `/settings/data` |
| /dashboard/settings/archived-assets | 200 | — | |
| /dashboard/platform | 200 | 53,671 | jane has grants ⇒ no redirect |

- **Expected:** all customer pages 200 with shell/content.
- **Actual:** every page renders 200 (settings index is a 307 to /account by design). The scorecard's page list uses "Data & Privacy" = route `/dashboard/settings/data` (my first probe of `/settings/data-privacy` 404'd — that was my wrong path, not a product defect).
- **Classification: CONFIRMED** (pages render with content). Server-rendered HTML only; **rendering/focus/SR UNVERIFIED** (no browser). The "error" tokens grep found in HTML are minified JS identifiers, not error states.

### 6.2 Permission enforcement at runtime — the UI-001 core claim

Method: same route hit as john (PLATFORM_OPS READ), alex (no grants), jane (CONTROL + multi-area WRITE). State-changing POSTs carried `Origin: http://127.0.0.1:3100`. Mutation gate tested with a nonexistent id (the gate fires before id resolution).

| Route | Verb | john (READ) | alex (none) | jane (CONTROL/WRITE) |
|---|---|---|---|---|
| /api/platform/platform-ops/overview | GET | **200** | **403** | 200 |
| /api/platform/security-ops/anomalies | GET | **403** (no SECURITY_OPS grant) | — | 200 (jane has SECURITY_OPS READ) |
| /api/platform/customer-success/customers | GET | **403** (no CS grant) | **403** | 200 (jane CS WRITE) |
| /api/platform/platform-ops/operations | POST `{commandId}` | **403** | **403** | **200 accepted** |
| /api/platform/customer-success/customers/[id]/refresh | POST | **403** | **403** | — |
| /api/platform/growth-revenue/requests/[id]/approve | POST | **403** | **403** | — |

jane (CONTROL) accepted mutations (harmless, no data change):
- `POST operations {commandId:"dry-run:evaluate-alerts"}` → **200**, `outcome:"planned"`, `writesJobRun:false` (preflight only, touches no data).
- `POST operations {commandId:"run-now:evaluate-alerts"}` → **200**, `outcome:"executed"` (idempotent evaluator; used for Phase 7).

- **Expected (static audit §1):** server gates every GET at READ and every mutation at `requireFreshPlatformAccess(WRITE|CONTROL)`, independent of what the widget renders.
- **Actual:** exactly as claimed. READ holders and no-grant users are refused **403 by the route** on every mutation sampled, and cross-area READ is refused (john has no SECURITY_OPS/CS). A WRITE/CONTROL holder's mutation is accepted.
- **UI-001 verdict:** the widget rendering a WRITE control to a READ holder is **cosmetic only — the server refuses the action (403).** The static audit's central authorization claim is **CONFIRMED**; UI-001 as a *security* finding is **REFUTED** (it is a UX/clarity defect, not an enforcement gap). Severity should sit at P3 UX.
- **Reproducibility:** deterministic (10+ calls across three identities).

### 6.3 Membership enforcement on customer Space data routes

Method: as jane, GET data routes for **John's Space** (`cmviisb7s001i…`, jane not a member) vs **Jane's Space** (member). Jane memberships confirmed in DB: OWNER/ADMIN/MEMBER of 6 of 14 Spaces; not a member of John's Space, JD Freelance, Rtv's Space.

| Route (suffix on /api/spaces/[id]) | Non-member (John's Space) | Member (Jane's Space) |
|---|---|---|
| (base) | **403** `{"error":"Forbidden"}` | 200 |
| /accounts/detail | **403** | 200 |
| /transactions/query | **403** | 200 |
| /activity | **403** | 200 |
| /perspectives | **403** | — |
| /snapshots | **403** | — |

- **Classification: CONFIRMED.** Every `/api/spaces/[id]/*` re-runs the membership check; a non-member is uniformly refused 403. No cross-customer data leaked.

### 6.4 UI-006 / UI-007 — silent failure / no error boundary

Method: code read (`lib/space/use-space-data.ts`) + the non-member 403 probe above + `find app -name error.tsx|loading.tsx|not-found.tsx`.

- `lib/space/use-space-data.ts`: a **non-ok response is folded to an empty payload** — `:229` `(r.ok ? r.json() : { snapshots: [] })`, `:255` `… : { transactions: [] }`, `:277-278` sections/accounts `… : []`; the `.catch` blocks (`:235,:264`) set `setSnapshots([])` / `setTransactions([])`. A 403/500 on a data route therefore renders as "no data", **indistinguishable from a genuinely empty Space**.
- `find app … error.tsx|loading.tsx|not-found.tsx` → **only `app/global-error.tsx`** (which drops the chrome). No per-route `error.tsx` or `loading.tsx` anywhere.
- Runtime: a non-member data route returns 403 (§6.3), which the client code path folds to `[]`.
- **Classification: CONFIRMED from code** (fold-to-empty + no error boundary). **Runtime *visual* rendering of the false-empty state is UNVERIFIED** (no browser; and I did not induce a data-route 500 for a Space jane *is* a member of, because that would mean breaking the shared server — out of scope by the rules).
- **Remediation:** add `error.tsx`/`loading.tsx` to the dashboard segment; surface fetch failures distinctly from empty (an error banner + retry), rather than `catch → []`.

### 6.5 Write-origin (CSRF) enforcement — runtime observation

Method: `POST operations` as jane with (a) no Origin header, (b) a mismatched Origin.
- No Origin header → **200** (allowed).
- `Origin: https://evil.example.com` → **403** `{"error":"cross_origin_write_refused","reason":"origin-mismatch"}` (`lib/security/write-origin.ts:59,91,128`).
- **Classification: CONFIRMED.** The write-origin check is a *mismatch* check: a present-but-wrong Origin (the cross-site browser attack shape) is refused; an **absent** Origin is allowed (legitimate non-browser clients). Correct CSRF posture; record as a runtime observation, not a defect. (`origin-null` is also refused per code; a truly absent header is not.)

### 6.6 API/UI consistency spot-check (route JSON vs widget expectation)

| Route | Top-level keys returned | Note |
|---|---|---|
| /platform-ops/plaid-usage | `checkedAt, population, cycles, priceAuthority, limits` | `cycles` len 2 ⇒ the scorecard's unguarded `cycles[0]` (`:57,64`) did **not** throw here; defect needs an *empty* `cycles` edge case to trip — **not reproduced** at runtime |
| /platform-ops/scheduler | `observed, expected, notes, window, checkedAt` | matches widget |
| /platform-ops/refresh/summary | `executions, byStatus, byTrigger, …, checkedAt` | matches widget |
| /api/spaces/[id]/activity | `{ events: [...] }` | matches ActivityWorkspace |

- Every platform payload carries `checkedAt` — confirming the scorecard's **freshness** observation: the age data is *in the payload* but widgets freeze "N ago" at mount (rendering UNVERIFIED without a browser). **Classification: SUPPORTED** (shapes consistent; the `plaid-usage` empty-cycles crash is PARTIAL/unreproduced).

---


## Per-Space scores (static vs runtime)
### Per-Space (Phase 6) — runtime adjustments only; unlisted categories unchanged from the scorecard

| Space | Static overall | Runtime finding | Runtime overall | Confidence | Uncertainty |
|---|---|---|---|---|---|
| My Space | 6.4 | Permission enforcement **CONFIRMED** (membership 403 on all non-member routes); silent-failure fold **CONFIRMED in code**; error-handling score (3) holds | **6.4** (perm-enforcement confidence ↑ to high; error-handling unchanged) | high on auth/membership; med on UX | rendering/focus/SR/mobile UNVERIFIED; member-space 500 not induced |
| Brief | 7.8 | page 200, title correct; not deep-probed (AI workstream owns generate) | 7.8 | med | generate path not exercised here |
| AI (Analyze) | 7.5 | page 200; routes owned by AI workstream | 7.5 | med | not exercised here |
| Connections | 7.3 | page 200 | 7.3 | med | Plaid paths not exercised (dummy creds) |
| Spaces mgmt | 6.2 | page 200, membership gating confirmed | 6.2 | med-high | accept/decline UX UNVERIFIED |
| Credit | 4.6 | page **renders 200** (orphaned but reachable) | 4.6 | med | legacy markup UNVERIFIED |
| Settings | 7.1 | all sub-pages 200; index 307→account correct | 7.1 | med-high | session/TOTP flows not driven |
| Platform Operations | 7.0 | **Permission enforcement CONFIRMED at runtime** (R/FW/FC all enforced server-side; UI-001 is cosmetic); freshness `checkedAt`-in-payload confirmed | **7.2** (permission-enforcement 9 confidence → high; UI-001 downgraded to P3 UX) | high on auth; med on UX | widget rendering UNVERIFIED |
| Security Ops | 6.6 | cross-area READ gating confirmed (john 403, jane 200) | 6.6 | high on auth | read-only Space |
| Growth & Revenue | 5.9 | mutation gates 403 for READ/none (approve) | 5.9 | high on auth; med UX | one-click UX UNVERIFIED |
| Customer Success | — | mutation + GET gates 403 for non-CS; jane WRITE 200 | — | high on auth | fabricated-reason UX UNVERIFIED |

**UI-001 reclassified:** server enforcement CONFIRMED ⇒ UI-001 is a **UX clarity defect (P3)**, not a security gap. **UI-006/UI-007 CONFIRMED (code)**, runtime-visual UNVERIFIED.

