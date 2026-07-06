-- ============================================================================
-- CC-1 verification query — READ-ONLY. No data is modified.
-- Source: scripts/.backfill-logs/backfill-cc-payment-categories-2026-07-04T18-52-22-176Z.json
--         (51 ids, all recorded from='Other' to='Payment'; verified unique).
-- Purpose: confirm the 51 rescued credit-card payment legs currently sit at
--          category = 'Payment' AND flowType = 'DEBT_PAYMENT'.
-- Plan: docs/initiatives/desync/DESYNC_REMEDIATION_2026-07-06.md (RESOLUTION).
-- Run in psql:  \i docs/initiatives/desync/VERIFY_CC1_51.sql
-- ============================================================================

-- The 51 CC-1 ids as a temp view so every query below shares one definition.
CREATE TEMP VIEW cc1_ids (id) AS VALUES
    'cmr45f4va0098117fh3hbfphx', 'cmr45f56o00b8117fmazq5i9v', 'cmr45hz99032c117fz482f6bs', 'cmr45hz9i032e117fdg3v9oqs', 'cmr45i5e403he117f2std2x7n',
    'cmr45i5hh03i0117fr1crdw7d', 'cmr45i5lq03is117f5gapbdef', 'cmr45i5op03ji117fmj22yct5', 'cmr45i5zd03le117fy1i31lwq', 'cmr45i62x03ly117fqblqcuas',
    'cmr45i72203mk117fvz5dt7ag', 'cmr45i72f03mw117fst5h65v6', 'cmr45i7bx03pc117fbcr3k6fx', 'cmr45i7c603pk117f8ppam1ee', 'cmr45i7cb03po117f2y8zeh66',
    'cmr45i7d303q6117f1gst9h8l', 'cmr45i7dm03qk117f6vtv2b13', 'cmr45i7ej03r2117fanrvs87g', 'cmr45i8jm03rw117f0kw6i3x3', 'cmr45i8n203sm117fgtaae157',
    'cmr45i8o603ss117fnojgyb3s', 'cmr45i8qq03t6117fe2h8dphd', 'cmr45i8tn03tu117fm6gozeqy', 'cmr45i8v103u6117f2xirpzl0', 'cmr45i8xm03uo117f3mq4wido',
    'cmr45i91x03vi117fa2mrlo4m', 'cmr45i93803vq117fj8gst6ds', 'cmr45i96w03wc117fzt387jae', 'cmr45i97i03wg117fq78dfmig', 'cmr45i99x03ww117foctkikir',
    'cmr45im8204tm117f8v9jyo9t', 'cmr45iny404v8117fr7kho4zq', 'cmr45iod404yq117fqbdiv7ru', 'cmr45ir6u0534117fq1m3w0p2', 'cmr45irao0540117fomwdh79o',
    'cmr45irb8054a117fm03id87r', 'cmr45iyn505ae117fcrg7v380', 'cmr45iz5v05e8117f2h0z8t0n', 'cmr45iz7h05eq117fc9uwk5xl', 'cmr45iz8r05f4117fvpsd9rjw',
    'cmr45jicv05g2117f4ejn13w5', 'cmr45jidz05ga117fu2kp4s7h', 'cmr45jkea05pe117furgqouzv', 'cmr45jm2t05rw117fwcx5epd0', 'cmr45jnrr05zk117fttln0y9x',
    'cmr45jnu6060a117fsl7lvq1r', 'cmr45jp4l0628117f2kpitkz3', 'cmr45jpdg064m117fzmgefa3e', 'cmr45jph3065g117f177dfwxf', 'cmr45jqa1066o117fdbtys87z',
    'cmr45jqer067o117f8xby9sjm';

-- == Q1. Existence check — are all 51 ids still present? =====================
SELECT (SELECT count(*) FROM cc1_ids)                                       AS expected_ids,
       (SELECT count(*) FROM "Transaction" t JOIN cc1_ids c ON t.id = c.id) AS rows_found;
-- Expect: 51 / 51. A shortfall means some ids no longer exist (deleted/re-keyed).

-- == Q2. THE verdict — current (category, flowType) distribution =============
SELECT t."category"::text  AS category,
       t."flowType"::text   AS flow_type,
       count(*)             AS n
FROM "Transaction" t
JOIN cc1_ids c ON t.id = c.id
GROUP BY 1, 2
ORDER BY n DESC, 1, 2;
-- PASS  (rescue held):       Payment / DEBT_PAYMENT = 51
-- REVERTED (rescue undone):  Other   / REFUND       = 51   (consistent, but CC-1 lost)
-- Anything else -> inspect with Q3.

-- == Q3. Row-level detail for any row NOT in the passing state ===============
SELECT t.id,
       t."category"::text            AS category,
       t."flowType"::text            AS flow_type,
       t."flowDirection"::text       AS flow_direction,
       t."classificationReason"::text AS reason,
       t."classifierVersion"         AS version,
       (t.amount > 0)                AS amount_positive
FROM "Transaction" t
JOIN cc1_ids c ON t.id = c.id
WHERE NOT (t."category" = 'Payment' AND t."flowType" = 'DEBT_PAYMENT')
ORDER BY t.id;
-- Expect: 0 rows when the rescue held.

-- == Q4. One-line PASS/FAIL summary =========================================
SELECT count(*)                                                       AS total_ids_present,
       count(*) FILTER (WHERE t."category" = 'Payment'
                          AND t."flowType" = 'DEBT_PAYMENT')          AS payment_debtpayment,
       count(*) FILTER (WHERE NOT (t."category" = 'Payment'
                          AND t."flowType" = 'DEBT_PAYMENT'))         AS off_state,
       CASE WHEN count(*) = 51
             AND count(*) FILTER (WHERE t."category" = 'Payment'
                          AND t."flowType" = 'DEBT_PAYMENT') = 51
            THEN 'PASS - all 51 at Payment/DEBT_PAYMENT'
            ELSE 'REVIEW - see Q2/Q3' END                            AS verdict
FROM "Transaction" t
JOIN cc1_ids c ON t.id = c.id;

-- Cleanup (optional; temp view drops at session end anyway):
-- DROP VIEW cc1_ids;
