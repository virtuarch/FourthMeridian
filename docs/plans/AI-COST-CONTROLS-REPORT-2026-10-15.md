# AI COST CONTROLS + OPENAI ENVIRONMENT SEPARATION — MILESTONE REPORT (2026-10-15)

**Program:** owner-authorized post-beta milestone (brief of 2026-10-15). **Branch:** `v2.6` (integrated from `aicost/base`). **Base:** docs HEAD `3e91562`, verified application baseline `1c04752`. **Coordinator:** the lead session; agents A (policy backend + enforcement), B (Platform Ops UI + Economics), C (OpenAI environment separation). **Contract:** [coordination](AI-COST-CONTROLS-COORDINATION.md). **State of record:** [`/STATUS.md`](../../STATUS.md).

**Production:** untouched. No deployment, migration, seed, configuration, credential or data change on Production. Everything below is Dev-built, locally gated, and Preview-deployed/verified only as §8 states.

**Evidence labels:** VERIFIED = run or read by the coordinator (output in hand) · AGENT-REPORTED = stated in an agent hand-off and not independently re-run · NOT VERIFIED = not exercised.

---

## 1. Feature summary

**Platform Operations → Policies → AI Cost Controls** (editable, CONTROL-gated, reason-required, audited; no code, env or redeploy needed to change a policy):

| Control | Setting key | Default | What it does |
|---|---|---|---|
| Per-user daily AI allowance — enforcement | `ai_daily_allowance_enforced` | on | Off ⇒ the `ALLOWANCE_EXHAUSTED` refusal is withheld; usage and estimated cost are still recorded; pricing validation (`UNPRICED_MODEL`, the provider chokepoint) stays |
| Per-user daily AI allowance — platform value | `ai_daily_allowance_usd` | $5 / UTC day | The platform-wide allowance; integer 1 … catalogue ceiling ($20, derived not copied) |
| Per-user spending alert — enabled | `alert_rule_enabled:ai-spend-user-high` | on | The alert engine's own enable key for the split rule |
| Per-user spending alert — threshold | `ai_spend_alert_user_usd_24h` | $3 / rolling 24 h | existing key, now editable here |
| Fleet spending alert — enabled | `alert_rule_enabled:ai-spend-fleet-high` | on | fleet = customer surfaces (Conversations + Daily Brief); harness/unattributed traffic is overhead, never fleet |
| Fleet spending alert — threshold | `ai_spend_alert_fleet_usd_24h` | $10 / rolling 24 h | existing key, now editable here |
| **Pause paid AI requests** (emergency) | `ai_paid_requests_paused` | off (absent) | Judged in the Conversations and Daily Brief routes before the allowance AND at the provider chokepoint (harness too); 503 `AI_PAUSED` with a customer sentence; unreadable ⇒ paused (fail closed); no overlay or override lifts it; Pause/Resume both confirmation-gated; the emergency card has exactly those two actions |

**Per-customer allowance override** (Customer Success → customer → policy): `CustomerPolicyAssignment.aiDailyUsdAllowanceOverride` (the one additive migration), set/removed through the existing audited assignment service with a reason, refused above the ceiling (never silently clamped), audited as `CUSTOMER_AI_ALLOWANCE_OVERRIDE_CHANGED`. **Precedence** (one pure function used by enforcement and every operator view): `USER_OVERRIDE > OVERLAY > PLATFORM_SETTING > POLICY`, then the catalogue ceiling clamps last. The kill switch is judged before any of it.

**Platform Operations → Economics → AI Budget:** fleet rolling-24 h estimate vs the fleet threshold with utilization; paused/enforced state words; per-customer rows (opaque refs) with today's spend vs that customer's effective allowance and rolling-24 h vs the per-customer threshold; spend by surface (customer vs overhead); unpriced-usage warning (never $0); recent alert deliveries (past, never "open"); every figure labelled an estimate from the rate card, never provider billing.

**Alert split:** `ai-spend-high` → `ai-spend-fleet-high` (fleet + unpriced-coverage warning) and `ai-spend-user-high` (per customer); dedupe families and the 20 h suppress-while-open window unchanged ⇒ idempotent; disabling a rule changes evaluation only.

**Concurrency (bounded, stated honestly):** the allowance decision runs in one short `fm_system` transaction under `pg_advisory_xact_lock(hashtext('ai-allowance:'||userId))`, counting in-flight turns (a `RateLimit` counter `user:ai-inflight:<userId>`, current + previous hour bucket, released in the routes' `finally`, self-healing within 2 h) at a reserve derived from the rate card (gpt-5.1 × 6 invocations ≈ $0.315). Guarantee: **admitted spend ≤ allowance + Σ(actual turn cost − reserve) over concurrently admitted turns** — overshoot bounded per concurrent turn, **not an absolute hard cap**. If the transaction cannot run the verdict falls back to the stale-sum check and says so (`reservation: "UNAVAILABLE"`).

**Caching:** nothing is cached. The kill switch is read per route call and per provider call; the enforcement flag and the spend inside the reservation transaction; the platform allowance with each request's entitlement load; the alert-enabled keys per evaluation cycle; `AI_RATES` is code. A change is in force for the very next decision (pinned by test; stated in the read model's `propagation` note).

**OpenAI environment separation (code side):** one credential seam (`lib/ai/openai-credentials.ts`) with one key name and no fallback; optional `OPENAI_PROJECT_ID` pin passed to the SDK (`OpenAI-Project` header); optional `OPENAI_EXPECTED_ENVIRONMENT` guard that refuses a record copied to another environment before any call; `organization` and `baseURL` pinned so the SDK's own `OPENAI_ORG_ID` / `OPENAI_BASE_URL` side channels cannot decide; service-account keys (`sk-svcacct-`) recognised as project-scoped; a value-free "OpenAI project pin" block in the env-status widget (key kind · `proj_…` in full · guard state; never the key); OpenAI project spend-limit 429 codes classified as QUOTA (no retry). Runbook: [`docs/operations/openai-environment-separation.md`](../operations/openai-environment-separation.md).

## 2. Screens and routes changed

| Surface | Change |
|---|---|
| Platform Ops → Policies | read-only "Cost safeguards" group retired; editable **AI Cost Controls** group (four cards) added below Execution cadence (`AiCostControlsPanel.tsx`, `ai-cost-controls-view.ts`, shared editor grammar in `policy-editor-kit.tsx`) |
| Platform Ops → Economics | new first section **AI Budget** (`ops_ai_budget`, `OpsAiBudgetWidget.tsx`, `ai-budget-view.ts`) — **needs `platform:seed-spaces` on every environment** |
| Platform Ops → Overview → Economics block | one doorway sentence, no new fetch |
| Platform Ops → Providers → Env status | "OpenAI project pin" block |
| Customer Success → customer policy | daily AI allowance override editor (Set / Remove), effective allowance + source |
| Security Ops → operator actions | label for `CUSTOMER_AI_ALLOWANCE_OVERRIDE_CHANGED`; operator-feed labels read "platform policy" |
| `GET/PATCH /api/platform/platform-ops/ai-cost-controls` | new (READ / fresh CONTROL + pacing; `changes[]` in ONE transaction, 200/400/404/409) |
| `GET /api/platform/platform-ops/ai-budget` | new (READ) |
| `POST /api/platform/customer-success/customers/[userId]/policy` | body gains `aiDailyUsdAllowanceOverride?: number \| null` |
| `POST /api/ai/chat`, `POST /api/brief/generate` | kill switch before the allowance (503 `AI_PAUSED`); reservation released in `finally`; `allowance.enforced` honoured |
| `GET /api/platform/platform-ops/ai-spend` | safeguards shape kept, names both rules and the controls route |

## 3. New settings and environment variables

PlatformSetting keys (no migration): `ai_daily_allowance_enforced`, `ai_daily_allowance_usd`, `alert_rule_enabled:ai-spend-user-high`, `alert_rule_enabled:ai-spend-fleet-high`, `ai_paid_requests_paused` — all `OPERATOR_CONFIGURABLE`, `PLATFORM_OPS` / `CONTROL`, resettable (reset = row deleted, default in force with origin DEFAULT). Environment variables (optional, same three names in every environment): `OPENAI_API_KEY` (existing), `OPENAI_PROJECT_ID`, `OPENAI_EXPECTED_ENVIRONMENT`.

## 4. Migration requirements

| Migration | Content | Repo | Dev | Preview | Production |
|---|---|---|---|---|---|
| `20261016000000_customer_ai_allowance_override` | `ALTER TABLE "CustomerPolicyAssignment" ADD COLUMN "aiDailyUsdAllowanceOverride" INTEGER;` — additive, nullable, no backfill, no index, table-level grants unchanged (RLS needs nothing); rollback in the README (`DROP COLUMN`) | ✔ | applied 2026-10-15 19:57Z (`db:migrate:safe`, backup `backups/fintracker-2026-10-15T19-56-58-351Z.sql`; column verified) | applied 2026-10-15 20:11Z (`db:migrate:safe`, backup `backups/postgres-2026-10-15T20-11-33-588Z.sql`, "All migrations have been successfully applied", 126 finished; column verified) — ahead of the code push, old-client compatible | **not applied — prohibited** |

Seeds: `ops_ai_budget` section on Dev (`platform:seed-spaces`, row verified on the Platform Operations Space) and on Preview (`platform:seed-spaces` 2026-10-15 20:12Z; `ops_ai_budget` row verified on the Platform Operations Space, enabled). Old-client compatible: the column is nullable and the old code never selects it.

## 5. Authorization review

- Every new Platform Ops read starts with `requirePlatformAccess("PLATFORM_OPS", "READ")`; the PATCH requires `requireFreshPlatformAccess("PLATFORM_OPS", "CONTROL")` plus the `platform-policy` pacing window — READ and WRITE holders receive 403 (route pins; CONTROL-route census re-pinned to three routes).
- The per-customer override rides the existing `CUSTOMER_SUCCESS` WRITE fresh-access route and the one audited assignment service; above the ceiling is refused at the service, and the resolver clamps as belt-and-braces — no accidental escalation.
- `canControl` only decides whether an affordance renders; the server re-validates every rule. The panel takes the flag as `editable` so the capability ratchet keeps one consumer.
- Identity minimisation preserved: PLATFORM_OPS surfaces carry opaque refs (`user …abc123`), operator display names never emails; Customer Success keeps usernames.
- The kill switch has no exemption: no overlay, override or SYSTEM_ADMIN lifts it.

## 6. Audit review

Every control change writes one `PLATFORM_POLICY_CHANGED` / `PLATFORM_POLICY_RESET` row per control through `recordOperatorAction` in the same transaction as the setting write: actor (operator id, via, area), target `PLATFORM_SETTING` + key, reason `{ code, note? }` (required), `change.before/after = { value, origin, updatedAt }`, detail `{ control, settingKey }`, result, ip/user-agent. The override writes `CUSTOMER_AI_ALLOWANCE_OVERRIDE_CHANGED` (reason-required; admitted to the operator feed and the Security Ops feed). No secret, prompt, email or free dollar figure is in any row (observability-privacy and operator-action ratchets green). Allowance and pause refusals write no audit row (no fitting action; observable by response code and the chokepoint's `FAILED/AI_PAUSED` ledger row) — unchanged from the beta posture.

## 7. Tests, typecheck, lint, local CI, clean build

Agent suites (AGENT-REPORTED, every file re-run green in the coordinator's full run below): A — cost-controls 58, paid-requests-admission 30, allowance-reservation 21, ai-budget 18, plus platform-settings, alerts, allowance, resolve, assign, rate-limit-retry extended; B — ai-cost-controls 94, ai-budget 36, policies 81, ai-economics-activity 70; C — openai-credentials 68, env-status-view 16, env.validate 30 cases.

Coordinator (VERIFIED): `npx tsc --noEmit` on the merged tree: 0 errors outside `tmp/` / `prototype/`. Full `npm run test:unit` (Node 24) on the merge `83666f3`: **737/738 files** — the one red file (`lib/platform/policies/refresh-policies.test.ts`, three source-scan pins written for the pre-rewrite widget layout) re-pinned in `9640df4` and green alone; eslint clean on the four coordinator-touched files.

**Gates on the integration HEAD `9640df4` (VERIFIED, output in hand):**
- Clean-copy `npm run ci` (Node 24.21.0): **PASSED every job** — unit **738/738** files, typecheck, lint; architecture `npm ci` → `prisma migrate deploy` (126 migrations incl. `20261016000000` on a throwaway `postgres:16`) → `db seed` → `audit:ci` → RLS **34/34 · 98/98 · 72/72 · 20/20 · 67/67**; site verify (test, typecheck, lint, clean-env build).
- Clean production build (`next build` from the detached `FourthMeridian-build` worktree at `9640df4`, its own `npm ci`): **compiled successfully** (22.6 s).
- Push / GitHub Actions: `git push origin b770d71:v2.6` (`3e91562..b770d71`). **GitHub CI run 38800946139 on `b770d71`: `success`** — `test`, `Architecture audits`, `Public site (zero-authority boundary)` all success; STATUS drift guard 38800946081 `success` (VERIFIED from the runs). Fixes: `git push origin a01bbbb:v2.6` (`b770d71..a01bbbb`) after clean-copy `npm run ci` on `a01bbbb` **PASSED** (738/738, typecheck, lint, audits, RLS 34/98/72/20/67, site); **GitHub CI run 38803837912 on `a01bbbb`: `success`** (all three jobs), drift guard 38803837844 `success` (VERIFIED).

## 8. Preview verification

**Deployment.** Vercel Preview `fintracker1-ilvun8vig` built from the push, Ready, aliased to `preview-app.fourthmeridian.com`; `/api/health` → `{"status":"ok","db":"ok","commit":"b770d71"}` (VERIFIED, owner's signed-in session). The fixes: Preview `fintracker1-ck45gn5va`, `/api/health` → `commit: "a01bbbb"` (VERIFIED). Preview DB: the migration applied before the push and the `ops_ai_budget` row seeded (§4); no AI setting rows existed before the pass (defaults in force).

**Browser + API pass (owner's session, desktop ~1160 px; the API calls were made from the page with the session cookie, i.e. the same authority the UI has; server truth read back after every UI action):**

| Area | What was exercised | Result |
|---|---|---|
| Policies → AI Cost Controls | The group renders below Execution cadence with the propagation sentence ("Nothing here is cached …"), four cards with value, origin chips (Default/Setting/Max), provenance, rule id + status, the enforcement note, and Edit / Restore defaults only for the CONTROL operator | VERIFIED |
| Validation before submission | Allowance platform value typed as 25 ⇒ inline "Must be between $1 and $20.", Save disabled; nothing posted | VERIFIED |
| Allowance platform value | 7 + reason `testing` + Save ⇒ server read model: value 7, origin SETTING, `updatedByName` the operator, `effectiveDefaultUsd` 7 from PLATFORM_SETTING; AI Budget's customer row immediately shows allowance $7 / PLATFORM_SETTING; one `PLATFORM_POLICY_CHANGED` row (target `ai_daily_allowance_usd`, before DEFAULT/null → after SETTING/"7", reason, control `allowance.usd`) in `AuditLog` and in the operator feed as "Changed a platform policy" | VERIFIED |
| **Kill switch — enforcement** | "Pause paid requests" ⇒ armed editor (Paused selected, the customer sentence, the confirmation sentence), reason, **Confirm pause** ⇒ read model paused=true origin SETTING; **`POST /api/ai/chat` → 503 `{ error: "AI features are paused for maintenance. Nothing was changed. Please try again later.", code: "AI_PAUSED" }`; `POST /api/brief/generate` → the same 503**; no ledger row written (the routes refuse before the chokepoint). "Resume paid requests" ⇒ armed editor, reason, **Confirm resume** ⇒ paused=false; the same chat POST then proceeds past the switch (400 on a deliberately malformed body, i.e. the body is parsed AFTER the switch), and a well-formed turn **returns 200** with an answer; the ledger gains one `chat · RETURNED` row and AI Budget's today figure rises ($0.036 → $0.059, 0.8 % of $7) — the reservation was taken and released. Two `PLATFORM_POLICY_CHANGED` rows for `ai_paid_requests_paused` (null→"true", "true"→"false") | VERIFIED |
| Per-customer override — enforcement | Customer Success → customer → "Daily AI allowance override (USD)" 10 + reason `testing` + Set override ⇒ `CustomerPolicyAssignment.aiDailyUsdAllowanceOverride = 10` (read in the Preview DB); AI Budget customer row allowance **$10 / USER_OVERRIDE**; Policies read model `overrides.count` 1 with the opaque ref; the detail JSON carries `aiDailyUsdAllowanceOverride: 10` and `aiDailyAllowance { usd 10, source USER_OVERRIDE, ceilingUsd 20, platformUsd 7, policyUsd 5 }`. **Above the ceiling: `aiDailyUsdAllowanceOverride: 25` ⇒ 400 "The allowance override cannot exceed the platform ceiling of 20."** Remove (null) ⇒ effective back to $7 / PLATFORM_SETTING. Audit: the first write created the assignment row ⇒ `CUSTOMER_POLICY_ASSIGNED` carrying `aiDailyUsdAllowanceOverride: 10` in `change.after`; the removal ⇒ **`CUSTOMER_AI_ALLOWANCE_OVERRIDE_CHANGED`** with before 10 → after null and the note | VERIFIED. **Finding P1:** the Customer Success detail showed "Effective allowance not reported by this build." — the widget read a provisional field name (`policy.aiDailyUsdAllowance`) while the server serves `policy.aiDailyAllowance` + `policy.aiDailyUsdAllowanceOverride`; display only, the write and the server-side resolution were correct. Fixed in `71dd722` (**VERIFIED on Preview `a01bbbb`: the detail reads "$5 per UTC day (policy group) · no override · estimated"**) |
| Per-user spending alert | Edit ⇒ Disabled + threshold 4 + reason ⇒ read model enabled=false (SETTING) threshold 4; **the alert engine's own rule list (`/platform-ops/alerts`) shows `ai-spend-user-high` enabled=false while `ai-spend-fleet-high` stays enabled** — the engine reads the same key; one `PLATFORM_POLICY_CHANGED` row per control | VERIFIED |
| Restore defaults | Restore defaults on the per-user alert card ⇒ armed editor, reason, **Confirm restore** ⇒ both rows deleted (enabled true / DEFAULT / updatedAt null; threshold 3 / DEFAULT); `PLATFORM_POLICY_RESET` ×2 in the feed; the allowance platform value restored through the same PATCH (`value: null`) ⇒ $5 / DEFAULT / effective default POLICY; `PLATFORM_POLICY_RESET` ×1 | VERIFIED |
| Optimistic concurrency + invalid value | PATCH with a stale `expectedUpdatedAt` ⇒ **409 CONFLICT naming `allowance.usd`** with the canonical model; `fleetAlert.thresholdUsd: 0` ⇒ **400 VALIDATION "Value must be at least 1."**; nothing written either time | VERIFIED |
| Persistence after refresh | Policies reloaded ⇒ the current state renders (allowance Default $5, alerts Enabled, pause Admitting); every value above was read back from the server, not the client | VERIFIED |
| Economics → AI Budget | First section on Economics: fleet rolling-24 h **$0.06 · 1 % of the $10 fleet alert threshold · estimate, not a bill**, controls in force (Admitting · Enforced · default $7 at the time), overhead "none in the window — harness and unattributed, never fleet", one customer row as an opaque ref (today vs allowance, rolling 24 h vs alert), by surface (chat · brief customer; harness · other overhead), recent spending alerts | VERIFIED |
| Env-status / OpenAI credential kind | `GET /platform-ops/env-status` → `openAi: { keyConfigured: true, keyKind: "project", projectPin: unpinned, expectedEnvironment: unset (actual "preview"), refused: false }` — the current Preview key is the pre-split `sk-proj-` key, so the service-account label can only be seen once the owner installs the `fm-preview-backend` key (unit-pinned: `sk-svcacct-` ⇒ "service-account key (project-scoped)"). **Finding P2:** the standalone env-status widget is absorbed by Platform Health (`lib/platform/workspaces.ts`) and is never composed, so Agent C's "OpenAI project pin" block was reachable only through the API. Fixed in `a01bbbb`: Platform Health's environment source now lists the three value-free lines (**VERIFIED on Preview `a01bbbb`: Platform Health → Configuration → Environment lists "OpenAI · OpenAI key: project key (project-scoped)", "OpenAI · Project pin: unpinned — usage lands in the key's own project", "OpenAI · Environment guard: unset — a copied record would be accepted"; no key value anywhere**) | VERIFIED (API and, after `a01bbbb`, the Platform Health rows) |
| Unauthorized change | Not exercisable in the browser (only the owner's CONTROL session exists on Preview); READ/WRITE ⇒ 403 is pinned by the route tests and the CONTROL-route census (§5) | NOT VERIFIED in browser |
| Cosmetic | At ~1160 px the three alert/allowance cards' KeyRow values sit close to their labels ("Enabled" beside "Per-customer AI spend alert enabled"); legible, not overlapping at desktop widths above it | noted |

**State left on Preview:** every test value restored (allowance platform value DEFAULT $5; both alerts DEFAULT; override removed); the `ai_paid_requests_paused` row remains with value `false` (origin SETTING — "Admitting"), which is equivalent to absent. Ledger: one real `chat · RETURNED` row from the admitted turn (≈ $0.02 estimated).


## 9. OpenAI project setup (owner)

The three projects and service accounts exist (owner, 2026-10-15): `fourth-meridian-dev` / `fm-dev-backend`, `fourth-meridian-preview` / `fm-preview-backend`, `fourth-meridian-prod` / `fm-prod-backend`; keys generated and retained by the owner. What the owner enters, where (runbook §2.1–§3):

- **Development** — `/Users/chrstn/dev/FourthMeridian/.env.local`: `OPENAI_API_KEY` (the `fm-dev-backend` key), `OPENAI_PROJECT_ID` (`proj_…` of the dev project), `OPENAI_EXPECTED_ENVIRONMENT=development`; restart `next dev`.
- **Preview** — Vercel `fintracker1` → Settings → Environment Variables → Preview, branch `v2.6`, Sensitive: the same three names with the `fm-preview-backend` key, the preview `proj_…`, `preview`; or `vercel env add <NAME> preview v2.6` (value typed at the prompt); **redeploy `v2.6`**.
- **Production** — **NOT AUTHORIZED in this milestone**; documented as owner-only for later.
- **Verify** (key-free): env-status widget shows the pin and guard; one AI turn; OpenAI Usage filtered by project **and** service account shows it; the ledger's `environment` count for the same window matches (runbook §4–§5).
- **Budgets** (OpenAI alerts notify; hard limits are soft-edged monthly 429 stops, not guaranteed caps; the app allowance + kill switch are the enforcement): dev $10 alert / $25 hard · preview $5 / $15 · prod $60 / $150 (runbook §6 derivation).
- **Legacy key:** the pre-split key is still Production's key and **must not be revoked** until Production has moved to `fm-prod-backend` (later, owner only).

**The OpenAI project split is NOT complete** until the owner has entered the records and the routing is verified per §4–§5 of the runbook (owner-state table §8 there: keys generated · env records pending · routing verified NO).

## 10. Remaining owner-only actions

1. Enter the Development and Preview OpenAI records (§9), redeploy Preview, verify attribution, share the two `proj_…` ids so the runbook's §8 table can record them.
2. Set the OpenAI per-project spend alerts and hard limits (§9).
3. Review the provisional thresholds after the first beta week — now from Policies → AI Cost Controls, no code change.
4. Production: every step (migration, seed, env records, deploy) needs explicit authorization; nothing was done.

## 11. Deliberate omissions and residuals

- Allowance / pause refusals write no AuditLog row (as in the beta); the chokepoint writes a `FAILED/AI_PAUSED` ledger row.
- The concurrency guarantee is bounded, not absolute (§1); the reserve is a code constant derived from the rate card and pinned to the chat model.
- A pause landing between the Brief route's check and generation surfaces through the Brief lifecycle as a provider error ("Couldn't update"), the same as any provider throw.
- The `sk-svcacct-` prefix is owner-stated, not found in OpenAI's docs; both prefixes are accepted as project-scoped and a different real prefix would be cosmetic only.
- `platform.openai.com/docs` and `help.openai.com` refused fetches; the mismatch-project 401 code is inferred from a community thread, the rest is confirmed from `developers.openai.com` (runbook §1.6).
