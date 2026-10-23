# THE SILENT REFUSAL

Status: **FINDING — prerequisite to Slice C S7/S8, to the Plaid split-authority
slice, and to the AI per-tool scoping slice.**
Found: 2026-10-02, from two independent directions on the same day — reviewing
the Plaid split-authority design (writes) and the AI per-tool scoping design
(reads).
Scope: read-only investigation. No code changed by this document.

---

## One defect, two faces

RLS can refuse quietly. Where it does, this codebase has code that reads the
quiet refusal as a **meaningful answer** and says so.

- **WRITES** — a refused `UPDATE`/`DELETE` returns `{count: 0}`, which seven
  compare-and-swap sites read as *"somebody else got there first."* (Part 1.)
- **READS** — a refused `SELECT` returns an empty set, which ten sites on the AI
  surface read as *"you have none of these."* (Part 2.)

Both turn a security refusal into a confident, calm, wrong statement. Neither is
reachable by widening a policy or adding a grant, because neither is a database
defect: Postgres is behaving exactly as specified in both cases. The defect is
that we ask a question whose answer cannot distinguish *refused* from *absent*,
and then publish the answer.

Part 2 is the worse half, because its output is English handed to a model that
will repeat it to the user.

---

# PART 1 — WRITES: WHEN A REFUSAL LOOKS LIKE LOSING A RACE

## The asymmetry

Under `fm_app`, a policy refusal is **not** uniformly loud:

| Statement | Refused by | Observable as |
|---|---|---|
| `INSERT` | `WITH CHECK` | **raises** — `new row violates row-level security policy` |
| `UPDATE` / `DELETE` | `USING` | **`{ count: 0 }`** — no error, no warning, no log |
| `SELECT` | `USING` | an empty result set |

`updateMany`/`deleteMany` return a count, and a row the policy hides is simply
not a row the statement matched. Postgres is behaving exactly as specified.
The hazard is entirely on our side: **we have code that reads that count as a
business answer.**

## Why that is worse than an error

The seven sites below are all compare-and-swap: a conditional bulk update whose
count distinguishes *"I won"* from *"somebody else got there first"*. That is a
correct and idiomatic lock when the only reason to match zero rows is
contention. Add RLS and a second reason appears, with the same signature.

So a tenant isolation refusal is reported to the product as **ordinary
contention**, and contention has a defined, calm, permanent response: back off
and let the other worker finish. There is no other worker. Nothing retries into
success, nothing escalates, and nothing is written to any log — the failure
mode is a system that politely does nothing, forever, while reporting health.

## The seven sites

| # | Site | Count means today | Under a refusal it would mean |
|---|---|---|---|
| 1 | `lib/plaid/sync-lock.ts:74` `claimPlaidItemSyncLock` | `0` ⇒ another sync is in flight | permanent phantom contention; **never refreshes** |
| 2 | `lib/plaid/sync-lock.ts:81` (the `syncIncompleteAt` stamp inside that failure branch) | — | refused and **`.catch(() => {})`** — swallowed twice over |
| 3 | `lib/ai/brief/store.ts:174` `claim` | `1` ⇒ I hold the generation lease | lease lost; falls through to `createMany`, which **raises** — accidentally rescued |
| 4 | `lib/platform-settings.ts:334` `setSettingIfVersion` | `1` ⇒ optimistic token matched | reported to the operator as a concurrent edit (409). Loud, but a lie |
| 5 | `lib/platform-settings.ts:343` `deleteSettingIfVersion` | `1` ⇒ token matched | same |
| 6 | `app/api/imports/[id]/rollback/route.ts:152` | `0` ⇒ not rollback-eligible | **tenant request path**, converted by Slice C S8 |
| 7 | `jobs/retry-notifications.ts:208` | `0` ⇒ `claimLost` | job path on `fm_system`; lower risk, same shape |

Site 3 is the instructive one. It survives only because its *fallback* is an
`INSERT`, and inserts raise. Nobody designed that rescue; it is luck, and it is
the only one of the seven that has any.

## The rule

> Inside a tenant phase, a zero-row `updateMany`/`deleteMany` is **indeterminate**
> unless the row's visibility was already established in the same phase. It may
> not be reported as a business outcome.

## The mechanism

A convention cannot carry this — the whole problem is that the wrong code looks
right. The distinction is cheap to make mechanically, because *visibility* and
*the CAS condition* can be asked separately:

```ts
const { count } = await client.x.updateMany({ where: { id, ...condition }, data });
if (count === 0) {
  // Can I see the row AT ALL, ignoring the CAS condition? Subject to the same
  // policy, so this answers "did RLS hide it" — the question the CAS cannot.
  const visible = await client.x.count({ where: { id } });
  if (visible === 0) throw new IndeterminateWriteError(...);  // refusal or vanished
  return false;                                               // genuine contention
}
```

One extra indexed `count`, on the failure path only. `visible === 0` conflates
"RLS hid it" with "it was deleted" — and that is fine, because **neither is
contention**, which is the only thing the caller is entitled to conclude.

Note this is not reachable by widening a policy or by a grant. It is a property
of how our code reads a count, and it would still be a defect if RLS were
switched off tomorrow and the row had merely been deleted.

## Recommendation (writes)

Land the helper and convert all seven sites **before** S7 (accounts
write/lifecycle), S8 (imports) and the Plaid slice, not after. Each of those
converts a write path to `fm_app`, and each would otherwise be shipping a new
instance of this bug while the suite stayed green.

`lib/accounts/disconnect.ts` — the open cross-Space revoke question — is the
same class in its partial form: a joint account disconnected by one owner yields
a *smaller* `updateMany` count, not an error, so the co-owner's Space keeps a
live connection and nobody is told. It should be decided alongside this, not
separately.

---

# PART 2 — READS: WHEN A REFUSAL BECOMES A SENTENCE

## Why the AI surface is the acute case

**Every table the AI tools read is GRANTED to `fm_app`.** There is no
`permission denied` path anywhere on the tool surface, which sounds like good
news and is the opposite: it means **not one AI read can fail loudly.** The only
failure mode RLS has on this surface is the silent empty set.

And this surface converts empty sets into declarative English, which it then
hands to a model as orientation evidence.

## The sharpest instance

`lib/ai/coverage-envelope.ts` — the **prologue**, which runs on every turn
regardless of which tools the model picks (`lib/ai/conversation/evidence.ts:303`):

| Line | What happens |
|---|---|
| `:172` | aggregates `Transaction` under `bankingTransactionWhere(spaceId)` |
| `:223` | `availability: NONE` when `txn._count === 0` |
| `:285` | heads the block *"EVIDENCE THAT EXISTS in this Space"* and instructs: *"Asked how far back your records go, answer from THESE ranges, not from the loaded window."* |
| `:306` | emits, verbatim: **`'  Transactions: none recorded in this Space.'`** |

The module whose entire purpose is preventing false absence — its own header
cites the 2×2 experiment `bb2f6ec`, where 11 of 18 negative answers over-claimed
— becomes the thing that *asserts* the absence.

Worse, its error handling runs the wrong way round. `:243-246` catches every
exception into `unknownEnvelope()`, which renders as `[]`. So a **grant** failure
would fail safe and silent, while a **policy** filter fails loud and wrong — and
on the AI read path only the second is reachable.

## The ten sites, ranked by how declarative the sentence is

| # | Site | What the model is handed | Severity |
|---|---|---|---|
| 1 | `lib/ai/coverage-envelope.ts:306` | `"Transactions: none recorded in this Space."`, under an instruction to answer record-span questions from it | **critical** |
| 2 | `lib/data/transaction-query.ts:262` | `"no dated transactions are available for this Space"` — from the corpus-span authority built precisely so an empty *window* is not mistaken for an empty *Space* | **critical** |
| 3 | `lib/ai/conversation/memory-tools.ts:234` | `"Nothing has been remembered for this user yet. Say so plainly rather than guessing…"` — an explicit **instruction to assert the absence** | **critical** |
| 4 | `tools.ts:2574` | `"no investment accounts in scope"` | high |
| 5 | `tools.ts:1118` | `"no expense baseline: nothing stated, nothing declared, and no complete month…"` | high |
| 6 | `tools.ts:1819` | `"there is no evidence-based projection to take an interval of"` | high |
| 7 | `tools.ts:2461` | `"no liability with that id is in this position"` | medium |
| 8 | `tools.ts:2976` | `"this run spends nothing, so N months of expenses is zero"` | medium |
| 9 | `tools.ts:1606` | `NODE_NOT_FOUND` | medium |
| 10 | `tools.ts:1260`, `:1443` | an empty series — no sentence, but `find_in_balance_history`'s contract is *"the first day debt hit $0"*, so an empty series answers it **wrongly** rather than refusing | medium |

Sites 1 and 2 are the two mechanisms earlier slices in this programme built to
*stop* false absence (`bb2f6ec`, `55a2c22`, `1b83384`). Arming RLS inverts both.

That is not an argument against RLS. It is the reason the absence contract must
land **before** the authority flip on this surface, not after.

## What the design already gets right

The four assemblers return `null` on an empty set
(`lib/ai/assemblers/accounts.ts:236`, `transactions.ts:665`, `snapshot.ts:104`,
`holdings.ts:134`), so `thinCore` renders `current: null, recent: null,
netWorthHistory: null` — **honest ambiguity, not zeroes.** The existing design is
mostly right; the coverage envelope is the exception, and it is the one that
speaks in sentences.

One step removed, and worth fixing in the same pass:
`evidence.ts:80-82` swallows every assembler exception into `console.error` and
continues. That yields a *missing domain* rather than a failed turn — the lesser
evil, since `null` is honest — but it means a broken authority produces an
answer, and nothing in the response says so.

## The mechanism (reads)

The same shape as Part 1: ask the question the failing read cannot answer, on
the failure path only.

```ts
/**
 * ⚠️ THE ABSENCE ORACLE — a capability, never a client.
 * Under fm_app an empty SELECT is indistinguishable from "no data", and this
 * surface NARRATES that difference. Called ONLY on the empty path: one indexed
 * read of SpaceMember under the SAME policy. False ⇒ the emptiness is
 * INDETERMINATE and must be reported as such, never as absence.
 */
spaceIsVisible: (spaceId: string) => Promise<boolean>;
```

It needs no widened authority — it runs under `fm_app` under the same
`SpaceMember` policy. It only needs to be a *separate, answerable question*
rather than an inference from a count.

Then the three critical sites gain an explicit third state: `coverage-envelope.ts:306`
falls silent (the `UNKNOWN` branch) instead of saying `"none recorded"`;
`transaction-query.ts:262` returns `unavailableReason: 'INDETERMINATE'`;
`memory-tools.ts:234` drops *"Say so plainly"* when indeterminate.

## Recommendation (reads)

Land the absence contract as its own slice **before** the AI authority flip. The
AI scoping work sequences as S0–S5 (mechanism, no authority change) → S6 (read
flip) → S7 (write flip); the absence contract is S5 and it gates S6.

## The test that proves it

An empty-**but-visible** Space must still say `"none"`. An
empty-**and-invisible** Space must say `"indeterminate"`. One test, two
fixtures, and it is the only test that distinguishes the fix from the bug.
