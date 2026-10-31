# Beta-Request Risk — Abuse Assessment and Signal Design (2026-10-31)

Owner directive: *Beta Request Risk Intelligence* (Session 2).
Status: **read-only assessment.** Nothing has been implemented yet.
Production has not been inspected: no Production credentials are available to this session. §5 gives the read-only query for the owner to run, or to authorise.

The owner's estimate of about 20 submissions, about 15 of them suspicious, is an **observation, not a verified fact**. This document does not confirm or refute it.

## 1. Pipeline as built (code, `develop`)

Path: the public `/request-access` form → `POST /api/access-request`.

**Checks, in order:**
1. **IP rate limit:** 5 per 15 min per IP, fixed window. Fails **open** if the store errors.
2. **Email shape:** a simple regex. Normalisation is `trim()` and `toLowerCase()` only.
3. **Consent:** must be true.
4. **Note:** at most 1000 characters.
5. **Turnstile CAPTCHA:** passes when no key is configured and when Cloudflare errors or times out. **Production has no Turnstile key**, so this step is a no-op today.

**Origin check:** applied to browsers only. A request with no `Origin` and no `Sec-Fetch-Site` header, such as curl or a script, passes.

**Duplicates:**
- A `BetaAccessRequest` row is inserted only if none exists for that email. A repeat's note is dropped.
- A `BetaAccessRequestEvent` row is inserted for every submission.
- The response is the same 200 in every case, so it never reveals whether an address exists.

**Side effect:** every submission emails the operator inbox, with no throttle.

**Not present:** honeypot, timing token, disposable-domain list, MX check, blocklist, bot-UA check, per-email limit, global limit, and any durable record of a blocked or 429 request.

## 2. What is stored for each submission

| Store | Useful facts | Retention |
|---|---|---|
| `BetaAccessRequest` | email (unique), first note, status, `createdAt`, decision fields | 180 d unless REDEEMED |
| `BetaAccessRequestEvent` | email, `receivedAt`, allowlisted `source` (utm/referrer/landing path, plus a `country` that can be spoofed through `cf-ipcountry`) | 180 d |
| `AuditLog` `BETA_ACCESS_REQUESTED` | **`ipAddress`, full `userAgent`**, unsalted email hash | **kept indefinitely** (AuditLog is not purged) |
| `RateLimit` | count per `ip:access-request:<ip>` window | about 24–48 h |

The IP and user agent already exist in the audit row. **No new collection is needed** for correlation. Two retention points follow, and they are an owner decision (§7):
- Raw IP and user agent are kept forever in AuditLog.
- The Growth surface must never show raw IPs.

## 3. Signals that can be computed from data we already hold

Each signal has a reason code, a plain-language label, and the evidence behind it. Strength reflects how far the signal can be trusted **on its own**.

| Code | Signal | Source | Strength alone |
|---|---|---|---|
| `BURST_WINDOW` | Request falls in a burst: at least N distinct requesters within M minutes, fleet-wide | event `receivedAt` | moderate |
| `SHARED_NETWORK` | Same IP as 3 or more *other* requesters within 24 h (compared as a digest in SQL; the raw IP is never output) | AuditLog `ipAddress` | moderate |
| `AUTOMATION_UA` | User agent is empty, a script or headless client (curl, python-requests, Go-http-client, HeadlessChrome…), or matches no browser family | AuditLog `userAgent` | moderate |
| `REPEATED_SUBMISSION` | Same normalised email submitted 3 or more times | event count | weak |
| `ALIAS_CLUSTER` | Plus-address or Gmail-dot variants fold to one mailbox that is shared with other requests | email, canonicalised in the core | moderate |
| `DUPLICATE_NOTE` | Note text identical (after normalising) to another requester's | `BetaAccessRequest.note` | moderate |
| `DISPOSABLE_DOMAIN` | Domain is on a pinned, sourced disposable-email list (vendored with its source and date; no network lookup at runtime) | email domain | weak (some real people use them) |
| `NO_BROWSER_SIGNALS` | No referrer, no landing path and no UTM on a submission whose user agent does not look like a browser | source + UA | weak |

**Deliberately excluded:**
- VPN use, country, email provider, name or language patterns.
- An AI or "bot probability" score.
- CAPTCHA results. None exist while Turnstile is off.
- Rate-limit blocks. They are never persisted, so they cannot be shown.

## 4. Classification (explainable, advisory)

| Level | Rule |
|---|---|
| **High suspicion** | Two or more *moderate* signals, at least one of them network- or automation-based (`SHARED_NETWORK`, `AUTOMATION_UA`, `BURST_WINDOW`) |
| **Review suggested** | One moderate signal, or two or more weak ones |
| **No notable signals** | None of the above |
| **Insufficient evidence** | The audit row is missing, for example a request older than the audit trail or a deleted event, so the network and UA signals cannot be evaluated |

**Wording:** "Review suggested" and "High suspicion". Never "bot", "fraud" or "malicious".

**Advisory only:** the classification never blocks approval, never hides a request and never changes its status.

## 5. Production validation: read-only, aggregate-only (owner to run or authorise)

Run inside `BEGIN; SET TRANSACTION READ ONLY; … ROLLBACK;`. The output contains **counts and buckets only**: no email, IP or user agent.

```sql
BEGIN; SET TRANSACTION READ ONLY;
-- volume and status
SELECT status, count(*) FROM "BetaAccessRequest" GROUP BY 1;
SELECT count(*) events, count(DISTINCT lower(trim(email))) requesters, min("receivedAt"), max("receivedAt") FROM "BetaAccessRequestEvent";
-- bursts: requesters per 10-minute bucket (top 10)
SELECT date_trunc('hour',"receivedAt") + floor(extract(minute from "receivedAt")/10)*interval '10 min' b, count(DISTINCT lower(email)) FROM "BetaAccessRequestEvent" GROUP BY 1 ORDER BY 2 DESC LIMIT 10;
-- network sharing: how many requesters share an IP with N others (digest-free: counts only)
WITH ip AS (SELECT "ipAddress" i, count(DISTINCT metadata->>'emailHash') n FROM "AuditLog" WHERE action='BETA_ACCESS_REQUESTED' GROUP BY 1)
SELECT CASE WHEN n=1 THEN '1' WHEN n<=3 THEN '2-3' ELSE '4+' END sharing, count(*) ips, sum(n) requesters FROM ip GROUP BY 1 ORDER BY 1;
-- user-agent families (coarse)
SELECT CASE WHEN "userAgent" IS NULL OR "userAgent"='' THEN 'empty'
            WHEN "userAgent" ~* '(curl|python|go-http|wget|axios|node-fetch|httpclient|okhttp|java/|libwww|scrapy)' THEN 'script'
            WHEN "userAgent" ~* 'headless' THEN 'headless'
            WHEN "userAgent" ~* '(chrome|safari|firefox|edg/)' THEN 'browser'
            ELSE 'other' END fam, count(*) FROM "AuditLog" WHERE action='BETA_ACCESS_REQUESTED' GROUP BY 1 ORDER BY 2 DESC;
-- alias folding: requesters whose plus/dot-folded mailbox collides with another
WITH c AS (SELECT lower(regexp_replace(split_part(email,'@',1),'\+.*$','')) || '@' || lower(split_part(email,'@',2)) k FROM "BetaAccessRequest")
SELECT count(*) FILTER (WHERE n>1) colliding_groups, coalesce(sum(n) FILTER (WHERE n>1),0) requests_in_groups FROM (SELECT k, count(*) n FROM c GROUP BY k) g;
-- duplicate notes
SELECT count(*) FILTER (WHERE n>1) dup_note_groups, coalesce(sum(n) FILTER (WHERE n>1),0) requests FROM (SELECT lower(trim(note)) t, count(*) n FROM "BetaAccessRequest" WHERE note IS NOT NULL AND trim(note)<>'' GROUP BY 1) g;
-- domains: count of distinct domains and the top-5 share (no names)
SELECT count(DISTINCT split_part(lower(email),'@',2)) domains FROM "BetaAccessRequest";
ROLLBACK;
```

**Preview, inspected read-only on 2026-10-31:** 4 test requests and 2 events, all from test domains. **Too few to say anything about the Production population.**

## 6. Implementation plan (Preview, once the owner confirms §7)

1. **`lib/platform/growth/beta-risk-core.ts`** (pure). Signals, reason codes and classification. Tested against synthetic legitimate and suspicious fixtures.
2. **`beta-risk.ts` reader** (systemDb). Joins `AuditLog` by `emailHash`. IP and UA are reduced **in SQL** to a digest or family. Only reason codes and evidence leave the database: counts, timestamps and UA family, never a raw IP or UA.
3. **`BetaAccessRequestReview` table** (additive migration, Preview first). Append-only rows: `requestId`, `status` (UNREVIEWED | LEGITIMATE | SUSPICIOUS), `reasonCode`, `note`, `operatorId`, `createdAt`. The latest row is the current state. Heuristic evidence is never stored over.
4. **API changes:**
   - The existing requests route gains `risk?` (shape agreed with Session 1).
   - New `POST requests/[id]/risk-review`: GROWTH_REVENUE WRITE, fresh session, reason required, audit row in the same transaction.
5. **UI:** after Session 1's PR C (bulk selection) lands, rebased on it:
   - a compact badge column;
   - a risk filter and sort;
   - drawer reasons with evidence timestamps;
   - review history and review actions.
   - Bulk-approve confirmation counts flagged rows (Session 1's contract).

## 7. Owner decisions

1. **Turnstile in Production.** Set the keys. The code already exists; this is configuration only and needs approval.
2. **Origin bypass for non-browser POSTs** on `/api/access-request`. Require a browser `Origin` header for this public route?
3. **Retention of raw IP and UA** in `BETA_ACCESS_REQUESTED` audit rows, currently indefinite. Proposal: keep a 90-day digest, then null the raw fields. This is a privacy review item.
4. **Per-email and global limits on intake**, plus throttling the operator email (today one email per submission).
5. **Disposable-domain list:** source, licence and update cadence.
6. **`cf-ipcountry` spoofing.** Gate it on `CLIENT_IP_TRUST_CLOUDFLARE` like the IP header.
7. **Whether the bulk-approval acknowledgement count is recorded in the audit row.** Session 1 offered `acknowledgedFlagged`.

## 8. Future: free-registration abuse (design notes)

These are separate problems and need separate controls.

| Problem | Existing data | Missing | Graduated response |
|---|---|---|---|
| Marketing / beta intake | events, audit IP/UA | challenge, global limit | observe → flag → rate-limit → require challenge |
| Account registration | `REGISTER` audit (**no IP/UA**), verification flow | IP/UA on `REGISTER`; registrations that never verify | observe → flag → step-up verification → restrict on owner authorisation |
| Authentication | `LOGIN_FAILED` with IP/UA, detectors (identifier/IP bursts) | lockout state | already rate-limited per IP and identifier (fail-closed); add review queue |
| API / resource use | AI allowance, policy entitlements, rate limits | durable record of rate-limit violations | entitlement caps, then cost freeze (Beta lifecycle work), then restriction on authorisation |

**Principles:**
- Every response is reversible, has a review path and is audited.
- Retention is bounded.
- No automatic bans based on a heuristic score.
