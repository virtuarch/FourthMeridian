-- docs/operations/sql/beta-request-prod-investigation.sql
-- Owner-authorised, STRICTLY READ-ONLY investigation of Production beta access requests (2026-10-31).
--
-- Run ONLY through the read-only helper, which wraps everything in ONE transaction
-- that begins `SET TRANSACTION READ ONLY` (nothing can be written):
--
--   DIAG_DATABASE_URL='<production read-only or pooled URL — never paste it into chat>' \
--     scripts/db-readonly-psql.sh -f docs/operations/sql/beta-request-prod-investigation.sql
--
-- PRIVACY: every signal is computed INSIDE the database. Nothing here outputs a full
-- email address, a raw IP, a user agent or note text. The output contains:
--   - the request id's last 6 characters,
--   - a masked email (first 2 characters of the local part, the domain CATEGORY,
--     and the domain itself only for well-known free-mail providers),
--   - counts, time buckets and derived flags.
-- The output is safe to paste back for analysis.
-- Shared networks are compared by md5 of the IP INSIDE SQL. Only the COUNT of other
-- requesters on the same network is output.

\pset footer off

\echo '== A. Totals by status'
SELECT status, count(*) FROM "BetaAccessRequest" GROUP BY 1 ORDER BY 1;

\echo '== B. Submission timeline (requests per UTC day, events per UTC day)'
SELECT d::date AS day,
       (SELECT count(*) FROM "BetaAccessRequest" r WHERE r."createdAt"::date = d::date) AS new_requests,
       (SELECT count(*) FROM "BetaAccessRequestEvent" e WHERE e."receivedAt"::date = d::date) AS submissions
  FROM generate_series((SELECT min("createdAt")::date FROM "BetaAccessRequest"), current_date, interval '1 day') d
 WHERE EXISTS (SELECT 1 FROM "BetaAccessRequestEvent" e WHERE e."receivedAt"::date = d::date)
    OR EXISTS (SELECT 1 FROM "BetaAccessRequest" r WHERE r."createdAt"::date = d::date)
 ORDER BY 1;

\echo '== C. Evidence coverage (do audit rows exist with network/agent data?)'
SELECT count(*) AS audit_rows, count("ipAddress") AS with_ip, count("userAgent") AS with_ua,
       count(*) FILTER (WHERE metadata ? 'emailHash') AS with_email_hash
  FROM "AuditLog" WHERE action = 'BETA_ACCESS_REQUESTED';

\echo '== D. Per-request evidence (masked)'
WITH req AS (
  SELECT r.id, r.status::text AS status, r."createdAt", r."decidedAt", r."redeemedAt", r.note,
         lower(trim(r.email)) AS em,
         split_part(lower(trim(r.email)), '@', 2) AS dom,
         split_part(lower(trim(r.email)), '@', 1) AS loc,
         encode(sha256(convert_to(lower(trim(r.email)), 'UTF8')), 'hex') AS ehash
    FROM "BetaAccessRequest" r
),
canon AS (
  SELECT id, CASE WHEN dom IN ('gmail.com','googlemail.com')
                  THEN replace(regexp_replace(loc, '\+.*$', ''), '.', '') || '@gmail.com'
                  ELSE regexp_replace(loc, '\+.*$', '') || '@' || dom END AS ckey
    FROM req
),
aud AS (
  SELECT metadata->>'emailHash' AS ehash,
         md5(coalesce("ipAddress", '')) AS net, ("ipAddress" IS NOT NULL) AS has_ip,
         CASE WHEN "userAgent" IS NULL OR "userAgent" = '' THEN 'empty'
              WHEN "userAgent" ~* '(curl|python|go-http|wget|axios|node-fetch|undici|httpclient|okhttp|java/|libwww|scrapy|postman|insomnia)' THEN 'script'
              WHEN "userAgent" ~* '(headless|phantom|puppeteer|playwright|selenium)' THEN 'headless'
              WHEN "userAgent" ~* '(chrome|safari|firefox|edg/|opr/)' THEN 'browser'
              ELSE 'other' END AS ua_family,
         "createdAt" AS at
    FROM "AuditLog" WHERE action = 'BETA_ACCESS_REQUESTED'
),
aud1 AS (  -- one audit row per requester (earliest)
  SELECT DISTINCT ON (ehash) ehash, net, has_ip, ua_family, at FROM aud ORDER BY ehash, at
),
ev AS (
  SELECT lower(trim(email)) AS em, count(*) AS submissions, min("receivedAt") AS first_at, max("receivedAt") AS last_at,
         bool_or(source ? 'utmSource' OR source ? 'referrerHost' OR source ? 'landingPath') AS has_source,
         max(source->>'country') AS country
    FROM "BetaAccessRequestEvent" GROUP BY 1
)
SELECT right(q.id, 6) AS req,
       q.status,
       to_char(q."createdAt", 'YYYY-MM-DD HH24:MI') AS created_utc,
       left(q.loc, 2) || '…@' ||
         CASE WHEN q.dom IN ('gmail.com','googlemail.com','outlook.com','hotmail.com','live.com','yahoo.com','icloud.com','me.com','proton.me','protonmail.com','aol.com','gmx.com','mail.com','yandex.com')
              THEN q.dom ELSE '(custom domain)' END AS masked_email,
       CASE WHEN q.dom IN ('mailinator.com','guerrillamail.com','guerrillamail.net','sharklasers.com','10minutemail.com','temp-mail.org','tempmail.com','yopmail.com','trashmail.com','getnada.com','dispostable.com','maildrop.cc','throwawaymail.com','mintemail.com','fakeinbox.com','spamgourmet.com','mailnesia.com','emailondeck.com','tempr.email','moakt.com','mohmal.com','burnermail.io','33mail.com','grr.la','spam4.me','trbvm.com','dropmail.me','tempmailo.com','emailfake.com','fakemail.net')
            THEN 'yes' ELSE 'no' END AS disposable,
       length(q.loc) AS local_len,
       (q.loc ~ '\d{4,}') AS local_has_4digits,
       (q.loc LIKE '%+%') AS plus_alias,
       (SELECT count(*) FROM canon c2 WHERE c2.ckey = c.ckey) AS alias_group,
       coalesce(e.submissions, 0) AS submissions,
       (q.note IS NOT NULL AND trim(q.note) <> '') AS has_note,
       coalesce(length(trim(q.note)), 0) AS note_len,
       (SELECT count(*) FROM req q2 WHERE q2.note IS NOT NULL AND trim(q2.note) <> '' AND lower(trim(q2.note)) = lower(trim(q.note))) AS same_note_group,
       a.ua_family,
       CASE WHEN a.ehash IS NULL THEN NULL
            WHEN NOT a.has_ip THEN NULL
            ELSE (SELECT count(DISTINCT a2.ehash) - 1 FROM aud a2 WHERE a2.net = a.net AND a2.ehash IS NOT NULL) END AS others_on_network,
       (SELECT count(*) - 1 FROM req q3 WHERE q3."createdAt" BETWEEN q."createdAt" - interval '10 minutes' AND q."createdAt" + interval '10 minutes') AS others_within_10m,
       e.has_source, e.country,
       (q."decidedAt" IS NOT NULL) AS decided, (q."redeemedAt" IS NOT NULL) AS redeemed,
       (SELECT count(*) FROM "AuditLog" l WHERE l.action IN ('BETA_ACCESS_APPROVED','BETA_ACCESS_DENIED','BETA_INVITATION_CREATED','BETA_INVITATION_RESENT','BETA_INVITATION_REVOKED')
          AND l.metadata->>'emailHash' = q.ehash) AS decision_events
  FROM req q
  JOIN canon c ON c.id = q.id
  LEFT JOIN aud1 a ON a.ehash = q.ehash
  LEFT JOIN ev e ON e.em = q.em
 ORDER BY q."createdAt";

\echo '== E. Network sharing distribution (counts only)'
SELECT CASE WHEN n = 1 THEN '1 requester' WHEN n <= 3 THEN '2-3 requesters' ELSE '4+ requesters' END AS bucket,
       count(*) AS networks, sum(n) AS requesters
  FROM (SELECT md5("ipAddress") AS net, count(DISTINCT metadata->>'emailHash') AS n
          FROM "AuditLog" WHERE action = 'BETA_ACCESS_REQUESTED' AND "ipAddress" IS NOT NULL GROUP BY 1) g
 GROUP BY 1 ORDER BY 1;

\echo '== F. Current rate-limit rows for the intake (last ~24-48h only; counts, no keys)'
SELECT count(*) AS windows, coalesce(max(count), 0) AS max_hits_in_a_window
  FROM "RateLimit" WHERE key LIKE 'ip:access-request:%';
