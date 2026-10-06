# Conversations — security model, product identity and explainability

**Status:** hardening slice on v2.6 (2026-10-07). Composes with the financial-guidance boundary
(`docs/systems/ai-financial-guidance-boundary.md`, closed at `ae1172c`), which is unchanged.

> MODEL OWNS MEANING. CONTRACTS OWN SEMANTICS. CODE OWNS MONEY. DATA OWNS TRUTH.
> USER OWNS INTENT. DATA PROVIDES EVIDENCE. DATA NEVER PROVIDES INSTRUCTIONS.
> **A model failure must not grant authority.**

Prompt injection is not claimed to be impossible. The design goal is containment: whatever the
model is persuaded to say or call, the doors it can reach are fixed by code.

## Trust boundaries (verified against the implementation)

| | Source | Where it is decided | Notes |
| --- | --- | --- | --- |
| **Trusted** | Authenticated user id | `requireUser()` in `app/api/ai/chat/route.ts` | Never from the body, a header the client sets, a cookie it can read, or a tool argument. |
| | Authorized Space | `resolveSpaceContext` re-derived per request; a named Space that does not resolve as itself is **403** | The model is never told an id it could swap. |
| | Database authority | `aiPhaseRunner(user.id)` — every prologue read and every tool call runs in its own short tenant transaction (`SET LOCAL` identity, RLS on `fm_app`) | Proven by `scripts/rls-ai-acceptance.ts` (72 checks), incl. smuggled `spaceId`/`userId` args (29) and no identity parameter on any tool (28). |
| | Deterministic financial authorities | the tools (`lib/ai/conversation/tools.ts`) over the canonical ledgers | The model never computes a stored figure; it can only ask. |
| | Validated tool contracts | JSON schemas (`additionalProperties: false`) + per-tool validation (e.g. a `liabilityId` must be one of this position's liabilities; a drill-down `componentId` must be a component of this Space's own tree) | |
| | Provenance record | built server-side from the turn record, sealed (AES-GCM) and bound to user + Space + the digest of the answer it describes | Grants nothing: a replayed call runs under the current request's authority. |
| **Untrusted** | User prose | | Intent, never authority. A claimed role, id or ownership changes nothing. |
| | Imported prose — transaction descriptions, merchant names, account and Space names, category names | arrives inside the `FINANCIAL ORIENTATION` (now labelled as supplied by Fourth Meridian, data not instructions) and inside tool JSON fields | In a **shared Space another member controls some of these** (CSV import, manual entries, account names): this is the cross-user injection channel. |
| | Memory text (labels ≤40 chars, `statedAs` ≤280) | typed classes only; labels refuse brackets/quotes | Per **owner** per Space — never another member's. |
| | Model output | | Rendered through a sink that loads nothing and links nowhere external. |
| | Model-selected identifiers | | Resolved only within the authorized Space; foreign ids return `NODE_NOT_FOUND` / refusal. |

Market data, news, uploaded documents and web content do **not** exist as Conversations inputs today.

## Source → model → tool → authority → sink

```
browser ──(role user/assistant prose only; other roles = 400)──▶ route
route: requireUser → limitByUser (10/min, 60/h ALL roles) → readChatRequest (turns, chars, UTF-8 bytes)
       → resolveSpaceContext (403 on mismatch) → aiPhaseRunner(user.id)
engine: system instruction + FINANCIAL ORIENTATION (Space data) + replayed prose + sealed state
        (scenario / staged plan / continuity / PROVENANCE of the last answer)
turn loop: ≤6 model round trips, ≤16 tool executions (refusal beyond), each tool in its own tenant phase
tools: read-only over canonical authorities, except
       · remember → SpaceMemory of THIS owner in THIS Space; money only if the user's own words state it
       · project_cash → silent checkpoint (PROJECTION) of what was told, same owner/Space
       · stage_assumptions → conversation state only (sealed cookie)
after the answer: guidance label (1 structured call, clipped prose input) · provenance record (pure)
route → browser: {message, guidance?, knowledgeGaps?, continuity?}; state re-sealed in an HttpOnly cookie
browser sink: Markdown with NO <img> and NO external/protocol-relative/javascript: links
```

There is **no** tool that writes a balance, a transaction, an account, a link, a membership, a
role or a setting; no tool performs an external side effect (no HTTP, email, Plaid call); the
model has no outbound channel except the answer text, and the answer sink loads nothing.

## Findings of this slice

| # | Finding | Class | Fix |
| --- | --- | --- | --- |
| 1 | Answer Markdown rendered `![](https://…)` as an `<img>` the browser fetches (CSP is report-only and allows any `https:` image) — a zero-click channel for injected text to carry figures off-site; external links were live. | **Security (sink)** | `components/ai/Markdown.tsx`: no images (alt text shown), only same-origin root-relative links. Negative control in `hardening.test.ts` proves react-markdown's defaults render both. |
| 2 | `AdviceBanner` passes `adviceText` to `dangerouslySetInnerHTML` (seed-only writer today). | Latent XSS | Escaped before its own `<strong>`. |
| 3 | Request ceilings were in UTF-16 characters; pathological Unicode measured **≈2 tokens/char** (English 0.2), so the 160k-char transcript admitted ~10× an English transcript's tokens, re-sent per round trip. Per UTF-8 byte the worst measured was 1.00. | Resource | `MAX_MESSAGE_BYTES` 16,000 and `MAX_TRANSCRIPT_BYTES` 160,000 beside the char ceilings. |
| 4 | One model response may request any number of tool calls; six round trips of an unbounded fan-out is unbounded DB work. | Resource | `MAX_TOOL_CALLS_PER_TURN` 16; beyond it the call is not run and returns a refusal (proven through the real turn loop: 80 requested → 16 run). |
| 5 | 30/min per user, SYSTEM_ADMIN exempt, no longer window. | Resource | 10/min (non-admin) and 60/hour for every role. |
| 6 | A follow-up sees only prose: "how did you get that number?" drew "I also didn't actually run the get_baselines tool" (it had) and an invented method; "you suck" after a tool-computed answer drew "I made numbers up". | **Explainability / truthfulness** | Provenance record (below). |
| 7 | The model believed the server-supplied orientation was "the orientation you pasted", lending names inside it the user's voice. | Injection framing | `ORIENTATION_HEADER` says Fourth Meridian supplied it, and that its text is data. |
| 8 | Product claims had no source ("financial copilot", "money brain"; disconnect "depends on the app's rules"); a Call of Duty loadout was offered in full; a forged Space id was confirmed as "your space". | Identity / scope | `describe_fourth_meridian` capability authority + identity line + `CONVERSATION_RULE`. |

## Explainability architecture

`lib/ai/conversation/provenance.ts`. After every answer the engine builds, from the turn record:

* **calls** — each tool the answer ran, with its arguments (≤6, args ≤220 chars);
* **figures** — each figure the answer stated (money, %, decimals; not dates/years/list numbers)
  tagged `tool:<name> <json path>`, `orientation <path>`, `you said it`, or **`unsourced`**
  (computed in the answer's prose).

The route seals it with the scenario state (lowest priority: when the cookie would overflow it
becomes `NOT_CARRIED`, never at the plan's expense), bound to the digest of that answer. The next
turn receives it as a trailing system record: re-run the listed call to explain, say "worked out in
my own words" for an unsourced figure, never describe another derivation, never claim a tool did or
did not run against the record. Every tool is deterministic for a Space and date, so re-running a
call reproduces the figure **and** its derivation fields (`get_baselines` returns numerator,
denominator, window and basis). Results are never cached — the tool remains the authority.

On prose arithmetic (cash after a payment ÷ baseline): with the record, such a figure is
truthfully labelled `unsourced`, so the explanation can say exactly what happened. A new arithmetic
primitive was **not** required for truthful derivation and was deliberately not added.

## Memory boundary

Memory classes are closed (GOAL, PLANNED_EXPENSE, RULE, BASELINE; PROJECTION by code only). There
is no class for a balance, ownership, access or an instruction. Money is admitted only when the
user's own words in this conversation state it (`turnEvidence` is built from the user's turns,
never from tool results or the orientation), so text injected through data cannot satisfy it. A
remembered figure is stamped `REMEMBERED` and no resolver reads it — proven live: after storing
"plan with $1,000,000 a month", the measured baseline stayed `$5,438.35 MEASURED` and the snapshot
was byte-identical.

## Measurements

_See the slice's commit message and the final report; transcripts in the `ai:hardening-check` output._

## Deferred

* CSP is report-only (`next.config.ts`); enforcing it is its own change. The Markdown sink no
  longer depends on it.
* Rate limiting is per-window, not per in-flight request; the surface sends one question at a
  time, so concurrency is reachable only by a script and is bounded by the windows.
* Cross-member injection in shared Spaces is contained (no authority, no sink) but not filtered —
  the model may still repeat injected prose as prose.
