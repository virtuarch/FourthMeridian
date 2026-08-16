# Plaid Support ticket — removal of orphaned Production Items

> **Send-ready as of 2026-08-16.** No placeholders, no unverified identifiers.
> Everything below the rule is the ticket. Everything below "Not sent — internal" is not.

---

**Subject:** Production — remove orphaned Items; access_tokens permanently lost (client_id 6a26ffaf4d9409000e53f464)

Hello,

We have a number of Items live under our Production `client_id` that we can no longer
remove ourselves, because we no longer hold their `access_tokens`. We're asking for help
removing them, and we've included a protect-list so nothing in use is touched.

**Account**

- Client ID (Production): `6a26ffaf4d9409000e53f464`
- Environment: Production
- Contact: Chris Hogan — <chr.hogan1997@gmail.com>

**What we're asking for**

1. Remove the three Items in §1.
2. Send us the `item_id`s of all Items currently live under this `client_id`.
3. After we reply confirming them against §2, remove the remaining orphans.

Please don't remove anything beyond §1 until we've confirmed your list in writing.

## Why we can't do this ourselves

`/item/remove` requires the Item's `access_token`. These Items were created by a
development environment whose database was destroyed on 2026-07-19; that database held
the only copy of their tokens, and our earliest surviving backup postdates the loss. We
no longer hold those tokens in any form — this isn't a case of tokens expiring or
erroring, so there is no call we can make to clean these up ourselves.

## §1 — Orphaned Items to remove

```
0pqXYbDgNqtPvryMK1KQI67AwqDJAeCejAnDN
wbdJ0j9PB8uBEwxMZnzbh1xXgwYaBytdrY6pO
KnAjNkxpzgc3Pw65dB46fayq4p7QAXsdApqLQ
```

These three appear in our Dashboard's Developer Logs as webhook deliveries under our
`client_id`, and match no Item record in either of our databases. Our application does
not use them, and no customer of ours depends on them.

## §2 — Protect-list: do NOT remove

These eight Items are live and in use. Please exclude them from removal in both step 1
and step 3.

```
VVZw4kaar7t8ewZj4gResPpyN8zymNIOKx9Rd    Robinhood
8w41YwpNgVHYJ5xgwzwPS4w1ND4n6wI19eX89    Charles Schwab
zYVKgyBDOLuZK8LDEJwdFYZdyQkbMkCAKwYBQ    American Express
REj4Y3JKVYiDgbAen6ekt71MLB6AqmtVBvg5o    Chase
AkY6XxnJKeF6zQaJgEykFNO6Y4ZzxnCN9dqAe    American Express
1Oz8qQX9OkSKNQRnZ4MNHbeQ4q63vBUb0N8Bx    Chase
xnVV47P50JSEddnb94rbtLLoBoRN6vtRyvkLj    Robinhood
JEDyLJvM3dS8EzDJwxRafZxkO0aM8Yf96xMZr    Charles Schwab
```

Two notes so nothing here is mistaken for an orphan:

- There are two Items per institution because we run two environments against this one
  `client_id`. Both sets are in active use. The duplication is expected, not a fault.
- `JEDyLJvM3dS8EzDJwxRafZxkO0aM8Yf96xMZr` (Charles Schwab) currently reports
  `ITEM_LOGIN_REQUIRED`. It is still in use and pending re-authentication — please keep it.

## §3 — The remaining orphans

We believe further orphaned Items exist beyond the three in §1, but we cannot list them.

- **This is an estimate, not a firm count:** we expect roughly six, derived by
  subtracting the Items we can account for from the live-Item count shown on our
  Dashboard on 2026-08-01.
- We cannot recover their `item_id`s ourselves. Developer Logs retain 14 days, and the
  events that would have named them fell outside that window before we identified the
  problem.

That is why we're asking for the enumeration in step 2 — your list is the only remaining
source for these `item_id`s.

Once the removals are done, a quick confirmation would be appreciated so we can close
this out on our side.

Thanks very much,
Chris Hogan

---

# Not sent — internal

## Verification record — 2026-08-16

| Claim in the ticket | How verified | Verdict |
| --- | --- | --- |
| `6a26ffaf...` is the Production client_id | Used in a live `/item/get` call against Plaid Production; call succeeded | **Observed** |
| §1 IDs came from our Developer Logs | Dashboard → Developers → Logs, Type=Webhook, read 2026-08-10 | **Observed** |
| §1 IDs match no record in our databases | Cross-checked against **all 20** Item records: 13 local (4 real + 9 seed) + 7 production. No match | **Observed** |
| Four production protect-list Items are live | `/admin/providers` on production: all four `ACTIVE`, all synced successfully on 2026-08-16 | **Observed** |
| Four local protect-list Items are live | `/item/get` returned a live Item for each, 2026-08-16 | **Observed** |
| Schwab Item is in `ITEM_LOGIN_REQUIRED` | `item.error` on that `/item/get` response | **Observed** |
| Two Items per institution is expected | Both environments link the same four institutions on one `client_id` | **Observed** |
| Dev database destroyed 2026-07-19; no earlier backup | `backups/` listing — earliest file is 2026-07-19T09:30 | **Observed** |
| `/item/remove` requires the access_token | Plaid API contract | **Observed** |
| ~6 further orphans | Dashboard live-Item count on 2026-08-01 minus the 8 accounted-for Items | **Estimate — labelled as such in the ticket** |
| §1 Items are still live at Plaid | Cannot be checked without their tokens. Immaterial: removal is a no-op if already gone | **Unverifiable — not claimed in the ticket** |

## Deliberately excluded

- **Three production Items in `REVOKED` / `ITEM_NOT_FOUND` state**
  (`NLEXpOPMOpCa9qR0yRR6iPYZevp3BYtYbVBRy`, `5kOwdo6L8khRPBqrpMzdhAMkz0Z4NatDVMrPd`,
  `AXgZn8n8xoHpeZdvdr7zfygb309o61INO4dMd`, all American Express, all 2026-07-22). Already
  gone at Plaid. Listing them would add noise to both §1 and §2.
- The nine `demo_item_*` seed rows in the local database. Not real Plaid Items.
- Billing figures, the incident timeline, the `db:wipe` root cause and its fix, the
  `server-only` script breakage, Item Debugger reliability, and our recovery tooling.
  None of it changes what Support does.

## Production access note

The production `item_id`s could not be obtained programmatically from the dev machine.
`vercel env pull` succeeds but returns **empty strings** for every secret including
`DATABASE_URL`, so the production database is unreachable locally even with an
authenticated Vercel CLI. The working route is the production `/admin/providers` page,
which renders `PlaidItem.externalItemId` per row and is read-only by construction.
