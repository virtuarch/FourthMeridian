# OpenAI environment separation: one project per environment (Agent C, AI COST CONTROLS, 2026-10-15)

**Scope.** How the application loads its OpenAI credentials, where each deployment environment obtains them, what the code now refuses, and the owner's checklist for moving from one shared key to three OpenAI projects — `fourth-meridian-dev`, `fourth-meridian-preview`, `fourth-meridian-prod` — each with its own key, budget and alert. Companion to `environment-separation.md` (§4 matrix row `OPENAI_API_KEY`, §7) and the coordination doc `docs/plans/AI-COST-CONTROLS-COORDINATION.md`.

**Status.** Code and tests landed on `aicost/c`. **Nothing here is complete until the owner has created the three projects, placed each project's key, project id and expected-environment guard on that environment's own Vercel record, and the routing has been verified per §4–§5.** Production steps are **NOT AUTHORIZED** in this milestone and are marked as such.

**Evidence labels** (reused from `environment-separation.md` §1): **PROVEN** = read from source, a test, or a machine-checked fact · **OWNER-STATED** = the owner said so and no machine check can confirm it · **OPENAI-DOCS** = read on OpenAI's public documentation on the date given · **INFERRED** = a reasonable conclusion that no source states outright.

## 1. Findings — how credentials are loaded today

### 1.1 One SDK import, one seam, one key name (PROVEN)

| Fact | Where | Pinned by |
|---|---|---|
| The OpenAI SDK (`openai` 6.45.0) is imported in exactly one file | `lib/ai/provider.ts:18` | `lib/usage/ai-tokens.test.ts:140` (one `from 'openai'`), `lib/ai/openai-credentials.test.ts` §7 (one `new OpenAI(`, no other file constructs a client) |
| The client is a lazy singleton built from `resolveOpenAiCredentials()`; it passes `apiKey` and, when pinned, `project` | `lib/ai/provider.ts:37-45` | `openai-credentials.test.ts` §7 ("passes apiKey and project from the seam"; the provider never reads the key itself) |
| The seam reads exactly one key variable, `OPENAI_API_KEY`, from the env map it is given; the only `process.env` in the module is the injectable default parameter | `lib/ai/openai-credentials.ts` | `openai-credentials.test.ts` §7 ("touches process.env exactly once") |
| No `\|\|` / `??` joins two credential reads anywhere in the seam or the provider; no tracked or untracked source file reads any `OPENAI_*` name other than `OPENAI_API_KEY`, `OPENAI_PROJECT_ID`, `OPENAI_EXPECTED_ENVIRONMENT` | repo grep + scan | `openai-credentials.test.ts` §7 ("no `\|\|`/`??` between env reads"; "no tracked file reads any other OPENAI_* variable") |
| Every other reader of `process.env.OPENAI_API_KEY` is the `lib/env.ts` snapshot (`:62`, for the value-free report and the `env.OPENAI_API_KEY` accessor), three tests that set a dummy (`invocation-failures`, `model-rate-coverage`, `conversation-identity`), and three harness scripts under `scripts/ai-baseline/` that only test presence (`if (!process.env.OPENAI_API_KEY) exit 2`) | repo grep | `openai-credentials.test.ts` §7 ("only lib/env.ts's snapshot and tests/harness read"; "presence test only" per script) |
| The public site's clean-env build scans its emitted output for the NAME `OPENAI_API_KEY` and for a provider-key SHAPE (`sk-(proj-)?…`) and fails on either, and builds in a constructed env with no application variable at all | `site/scripts/clean-env-build.mts:30-36, 79-83` | the site job in CI (`scripts/lib/ci-contract.ts:85`: PATH / HOME / TMPDIR only) |
| `/api/health` never references `OPENAI_API_KEY` and reads only `VERCEL_GIT_COMMIT_SHA` | `app/api/health/route.ts` | `lib/security-surface.test.ts` §4 |

### 1.2 What the SDK does on its own (PROVEN from the installed code — the one subtlety)

`node_modules/openai/client.js:140` (v6.45.0): when a client option is **undefined**, the SDK reads the environment itself — `apiKey` from `OPENAI_API_KEY`, `project` from `OPENAI_PROJECT_ID`, `organization` from `OPENAI_ORG_ID`, `baseURL` from `OPENAI_BASE_URL`, `adminAPIKey` from `OPENAI_ADMIN_KEY`, `webhookSecret` from `OPENAI_WEBHOOK_SECRET`. `client.js:658` sends `project` as the `OpenAI-Project` request header.

Consequences:
- The provider passes `apiKey` and `project` **explicitly** from the seam (`provider.ts:43`), so for those two the SDK's own env read never decides. (If `project` were omitted the SDK would still read `OPENAI_PROJECT_ID` — same value, but outside the seam's validation. The test pins the explicit pass.)
- `organization` and `baseURL` are **not** passed, so the SDK would honour `OPENAI_ORG_ID` and `OPENAI_BASE_URL` if a deployment record carried them. No file in this repository sets or reads them (pinned), `.env.example` does not list them, and no Vercel record is known to carry them (**OWNER-STATED** absence is not available; the owner should confirm neither name exists on any Vercel environment). **Recommendation for the provider's owner (Agent A / coordinator, one line, not made here):** pass `organization: null` and leave `baseURL` to its default explicitly, so the client's authority surface is exactly the seam's two values. Until then this is a documented, unexercised side channel, not a live one.

### 1.3 Where each environment obtains the value

| Environment | Source of `OPENAI_API_KEY` | Evidence |
|---|---|---|
| **Development** (local `next dev`, scripts, tests) | `.env.local` in the checkout (gitignored: `.gitignore:43-46` ignores `.env` and `.env.*`, exempting only `.env.example`). `vercel env pull` with the Development scope writes it there; Vercel marks every variable on this project **Sensitive**, so a pull returns the value **empty** for Preview/Production scopes (`environment-separation.md` §1) — the local key is whatever the owner placed by hand. Tests never need a real key: the three AI test files set `'test-key-never-used'` and inject a fake client; CI's test job has no `OPENAI_*` at all (`.github/workflows/ci.yml`), and `npm run ci` runs the clean copy with only database URLs removed, so a developer's local key would be inherited by a local `npm run ci` test job — harmless because no test calls the provider, but worth knowing. | PROVEN (gitignore, tests, ci contract); the content of the owner's `.env.local` is not read by this lane |
| **Preview** (`preview.fourthmeridian.com`, the `v2.6` git-branch domain) | The Vercel env record of that name targeted **Preview** — its **own record, dated 2026-07-01**, separate from Production's (`environment-separation.md` §4). Branch-specific overrides for `v2.6` exist for `NEXTAUTH_SECRET` and `CRON_SECRET` (§4); `OPENAI_API_KEY` has no such override, so the generic Preview record serves every Preview branch. | Record structure PROVEN (2026-10-06 inventory); **value equality with Production OWNER-STATED** (2026-10-03) |
| **Production** | The Vercel env record of that name targeted **Production** — its **own record, dated 2026-07-02**. | PROVEN record; value OWNER-STATED equal to Preview's. **Not touched in this milestone.** |

**Does the deployment configuration support separate keys?** Yes — **PROVEN by structure**: the two records already exist, one per target, under the same name; separation is a matter of the *values* the owner pastes into them, which no machine check in this repository can read (Sensitive) or compare. What the code adds is a way to *prove the pasted record belongs to the environment it is on* without reading it (§2, the guard) and a way to *see which project it spends in* without reading it (§4–§5, the pin + the ledger + OpenAI's dashboard).

### 1.4 The ledger's `environment` column — the app-side half of attribution (PROVEN)

Every provider call writes one `AiInvocation` row — a `RETURNED` row on the return path, a zero-token `FAILED / TIMEOUT / RATE_LIMITED / QUOTA` row on the throw path — and every row carries `environment: deploymentEnvironment()` (`lib/ai/invocation.ts:158, 192`), i.e. `"production" | "preview" | "development"` from `VERCEL_ENV` on Vercel (`lib/env.ts deploymentEnvironment()`), indexed as `@@index([environment, occurredAt])` (`prisma/schema.prisma`, model `AiInvocation`). Readers: `lib/platform/ai/invocations-core.ts` (`byEnvironment`), `invocation-economics.ts byEnvironment()` (whose header says why the column exists: "one provider account serves local development, preview and production, so without this dimension platform AI spend and production cost-to-serve are the same number"), and `GET /api/platform/platform-ops/ai-invocations?environment=…` (PLATFORM_OPS READ).

Reconciliation per project therefore has two independent sides: **the app's row count and estimated USD per `environment`** (one database per environment, so Preview's ledger holds Preview's rows and Production's holds Production's — the column is belt-and-braces within one database and the cross-check across the three), and **OpenAI's usage dashboard per project**. When the three projects are live, each environment's ledger count for a window must match that environment's project's request count on the dashboard for the same window; a row in the Preview ledger with usage appearing in `fourth-meridian-prod` means the Preview record still carries the Production key.

### 1.5 What the seam now refuses (PROVEN by tests)

`lib/ai/openai-credentials.ts` `resolveOpenAiCredentials(env = process.env, environment = deploymentEnvironment())`, loud at the **first call**, never at import, never printing a value:

| Condition | Result |
|---|---|
| `OPENAI_EXPECTED_ENVIRONMENT` set but not `development` / `preview` / `production` (exact, lower-case) | refused — `OpenAiCredentialsError`, value not shown |
| `OPENAI_EXPECTED_ENVIRONMENT` set and ≠ the deployment environment | refused — message names both environment words (validated, non-secret) |
| `OPENAI_PROJECT_ID` set but not `proj_` + `[A-Za-z0-9]+` | refused — value not shown (a malformed "project id" might be a key pasted in the wrong field) |
| `OPENAI_API_KEY` absent / empty | refused (the pre-existing message) |
| otherwise | `{ apiKey, project: proj_… \| null, keyKind: project \| legacy \| unknown }` |

The guard is checked before the pin and before the key, so a copied record is refused even when its key would have worked. `lib/env.ts validateEnv()` warns loudly at boot on the same three refusal states and **never throws for them** — an AI misconfiguration must not take every route down (the Preview instrumentation-throw incident, `lib/env.ts deploymentEnvironment()` header). `getEnvReport()` carries the same facts (`openAi`) plus three rows `OPENAI_API_KEY` / `OPENAI_PROJECT_ID` / `OPENAI_EXPECTED_ENVIRONMENT`, and the `ops_env_status` widget renders an **OpenAI project pin** block: key shape · pin (`proj_…` in full) · guard. Never the key.

### 1.6 What OpenAI says about the header, the key and the mismatch

- **OPENAI-DOCS, 2026-10-15** — `https://developers.openai.com/docs/api-reference/authentication`: credentials are HTTP Bearer; "pass a header to specify which organization and project to use for an API request" if you belong to more than one organization or use a legacy user key; **"Usage from these API requests counts as usage for the specified organization and project."** The page does **not** state what happens when `OpenAI-Project` and the key's own project disagree, and does not describe the `sk-proj-` prefix.
- **OPENAI-DOCS, 2026-10-15** — `https://developers.openai.com/api/docs/guides/error-codes`: among the 401 causes, "You are using an API key that belongs to a different organization or project" and "You are using a different API key than the one assigned to the requesting organization or project." Mismatch ⇒ **401**, per this page. The page also lists `project_spend_limit_exceeded` / `organization_spend_limit_exceeded` (429) and notes `error.type` may still be `insufficient_quota` — "inspect `error.code`".
- **INFERRED (community report, not official)** — `https://community.openai.com/t/authenticationerror-error-code-401/766947` reports the exact shape: `401 mismatched_project — "OpenAI-Project header should match project for API key"`. Consistent with the official 401 list; the specific `code` string is not in OpenAI's docs and is treated as unconfirmed.
- **PROVEN (installed SDK)** — the pin is sent as the `OpenAI-Project` header (`node_modules/openai/client.js:658`).

**So (b) holds as designed:** with a project key (`sk-proj-…`) and a pin, both go to OpenAI; a pin for a project the key does not belong to is **refused by OpenAI with a 401 before any usage is billed** (official: 401 category; the exact code INFERRED). The seam cannot detect that mismatch offline — only the first call can — which is why §4 verifies with one real turn.

## 2. Exact variable names and configuration locations

| Variable | Development (`.env.local`) | Preview (Vercel env, target Preview, branch `v2.6` domain; Sensitive) | Production (Vercel env, target Production; Sensitive — **OWNER ONLY, NOT IN THIS MILESTONE**) | Who sets it |
|---|---|---|---|---|
| `OPENAI_API_KEY` | the `fourth-meridian-dev` project's service-account key | the `fourth-meridian-preview` project's service-account key (replace the current value on the existing 2026-07-01 record) | the `fourth-meridian-prod` project's service-account key (replace on the existing 2026-07-02 record) | owner, by hand, in the Vercel dashboard — never through chat, a file in git, or a shell history |
| `OPENAI_PROJECT_ID` | `proj_…` of `fourth-meridian-dev` | `proj_…` of `fourth-meridian-preview` | `proj_…` of `fourth-meridian-prod` | owner; **not secret** — may be pasted in chat, appears in full in the widget |
| `OPENAI_EXPECTED_ENVIRONMENT` | `development` (optional locally; recommended so a copied Preview record fails on a laptop too) | `preview` | `production` | owner; not secret |

Rules: exactly these three names, the same in every environment; **no** `OPENAI_API_KEY_PREVIEW`-style suffixes (the scan test refuses any other `OPENAI_*` reader); nothing set in `vercel.json` (it holds crons only); nothing in `.env.example` but the placeholders and comments. The public site (`site/`) must never see any of the three — its build env is constructed (§1.1) and its output is scanned for the key name and the key shape.

## 3. Credential setup checklist for the owner

Never type a key anywhere but the OpenAI dashboard (create) and the Vercel dashboard (paste). Never into chat, a file in the repository, `.env.example`, a Slack message, or a shell command (shell history is a file).

1. **Create the three projects** — platform.openai.com → Settings → Organization → Projects → Create: `fourth-meridian-dev`, `fourth-meridian-preview`, `fourth-meridian-prod`. Note each project's id (`proj_…`, shown on the project's Settings → General page). The ids are not secrets.
2. **One service-account key per project** — in each project: Settings → API keys (or Service accounts) → create a **service account** and its key, named for the environment (`vercel-preview`, …). A service-account key belongs to the project, not to a person, so it survives membership changes. Set the key's permissions to the minimum the app uses: model capabilities (chat completions) only — no Files, no Fine-tuning, no Admin.
3. **Budget and alert per project** — in each project: Settings → Limits → Spend: **Edit spend limit** (the hard monthly limit) and a **spend alert** below it, per §6. Also set an organization-level alert as a backstop (Settings → Organization → Limits).
4. **Development** — put the dev project's key in `.env.local` as `OPENAI_API_KEY`, plus `OPENAI_PROJECT_ID=proj_…` (dev) and `OPENAI_EXPECTED_ENVIRONMENT=development`. Restart `next dev`. Confirm with §4 step 1.
5. **Preview** — Vercel → Project → Settings → Environment Variables: edit the existing `OPENAI_API_KEY` record targeted **Preview** (Sensitive) and replace its value with the preview project's key; add `OPENAI_PROJECT_ID` (Preview, value `proj_…` of the preview project) and `OPENAI_EXPECTED_ENVIRONMENT` (Preview, value `preview`). Redeploy `v2.6` (a new deployment is required; env changes do not reach running deployments). Verify per §4.
6. **Production — NOT AUTHORIZED in this milestone.** When the owner later authorizes it (`production-cutover-plan.md` item 9, "SAFE TO DEFER"): the same three records targeted **Production** with the prod project's key, its `proj_…`, and `production`; redeploy; verify per §4; then **revoke the old shared key** in whichever project it lives in, after confirming Preview no longer uses it (§5). Until then Preview and Production share one project by owner statement, and a Preview compromise can spend from and rate-limit the Production project (`environment-separation.md` §7).
7. **After the switch**, delete the old key from any local file that still holds it, and record the rotation in the incident log if it was exposure-driven (`key-rotation.md` "After ANY rotation").

## 4. Safe verification — non-sensitive identifiers only, no curl, no key

1. **The env-status pin (value-free).** Platform Ops → Platform workspace → *Environment configuration* (`ops_env_status`): the **OpenAI project pin** block must read `project key` · `pinned · proj_…` (the id of the project *for that environment*) · `match · preview` (or `production`, `development`). A `fail` row on `OPENAI_PROJECT_ID` or `OPENAI_EXPECTED_ENVIRONMENT` means the seam is refusing every AI call — fix the record, redeploy. The same facts are in `GET /api/platform/platform-ops/env-status` (PLATFORM_OPS READ), key names and states only.
2. **`/api/health` shows nothing of this** — pinned by `lib/security-surface.test.ts` §4 (no `OPENAI_API_KEY` reference; the only env read is the commit sha). It is the public liveness probe and must stay that way; do not add the pin there.
3. **One AI turn** on the environment (Conversations, any grounded question). Expect a normal answer. A 401 from the provider at this step means key and pin disagree (§1.6) — the pin names a project the key does not belong to; fix the record, never the code.
4. **The ledger side**: Platform Ops → AI workspace → *Invocations* with `environment` = the environment under test and the window `24h`: the turn's `RETURNED` rows (one per model call; a tool-using turn writes several) with `model gpt-5.1`.
5. **The OpenAI side**: platform.openai.com → Usage, filtered by **project** = the environment's project, same window: the same number of requests, and **zero** new requests in the other two projects. The request ids match: the ledger stores `providerRequestId` (the SDK's `_request_id`) on every row, and the dashboard's request log shows the same ids.
6. **Negative control (Preview only, optional):** temporarily set `OPENAI_EXPECTED_ENVIRONMENT=production` on the Preview record and redeploy: the widget shows `mismatch — says production, this is preview; AI calls refused`, a chat turn is refused with the provider-error sentence, and a zero-token `FAILED` row appears in the ledger with no usage in any OpenAI project. Restore `preview`, redeploy.

Nothing in these six steps reads, prints or transmits a key.

## 5. Confirming usage lands in the right project

For a window `W` (start with the 24 h after the redeploy):

| Side | Read | Expect |
|---|---|---|
| App, Preview database | `ai-invocations` widget, `environment=preview`, window `W`: count of `RETURNED` rows and the estimated USD | N rows, $X |
| App, Preview database | same widget, `environment=production` or `development` | 0 rows (Preview's database holds only Preview's rows; a non-zero count here means a Preview deployment classified itself wrongly — `VERCEL_ENV`) |
| OpenAI | Usage → project `fourth-meridian-preview`, window `W` | N requests, cost ≈ $X (the app's figure is an estimate over the rate card, "not a bill") |
| OpenAI | Usage → the project the **old shared key** belongs to, window `W` | no new requests after the redeploy timestamp |
| OpenAI | Usage → `fourth-meridian-prod`, window `W` | **unchanged by Preview activity** |

Repeat with the Production environment only after the owner authorizes the Production step. Do not mark this doc complete until the Preview column reconciles and the old project shows no Preview traffic.

## 6. Recommended project budgets and alerts

### 6.1 What OpenAI's budget feature actually does (OPENAI-DOCS, read 2026-10-15)

`https://developers.openai.com/api/docs/guides/spend-limits`:
- A **spend alert** "Sends a notification; API traffic continues." — **"Spend alerts do not enforce a cap."**
- A **hard spend limit** stops traffic "after tracked spend reaches a configured amount": affected requests fail with **429** and `error.code` `project_spend_limit_exceeded` (project) or `organization_spend_limit_exceeded` (organization). "A project hard limit applies only to API traffic billed to that project"; an organization hard limit "applies to API traffic across all projects in the organization."
- **"Enforcement is not instantaneous, so recorded spend can slightly exceed the configured amount."** The limit resets with the next monthly cycle, or traffic resumes after the limit is raised/removed "after the update propagates."
- Configured at Project settings → Limits → Spend → *Edit spend limit* (project) and platform.openai.com/settings/organization/limits (organization); requires permission to manage those settings.
- `https://developers.openai.com/api/docs/changelog` (OPENAI-DOCS, read 2026-10-15): **Jul 22, 2026** — "Added hard spend limits for organizations and projects on the OpenAI API platform. Set a monthly cap that causes affected API requests to return a `429` error when tracked spend reaches the limit." **Aug 4, 2026** — "Customers can now filter and group data by API key in the Usage and Costs dashboards" (so §5 can reconcile per key as well as per project).

**So, plainly:** the alert is a notification; the hard limit is a soft-edged monthly stop (not instantaneous, may be slightly exceeded, and resets monthly). Neither is the app's enforcement. **The enforcement is in the application:** the per-customer daily allowance (`ai_daily_allowance_usd`, default $5, ceiling $20, judged before any model work), the fleet and per-customer spend alerts (`$10` / `$3` per 24 h), the unpriced-model refusal, and the **kill switch** (`ai_paid_requests_paused`, judged in the routes and at the provider chokepoint) — all in `docs/plans/AI-COST-CONTROLS-COORDINATION.md` §1. OpenAI's project limit is the backstop behind those for the case the application itself is wrong (a routing mistake to a 6× model, a bug in the allowance), and the per-project split is what makes a backstop meaningful: a stop on Preview cannot stop Production.

**One app-side consequence to hand to Agent A** (`lib/ai/rate-limit-retry.ts`, not this lane's file): a project hard-limit 429 carries `code: project_spend_limit_exceeded`, which `isQuotaExhaustedError` does **not** recognise (it matches `insufficient_quota` and three message phrasings), so the retry helper treats it as an ordinary rate limit, **retries it** up to `maxRetries`, and the ledger records `RATE_LIMITED` rather than `QUOTA`. Recommended: add the two `*_spend_limit_exceeded` codes to the quota predicate so a reached limit is recorded as `QUOTA`, not retried, and surfaces on the failure readers as the quota outage it is.

### 6.2 The observed rates the figures are derived from (PROVEN, `docs/plans/AI-PLAID-COST-ECONOMICS-ASSESSMENT.md` §7; readiness report §Growth & Revenue)

- Chat turn on `gpt-5.1` (~80 % cached): **$0.0065 – $0.0116** observed in dogfood ledgers; Daily Brief **$0.003 – $0.005**.
- Per active user per month: AI **$0.18 low / $0.82 baseline / $2.47 high** (20 / 60 / 200 turns + 15 / 30 / 30 Briefs).
- Model-routing shock: `gpt-5.5` at **$0.0741/turn** (6×) ⇒ $4.56 baseline / $14.97 high per active user.
- Observed fleet, all environments on the one shared key, over the beta-readiness window: **AI ≈ $1.11 in 30 days** (readiness report: "cost per engaged user $2.70 … AI $1.11 + Plaid $4.30 ÷ 2"). Harness/eval traffic is engineering overhead and is the dominant *development* cost: a 100-turn eval sweep on the `gpt-5.5` "ceiling" arm is ≈ $7.41.
- In-app ceilings already in force: allowance $5 per customer per day; fleet alert at $10 per 24 h; per-customer alert at $3 per 24 h.

### 6.3 Recommended figures (monthly, USD; review after the first beta month)

| Project | Spend **alert** (notification) | **Hard limit** (429 stop) | Reasoning |
|---|---|---|---|
| `fourth-meridian-dev` | **$10** | **$25** | Local dev + harness/evals. Observed whole-fleet AI is ≈ $1/month; one `gpt-5.5` eval sweep ≈ $7.41, so $25 admits ~3 sweeps before a stop, and a stop here costs nothing but an engineer's afternoon. The alert at $10 is "someone ran a sweep" — expected, visible. |
| `fourth-meridian-preview` | **$5** | **$15** | Browser verification is a handful of turns at ≈ $0.01; crons never run on Preview (`environment-separation.md` §3) and SSO protects it. $15 ≈ 1,300 `gpt-5.1` turns — far beyond any verification session, so a stop means an automation loop or a leaked key. |
| `fourth-meridian-prod` | **$60** | **$150** | Invite-only beta, planning figure ≤ 25 active users: baseline AI 25 × $0.82 = **$20.50**, high 25 × $2.47 = **$61.75**. Alert at ≈ the high case (something is above plan, nobody is harmed). Hard limit ≈ 2.4 × the high case and ≈ 15 days of the in-app fleet alert firing at $10 every day — i.e. the app's own alarms fire for two weeks before OpenAI stops anything. A silent routing mistake to `gpt-5.5` (25 × $14.97 = $374) is stopped mid-month: that is the backstop's job. **Set only when the Production step is authorized.** |

Scaling rule once the cohort grows: **alert ≈ active users × $2.47** (the high case), **hard limit ≈ 2.5 × alert**, floors $20 / $50. Raise the organization-level alert to the sum of the three project alerts. Never set a project hard limit below the app's own daily ceiling × 30 for the environment's expected customers divided by a safety factor — the allowance ($5/day) is per customer and is the thing that bounds a single user; the project limit bounds the fleet.

*Sources note.* The authentication reference, the spend-limits guide, the error-codes guide and the changelog were each read directly on 2026-10-15 (URLs above). `platform.openai.com/docs/...` and `help.openai.com` answered 403 to this lane's fetches; `developers.openai.com` is OpenAI's current documentation host and is what was read. The one non-official source is the community thread for the `mismatched_project` code (§1.6), labelled INFERRED.

## 7. What remains owner-only, and the completion rule

Owner-only (no agent can do these; none was attempted):
- Creating the three OpenAI projects, their service-account keys, their spend alerts and hard limits (§3 steps 1–3).
- Pasting keys into `.env.local` and into the Vercel Preview records; redeploying Preview (§3 steps 4–5).
- Everything on Production (§3 step 6) — **NOT AUTHORIZED in this milestone**; the Production record, project and key are untouched and must stay so until the owner says otherwise.
- Confirming that no Vercel record carries `OPENAI_ORG_ID` or `OPENAI_BASE_URL` (§1.2).
- Revoking the old shared key once Preview is confirmed off it (§5), and later Production.

Not owner-only, handed to the provider's owner (Agent A / coordinator): the `organization: null` line in `provider.ts` (§1.2) and the `*_spend_limit_exceeded` quota classification (§6.1).

**Do not mark this doc, or the OpenAI-separation half of the AI COST CONTROLS milestone, complete until the owner has configured the projects and the routing is verified per §4 and §5: the Preview widget shows the Preview project's pin with `match · preview`, one Preview turn appears in `fourth-meridian-preview` and nowhere else, and the ledger's Preview count for the window equals the dashboard's.** Until then the honest status is: *code and tests landed; Preview and Production share one OpenAI project by owner statement.*
