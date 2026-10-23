# 13 — Local Backup Cleanup (owner decision 5)

Executed 2026-10-22 in `/Users/chrstn/dev/FourthMeridian/backups/` (gitignored; 72 entries, 317 MB before). Rule: delete only local `pg_dump` text copies of the **dev** database (`fintracker-*.sql`) that (a) are referenced by no document, STATUS row or memory record and (b) are superseded by a newer complete dump of the same database. Everything else is retained.

## Pre-checks

- Running databases: none that use dumps (`docker ps -a`: only this program's throwaway `rem-c-pg`; `fintracker-db` exited 5 days ago; its data lives in volume `fintracker_postgres_data`, not in any dump).
- Restore procedure (`docs/operations/database-safety.md` §4) restores the **newest good dump**; the newest dev dumps (2026-10-15) are retained, as are the 2026-08-26 recovery source and both 2026-09-15 recovery artifacts.
- Preview dumps (`postgres-*.sql`, `preview-*.sql`): retained, untouched (not disposable local copies).
- Two further dumps in `/Users/chrstn/dev/FourthMeridian-aicost/base/backups/` (referenced by STATUS §11): untouched.
- Docker: 22 anonymous volumes + `fintracker_postgres_data` + `fourthmeridian_postgres_data` exist. **None deleted** (unidentified volumes are outside the authorisation); flagged for the owner in `11-OPEN-GATES-OWNER-ACTIONS.md`.
- File-type check passed: every deleted file begins with the `pg_dump` header.

## Retained dev dumps

- `fintracker-2026-07-31T23-48-16-372Z.sql`
- `fintracker-2026-08-04T21-12-26-191Z.sql`
- `fintracker-2026-08-04T21-59-06-000Z.sql`
- `fintracker-2026-08-04T23-08-31-804Z.sql`
- `fintracker-2026-08-07T13-58-44-412Z.sql`
- `fintracker-2026-08-26T23-26-40-599Z.sql`
- `fintracker-2026-09-15T17-25-45-979Z.sql`
- `fintracker-2026-09-20T23-24-00-642Z.sql`
- `fintracker-2026-09-21T13-09-12-033Z.sql`
- `fintracker-2026-10-01T19-22-24-926Z.sql`
- `fintracker-2026-10-15T00-39-17-531Z.sql`
- `fintracker-2026-10-15T00-51-03-753Z.sql`

## Deleted (42 files) — sha256 recorded before deletion

| File | Bytes | mtime | sha256 |
|---|---|---|---|
| `fintracker-2026-07-19T09-30-03-863Z.sql` | 422391 | 2026-07-19T12:30 | 3877ad4f35f55d197633098c74d85fa2d3092f790925cc3d517b8d6555e8f4dc |
| `fintracker-2026-07-19T09-38-48-861Z.sql` | 422554 | 2026-07-19T12:38 | c5654d1e4936aa907ccb832f67356127aac6f4c38a8d21e716bf10165748d528 |
| `fintracker-2026-07-19T19-15-55-394Z.sql` | 3938225 | 2026-07-19T22:15 | 16539d4372e8700f23ba644b788e9dbf5a52a05178d96ef33e93b91a54677e73 |
| `fintracker-2026-07-22T19-16-23-054Z.sql` | 4034841 | 2026-07-22T22:16 | c33e1e3bd8d80ccab0e0beb11ae19972de4f7815c32cb2491b2f3ce20e620a08 |
| `fintracker-2026-07-22T19-33-16-777Z.sql` | 4034841 | 2026-07-22T22:33 | 989fa8ced8905e35a60a32fd75d10b3d9ed0f23fc1ae10ca32d1262b7d8c488e |
| `fintracker-2026-07-22T21-06-37-065Z.sql` | 4035145 | 2026-07-23T00:06 | 365a3b3027b6a2565cfe42391df17c9e0d54cf119b5b0cf69dfbde40c1f7ecb4 |
| `fintracker-2026-07-22T22-38-35-742Z.sql` | 4035452 | 2026-07-23T01:38 | af6c86c34f0baf949428199f63fc852e4707742930817ea9f74952f4d7c7fd3d |
| `fintracker-2026-07-24T21-08-24-228Z.sql` | 4037843 | 2026-07-25T00:08 | e64659de910d4838e64c436293b9340443de8f7fa4f557b74c77f9d68323133a |
| `fintracker-2026-07-25T15-33-22-586Z.sql` | 4048973 | 2026-07-25T18:33 | 4d81a653fe19edbe05b317d8e3f654b50b627c964f1836d52048ae5412b0b741 |
| `fintracker-2026-07-25T18-53-17-266Z.sql` | 4065363 | 2026-07-25T21:53 | 3be6a902a66c303fe77191cd41053afb626b0057aa6ef2165e4166c6a0a8023a |
| `fintracker-2026-07-26T21-51-34-365Z.sql` | 4070028 | 2026-07-27T00:51 | 0f61f30aa904de52270c369b4f1912ca7b8d2eb890a9d6454270596fb6240dd4 |
| `fintracker-2026-08-01T00-08-30-443Z.sql` | 4142743 | 2026-08-01T03:08 | fc7b77a889e76338e5aea08f544018aafe7d598e5499b25f36fcee94811247aa |
| `fintracker-2026-08-01T01-05-37-450Z.sql` | 4157000 | 2026-08-01T04:05 | b5116649c5ef68a07d33afded3dee82a4f1514f6a5db6ae89b32e5b659cec091 |
| `fintracker-2026-08-01T01-09-58-396Z.sql` | 4157000 | 2026-08-01T04:09 | c4409e30f911acc05f6d4514a13c620336a01ff2f2cfdc966061f8fa3d6999de |
| `fintracker-2026-08-01T12-42-50-786Z.sql` | 4174472 | 2026-08-01T15:42 | 60943c7015eefcd99ef4f5f8400ccf847b3bb082b02462d2c5efe0f4e29f7e7c |
| `fintracker-2026-08-01T23-07-18-687Z.sql` | 4190572 | 2026-08-02T02:07 | 2ebf2febf70bac17910e03c32bd55bf99b3d955345aa8daf7ffa0fcabd795028 |
| `fintracker-2026-08-03T16-22-28-611Z.sql` | 4225299 | 2026-08-03T19:22 | b0bad5ad31df863b3890bf33b281b57fa8204df41854ea1f000d04fa92a4e5db |
| `fintracker-2026-08-03T16-25-55-703Z.sql` | 4226717 | 2026-08-03T19:25 | 9facca3ed3a600ee9cf202d323713edbde66ba8e060b6864191bb3cca6472e12 |
| `fintracker-2026-08-03T16-52-41-993Z.sql` | 4231634 | 2026-08-03T19:52 | 698aaaaaf28a191fd803e3bc709340ef418f6e80c6af97467217f6f3c21c07fd |
| `fintracker-2026-08-03T17-20-04-850Z.sql` | 4267097 | 2026-08-03T20:20 | de03a6e456ae2e96a920933190c29c2e1281fe617e8ca6128f89b10a646714bf |
| `fintracker-2026-08-03T18-13-33-296Z.sql` | 4271702 | 2026-08-03T21:13 | 6156b5b8ebfc4e4524a2483f961cd77d2bd152c50b0b701ea7e4b05cb236557e |
| `fintracker-2026-08-03T19-01-34-584Z.sql` | 4282931 | 2026-08-03T22:01 | 0975e316134fbe4336f7f9366f21aca49e5b895fa8630e0846241cac03d836d3 |
| `fintracker-2026-08-03T22-17-53-404Z.sql` | 4284942 | 2026-08-04T01:17 | 9b586110ca2654c817c8d92d2d6700c5d383e9cdceac111090594d10eaa4c64d |
| `fintracker-2026-08-03T23-18-19-784Z.sql` | 4288666 | 2026-08-04T02:18 | c96ee286e73d38b227b3c145e790a01eb1ebeea98ab72491c50540b7accec550 |
| `fintracker-2026-08-04T00-08-07-027Z.sql` | 4290895 | 2026-08-04T03:08 | 845b651c8996c51c55f129bfad70089db836e47d04c8e025fe572dd2226573ec |
| `fintracker-2026-08-04T00-11-25-004Z.sql` | 4301247 | 2026-08-04T03:11 | f5cd864c4ddeee9a80f3e1b4cb641c6b6788534dbf7dc8e503078af27eaa1c76 |
| `fintracker-2026-08-04T20-53-17-986Z.sql` | 4305135 | 2026-08-04T23:53 | f6ee4722cc124bddcd64c17785a280497a89fc607b37f6717efd58354fda2bfb |
| `fintracker-2026-08-04T21-28-55-641Z.sql` | 4326355 | 2026-08-05T00:28 | bf0ef2e6bb06adf3631147e7a0daa12289b78c1dd782b8bb88bb503801ce701a |
| `fintracker-2026-08-04T22-30-03-583Z.sql` | 4326291 | 2026-08-05T01:30 | 2b0e62e0acfd7858a86a744559ed0fd6a098c22f5f6f8bca59273cc920601fcc |
| `fintracker-2026-08-05T02-39-36-049Z.sql` | 4326303 | 2026-08-05T05:39 | 6e102310d157bc6b9c7856e31867b73e2603a8f78aa6dd8c0f91c9eada754328 |
| `fintracker-2026-08-05T03-28-26-958Z.sql` | 4326303 | 2026-08-05T06:28 | aef11df046628965e87b8d87aea5a5a41bb7b1260d509f8d970419cbbb6d7244 |
| `fintracker-2026-08-05T10-52-28-934Z.sql` | 4334373 | 2026-08-05T13:52 | 6b7d13cb8c8717a554316613f8b43e9d62af762ce7c996f9b65de334c0af582b |
| `fintracker-2026-08-05T10-54-58-278Z.sql` | 4348386 | 2026-08-05T13:54 | 58e07e5c6a4668ce5d88ee13e6c4d668a80c0e0856fa52f2befa9c157a4e59a6 |
| `fintracker-2026-08-05T11-33-48-384Z.sql` | 4384085 | 2026-08-05T14:33 | 4b34a2db8fb8a7c0da0efac82f645182e0bb45560131cce18078a15f61824999 |
| `fintracker-2026-08-05T11-41-37-980Z.sql` | 4403552 | 2026-08-05T14:41 | c5be152c58638f793753a8fa417ced6051c1e030c1a7b94c09c3e0d041eddf95 |
| `fintracker-2026-08-18T17-54-37-414Z.sql` | 7038869 | 2026-08-18T20:54 | b64991b756822b20a1ca98563265e02f50a236e27c2ef7b0ea9fb7b79f523230 |
| `fintracker-2026-09-15T18-10-54-245Z.sql` | 8151380 | 2026-09-15T21:10 | c71966cfc28c468b4c57089f0917f40a10af6ee2c7fe7ba5aaddf07bb14050c9 |
| `fintracker-2026-10-02T15-55-26-786Z.sql` | 9206865 | 2026-10-02T18:55 | 4c464030420c680ffa373569e3d455d5f2d4742c02d2202a98636e044195c348 |
| `fintracker-2026-10-02T19-29-27-081Z.sql` | 9206884 | 2026-10-02T22:29 | 1de224faaa46d338e391bd8cd13f1f84b38eb6cf0cbedb4cb07df5590cb04c44 |
| `fintracker-2026-10-07T17-28-16-290Z.sql` | 9439539 | 2026-10-07T20:28 | d945d1d599896c4c8d61deafea5b0cfa9c1064b7213b61a3388699f667450d3d |
| `fintracker-2026-10-07T17-32-22-550Z.sql` | 9440675 | 2026-10-07T20:32 | e370679b1e372bba4530716698e57ed46aa8121182f5ced414d1f035141bf21a |
| `fintracker-2026-10-07T19-25-37-104Z.sql` | 9458793 | 2026-10-07T22:25 | 657d0885e24fa2beb92e3fd34179c8bc3e1cc59928042630245d5bc13e2963da |

## Reference map (all 72 entries, before deletion)

```
fintracker-2026-07-19T09-30-03-863Z.sql | NONE
fintracker-2026-07-19T09-38-48-861Z.sql | NONE
fintracker-2026-07-19T19-15-55-394Z.sql | NONE
fintracker-2026-07-22T19-16-23-054Z.sql | NONE
fintracker-2026-07-22T19-33-16-777Z.sql | NONE
fintracker-2026-07-22T21-06-37-065Z.sql | NONE
fintracker-2026-07-22T22-38-35-742Z.sql | NONE
fintracker-2026-07-24T21-08-24-228Z.sql | NONE
fintracker-2026-07-25T15-33-22-586Z.sql | NONE
fintracker-2026-07-25T18-53-17-266Z.sql | NONE
fintracker-2026-07-26T21-51-34-365Z.sql | NONE
fintracker-2026-07-31T23-48-16-372Z.sql | docs/plans/V26-QUANTITY-ARC-EXECUTION-LEDGER.md 
fintracker-2026-08-01T00-08-30-443Z.sql | NONE
fintracker-2026-08-01T01-05-37-450Z.sql | NONE
fintracker-2026-08-01T01-09-58-396Z.sql | NONE
fintracker-2026-08-01T12-42-50-786Z.sql | NONE
fintracker-2026-08-01T23-07-18-687Z.sql | NONE
fintracker-2026-08-03T16-22-28-611Z.sql | NONE
fintracker-2026-08-03T16-25-55-703Z.sql | NONE
fintracker-2026-08-03T16-52-41-993Z.sql | NONE
fintracker-2026-08-03T17-20-04-850Z.sql | NONE
fintracker-2026-08-03T18-13-33-296Z.sql | NONE
fintracker-2026-08-03T19-01-34-584Z.sql | NONE
fintracker-2026-08-03T22-17-53-404Z.sql | NONE
fintracker-2026-08-03T23-18-19-784Z.sql | NONE
fintracker-2026-08-04T00-08-07-027Z.sql | NONE
fintracker-2026-08-04T00-11-25-004Z.sql | NONE
fintracker-2026-08-04T20-53-17-986Z.sql | NONE
fintracker-2026-08-04T21-12-26-191Z.sql | /Users/chrstn/.claude/projects/-Users-chrstn-dev-FourthMeridian/memory/v2.6-l4-counterparty-repair.md 
fintracker-2026-08-04T21-28-55-641Z.sql | NONE
fintracker-2026-08-04T21-59-06-000Z.sql | /Users/chrstn/.claude/projects/-Users-chrstn-dev-FourthMeridian/memory/v2.6-r1-r3-transfer-classification-repair.md 
fintracker-2026-08-04T22-30-03-583Z.sql | NONE
fintracker-2026-08-04T23-08-31-804Z.sql | /Users/chrstn/.claude/projects/-Users-chrstn-dev-FourthMeridian/memory/v2.6-truth1-two-row-repair-and-readtime-resolver.md 
fintracker-2026-08-05T02-39-36-049Z.sql | NONE
fintracker-2026-08-05T03-28-26-958Z.sql | NONE
fintracker-2026-08-05T10-52-28-934Z.sql | NONE
fintracker-2026-08-05T10-54-58-278Z.sql | NONE
fintracker-2026-08-05T11-33-48-384Z.sql | NONE
fintracker-2026-08-05T11-41-37-980Z.sql | NONE
fintracker-2026-08-07T13-58-44-412Z.sql | docs/plans/v2.6-BRIEF-1-ASSESSMENT-CONVERGENCE.md 
fintracker-2026-08-18T17-54-37-414Z.sql | NONE
fintracker-2026-08-26T23-26-40-599Z.sql | docs/plans/DATABASE-ROLLBACK-RECOVERY-2026-09-15.md /Users/chrstn/.claude/projects/-Users-chrstn-dev-FourthMeridian/memory/platform-ops-observability-shipped.md /Users/chrstn/.claude/projects/-Users-chrstn-dev-FourthMeridian/memory/dev-db-restored-2026-08-26-backup.md 
fintracker-2026-09-15T17-25-45-979Z.sql | docs/plans/DATABASE-ROLLBACK-RECOVERY-2026-09-15.md 
fintracker-2026-09-15T18-10-54-245Z.sql | NONE
fintracker-2026-09-20T23-24-00-642Z.sql | /Users/chrstn/.claude/projects/-Users-chrstn-dev-FourthMeridian/memory/refund-economics-shipped.md 
fintracker-2026-09-21T13-09-12-033Z.sql | /Users/chrstn/.claude/projects/-Users-chrstn-dev-FourthMeridian/memory/pre-s1-clean-baseline.md 
fintracker-2026-10-01T19-22-24-926Z.sql | docs/plans/CRYPTO-REFRESH-REPAIR-OPERATOR-PROCEDURE.md /Users/chrstn/.claude/projects/-Users-chrstn-dev-FourthMeridian/memory/crypto-refresh-repair-shipped.md 
fintracker-2026-10-02T15-55-26-786Z.sql | NONE
fintracker-2026-10-02T19-29-27-081Z.sql | NONE
fintracker-2026-10-07T17-28-16-290Z.sql | NONE
fintracker-2026-10-07T17-32-22-550Z.sql | NONE
fintracker-2026-10-07T19-25-37-104Z.sql | NONE
fintracker-2026-10-15T00-39-17-531Z.sql | STATUS.md docs/plans/BETA-READINESS-REPORT-2026-10-15.md /Users/chrstn/.claude/projects/-Users-chrstn-dev-FourthMeridian/memory/beta-implementation-state.md 
fintracker-2026-10-15T00-51-03-753Z.sql | STATUS.md docs/plans/BETA-READINESS-REPORT-2026-10-15.md 
post-recovery-2026-09-15-fintracker.sql | /Users/chrstn/.claude/projects/-Users-chrstn-dev-FourthMeridian/memory/db-recovery-2026-09-15-executed.md 
post-rollback-2026-09-15-fintracker.sql | docs/plans/DATABASE-ROLLBACK-RECOVERY-2026-09-15.md /Users/chrstn/.claude/projects/-Users-chrstn-dev-FourthMeridian/memory/db-recovery-2026-09-15-executed.md /Users/chrstn/.claude/projects/-Users-chrstn-dev-FourthMeridian/memory/dev-db-restored-2026-08-26-backup.md 
postgres-2026-07-22T17-46-34-550Z.sql | NONE
postgres-2026-07-22T18-16-43-911Z.sql | NONE
postgres-2026-07-22T18-38-57-700Z.sql | NONE
postgres-2026-07-22T19-54-15-225Z.sql | NONE
postgres-2026-07-22T21-13-48-870Z.sql | NONE
postgres-2026-07-26T12-29-21-852Z.sql | NONE
postgres-2026-10-07T18-19-00-079Z.sql | NONE
postgres-2026-10-07T20-43-08-976Z.sql | NONE
postgres-2026-10-15T01-16-14-422Z.sql | STATUS.md docs/plans/BETA-READINESS-REPORT-2026-10-15.md /Users/chrstn/.claude/projects/-Users-chrstn-dev-FourthMeridian/memory/beta-implementation-state.md 
PRE-S1-BASELINE-2026-09-21.txt | /Users/chrstn/.claude/projects/-Users-chrstn-dev-FourthMeridian/memory/pre-s1-clean-baseline.md 
preview-lqagrryecvhbaqvczjgc-post-migrate-pre-backfill-2026-10-06T01-44-13Z.sql | NONE
preview-lqagrryecvhbaqvczjgc-pre-rls-2026-10-06T01-19-40Z.sql | /Users/chrstn/.claude/projects/-Users-chrstn-dev-FourthMeridian/memory/rls-preview-cutover-prep.md 
repair-event-pin-drift-2026-10-02-apply.log | NONE
repair-liability-income-credits-2026-09-21-apply.log | /Users/chrstn/.claude/projects/-Users-chrstn-dev-FourthMeridian/memory/refund-economics-shipped.md 
repair-liability-income-credits-2026-10-02-apply.log | NONE
worktree-evidence-2026-09-21 | /Users/chrstn/.claude/projects/-Users-chrstn-dev-FourthMeridian/memory/pre-s1-clean-baseline.md /Users/chrstn/.claude/projects/-Users-chrstn-dev-FourthMeridian/memory/MEMORY.md 
```

## Result

After deletion: 30 entries, 125M.
