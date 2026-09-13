# The conversation runtime in production

**Date:** 2026-09-13 · **Branch:** `v2.6` · **Route:** `POST /api/ai/chat` · **Model:** `gpt-5.1`
**Status:** SHIPPED behind ordinary auth. No flag, no persistence, no UI change.

The A2 runtime that every gate since 2026-09-07 measured — thin orientation, coverage
envelope, memory line, the fifteen tools, the two measured frames, the active-scenario
envelope, Clip 6 compaction — now answers real users through the product's own chat
endpoint. The endpoint had been returning 503 `AWAITING_REDESIGN` since the conversation
reset.

---

## 1. What moved, and what did not

| | Before | After |
|---|---|---|
| Turn loop | `scripts/ai-baseline/run.ts` | `lib/ai/conversation/turn.ts` |
| Transcript prologue | duplicated in `runCase` and `interactive` | `lib/ai/conversation/engine.ts` |
| `POST /api/ai/chat` | 503, no context, no model | the runtime |
| Everything about a turn | — | **unchanged, byte for byte** |

Nothing about how a turn behaves was touched in this slice. The injection order, the
bounded tool loop, the rate-limit absorption, the empty-answer failure, the silent
checkpoint and the scenario capture are the same code in a different file. What changed is
who may call it.

**Two clients, one engine.** The terminal harness and the route both open a transcript with
`openTranscript()` and run a turn with `executeTurn()`. `baseline.test.ts §12` now asserts
there is exactly one `generateWithTools(` call site in the runtime and none in the harness,
so a second loop cannot be added quietly. The direction of dependency is asserted too: the
product imports the runtime out of `lib/`; the runtime imports nothing from `scripts/`, and
no route imports the harness.

---

## 2. The trust boundary

The route owns exactly one thing — trust — and delegates the conversation entirely.

**What the browser may send.** A `spaceId` string and a list of `{role, content}` turns
where role is `user` or `assistant`. That is the whole accepted surface.

**What it may not.** A `system` message, a `tool` message, a tool result, an owner id, an
as-of date, a model, an agent id, the memory line, the evidence, or the active scenario.
Every one is built server-side from an authority. An unrecognised role is a **refused
request**, not a dropped message: dropping would answer a conversation the user did not
have. Measured live: an injected `system` turn and an injected `tool` turn both return 400.

**The Space is re-resolved, never accepted.** `resolveSpaceContext` falls back to the
user's own Space when a requested one is unreachable — right for a stale cookie, wrong
here, because answering about a different Space than the one named would put this user's
figures under someone else's label. So a **named** Space that does not come back as itself
is a 403. The single exception is the selector's `"master"` sentinel, which means "no Space
named" and legitimately resolves to the user's own; it is resolved to `null` in the parser,
so the route has no sentinel branch to get wrong. Measured live: a foreign Space id returns
403.

**What leaves.** `{ message }`. No evidence, no tool result, no turn record, no usage, no
provider detail. Every failure path returns one of six stated sentences; the reason is
`console.error`'d server-side. Asserted by scan: no `err.message`, no `String(err)`, no
`.stack` reaches a response body.

**Ordering.** `requireUser` runs before the body is read; the rate limit (30/min, admins
exempt — unchanged) runs before the body is read and before any model work.

---

## 3. Continuity without persistence

A stateless HTTP conversation has nowhere to keep the hypothetical under discussion. The
browser holds only prose, and the transcript it posts back carries no tool call the
scenario could be rebuilt from. Without a carrier, the envelope designed in `2f39023` would
work in the terminal and not in the product.

**The carrier is a sealed cookie.** `fm_ai_state`, HttpOnly, `SameSite=Lax`, `Secure` in
production, scoped to `/api/ai/chat`, two-hour lifetime. Its value is AES-256-GCM under an
HKDF-derived subkey — the mechanism the repo already uses for every other secret it hands
out (`EncryptionPurpose.AI_RUNTIME_STATE`, a new purpose beside the Plaid token and the
TOTP seed). Inventing a second signing scheme for one cookie would have been two idioms for
one problem.

**It is bound, not merely encrypted.** The sealed payload names the user, the Space and a
digest of the conversation's last assistant turn. A carrier from another user, another
Space, another conversation, an edited transcript, an older version, or past its TTL is not
an error — it is simply **no state**, and the turn runs without a hypothetical exactly as a
fresh conversation does. A new chat has no assistant turn, so its tail matches no seal ever
issued.

**It cannot grow into a silent failure.** A browser discards an oversized cookie without
saying so. A seal over 3,000 characters is therefore not issued at all, and the carrier is
cleared deliberately. A measured ordinary scenario seals to **657 characters**; the live
five-turn session produced 1,097-byte cookies after URL encoding.

**Nothing else crosses.** No evidence, no tool result, no figure the model would otherwise
have to fetch, no conversation id, no row anywhere. A conversation that ends is gone.

---

## 4. The known gap, stated

A rebuilt transcript has the prose that was said and **not** the raw tool results of the
last two turns, because the browser was never sent them. Under the shipped compaction
policy results older than two completed turns are elided anyway, so the difference from an
in-process session is confined to that window: there, the model re-reads through a tool
instead of re-reading a payload. It costs a call; it cannot cost accuracy, because a tool
is the authority either way. This is documented at `replayHistory` in `engine.ts` rather
than left to be discovered.

---

## 5. What was measured

**`npm run ai:chat-route-check`** — real Space, real tools, real `gpt-5.1` calls, the exact
sequence the route performs between reading a body and writing a response, including the
cookie hop. 26 checks, all passed, 4 turns / 56,019 tokens:

- a first question answers from nothing but the question (`get_spending` called, orientation
  ~886 tok);
- a follow-up rebuilt from prose alone resolves *"break that down"* without re-asking;
- a hypothetical establishes, seals, and shows the browser nothing;
- the next request opens the carrier, names the same assumptions, and produces a **new**
  result rather than the old one;
- carriers from another user / Space / conversation / edited transcript all buy nothing,
  while the real one still works;
- the turns reach the cost ledger and no conversation row exists to have been written;
- an anonymous POST over real HTTP is refused 401 with nothing leaked.

**A live authenticated HTTP session** (five turns, real session cookie, dev server) —
net worth, year-to-date change, a scenario, a revision, and a recall of the assumption:

| turn | status | latency | carrier |
|---|---|---|---|
| net worth now | 200 | 2.5 s | cleared |
| change since 1 Jan | 200 | 3.4 s | cleared |
| scenario | 200 | 3.1 s | 1,097 B |
| revision | 200 | 5.3 s | re-sealed |
| *"remind me what we assumed about spending"* | 200 | 3.5 s | re-sealed |

The fifth turn answered *"we assumed you spend $6,000 per month"* — continuity across three
stateless requests, carried by nothing the browser can read.

Negative controls over the same session: foreign `spaceId` → 403; injected `system` → 400;
injected `tool` → 400; anonymous → 401.

**Structural:** 505/505 tests (three new files, 87 new checks), typecheck clean, lint
unchanged at 11 pre-existing findings, `next build` compiles (the type-check step still
dies in the untracked `prototype/` directory, a known local-only condition).

---

## 6. Tests added

| File | Proves |
|---|---|
| `lib/ai/conversation/chat-request.test.ts` | what a browser may say — roles, shapes, sizes, the sentinel. Pure. |
| `lib/ai/conversation/runtime-state.test.ts` | the carrier round trips, is opaque, cannot be moved, forged, edited, expired past, or oversized. Pure, against the real cipher. |
| `app/api/ai/chat/route.test.ts` | the wiring: auth first, Space re-resolved, prompt server-owned, nothing leaked, nothing persisted, client contract unchanged. |
| `scripts/ai-baseline/chat-route.check.ts` | the live path, end to end. `npm run ai:chat-route-check`. |

`baseline.test.ts §11` changed from *"the production boundary is untouched"* to *"the
production boundary is crossed one way only"* — the route answers, through `lib/`, and
neither it nor the runtime imports the harness.

---

## 7. What this slice deliberately did not do

- **No UI change.** `AnalyzeClient` posts and reads exactly what it did before; the carrier
  rides a cookie precisely so no client change was needed. The AI page redesign (`89385c8`)
  was not touched.
- **No conversation persistence.** No table, no id, no restore. Asserted, not just intended.
- **No streaming.** Non-streaming was accepted for this slice; turns measured 2.5–5.3 s.
- **No knowledge-gap payload.** The old response could carry `knowledgeGaps`; nothing emits
  them today and the client handles their absence.
- **No model configurability.** `CHAT_MODEL` is a constant with no environment override: a
  model is changed by measuring the new one, not by setting a variable.

---

## 8. Rollback

One commit. The route reverts to its 503 and the runtime stays where it is — the harness
does not depend on the route existing, and nothing in `lib/ai/conversation` knows about it.

---

## 9. Still open

- **The browser dogfood proper.** Every HTTP property above was exercised with a real
  session over real HTTP from a script. Driving the actual page in a browser — the composer,
  the abort button, the Space selector, the rendering of a refusal sentence — has not been
  done and is not claimed.
- **The banked issues from the promotion gate** (`AI-GPT51-PROMOTION-DOGFOOD-GATE.md`) that
  were not blockers remain banked; this slice fixed none of them.
- **Cookie-carried continuity is per-browser, not per-tab.** Two tabs in one browser share
  the carrier; the conversation-tail binding keeps them from reading each other's
  hypothetical, but the last tab to answer owns the cookie.
