# Production beta-request investigation: results (2026-10-31)

**Authority.** The owner approved creating the temporary `fm_diag_ro` role and running the masked, read-only investigation ("You have the green light. Execute.").

**Method.**
- **Role:** `fm_diag_ro`, created per `docs/operations/sql/prod-diag-readonly-role.md` §2 (helper and docs pinned at `8320dc3`). Expiry was 24 h. The password was generated locally and set as a SCRAM-SHA-256 verifier, so the plaintext never reached Supabase. It was deleted afterwards.
- **Pre-checks (all passed):** the 18-row precheck, plus no `dblink`/`postgres_fdw`, no foreign servers, no user mappings, and no non-builtin SECURITY DEFINER functions in `pg_catalog`.
- **Role verified before any connection:**
  - not superuser and no BYPASSRLS;
  - read-only by default;
  - exactly 17 column grants and no table-level grant;
  - 4 SELECT-only RLS policies;
  - 0 memberships;
  - no CREATE and no write privilege;
  - no access to `User` or `inviteTokenHash`.
- **Connection:** the helper ran with `DIAG_REQUIRE_ROLE=fm_diag_ro` through the Supavisor session pooler, because the direct host is IPv6-only. Every run printed `read_only_guard = on` and `read_only_role_guard = verified`.
- **Retired:** the role was dropped per §6. Verified afterwards: 0 roles, 0 policies, 0 sessions; the schema ACL is unchanged; Production `/api/health` returns `db: ok`.
- **Approved scope and its extension:** the approved investigation is sections A–F. The supplementary queries E2–E4 and D2–D3 stay within the same role, the same columns and the same masking rules, and output counts and anonymous agent-group numbers only. They extend section E because 16 of the 20 audit rows predate the `emailHash` metadata, so E could only see 4.
- **No customer data was modified.** No status changed, no email was sent, no invitation was issued.

## Findings

| | Count |
|---|---|
| Requests | **20**, all `PENDING` (the owner's estimate was ~20) |
| One-actor cluster (high suspicion) | **13** |
| Plausibly genuine | **7** |

**The cluster (13 requests, 6 Sep – 22 Oct).** Every one of the 13 has all of the following:
- **byte-identical desktop user-agent string** (anonymous group 4). A real population drifts across Chrome releases over seven weeks; these didn't;
- **Gmail** local parts with **two or more dots**; 9 of them have the shape `letter.…` (e.g. `y.…`, `u.…`, `c.…`). Gmail ignores dots, but none fold into a single mailbox;
- a **long, unique note** (13+ characters, no duplicate text);
- a **different network** for each request (no IP shared across any of the 20 intake rows), consistent with rotating proxies;
- an evenly spaced cadence: about one every 3–5 days, at varied hours (02–22 UTC);
- no event-ledger row, no acquisition source, no plus-alias and no 4-digit run.

**Plausibly genuine (7).**
- **2 early requests:** 26 Jul and 11 Aug, desktop, unique agents, no note.
- **1 iCloud request:** mobile, 10 Oct.
- **4 late-October requests:** mobile, browser, with acquisition source and country present, and event-ledger rows. They span 3 anonymous agent groups; 2 share an agent string, which is common for iPhone Safari.

**Compared with the owner's estimate** of about 15 suspicious out of about 20: the evidence supports **13 high-suspicion requests out of 20**. The other 7 show no notable signals. The 2 early desktop requests can't be fully cleared, because they have no event-ledger row and no acquisition source.

**Advisory only.** These are heuristic signals, not proof. Nothing was blocked, rejected or changed. The decision is the owner's, in Growth's review flow; the #161 risk signals will show these patterns once their per-request evidence exists.

**Recommendations (owner decisions):**
1. Hold the 13 as **Review suggested / High suspicion**, and don't approve them without manual verification.
2. Turnstile in Production (already approved in principle; it needs the Preview validation and the keys).
3. The intake hardening in PR #160 (per-IP, per-email and global limits, operator-email throttle) blunts this pattern, whose rotating IPs per request defeat a per-IP limit on their own.
4. Consider a `same exact UA across N requests in M days` signal for `beta-risk-core` (privacy-preserving: computed in SQL, output as a group size only).

## Masked output (verbatim)
```
 read_only_guard 
-----------------
 on
(1 row)

 read_only_role_guard 
----------------------
 verified
(1 row)

== A. Totals by status
 status  | count 
---------+-------
 PENDING |    20

== B. Submission timeline (requests per UTC day, events per UTC day)
    day     | new_requests | submissions 
------------+--------------+-------------
 2026-07-26 |            1 |           0
 2026-08-11 |            1 |           0
 2026-09-06 |            1 |           0
 2026-09-12 |            1 |           0
 2026-09-14 |            1 |           0
 2026-09-15 |            1 |           0
 2026-09-18 |            1 |           0
 2026-09-27 |            1 |           0
 2026-10-01 |            1 |           0
 2026-10-03 |            1 |           0
 2026-10-10 |            1 |           0
 2026-10-15 |            1 |           0
 2026-10-17 |            2 |           0
 2026-10-22 |            2 |           0
 2026-10-26 |            2 |           2
 2026-10-27 |            1 |           1
 2026-10-31 |            1 |           1

== C. Evidence coverage: audit rows with network and agent data
 audit_rows | with_ip | with_ua | with_email_hash 
------------+---------+---------+-----------------
         20 |      20 |      20 |               4

== D. Per-request evidence (masked)
  req   | status  | created_hour_utc |    masked_email     | disposable | local_len_bucket | local_has_4digits | plus_alias | alias_group | submissions | has_note | note_len_bucket | same_note_group | ua_family | others_on_network | others_within_10m | has_source | country | decided | redeemed | decision_events 
--------+---------+------------------+---------------------+------------+------------------+-------------------+------------+-------------+-------------+----------+-----------------+-----------------+-----------+-------------------+-------------------+------------+---------+---------+----------+-----------------
 jsuu70 | PENDING | 2026-07-26 16:00 | aj…@gmail.com       | no         | 6-12             | f                 | f          |           1 |           0 | f        | 0               |               0 |           |                   |                 0 |            | absent  | f       | f        |               0
 tpknbw | PENDING | 2026-08-11 12:00 | my…@(custom domain) | no         | 6-12             | f                 | f          |           1 |           0 | f        | 0               |               0 |           |                   |                 0 |            | absent  | f       | f        |               0
 hzupno | PENDING | 2026-09-06 17:00 | y.…@gmail.com       | no         | 13+              | f                 | f          |           1 |           0 | t        | 13+             |               1 |           |                   |                 0 |            | absent  | f       | f        |               0
 bkz6ox | PENDING | 2026-09-12 07:00 | u.…@gmail.com       | no         | 13+              | f                 | f          |           1 |           0 | t        | 13+             |               1 |           |                   |                 0 |            | absent  | f       | f        |               0
 eqynsb | PENDING | 2026-09-14 05:00 | id…@gmail.com       | no         | 13+              | f                 | f          |           1 |           0 | t        | 13+             |               1 |           |                   |                 0 |            | absent  | f       | f        |               0
 2n6m3v | PENDING | 2026-09-15 04:00 | c.…@gmail.com       | no         | 6-12             | f                 | f          |           1 |           0 | t        | 13+             |               1 |           |                   |                 0 |            | absent  | f       | f        |               0
 50zg4y | PENDING | 2026-09-18 07:00 | h.…@gmail.com       | no         | 13+              | f                 | f          |           1 |           0 | t        | 13+             |               1 |           |                   |                 0 |            | absent  | f       | f        |               0
 yzvhm1 | PENDING | 2026-09-27 21:00 | n.…@gmail.com       | no         | 13+              | f                 | f          |           1 |           0 | t        | 13+             |               1 |           |                   |                 0 |            | absent  | f       | f        |               0
 9eyhv5 | PENDING | 2026-10-01 02:00 | o.…@gmail.com       | no         | 13+              | f                 | f          |           1 |           0 | t        | 13+             |               1 |           |                   |                 0 |            | absent  | f       | f        |               0
 aobmcd | PENDING | 2026-10-03 17:00 | r.…@gmail.com       | no         | 13+              | f                 | f          |           1 |           0 | t        | 13+             |               1 |           |                   |                 0 |            | absent  | f       | f        |               0
 972sb1 | PENDING | 2026-10-10 05:00 | ja…@icloud.com      | no         | 6-12             | f                 | f          |           1 |           0 | t        | 13+             |               1 |           |                   |                 0 |            | absent  | f       | f        |               0
 9qveys | PENDING | 2026-10-15 04:00 | jo…@gmail.com       | no         | 13+              | f                 | f          |           1 |           0 | t        | 13+             |               1 |           |                   |                 0 |            | absent  | f       | f        |               0
 0y5om1 | PENDING | 2026-10-17 08:00 | u.…@gmail.com       | no         | 13+              | f                 | f          |           1 |           0 | t        | 13+             |               1 |           |                   |                 0 |            | absent  | f       | f        |               0
 efst3n | PENDING | 2026-10-17 20:00 | qi…@gmail.com       | no         | 13+              | f                 | f          |           1 |           0 | t        | 13+             |               1 |           |                   |                 0 |            | absent  | f       | f        |               0
 fgmk5w | PENDING | 2026-10-22 09:00 | q.…@gmail.com       | no         | 6-12             | f                 | f          |           1 |           0 | t        | 13+             |               1 |           |                   |                 0 |            | absent  | f       | f        |               0
 4sowiz | PENDING | 2026-10-22 22:00 | ul…@gmail.com       | no         | 13+              | f                 | f          |           1 |           0 | t        | 13+             |               1 |           |                   |                 0 |            | absent  | f       | f        |               0
 yw52au | PENDING | 2026-10-26 01:00 | ca…@gmail.com       | no         | 13+              | f                 | f          |           1 |           1 | f        | 0               |               0 | browser   |                 0 |                 0 | t          | present | f       | f        |               0
 f22fnt | PENDING | 2026-10-26 14:00 | di…@gmail.com       | no         | 13+              | f                 | f          |           1 |           1 | f        | 0               |               0 | browser   |                 0 |                 0 | t          | present | f       | f        |               0
 5ys0fv | PENDING | 2026-10-27 15:00 | ma…@gmail.com       | no         | 6-12             | f                 | f          |           1 |           1 | f        | 0               |               0 | browser   |                 0 |                 0 | t          | present | f       | f        |               0
 j7mf0z | PENDING | 2026-10-31 01:00 | jo…@gmail.com       | no         | 13+              | f                 | f          |           1 |           1 | t        | 13+             |               1 | browser   |                 0 |                 0 | t          | present | f       | f        |               0

== E. Network sharing distribution (counts only)
   bucket    | networks | requesters 
-------------+----------+------------
 1 requester |        4 |          4

== F. Current rate-limit rows for the intake (last ~24-48h only; counts, no keys)
 windows | max_hits_in_a_window 
---------+----------------------
       1 |                    1

== E2. Network sharing across ALL intake audit rows (counts only; no hash join)
 bucket | networks | audit_rows 
--------+----------+------------
 1 row  |       20 |         20
(1 row)

== E3. User-agent family across ALL intake audit rows (counts only)
    ua_family    | audit_rows | distinct_agents 
-----------------+------------+-----------------
 browser-desktop |         15 |               3
 browser-mobile  |          5 |               4
(2 rows)

== E4. Intake audit rows per UTC day vs requests per day (counts only)
    day     | audit_rows 
------------+------------
 2026-07-26 |          1
 2026-08-11 |          1
 2026-09-06 |          1
 2026-09-12 |          1
 2026-09-14 |          1
 2026-09-15 |          1
 2026-09-18 |          1
 2026-09-27 |          1
 2026-10-01 |          1
 2026-10-03 |          1
 2026-10-10 |          1
 2026-10-15 |          1
 2026-10-17 |          2
 2026-10-22 |          2
 2026-10-26 |          2
 2026-10-27 |          1
 2026-10-31 |          1
(17 rows)

== D2. Request to intake audit row matched by time (+-120 s); anonymous agent group numbers only, never the agent
  req   |   hour_utc    |      shape       |  dots   | has_note |  kind   | ua_cluster | audit_offset_s 
--------+---------------+------------------+---------+----------+---------+------------+----------------
 jsuu70 | 2026-07-26 16 | gmail other      | no dot  | f        | desktop |          1 | 0.0
 tpknbw | 2026-08-11 12 | custom           | no dot  | f        | desktop |          3 | 0.0
 hzupno | 2026-09-06 17 | gmail letter-dot | 2+ dots | t        | desktop |          4 | 0.0
 bkz6ox | 2026-09-12 07 | gmail letter-dot | 2+ dots | t        | desktop |          4 | 0.0
 eqynsb | 2026-09-14 05 | gmail other      | 2+ dots | t        | desktop |          4 | 0.0
 2n6m3v | 2026-09-15 04 | gmail letter-dot | 2+ dots | t        | desktop |          4 | 0.0
 50zg4y | 2026-09-18 07 | gmail letter-dot | 2+ dots | t        | desktop |          4 | 0.0
 yzvhm1 | 2026-09-27 21 | gmail letter-dot | 2+ dots | t        | desktop |          4 | 0.0
 9eyhv5 | 2026-10-01 02 | gmail letter-dot | 2+ dots | t        | desktop |          4 | 0.0
 aobmcd | 2026-10-03 17 | gmail letter-dot | 2+ dots | t        | desktop |          4 | 0.0
 972sb1 | 2026-10-10 05 | icloud           | no dot  | t        | mobile  |          5 | 0.0
 9qveys | 2026-10-15 04 | gmail other      | 2+ dots | t        | desktop |          4 | 0.0
 0y5om1 | 2026-10-17 08 | gmail letter-dot | 2+ dots | t        | desktop |          4 | 0.0
 efst3n | 2026-10-17 20 | gmail other      | 2+ dots | t        | desktop |          4 | 0.0
 fgmk5w | 2026-10-22 09 | gmail letter-dot | 2+ dots | t        | desktop |          4 | 0.0
 4sowiz | 2026-10-22 22 | gmail other      | 2+ dots | t        | desktop |          4 | 0.0
 yw52au | 2026-10-26 01 | gmail other      | no dot  | f        | mobile  |          2 | 0.0
 f22fnt | 2026-10-26 14 | gmail other      | no dot  | f        | mobile  |          7 | 0.0
 5ys0fv | 2026-10-27 15 | gmail other      | 1 dot   | f        | mobile  |          7 | 0.0
 j7mf0z | 2026-10-31 01 | gmail other      | 1 dot   | t        | mobile  |          6 | 0.0
(20 rows)

== D3. Agent groups: size and request-shape mix (counts only)
 ua_cluster |  kind   | audit_rows 
------------+---------+------------
          4 | desktop |         13
          7 | mobile  |          2
          1 | desktop |          1
          2 | mobile  |          1
          3 | desktop |          1
          5 | mobile  |          1
          6 | mobile  |          1
(7 rows)

```
