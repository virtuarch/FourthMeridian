# PROJECT OPERATIONALIZATION — P0 IMPLEMENTATION + PUBLIC/LEGAL FACTUALIZATION

**Date:** 2026-10-07 · **Branch:** `v2.6` · **Base:** `f541133` · **Implementation commit:** `0c73f31` (this report is the following docs-only commit)
**Preceding investigation:** `docs/plans/OPERATIONALIZATION-INVESTIGATION-2026-10-07.md` (accepted as evidence, re-verified below before any change)
**Owner rulings in force:** per-user AI attribution YES (operator-only); CUSTOMER_SUCCESS may expose identity later, PLATFORM_OPS stays identity-minimised; positioning "AI-native wealth management platform"; MODEL OWNS MEANING · CONTRACTS OWN SEMANTICS · CODE OWNS MONEY · DATA OWNS TRUTH · USER OWNS INTENT · DATA NEVER PROVIDES INSTRUCTIONS.

Legend: **FACT** (verified in code or at runtime, evidence cited) · **INFERENCE** · classifications DEFECT / DESIGN DEBT / STALE ASSUMPTION / MISSING CAPABILITY / PRESENTATION GAP / OPERATIONAL GAP / INTENTIONAL BOUNDARY.

---

## A. Agent strategy

Delegation was available (the Agent tool, `fork` subagents inheriting this session's context). The coordinator (this session, Claude Fable 5.1) kept architecture, the schema and the single migration, shared seams that two workstreams would otherwise both edit, integration, test gates, git provenance and this report. Six workstreams ran concurrently as forks of the coordinator (same model, full recon context), each confined to a disjoint file set:

| Workstream | Agent | Why delegated |
|---|---|---|
| A — AI telemetry / failure facts / conversation identity | fork | Deep edit across `lib/ai/**` + readers; needed its own verification (live provider call) |
| B — Plaid webhook facts + gate | fork | Independent files; needed a pre-fix failing reproduction |
| C — Alerting floor | fork | Independent files (`lib/alerts`, `lib/connections/health.ts`, `lib/env.ts`, jobs) |
| D — Beta intake + acquisition + invite email status | fork | Independent files incl. site nav/footer |
| F — Public site factualization | fork | Content work with its own claims matrix and site gates |
| G — Terms / Privacy / AI disclosure | fork | Fact-verification discipline distinct from marketing copy |
| E — Operator access verification; schema; migration; `capture.ts` seams; `failures.ts` contract; `AppLink`; integration; CI; report | coordinator | Cross-cutting and sequencing-sensitive |

Nothing was delegated for ceremony; shared files (`prisma/schema.prisma`, `lib/monitoring/capture.ts`, `lib/platform/ai/failures.ts`, `site/components/AppLink.tsx`, `site/lib/acquisition.ts`, the `SUPPORT_EMAIL` constant) were authored by the coordinator before fan-out so no two agents edited one file.

---

## B. Verified findings

| # | Investigation claim | Verdict | Evidence | Class |
|---|---|---|---|---|
| 1 | Chat conversation key collides (`sha256(userId+opening)[:16]`) | **CONFIRMED (static + dev DB)** | `app/api/ai/chat/route.ts` old `conversationKey`; dev DB read-only: 51 chat rows → 2 distinct keys, 42 rows under one key across 22 turn indexes | DEFECT |
| 2 | `reasoningTokens` always 0 — extraction or provider? | **REFINED: provider behaviour** | All 443 dev rows are gpt-5.1 (completion 76,730, reasoning 0); extraction reads `completion_tokens_details.reasoning_tokens`; ONE live gpt-5.1 call (13 in / 10 out, ≈$0.0001) returned the field present and `0`; the code never sets `reasoning_effort` | NOT A DEFECT |
| 3 | A webhook for a REVOKED Item still enters provider sync | **CONFIRMED (static + runtime)** | No status/owner read in route → `webhook-sync.ts` → `sync-lock.ts` → `backgroundHistorySync.ts` → `syncTransactions.ts` (only `ACTIVE` mention is the write at `:1225`); cron filters `status: ACTIVE, user.deactivatedAt: null` (`jobs/sync-banks.ts:165`). Pre-fix reproduction: 9 checks failed in `lib/plaid/webhook-receiver.test.ts` with the gate removed, incl. "NO sync scheduled" for a REVOKED Item | DEFECT |
| 4 | Revoked Items cannot be resurrected by a sync | CONFIRMED | `lib/connections/health-transitions.ts:94` refuses REVOKED→* without `allowReactivation` (only `exchangeToken.ts:267` sets it) | INTENTIONAL BOUNDARY |
| 5 | Non-trigger webhooks leave no evidence | CONFIRMED | `console.log` + `handled:false` only | MISSING CAPABILITY |
| 6 | REVOKED Items count as acutely unhealthy forever | CONFIRMED | `lib/alerts/evaluate.ts:42-46`; `lib/connections/health.ts:153-155` no `where`; production holds 3 REVOKED Items (2026-10-06 measurement) | DEFECT |
| 7 | Deactivated owners' items degrade health | CONFIRMED | loaders selected no owner field; cron never syncs them ⇒ permanent STALE | DEFECT / DESIGN DEBT |
| 8 | `PLATFORM_ALERTS_EMAIL` optional; alert run "skipped" silently | CONFIRMED | `lib/env.ts:541`; `lib/alerts/run.ts` `deliveryStatus:"skipped"`; `vercel env ls production` shows neither `PLATFORM_ALERTS_EMAIL` nor `BETA_REQUESTS_EMAIL` (names only) | OPERATIONAL GAP |
| 9 | evaluate-alerts once daily 07:30 UTC | CONFIRMED | `lib/jobs/registry.core.ts:120` | DESIGN DEBT |
| 10 | Job failures never reach Sentry | CONFIRMED | `lib/jobs/run.ts` wrote `status:"failed"` and rethrew; only ledger-write failures were captured | DEFECT |
| 11 | AI provider failure writes no fact | CONFIRMED | `lib/ai/invocation.ts` header: "A call that threw … writes nothing" | MISSING CAPABILITY |
| 12 | Beta intake captures email+note only; `cf-ipcountry` dropped; CTAs destroy the query string; invite email outcome unrendered; "Activated"=REDEEMED | CONFIRMED | `access-request/route.ts`; `lib/api.ts:87`; `site/lib/public-config.ts` `APP_LINKS`; `GrowthBetaRequestsWidget.tsx` | MISSING CAPABILITY / PRESENTATION GAP |
| 13 | Role wall: SYSTEM_ADMIN cannot open Platform Spaces; grants only to USER | CONFIRMED | `proxy.ts:146-147`; `app/api/admin/platform-grants/route.ts:112`; `app/(shell)/dashboard/platform/[area]/page.tsx` gates on an ACTIVE grant | INTENTIONAL BOUNDARY |
| 14 | Site: "not a chat window you have to prompt", "intelligent financial ecosystem", "Goals" Space, "Personal finance dashboard", no support address, no OG image | CONFIRMED | `legal-ai.md:7`; `site/app/page.tsx`; `public/manifest.json`; `lib/jobs/registry.ts:127` (Goals retired); `lib/space-templates/registry.ts:66-70` (Business `comingSoon`) | STALE / ASPIRATIONAL |
| 15 | HSTS not observed on Preview | REFINED | Preview is behind Vercel deployment protection; the 302 carries Vercel's HSTS without `includeSubDomains`; `https://fourthmeridian.com/` (app-served) returns `max-age=15552000; includeSubDomains`. Verify the site's header on Production after the domain cutover | UNKNOWN until cutover |

Runtime vs static: #1, #2, #3 carry runtime evidence (dev DB, one live provider call, failing-then-passing test); #6–#12 static plus production env names; #15 live HTTP.

---

## C. Implemented P0

### C.1 AI telemetry (Workstream A)
- `AiInvocation` + `userId`, `spaceId`, `conversationId`, `subSurface`, `outcome` (default `RETURNED`), `errorCode`, `providerRequestId`; indexes on `(userId, occurredAt)`, `(conversationId, turnIndex)`, `(outcome, occurredAt)`. RLS posture unchanged: revoked from `fm_app`, written/read by `fm_system` only — no tenant path, so Conversations cannot reach another user's telemetry.
- `lib/ai/invocation-context.ts`: context carries attribution; `AiAttribution` type threaded route → engine → turn → labeller; `subSurface` `chat:answer` / `chat:guidance` / `brief:generate`.
- `app/api/ai/chat/route.ts`: real `conversationId` (`randomUUID()` on a conversation's first turn) carried in the sealed `fm_ai_state` cookie (`runtime-state.ts` VERSION 3→4; an identity-only state now seals; the LOST marker carries it); `correlationId = conversationId`; the digest key and `createHash` removed.
- Readers: `lib/platform/ai/invocations*.ts` price/count `outcome='RETURNED'` only and expose failure counts and truthful `limits` (`failuresRecorded: true`, user/Space `RECORDED_NOT_EXPOSED` — a per-user reader is P1 by design). Provider-reported usage and the rate-card estimate stay distinct ("estimate" labelling unchanged).
- Estimated dollar cost is still read-time only from `lib/usage/pricing.ts`; no dollar figure is persisted.

### C.2 AI failure observability (A + C + coordinator)
- `recordAiInvocationFailure` + `classifyAiFailure` (QUOTA via `insufficient_quota`, RATE_LIMITED via 429, TIMEOUT via abort, else FAILED; a CODE, never a message) called from all three provider chokepoints in `lib/ai/provider.ts`; the original error is rethrown unchanged; each retry attempt that throws writes its own row (`lib/ai/invocation-failures.test.ts` pins create-sites == failure-paths == 3).
- `captureAiProviderFailure` (Sentry, `lib/monitoring/capture.ts`): tags `area=ai-provider`, `ai_outcome`, `model`, `error_code`, `surface`; QUOTA/FAILED/TIMEOUT → error, RATE_LIMITED → warning.
- `lib/platform/ai/failures.ts` — `getAiFailureHealth(24)`; Overview AI domain (`overview-core.ts deriveAi`) is now a real state: UNKNOWN only with no rows; QUOTA ⇒ FAILED "out of credit"; failures without returns ⇒ FAILED; mixed ⇒ DEGRADED; retried rate limits beside returns ⇒ HEALTHY.
- New live alert rule `ai-provider-failing` (`lib/alerts/rules.ts`): critical on any QUOTA in 24 h or failures with zero returns; warning at ≥3 failed+timeouts with returns.

### C.3 Plaid webhook facts and gating (B)
- `lib/plaid/webhook-receiver.ts`: pure `decidePlaidWebhook` + injected-deps `handlePlaidWebhook`; the route is a thin adapter. Verify first (401 writes nothing); 400 on bad JSON; every signature-verified webhook → one `PlaidWebhookEvent` (externalItemId, soft plaidItemId, type, code, Plaid `error.error_code` only, `itemStatusAtReceipt`, `ownerInactive`, `handling`, `environment`); 200 so Plaid never retries.
- Gate: trigger + `ACTIVE` + live owner ⇒ `SYNC_SCHEDULED`; NEEDS_REAUTH/ERROR/REVOKED ⇒ `REFUSED_ITEM_STATUS` (the cron's own predicate); deactivated owner ⇒ `REFUSED_OWNER_INACTIVE`; no Item ⇒ `UNKNOWN_ITEM`; non-trigger ⇒ `ACKNOWLEDGED`. Historical data untouched; no resurrection path.
- `lib/plaid/webhook-event.ts`: fm_system writer, non-throwing, nine allowlisted fields, errors logged through `redactedErrorForLog` (pinned by `plaid-log-safety.test.ts`).

### C.4 Alerting (C)
- `lib/connections/health.ts`: population = live fleet; REVOKED (both tables) and deactivated-owner connections excluded from `total`/`counts`/`unhealthy` and reported as `retired: { revoked, ownerInactive }` (widget shows "Not counted: …"). REVOKED removed from the acute set.
- `evaluate-alerts` now `hourUTC: [0,6,7,12,18], minuteUTC: 30` (≤6 h detection latency; 20 h re-notify keeps ≈1 delivery per breach per day; `cadence.ts` derives 6 h honestly).
- `lib/jobs/run.ts` → `captureJobFailure(jobName, err, executionId)` on the failure path (ledger semantics and rethrow unchanged).
- `PLATFORM_ALERTS_EMAIL` added to `PROD_REQUIRED_KEYS` (`lib/env.ts`); env-status widget reports it automatically. `BETA_REQUESTS_EMAIL` stays optional (the queue widget is the authority).

### C.5 Beta acquisition / intake (D)
- `BetaAccessRequestEvent` (INSERT-only for `fm_app`/`fm_auth`, all for `fm_system`): one row per submission, written after the untouched non-enumerating `createMany … skipDuplicates`; the count is still never read; the 200 is identical.
- `source` (pure `lib/marketing/acquisition.ts`, client and server allowlists): `landingPath` (site path, ≤200), `referrerHost` (cross-origin host only), `utm_source/medium/campaign/content/term`, `ref`, `source` (≤100 each, control chars stripped), server-only `country` (2 letters from `cf-ipcountry` ?? `x-vercel-ip-country`). No IP, user-agent, raw headers or fingerprint.
- Site: `AppLink` (hydration-time re-point via `useSyncExternalStore`; no-JS visitors get the plain link) on nav, footer, request-access page and landing CTA; `from=<site path>` forwarded because cross-origin referrers carry only the origin.
- Operator read: pending rows carry `requestCount`, `lastRequestedAt` (COUNT/MAX, one grouped query), first `acquisition`; invitation rows carry `inviteEmail {status, at}` from the latest audit row (approve / direct invite / resend `metadata.emailStatus`). Widget wording: "handed to provider (not delivery-confirmed)" / "captured — not sent" / "failed"; "Activated" → "Redeemed"; "Sent" → "Emailed".

### C.6 Operator access verification (E, coordinator)
- **FACT (static):** the only Platform render path (`app/(shell)/dashboard/platform/[area]/page.tsx`) gates on an ACTIVE `PlatformGrant`; grants are mintable to `role === USER` only; SYSTEM_ADMIN is redirected off `/dashboard/*` by `proxy.ts`. Routine beta operation needs four areas — GROWTH_REVENUE (queue, invites, beta mode), PLATFORM_OPS (health, alerts, jobs, AI), SECURITY_OPS (operator feed, sessions), CUSTOMER_SUCCESS (sync incidents). MERCHANT_OPS is not needed for a five-user beta.
- **FACT (production, read-only, 2026-10-06 measurement):** 4 `PlatformGrant` rows, WRITE, ACTIVE, on the USER account; 2 users (1 SYSTEM_ADMIN); 4 platform Spaces.
- **INFERENCE:** the 4 grants map one-to-one onto the four areas above (MERCHANT_OPS did not exist on 2026-10-06). **Not re-measured:** production `DATABASE_URL`/`DIRECT_URL` come back empty from `vercel env pull` (not retrievable from this session), so the owner should confirm the four areas in `/admin/platform-access` before inviting. No production mutation of any kind was performed.
- No change to the role wall or the grant model.

---

## D. Public site (F)

- **Positioning:** hero, philosophy, About, layouts, root app metadata and `public/manifest.json` now say "AI-native wealth management platform"; "intelligent financial ecosystem" and "Personal finance dashboard" are gone from every user-facing surface (remaining hits are docs and an archived plan).
- **Stale/aspirational removed:** the retired "Goals" Space card and the "Business" Space (template `comingSoon`) are gone; Spaces listed as personal / family / custom. "Help turn decisions into action" removed; "Transform clarity into action" replaced by "Decide with the whole picture." / "Then decide with it." (the user's action, not the product's). About's "durable financial infrastructure" reframed as direction with "Today that means connected accounts, a Daily Brief, Conversations and Spaces, in a closed beta."
- **Shipped and now stated:** Conversations (questions, what-ifs, "says what it does not know", never moves money); Daily Brief (figures computed by Fourth Meridian, words describe them); Banks & cards, Investments & crypto, Debt, Cash flow.
- **Qualified claims:** exports 3/day; deletion = 7-day cancellable window; tokens AES-256-GCM; "cannot move funds, pay bills, trade, or change anything at your bank".
- **Support/contact:** `support@fourthmeridian.com` published on both Security pages (mailto) and in the site footer; request-access copy says requests are reviewed by hand and invitations arrive by email.
- **Metadata:** titles/descriptions factual on all pages; OG image shipped (`site/app/opengraph-image.tsx`, `force-static`, 1200×630 PNG in the static export; `twitter:card=summary_large_image`), with two narrowly-commented allowances in the site's security proofs (metadata-route list; `next/og` + build-time `node:fs` read).
- **Headers:** Production apex (app-served) sends HSTS with `includeSubDomains`; Preview site headers not observable behind deployment protection — verify after cutover.

---

## E. Legal / policy (G) — evidence in `docs/operations/legal-factual-basis-2026-10-07.md`

**AI Disclosures (`legal-ai.md`):** CORRECTED "not a chat window" → Daily Brief + Conversations (capabilities from `product.ts`); provider named OpenAI (API); what is sent and what is never sent (password, bank credentials, Plaid tokens); guidance boundary as shipped (understanding / planning / recommendation, heightened wording for securities/tax/legal/retirement/borrowing); one-Space visibility; memory facts (24 h browser transcript, 2 h sealed what-if, Memory panel edit/delete); operator telemetry disclosed; "Fourth Meridian does not train any model on your data and does not opt in to any provider programme that would use it for training"; **retention window WITHHELD** — governed by OpenAI's terms, external verification.
**Privacy (`privacy.md`):** §1 adds hashed password / encrypted DOB / TOTP material, Plaid consent scope, AI memory, audit records with IP + user-agent, operational records; §3 Plaid named, consent in Link, read-only, AES-256-GCM tokens, disconnect semantics incl. **history retained until account deletion** (previously undisclosed); §5 Plaid and OpenAI named; §6 7-day grace, cancel by sign-in, what purge deletes, 3-day revocation hold, shared-Space survival, anonymised audit retention; §7 export ZIP, 3/day, newest 5,000 transactions with manifest flag; §10 contact → support@.
**Terms (`terms.md`):** beta status; read-only / no money movement extended to the AI; §4 names Brief + Conversations with the shipped "not a licensed adviser" wording; §7 deletion window; contact → support@. §1, §5, §6, §8, §9 untouched (counsel).
**Effective date** "October 7, 2026" on all three; `LEGAL.updated` "October 2026"; `TERMS_VERSION` → `"2026-10-07"` (it only stamps new registrations; no re-consent flow exists).
**Unresolved (owner / counsel / provider):** OpenAI API retention window; regulatory sufficiency of the guidance posture; whether Vercel/Supabase/Resend/Sentry must be named as sub-processors; `support@fourthmeridian.com` inbox monitored (provable only as a sending identity); eligibility/liability/governing law (none exists); re-consent of existing users; whether retaining history after disconnect is the desired product behaviour.

---

## F. Data / migrations

- **Schema:** `AiInvocation` +7 nullable/defaulted columns +3 indexes; new `PlaidWebhookEvent`; new `BetaAccessRequestEvent`. Soft references only (no FKs): both ledgers survive deletion of what they observed.
- **Migration:** `prisma/migrations/20261007100000_operationalization_p0_facts/migration.sql` — additive, no backfill, old client compatible. RLS: both new tables ENABLE + FORCE; `fm_system_all` policies; `fm_app`/`fm_auth` INSERT-only on `BetaAccessRequestEvent`; nothing for them on `PlaidWebhookEvent`; `fm_backup` SELECT.
- **Dev DB:** applied via `npm run db:migrate:safe` (guard + backup + `migrate deploy`); `check-schema-drift` in step (122 on disk · 122 applied); `prisma migrate diff --from-url … --to-schema-datamodel` shows no difference except a pre-existing truncated index name on `ProviderCapabilityObservation` (not this slice).
- **Preview:** NOT applied in this session (apply with the established `migrate deploy` over `DIRECT_URL`, `docs/operations/rls-preview-cutover.md` §1/§4, after the push). **Production: UNTOUCHED** — no SQL writes, migrations, deployments, env, secrets, DNS, Plaid or user changes. Pending on Production is now 34 migrations including this one (noted in the untracked cutover plan).

---

## G. Test / runtime evidence

- **New tests:** `lib/ai/invocation-failures.test.ts` (35), `lib/ai/conversation/conversation-identity.test.ts` (16), `lib/platform/ai/failures.test.ts` (8), `lib/platform/ai/invocations.test.ts` (10), `lib/plaid/webhook-receiver.test.ts` (40, incl. the pre-fix reproduction), `lib/monitoring/job-failure-capture.test.ts`, `lib/marketing/acquisition.test.ts`, `site/tests/acquisition.test.mts`. **Updated:** alerts (6 rules / 5 live pins, `ai-failing` suite, retired/REVOKED-leak checks), health (population scan), dispatch/run/env.validate/provider-health fixtures, runtime-state (§9 identity, VERSION 4), overview-core (AI state table + `retired`), provider-structured (one TIMEOUT row), request-access (exact body), brief-authority (scope ≠ client), webhook-verify-amplification (verify-first pinned on the receiver; route pinned to delegate).
- **Unit suite (working tree, env-free):** `run-tests: 677/677 passed`. **Typecheck:** clean on committed trees (only ignored `.next/`, `prototype/`, `tmp/` errors, excluded from the clean copy). **Lint:** only pre-existing warnings in tracked files. **Site:** `npm run verify` — 45/45 tests, typecheck, lint, clean-env build (92 files, static only). **Ratchets:** `audit-db-authority` all passed (no new `db` import; implicit owner calls 61 ≤ 64); `public-site-boundary` parity; `marketing-boundary`; `platform-surface`; `observability-privacy`; `sync-lock`; `plaid-log-safety`.
- **Clean-copy CI (`npm run ci`, Node 24, throwaway Postgres container, gates HEAD `0c73f31`) and GitHub exact-SHA run:** see the "Gate results" addendum at the end of this document (filled in after the runs).
- **Runtime proofs:** dev DB round-trip of `recordPlaidWebhookEvent` (probe row written, read, deleted); one live OpenAI call for the reasoning-token question. **Not performed:** the Preview webhook proof. Preview's `/api/plaid/webhook` sits behind Vercel deployment protection (an unauthenticated Plaid delivery gets a 302 to SSO), so it needs: (1) the migration applied to Preview; (2) either a forged-signature POST from the owner's SSO browser — expect 401 and `select count(*) from "PlaidWebhookEvent"` unchanged (rejected writes nothing) — or, with owner authorisation, one Plaid Sandbox `/sandbox/item/fire_webhook` (`webhook_code: DEFAULT_UPDATE`) through the existing protection-bypass token against a Sandbox Item, then on Preview `select "receivedAt","externalItemId","webhookType","webhookCode","itemStatusAtReceipt","handling",environment from "PlaidWebhookEvent" order by "receivedAt" desc limit 5;` — expect one `SYNC_SCHEDULED` row with `environment='preview'` and a WEBHOOK-trigger `RefreshExecution`; firing against the Sandbox Item the lane left REVOKED should yield `REFUSED_ITEM_STATUS` and no new `RefreshExecution`. The Plaid Sandbox lane record is `docs/operations/plaid-sandbox-lane-2026-10-06.md`.

---

## H. Deferred (genuine P1/P2/counsel/external-admin)

- Customer view in CUSTOMER_SUCCESS (ruling received; P1-1); per-user AI cost reader; readers/widgets for `PlaidWebhookEvent` and `BetaAccessRequestEvent`; retention sweeps for both.
- Operator chokepoint + reason (`runOperatorAction`), `AuditLog` DB-level append-only, scripts into the registry.
- `AiInvocation.userId` nulling on account purge (soft ref, unresolvable after deletion — P1 hygiene).
- Approve-refuses-existing-user; `getRequestMeta` country fallback centralised in `lib/api.ts`; audit-derived invite status scoped per request if volume grows.
- Maintenance-mode / ingestion-pause UI; Run Now for the remaining jobs; `provider-health.ts:359` REVOKED branch now dead (cleanup).
- Stale header comment in `lib/ai/provider.ts` ("503 AWAITING_REDESIGN"); `docs/architecture/FOURTH_MERIDIAN_DOCTRINE.md:40` "calm financial operating system"; STATUS.md drift (P1-7 docs reset).
- Counsel/external: items in §E; HSTS on the Production site after the domain cutover; Resend webhook (delivery truth).
- Config acts (owner): `PLATFORM_ALERTS_EMAIL` in Vercel Production (boot refuses without it); optionally `BETA_REQUESTS_EMAIL`; confirm support inbox; Turnstile production keys and `registration_mode = invite_only` (pre-existing readiness gates).

---

## I. Beta verdict

**"If Chris invited the first five real beta users now, what routine product operation or understanding would still force him into Claude Code, SQL, Supabase, Vercel, Plaid, OpenAI, Resend, Sentry, or another external console?"**

| Dependency | Where it still lives | Class |
|---|---|---|
| Apply migrations to Preview/Production; backups/PITR | `prisma migrate deploy` over `DIRECT_URL`; Supabase | appropriate external administration |
| Set `PLATFORM_ALERTS_EMAIL`, Turnstile keys, `registration_mode`; secrets, DNS, deployments | Vercel; `/admin` (registration mode) | appropriate external administration — **the alerts email is a one-time act that must precede the next Production deploy** |
| Confirm the operator USER account holds the four needed grants | `/admin/platform-access` (in product) | acceptable: in-product, one look |
| Email delivery truth (bounce/complaint) | Resend console | acceptable beta limitation — the product now shows hand-off vs captured vs failed |
| Reading a user's AI cost or a webhook's history row | SQL (ledgers exist, readers are P1) | acceptable beta limitation — facts are being captured from day one |
| Which user a broken connection belongs to | `/admin/providers` (SYSTEM_ADMIN) or SQL | acceptable beta limitation — Customer view is P1 with the ruling in hand |
| Plaid Item removal that failed upstream; Plaid dashboard webhook URL | Plaid console | appropriate external administration |
| Reasoning about a provider outage | Sentry (now receives job + AI failures) and the Overview AI domain / alert email | acceptable: Sentry is complementary, not required to learn of the outage |
| Pausing ingestion / maintenance mode | SQL (`PlatformSetting`) | acceptable beta limitation (P1-3) |

No remaining dependency is a **beta blocker** once the two config acts (alerts email; grant confirmation) are done.

**PROJECT OPERATIONALIZATION P0: CLEARED** (code complete and gated locally; Preview application of the migration and the Production config act are the owner's next steps).
**PUBLIC/LEGAL FACTUALIZATION: CLEARED** — with the explicitly withheld/marked items in §E (no unsupported claim is published).
**FIRST-FIVE BETA READINESS: GO**, conditional on: `PLATFORM_ALERTS_EMAIL` set in Production before deploy; the owner confirming the operator account's four grants and the monitored support inbox; migrations applied via the established procedure.

---

## Gate results addendum

**Clean-copy CI (`npm run ci`, Node 24.21.0, throwaway `postgres:16` container, HEAD `0c73f3167a7f`):** `[ci] PASSED — every CI job green on a clean copy of HEAD` — test job (prisma generate, 677/677 unit tests, typecheck, lint), architecture job (migrate deploy, seed, 25 REQUIRED audits all PASSED, `rls:accept`, `rls:accept:app`, `rls:accept:ai`, `rls:accept:plaid`, `rls:accept:foreground`), site job (`npm run verify`: 45/45, typecheck, lint, clean-env build 92 files).

**GitHub exact-SHA run on `0c73f31`:** run 37667559371 — `completed success`; jobs `test`, `Architecture audits`, `Public site (zero-authority boundary)` all `success`. Pushed as `f541133..0c73f31` to `v2.6` after confirming the remote had not moved.

**Preview (after push):** migration `20261007100000_operationalization_p0_facts` applied to Preview via the guarded `db:migrate:safe` (target check → backup → `migrate deploy`; exactly this migration was pending; `migrate status` → "Database schema is up to date!"). App deployment for `0c73f31` Ready; `vercel curl https://preview-app.fourthmeridian.com/api/health` → `{"status":"ok","db":"ok","commit":"0c73f31"}`. Site deployment Ready; `<title>Fourth Meridian — AI-native wealth management</title>`, `og:image` present (observation: the Preview site's `metadataBase` resolves to the `fourth-meridian-site-git-v26-…vercel.app` alias rather than `preview.fourthmeridian.com` — pre-existing `NEXT_PUBLIC_SITE_ORIGIN` configuration on the Preview site project, not this slice; harmless on Production where the origin is the apex).

**Alerts destination (owner-authorised, names only):** `PLATFORM_ALERTS_EMAIL` added to Vercel **Production** and **Preview** (`support@fourthmeridian.com`, confirmed monitored by the owner). Before this it existed in neither; Preview's `JobRun` ledger held **zero** `evaluate-alerts` runs, so the alert path had never executed there. Root cause: Vercel fires crons on Production deployments only, `evaluate-alerts` had no per-job route and no Run Now command, and `CRON_SECRET` is held by nobody — so the path could not be proven on Preview at all. Fix in the follow-up commit: `evaluate-alerts` registered as a Platform Ops Run Now target (one `OPERATION_TARGETS` entry; `registry.test`, `execute.test`, `capability-control`, `platform-surface`, `scheduler-capability` all green). **End-to-end proof on Preview** is recorded in the "Preview alert-path proof" addendum below once the operator has pressed Run Now on the Preview deployment carrying that commit.

**Operator access (production grants):** not re-measurable from this session (Production `DATABASE_URL`/`DIRECT_URL` are Vercel Sensitive values and pull back empty); stands at the 2026-10-06 measurement — owner to confirm the four areas in `/admin/platform-access`.

## Preview alert-path proof addendum

**Trigger:** the owner pressed Run Now → "Alert Evaluation" on the Preview deployment of `8d64468` at ≈10:09 local (2026-10-07 19:09:08 UTC). Audit row `PLATFORM_OPERATION_EXECUTED` `{kind: run-now, commandId: run-now:evaluate-alerts, outcome: executed, jobRunStatus: succeeded}` at 19:09:09 UTC.

**Execution (Preview `JobRun`, read-only):** `evaluate-alerts` started 19:09:08.654, completed 19:09:09.222, `status: succeeded`, 568 ms. This is the FIRST `evaluate-alerts` run Preview has ever recorded.

**Evaluation:** `counts: {evaluated: 6, live: 5, enabled: 5, firing: 3, delivered: 3, suppressed: 0}`. Three genuine breaches of Preview's real state qualified for delivery — nothing was manufactured and no protection was weakened:
- `resource-stale:fx-rates` (warning) — newest FX data 94 d old against a 2 d threshold (Preview receives no cron, so its archives are genuinely stale);
- `resource-stale:security-prices` (warning) — 75 d old;
- `provider-unhealthy` (warning) — 1 of 3 provider connections STALE (the REVOKED Sandbox items are now retired out of the population, so this is the live fleet only).
No critical breach fired; `ai-provider-failing` evaluated and did not fire (no failure rows yet on Preview); `quota-low` stays dormant.

**Delivery:** `destination` configured (non-null in the summary; the address itself never leaves the environment), `deliveryStatus: "sent"` — the OPS-1 email seam handed one alert email carrying the three breaches to the provider at 19:09:08.672 UTC. **Receipt confirmed by the owner** at the monitored `support@fourthmeridian.com` inbox. Nothing was suppressed (first delivery of each dedupe key) and nothing was skipped. The three breaches are now recorded as fired, so a re-run inside the 20 h re-notify window delivers nothing — the suppression contract is intact.

**Verdict:** the alert path on Preview executes, evaluates, delivers to the monitored inbox, and ledgers its own evidence. Production carries the same `PLATFORM_ALERTS_EMAIL` value; its first evaluation will run at the next dispatcher slot after the Production cutover.
