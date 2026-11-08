# 20261108120000_platform_ai_retention_7_days — review notes

**B11 batch, not part of B10.** It follows `20261104120000_platform_ai_conversations` and
`20261105120000_platform_ai_message_expiry_on_read`.

**Why.** On 2026-11-08 the owner amended OD-7: a Platform AI message is kept **at most 7 days**
from its creation (was 90). A question and its answer expire together, 7 days after the question.
Code: `PLATFORM_AI_RETENTION_DAYS = 7` (`lib/platform/intelligence/ai/conversations/constants.ts`).

**Statements.**

0. A `DO` block refuses a migration principal without `BYPASSRLS` (S2 REQUIRED 2). Under FORCE
   RLS a non-bypassing owner would clamp 0 rows silently.
1. `LOCK TABLE "PlatformAiMessage" IN ACCESS EXCLUSIVE MODE`, once, before anything else, so no
   later statement upgrades a lock. `SET LOCAL lock_timeout = '5s'` makes it fail rather than queue.
2. **The clamp** (one `DO` block). It never lengthens a row's life:
   - a question (USER): `purgeAfter := LEAST(purgeAfter, createdAt + 7 days)`;
   - an answer (ASSISTANT): `LEAST(purgeAfter, createdAt + 7 days, question.purgeAfter,
     question.createdAt + 7 days)`. An answer is never kept past its question.

   Only rows above their cap are updated, so a re-run changes nothing.
3. The `purgeAfter` default becomes `now() AT TIME ZONE 'UTC' + 7 days`.
4. `PlatformAiMessage_purgeAfter_bounded` is dropped (`IF EXISTS`) and re-added as
   `purgeAfter <= createdAt + interval '7 days'`. It validates against the clamped rows.

**No deletion.** Rows the clamp expires are hidden at once by the expiry-on-read policies
(`20261105120000`) and removed by the unchanged purge function on its next run.

**The settle trigger: decision.** `fm_platform_ai_message_settle` refuses every change to
`purgeAfter` on a settled row, including by a role that bypasses RLS (its one exception is the key
rotation's `contentEncrypted`-only update). So the clamp cannot run with the trigger active.

- **Chosen: disable that one trigger for the clamp only.** `DISABLE TRIGGER
  platform_ai_message_settle`, the clamp `UPDATE`, then `ENABLE TRIGGER`, all in one `DO` block
  under the ACCESS EXCLUSIVE lock from step 1. No other session can read or write the table while
  the trigger is off, the migration is one transaction (any failure leaves the trigger enabled), and
  the block RAISEs unless `pg_trigger.tgenabled = 'O'` afterwards. The trigger function is not
  redefined: the immutability rule stays exactly as S2 approved it.
- **Weighed: a permanent trigger exception "a bypassing role may only decrease `purgeAfter`".**
  Rejected. It would widen the immutability rule forever for a one-time data step, and it adds a
  new permanent write path to a retention column that S2 would have to re-review.

**Proof.**
- `npm run rls:accept:ai-conversations`, the `[retention-7d]` cases: the default and bound,
  the clamp on legacy 90-day rows (pairs clamped together, rows never lengthened, a re-run is a
  no-op, the trigger is enabled and still refuses afterwards), the expiry-on-read 7-day boundary,
  and the purge removing clamped rows.
- `migration-policy.test.ts` §10 (parse pins: the interval equals `PLATFORM_AI_RETENTION_DAYS`,
  the trigger is disabled and re-enabled in the same block, no `DELETE`, the function is not
  redefined).

**Apply.** Preview first, by S1 through `npm run db:migrate:safe`, after a backup and S2 review.
Production is owner-gated with B11. **Rollback** (owner-only): restore the 90-day default and
bound. The clamp cannot be undone (the shortened `purgeAfter` values are not recorded), and rows
already purged are gone.
