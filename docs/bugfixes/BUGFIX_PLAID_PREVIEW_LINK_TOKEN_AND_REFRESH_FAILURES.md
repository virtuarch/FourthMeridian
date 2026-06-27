# Bugfix investigation: Plaid `link-token` INVALID_FIELD + `refresh` 400 on Vercel Preview

Status: **investigation complete, no fix proposed yet, no code/schema/migration changes made.**
Bugfix track, separate from D2 Step 2 (provider identity / WALLET dual-write). D2 Step 2 remains paused and untouched by this investigation.

> **Update:** Retested `/api/plaid/refresh` against a different Preview sandbox account — returned `200` and synced successfully. The earlier 400 reported in logs reads as expected connection-health behavior for that specific account/item (e.g. an `ITEM_LOGIN_REQUIRED`-class state), not a refresh-pipeline crash. Section 3's structural analysis (refresh and link-token are separate failures, not the same root cause) stands; treat the original 400 as resolved/expected pending the raw `error_code` confirming which health state it was, rather than as an open refresh bug. The separate orphaned-`PlaidItem` gap found in `BUGFIX_PLAID_REFRESH_ORPHANED_PLAID_ITEMS.md` is independent of this and still open. A second, unrelated signal surfaced during retest — `[plaid][D2-3E] ProviderAccountIdentity miss, legacy plaidAccountId hit` warnings in refresh logs — which is **not** a Plaid refresh bug; see note at the end of `BUGFIX_PLAID_REFRESH_ORPHANED_PLAID_ITEMS.md`. The `link-token` `INVALID_FIELD` finding (Section 2, Preview `PLAID_REDIRECT_URI`/config) is unaffected by this update and remains the open item on this track.

## 1. Scope of what was read

Only Plaid routes/helpers and environment/config code, per instructions:

`app/api/plaid/link-token/route.ts`, `app/api/plaid/create-link-token/route.ts` (deprecated, unused), `app/api/plaid/refresh/route.ts`, `app/api/plaid/exchange-token/route.ts`, `lib/plaid/client.ts`, `lib/plaid/refresh.ts`, `lib/plaid/errors.ts`, `lib/plaid/encryption.ts`, `lib/env.ts`, `lib/session.ts`, `context/PlaidContext.tsx`, `app/plaid-oauth-return/page.tsx`, `.env.example`, `vercel.json`, `docs/operations/DEPLOYMENT.md`, plus `git log`/`git show` on all of the above and on `prisma/schema.prisma`'s `User`/`PlaidItem` models. No files were modified.

## 2. Root cause — `/api/plaid/link-token` INVALID_FIELD

`linkTokenCreate()` in `app/api/plaid/link-token/route.ts` sends exactly five fields. Four are hardcoded literals that cannot be malformed: `client_name` ("Fourth Meridian"), `products` (`[Products.Transactions, Products.Investments]`, valid SDK enum members), `country_codes` (`[CountryCode.Us]`), `language` ("en"). The frontend (`context/PlaidContext.tsx`) calls this route with a plain `GET` and no body, so it cannot inject any field either.

That leaves exactly two values that vary by environment, and both come from `process.env`, with **no logic anywhere in the codebase that branches on `VERCEL_ENV`** (confirmed — zero matches repo-wide):

- `user.client_user_id` — `user.id`, a Prisma `cuid()` from `lib/session.ts`. Always well-formed; ruled out.
- `redirect_uri` — `process.env.PLAID_REDIRECT_URI`, included only when truthy (`...(redirectUri && { redirect_uri: redirectUri })`).

`redirect_uri` is the only field that can vary in shape between deployments, and Plaid's `INVALID_FIELD` on `linkTokenCreate` is overwhelmingly most often returned for exactly one reason: the `redirect_uri` value supplied doesn't match an entry in that **specific Plaid environment + client_id's** "Allowed redirect URIs" list in the Plaid Dashboard — sandbox, development, and production each have their own independent allowlist.

`docs/operations/DEPLOYMENT.md` documents `PLAID_REDIRECT_URI` as a single, manually-typed, one-time value ("Step 6/7 — fill in after first deploy, then register that exact string in the Dashboard"), explicitly scoped to "Production and Preview" alike. That setup only stays correct as long as Preview keeps using the same Plaid environment/client_id as Production and the same domain the registered URI points at. If Preview uses different (e.g. sandbox) `PLAID_CLIENT_ID`/`PLAID_SECRET`/`PLAID_ENV` than Production — a sensible and common choice, so Preview never touches real bank data — but still inherits Production's `PLAID_REDIRECT_URI` value, every `linkTokenCreate` call from Preview will send a `redirect_uri` that was never registered under Preview's environment+client. That produces `INVALID_FIELD` on every call, regardless of which institution is eventually chosen, which matches the reported symptom (failure at link-token creation, before any institution is picked).

**This is a deployment/dashboard configuration question, not a code bug.** The route does exactly what `.env.example` and `DEPLOYMENT.md` describe.

One thing worth noting without over-claiming it: the route already has full diagnostic logging in place (`console.error("[plaid] link-token error:", { client_message, error_code, plaid_status, plaid_error_data, env })` in `app/api/plaid/link-token/route.ts:58-65`). That line prints Plaid's raw `error_message` string, which will say explicitly whether the rejected field is `redirect_uri` (or something else, e.g. a products/billing restriction). That log line has not been reviewed as part of this investigation — only the request-construction code has — so the above is the most probable cause given what the code can produce, not a confirmed reading of the actual Plaid error body.

## 3. Is the `refresh` → `/accounts/get` 400 the same root cause?

No — structurally cannot be, and the two should be tracked as separate symptoms even if they share a category of cause.

`lib/plaid/refresh.ts` never calls `linkTokenCreate`. `refreshPlaidItem()` decrypts an existing `PlaidItem.encryptedToken` row and calls `plaidClient.accountsGet({ access_token })` directly (line 95) — no `redirect_uri`, `products`, `country_codes`, or `language` involved at all. A 400 here means Plaid rejected the **access token itself**, not a request field.

Checked whether today's D2 commit (`8ac2291`, "support multi-account provider identities", same day as this investigation) could be responsible, since it touched `lib/plaid/refresh.ts`. `git show 8ac2291 -- lib/plaid/refresh.ts` confirms the only change is `providerAccountIdentity.findUnique` → `findFirst` inside the per-account loop, which runs **after** the `accountsGet` call that's already failed by the time that code would execute. Ruled out — the identity-schema work is downstream of the failing call, not upstream of it.

Two plausible causes for the access-token rejection, both Plaid-environment-related rather than application bugs, and only the raw `error_code` (already logged by the existing `console.error` in `refreshAllActiveItemsForUser`/the route's catch block) can distinguish them:

- **`ITEM_LOGIN_REQUIRED`** — expected, ordinary Plaid state (bank wants re-auth), already correctly mapped to a user-facing message in `lib/plaid/errors.ts`. Not a bug if this is what's in the log.
- **`INVALID_ACCESS_TOKEN`** (cross-environment token) — if Preview reads `PlaidItem` rows from the same Postgres database as Production (sharing real `encryptedToken` values minted under Production's `PLAID_CLIENT_ID`/`PLAID_SECRET`), but Preview's own Plaid API keys are sandbox/development, Plaid will reject those tokens outright on every call. `lib/env.ts:104` defaults `PLAID_ENV` to `"sandbox"` when unset, so any Preview deployment missing an explicit `PLAID_ENV` override would silently fall into this mismatch.

Verdict: same **family** of root cause (Preview's Plaid environment/credentials diverging from what either the Plaid Dashboard or the shared database expects), but a distinct trigger from the `link-token` bug, not the literal same error. Confirm via the raw `error_code` already sitting in the Vercel Preview function logs before assuming which one it is.

## 4. Preview vs. Production

Cannot be confirmed from the repository alone — actual Vercel env-var scoping and Plaid Dashboard allowlists aren't visible from code. Structurally, though, everything points at Preview-only impact: Production runs under one stable, deliberately-registered domain (per `DEPLOYMENT.md`'s Step 5-7 process), so its `PLAID_REDIRECT_URI` and Plaid credentials are far more likely to already be self-consistent. Preview deployments are the side of this that's prone to drift, both because Vercel Preview URLs commonly differ from the registered domain and because using non-production Plaid credentials in Preview is the safer, more likely setup. Needs a direct check against Production logs to confirm rather than assume.

## 5. Smallest safe fix (proposed only — not implemented)

No code change is required for either symptom as currently diagnosed; both read as Vercel/Plaid-dashboard configuration drift:

| Symptom | Smallest fix |
|---|---|
| `link-token` INVALID_FIELD | In Vercel → Environment Variables, give `PLAID_REDIRECT_URI` its own value for the **Preview** scope rather than inheriting Production's — set it empty/unset if Preview only needs to test non-OAuth sandbox institutions (the route already treats it as optional), or to a correctly-registered Preview-specific URI if OAuth testing is required there. |
| `refresh` 400 | Confirm Preview's `PLAID_CLIENT_ID`/`PLAID_SECRET`/`PLAID_ENV` are scoped correctly for Preview. If Preview intentionally uses sandbox/dev keys, it needs its own sandbox-created `PlaidItem` rows to test against rather than reading Production-issued access tokens — either give Preview a separate database/seed data, or align its Plaid keys with Production's if sharing the DB is intentional. |

Both are environment/dashboard changes, not commits. If a code-level safeguard is later wanted (e.g. failing fast with a clear error when `PLAID_ENV` and the stored token's origin can't be reconciled, or making `redirect_uri` automatically skip outside `VERCEL_ENV === "production"`), that would be a separate, small, additive follow-up — not proposed here since it wasn't asked for and isn't required to resolve the symptom.

## 6. Validation plan (Preview)

1. **Zero-deploy first step:** read the existing Vercel Preview function logs for the `[plaid] link-token error:` entry (`app/api/plaid/link-token/route.ts:59`) and the `[refreshAllActiveItemsForUser] refresh failed` entry (`lib/plaid/refresh.ts:290`) — both already log the raw Plaid `error_code`/`error_message`/`display_message`. This confirms or refutes the `redirect_uri` and access-token hypotheses with no code change.
2. Cross-check Vercel → Settings → Environment Variables, **Preview** scope specifically, for `PLAID_REDIRECT_URI`, `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` — confirm whether Preview has its own values or is inheriting Production's.
3. Cross-check Plaid Dashboard → Team → API → Allowed redirect URIs, on whichever environment tab matches Preview's resolved `PLAID_ENV` — confirm whether Preview's `PLAID_REDIRECT_URI` string is actually present there.
4. After whichever config change is applied: redeploy Preview, call `/api/plaid/link-token` while signed in, confirm `200` + a `link_token` in the response.
5. Complete a sandbox Link flow end-to-end in Preview, then call `/api/plaid/refresh` for that newly-created item and confirm no Axios 400.
6. Expect any pre-existing, Production-origin `PlaidItem` rows reachable from Preview to keep failing `accountsGet` if Preview intentionally uses different Plaid credentials — that's expected behavior (access tokens aren't portable across Plaid environments), not a remaining bug, once Preview has its own item to test against.

## 7. Rollback plan

The proposed fix is a Vercel environment-variable change, not a code change — rollback is restoring the previous Preview-scoped value in the Vercel dashboard, no `git revert`, no migration, no redeploy beyond Vercel's automatic env-change redeploy. If a follow-up code change (e.g. `VERCEL_ENV`-aware `redirect_uri` handling) is separately approved later, that would be a single small additive commit, revertable on its own with no schema/migration involved either way.

## 8. Affected files (read-only, for reference — none modified)

`app/api/plaid/link-token/route.ts`, `lib/plaid/refresh.ts`, `app/api/plaid/refresh/route.ts`, `lib/plaid/client.ts`, `lib/plaid/errors.ts`, `lib/plaid/encryption.ts`, `lib/env.ts`, `docs/operations/DEPLOYMENT.md`, `.env.example`. No schema, migration, route, or UI changes were made. D2 Step 2 / WALLET dual-write code was not touched.
