# Preview AI failure and conversation persistence: investigation

**Date:** 2026-10-26
**Mode:** read-only. No setting, schema, deployment or data was changed. The one exception is the operator's own scratch diagnostic tool (§1.5).
**Preview state at read time:**
- Deployment `dpl_88YjR36zEsfxdr2zNMggmiXAd4Y8` (`develop` @ `6342dc2`).
- `maintenance_mode = "true"` since 21:30:39Z, set by the owner through Operational Controls and audited. **Left enabled; resetting it needs approval.**
- Kill switch `"false"`; no `ingestion_paused` row.
- AiInvocation 236 (no new rows; no paid call was made).

---

## 1. Root cause: Conversations and Daily Brief (one cause)

### 1.1 Evidence

The owner signed in at 21:27:50Z; this was the re-login caused by the new `develop` auth secret. Maintenance was still off.

| Time (Z) | Request | Status | Server log |
|---|---|---|---|
| 21:27:56 | `POST /api/ai/chat` | 503 | `[ai/allowance] reservation unavailable: … prisma.rateLimit.upsert() … PostgresError code "25006": cannot execute INSERT in a read-only transaction` |
| 21:28:03 | `POST /api/brief/generate` | 503 | same |
| 21:28:29 | `POST /api/ai/chat` | 503 | same |
| 21:30:45 | `POST /api/brief/generate` | 503 | `[brief] refused before the provider: paid AI paused (MAINTENANCE)` (owner had enabled maintenance at 21:30:39) |

Both surfaces failed at the **same step**: the AI allowance reservation (`lib/platform/ai/allowance-reservation.ts`). It runs one interactive transaction on `systemDb` (role `fm_system`): an advisory lock, a read, then `rateLimit.upsert`. It **fails closed**, as designed, so no provider was called and nothing was written.

The user-visible messages were the correct ones for this failure class:
- Conversations showed the allowance-unavailable sentence.
- Brief showed "Couldn't update today's Brief". This is a non-pause 503; PR #31 deliberately keeps the generic wording for anything other than `AI_PAUSED`.

### 1.2 Why the transaction was read-only

**Cause: an operator session-level `SET` leaked through the Supavisor transaction pooler.**

1. **2026-10-25 20:50:23Z, during the `develop` migration.** To prove the cutover role credentials were live before copying them into the `develop` env records, I ran:

   `psql <role URL on the transaction pooler :6543> -c "SET default_transaction_read_only=on" -c "select current_user …"`

   This ran once each as `fm_app`, `fm_auth` and `fm_system`.
2. In transaction-pooling mode, a **standalone session-level `SET` stays on the server backend** after the client disconnects. The pooler then hands that backend to the next client using the same role: the application.
3. The `fm_system` backend stayed alive because the traffic between 20:50 and 21:27 was **read-only**: health probes, the scheduler read, and Trusted deployment health. Reads succeed on a read-only backend. The first **write transaction** to land on it was the allowance reservation at 21:27:56.
4. Writes on **fresh** backends succeeded in the same minutes: sign-in audit 21:27:50 (`fm_auth`, backend started 21:27:50), Space and refresh audit rows, the maintenance enable 21:30:39.

### 1.3 What was ruled out

| Hypothesis | Result |
|---|---|
| App code sets read-only | **No.** `git grep` over `lib`, `app`, `scripts`, `prisma` and `jobs` finds no `default_transaction_read_only`, `SET TRANSACTION READ ONLY` or `transaction_read_only`. |
| Role- or database-level setting | **No.** `pg_db_role_setting` for `fm_app` / `fm_auth` / `fm_system` holds only `statement_timeout` and `idle_in_transaction_session_timeout`. |
| Read replica | **No.** `pg_is_in_recovery() = false`. |
| Missing or incorrect `develop` env | **No.** The same deployment wrote successfully on other backends. Its database URLs, `FM_RLS_STRICT` and auth URL were verified before the domain switch. |
| Allowance logic, ledger or provider fault | **No.** It failed on the write itself, before any ledger read or provider call. |
| Stale client state | **No.** The server returned 503 with the logged error. |

### 1.4 Current state: self-healed

Every `fm_*` backend alive at 21:34Z started at or after 21:27:50. The `fm_system` backend that served the failures **no longer exists**; the current one started at 21:29:53. Sampling each role's current backend with `SHOW`-only queries gave `default_transaction_read_only = off`.

**No Preview configuration correction is needed.**

### 1.5 Prevention (already applied to the operator tool)

- The scratch Preview psql wrapper now uses `psql -1` with `SET TRANSACTION READ ONLY; SET LOCAL statement_timeout`. Read-only is **transaction-scoped** and can't outlive the transaction. Verified: writes are refused, and the session default stays `off`.
- **Rule for every operator** (proposed runbook addition, §5): never issue a session-level `SET` through the Supavisor pooler, on either port, as an application role. Use `BEGIN READ ONLY` / `SET TRANSACTION` / `SET LOCAL`, or the `-1` wrapper.

### 1.6 Relation to the `develop` migration, and Production

- **Related to the migration *work*, not to its configuration.** My verification step caused it. The `develop` deployment and env are correct. A `v2.6` deployment would have failed identically, since it uses the same pool.
- **Production is not affected.** No Production database connection was made in this work. Production's scheduler is writing normally (`lastDispatchAt` and `lastBackstopCronAt` current on `app.` health). Production uses its own Supabase project (`qirfzv…`) and pool.

---

## 2. Conversation persistence audit

### 2.1 The current architecture (inspected, nothing assumed)

| Layer | What exists |
|---|---|
| Server conversation store | **None.** There's no conversation, chat or message table in the Preview schema (checked 2026-10-24). The route is stateless per turn. |
| Client transcript | `components/ai/transcript-cache.ts`: a **browser-only UX cache** in `localStorage`. Key `fm:ai-transcript:v1:<user>:<space>`, 24 h TTL, `{role, content}` only. `parseTranscript` discards anything else, plus a hint cookie for first paint. Written by `AnalyzeClient.remember()` at turn boundaries. |
| History sent to the model | The client posts the **entire on-screen message list** on every turn (`AnalyzeClient.tsx`: `messages: nextMessages.map(…)`). The server (`lib/ai/conversation/request.ts`) accepts any `user`/`assistant` sequence whose last turn is `user`; consecutive user turns are allowed. |
| Carried runtime state | A sealed cookie, bound to `conversationTail(history)` = the sha256 of the **last assistant message** in the posted history (`runtime-state.ts`). |
| AI memory | Written only by the `remember` tool (user-stated money; writes off by default). Assistant text is never a memory source. |

### 2.2 Lifecycle today

| Event | Screen | Cache | Next request's history |
|---|---|---|---|
| User sends | user message appended | **written immediately** (so a refresh mid-answer keeps the question) | — |
| Success | assistant answer appended | written | includes the answer ✓ |
| **Failure (non-200 or network)** | error text appended **as `role: "assistant"`** | **not written** (deliberate: "a refusal is not remembered") | ⚠️ **includes the error text as an assistant turn** |
| Navigate away and back, or reload | restored from cache | — | the question with **no answer**: a dangling user turn |
| Next success after a failure | — | ⚠️ `remember(prev + answer)` **now writes the earlier error too**, as an ordinary assistant message | — |
| Retry (user re-asks) | a **second copy** of the question | written | two identical user turns |

### 2.3 Why the failure disappears while the question stays

The question is cached **before** the request. The failure is appended only to React state, and is deliberately not cached. Leaving the page unmounts that state; returning restores the cache, which ends at the question.

### 2.4 Defects found (beyond the disappearing message)

1. **Failures are sent to the model as assistant output.** Within a session, the next turn posts the error string as an `assistant` message. The model reads "Conversations is briefly unavailable…" as something it said.
2. **The failure is later persisted after all**, on the next successful turn, so it is restored tomorrow as an ordinary assistant message.
3. **A failure silently drops the carried plan.** The error becomes the last assistant message, so the conversation tail no longer matches the seal, and the scenario under discussion is lost on the next turn without the FM-AUDIT-018 notice.
4. **Retries duplicate the user message**, and a restored dangling question invites exactly that.

None of these reach **AI memory**: memory isn't fed from assistant text. They're limited to model **context** for subsequent turns, and to the local cache.

---

## 3. Proposed durable model (client-only; no server schema)

The current architecture has no server persistence. A schema would be a new product capability, so it isn't proposed here. Everything below fits the existing browser cache and the stateless route.

1. **Type the failure.** `Message` gains `status?: "failed"` (plus a client-owned category: `paused`, `unavailable`, `network`, `refused`). Failed entries render as a **distinct notice** (alert styling, "No answer: this request didn't complete", the server's customer sentence, and a **Retry** action), never as assistant prose.
2. **Never send failures to the model.** The request history is built by one pure function, `historyForRequest(messages)`, which drops `status: "failed"` entries. This also keeps the conversation tail on the **last real answer**, so a failed attempt no longer breaks continuity (fixes defect 3).
3. **Persist failures, labelled.** Transcript cache **v2**: `{role, content, status?: "failed"}`.
   - `parseTranscript` accepts v1 (all entries successful) and v2; anything else is discarded as today.
   - Existing v1 caches restore unchanged; the next write upgrades them.
   - A failed entry restores as the same failure notice.
   - A v1 transcript that **ends in a user turn** restores with a synthesized "No answer: this request didn't complete" notice, so legacy dangling questions are explained too.
4. **Retry without duplication.** Retry removes the failed entry and re-posts the existing history, which already ends with that user message. No second user message is created. Typing a new question instead keeps the unanswered one in history as the user's own words (honest), with the failure excluded.
5. **Successful answers persist exactly as today.**
6. **Optional server belt-and-braces:** `request.ts` drops any posted `assistant` turn whose content exactly equals a server refusal sentence (`AI_PAUSED_CUSTOMER_MESSAGE`, the allowance-unavailable sentence, …). This protects against old clients and caches. It's cheap, and adds no schema.

## 4. Minimal fixes and tests

| # | Fix | Scope | Tests |
|---|---|---|---|
| F1 | Typed failure, excluded from history, labelled in cache v2, retry without duplicate (§3.1–3.5) | `components/dashboard/AnalyzeClient.tsx`, `components/ai/transcript-cache.ts`, and a new pure `components/ai/conversation-history.ts` | **History:** `historyForRequest` excludes failed entries; tail unchanged by a failure; success after failure doesn't cache the failure as success; retry posts one user message. **Cache:** v2 round-trip; v1 still restores; unknown fields still discarded; dangling v1 user turn produces the synthesized notice. **Render:** failed notice has alert role, never assistant styling, shows the Retry control. **Navigate and restore:** the failure shows on return. |
| F2 (optional) | Server drops posted assistant turns equal to known refusal sentences | `lib/ai/conversation/request.ts` | Unit: those sentences are stripped; legitimate assistant text is kept; the last turn must still be `user`. |
| F3 | Runbook rule: no session-level `SET` through the pooler (§1.5) | `docs/operations/deployment.md` (database section) | — |
| F4 (optional) | Brief parity: for the allowance-unavailable 503, show a neutral "briefly unavailable" rather than "Couldn't update" | `components/brief/brief-flow.ts` | Same pattern as the AI_PAUSED tests |
| — | **No fix needed** for the allowance or Brief code paths: they failed closed correctly on a database fault | — | — |

**Optional hardening:** begin write transactions on the allowance path with `SET TRANSACTION READ WRITE`, which overrides a leaked default. I'd recommend against it: the operator rule removes the cause, and an explicit override would hide a poisoned pool rather than surface it.

## 5. Answers

1. **Conversations allowance failure:** a pooled `fm_system` backend carried a leaked `default_transaction_read_only=on` from my 20:50Z credential check through the transaction pooler. The allowance reservation's `rateLimit.upsert` hit Postgres 25006, and the route failed closed. The system has self-healed.
2. **Daily Brief failure:** the same backend, at the same step (21:28:03). The "Couldn't update" message is correct for a non-pause 503.
3. **Relation to the migration:** caused by my migration verification step, not by the `develop` configuration. `v2.6` would have failed the same way.
4. **Why failed responses disappear:** failures are kept only in React state. The question is cached before the request; the failure is deliberately not cached (§2.3). Worse, within a session the failure **is** sent to the model and later persisted (§2.4).
5. **Fixes:** F1 (required), F2 to F4 (optional), with the tests above.
6. **Preview configuration correction:** none. The pool has recycled. Maintenance is ON from the owner's test; reset it through Operational Controls when approved.
7. **Production:** not affected by the database fault. **The conversation defects in §2.4 exist in Production code too**: `AnalyzeClient` is unchanged on `main`. F1 would ship through the normal `develop` → `main` promotion.
