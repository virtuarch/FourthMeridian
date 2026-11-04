# 20261105120000_platform_ai_message_expiry_on_read — review notes

**B11 batch, not part of B10.** It follows `20261104120000_platform_ai_conversations`.

**Why.** OD-7 expiry took effect only when the purge physically removed a row, so an expired message was readable until the next purge run, and after any restore until a purge ran. S2 validated this finding on 2026-11-05 (C1).

**Statements.** It replaces two policies on `PlatformAiMessage`:
- `fm_app_sel` gains `"purgeAfter" > (now() AT TIME ZONE 'UTC')`, by the database clock, the purge's own UTC form.
- `fm_app_upd` gains the same predicate in `USING`. Its `WITH CHECK` is unchanged.

Nothing else changes: the INSERT policy, the conversation policies, every grant, trigger and function stay as they are. A conversation whose messages have all expired is hidden by the data module's `LIVE` filter (`store.ts`), not by a policy, because a message sub-select in the conversation policy would recurse.

**Not a substitute for the purge.** The ciphertext stays in the table and in backups until the purge (SECURITY DEFINER, owner bypasses RLS) deletes it.

**Proof.**
- `npm run rls:accept:ai-conversations`, cases 82–91;
- `migration-policy.test.ts` §9;
- the pre-enable check's two expiry lines (`scripts/lib/platform-ai-conversations-precheck.core.ts`).

**Apply.** Preview first, by S1 through `npm run db:migrate:safe`, after a backup and S2 review. Production is owner-gated, as part of the B11 precondition (release plan). Rollback (owner-only) recreates the two policies without the predicate. No data changes either way.
