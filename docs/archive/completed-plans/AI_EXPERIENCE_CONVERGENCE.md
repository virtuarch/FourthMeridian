# AI Experience Convergence

*Architecture investigation. **No implementation.** A UI-convergence slice: move the production AI
surface toward the prototype's grounded-conversation experience and the Fourth Meridian visual
language, with **zero AI-backend changes**. Extends the
[UI Convergence Roadmap](./UI_CONVERGENCE_ROADMAP.md); reuses the Wave-1 Atlas primitives
(`Field`/`Toast`/`InlineBanner`).*

Grounded in a read-only audit of the production AI UI (`AnalyzeClient`), the `/api/ai/chat`
contract, the `prototype-claude` AI experience, and the Atlas primitive layer.

---

## The load-bearing fact

**The migration is a presentation reshell, not a capability upgrade — because the data the
prototype's grounded answer card renders does not exist on the wire, and the constraints forbid
creating it.**

- The AI surface is **fully isolatable**: `AnalyzeClient` imports **zero** workspace/runtime code
  (`SpaceShell` / `useSpaceData` / `useSpaceNavigation` / `WORKSPACE_REGISTRY` / `lib/space/*`).
  It is a standalone global destination.
- The production API returns `{ message: string, knowledgeGaps: KnowledgeGap[], knowledgeGapMode }`
  — **unstructured Markdown prose plus one structured affordance** (`KnowledgeGap[]`). It is
  non-streaming, stateless, and carries no `fact`/`interpretation`/`evidence[]`/`followUps`/`jump`
  fields.
- The prototype's `AnswerCard` renders a structured `AiAnswer` (`fact → interpretation → evidence
  chips → follow-ups → space-jump`). **None of those fields are emitted by production**, and
  "no AI backend changes / no new evidence contracts" forbids adding them.

So the honest scope: **converge the layout, the composer, the message/answer card shells, the
suggested prompts, and the FM visual language** — all backed by what the API already returns.
The richer grounded affordances (evidence chips, follow-ups, interpretation toggle, space-jump)
are **designed into the component API as optional slots but rendered only when data exists** —
which, today, is never. We **omit, we do not fabricate** (FM honesty doctrine). Lighting those
slots up is a *separate, backend-gated initiative*, explicitly out of this slice.

---

## Part 1 — Current state

### The surface

| Aspect | Reality | Cite |
|---|---|---|
| Destination | Standalone global dest `id:"ai"` → **`/dashboard/analyze`**, `live` | `lib/space-nav.ts:152` |
| Nav treatment | Center BottomNav slot, `Sparkles`, filled accent disc; normal row on desktop navbar | `components/ui/BottomNav.tsx:36,57,70` |
| Is it a Space? | **No.** Not a workspace; inside `(shell)` so it gets `DashboardChrome` for free | `app/(shell)/dashboard/layout.tsx:33` |
| Server page | `analyze/page.tsx` (52 LOC) — fetches `getLatestAdvice`/`getFicoScore`/`getRecentSnapshots` for the Review tab; **no AI call** | `analyze/page.tsx:12-17` |
| Client | `AnalyzeClient.tsx` (**576 LOC**) — two tabs: **ML Review** \| **AI Chat** | `AnalyzeClient.tsx:16,101` |
| Workspace-runtime imports | **NONE** — react, react-markdown, `atlas/DataCard`, `AdviceBanner`, `KnowledgeAcquisitionCard`, lucide, `@/types` | `AnalyzeClient.tsx:1-14` |

### The chat tab today (`AnalyzeClient.tsx:385-573`)

```
DataCard padding=0  (chat workspace, h-[calc(100dvh-172px)])
├─ Assistant header: Brain icon · "Fourth Meridian AI" · Space/context <select> (master default)
├─ Messages scroll (max-w-3xl reading column)
│   ├─ assistant → Brain avatar + <ReactMarkdown> bubble  (+ Knowledge cards when knowledgeGaps)
│   ├─ user      → right-aligned accent bubble
│   └─ loading   → 3-dot bounce
├─ Suggested prompts  (EMPTY-STATE ONLY — vanish after first turn, messages.length<=1)
└─ Composer (sticky bottom): raw <textarea> + Send/Stop, Enter-to-send hint
```

- **Non-streaming.** `const data = await res.json()` — one buffered response. The 3-dot loader is the
  only "typing" affordance. (`AnalyzeClient.tsx:205`; `route.ts:47-48` lists streaming as not
  implemented.)
- **Session-only state, no persistence.** `messages: Message[]` in `useState`, seeded with one
  hardcoded greeting (stripped on send via `.slice(1)`); reset on refresh. No `conversationId`,
  no thread store, no DB model. (`AnalyzeClient.tsx:102,117-118,200`.)
- The one rich affordance: **`KnowledgeAcquisitionCard`** — a structured input form for missing
  debt fields (`apr`/`minimumPayment`) that PATCHes `/api/accounts/[id]/debt-profile` and re-asks.
  **Live and dual-consumed** (also by `space/widgets/debt-perspective-adapters.tsx:24`).

### The contract to preserve (DO NOT TOUCH)

**Request** `POST /api/ai/chat` — `{ spaceId: string | "master", messages: {role:"user"|"assistant",
content:string}[] }`; validation ceilings `MAX_MESSAGES=50`, `MAX_TOTAL_CONTENT_CHARS=24_000`,
≥1 user turn (`route.ts:219-309`).

**Response** (non-streaming JSON) — `{ message: string; knowledgeGaps: KnowledgeGap[];
knowledgeGapMode: "clarification"|"form" }` (`route.ts:508-512`). Errors `{error}`.

```ts
interface KnowledgeGap { accountId; accountName; field: "apr"|"minimumPayment"; label; debtSubtype?; }
```

- **Only structured evidence on the wire = `KnowledgeGap[]`.** Numeric-claim provenance is an
  **append-only notice inlined into `message`** (`UNVERIFIED_FIGURE_NOTICE`,
  `output-validator.ts:219-255`) — there is no separate evidence/annotation/confidence field.
- **No conversation state anywhere** (route, schema, client). Migration must not add persistence.
- **Permissions** (server-only): `requireUser` → rate-limit (30/60s) → role gate
  `OWNER/ADMIN/MEMBER` (`VIEWER` → 403); master mode aggregates eligible Spaces (`route.ts:252-464`).
- **Provider seam** `generateChatReply` + `recordApiUsage` (`lib/ai/provider.ts`) — unchanged.

Backend "do not touch" set: `app/api/ai/chat/route.ts`, `lib/ai/{provider,context-builder,
output-validator,types,intent}.ts`, `lib/ai/prompts/*`, `lib/ai/intelligence/annotations/*`,
`lib/usage/record.ts`, `prisma/schema.prisma`.

---

## Part 2 — Prototype mapping

Prototype (reference spec, imports nothing from production): `prototype/prototype-claude/`.

| Prototype file | LOC | Role |
|---|---|---|
| `components/ai/AiExperience.tsx` | 218 | The standalone "Ask" destination: header, empty state, thread, sticky composer |
| `components/ai/AnswerCard.tsx` | 123 | Grounded answer: dot + fact + reasoning toggle (interpretation+caveat) + evidence/jump chips + follow-ups |
| `components/shell/AmbientAI.tsx` | 109 | Inline **system-initiated** insight at the top of a workspace lens (not conversational) |
| `lib/ai.ts` | 172 | `AiAnswer`/`AiQuestion` types + fixture library — **the structured answer contract** |

### Target components → prototype source → what they render (all backed by the *existing* API)

| Target (`components/ai/`) | Prototype source | Renders (from production data) | Slots present but unlit today |
|---|---|---|---|
| **`AiShell`** | `AiExperience.tsx:93-105` | Centered `max-w-[720px]` column: "Ask" header + `Sparkles`, "Grounded in `[Space chip]`" context line (the existing master/Space selector), thread + sticky composer | — |
| **`ConversationView`** | `AiExperience.tsx:107-191` | The exchange list; empty state (starter prompts); loading indicator; auto-scroll | Recent/"memory" rail (needs persistence — **out of scope**) |
| **`MessageCard`** | `AiExperience.tsx:155-160` | The user turn — quiet right-aligned bubble | — |
| **`AnswerCard`** | `AnswerCard.tsx` (whole) | The AI turn: the `message` Markdown as the answer body; inlined validation notice as the honesty/caveat line; **`KnowledgeGap` cards** (reusing the live `KnowledgeAcquisitionCard`) as the one grounded affordance | `evidence[]` chips, `followUps`, `interpretation` toggle, `spaceJump` — **no API data; omitted** |
| **`Composer`** | `AiExperience.tsx:193-215` | Sticky bottom input, Space-scoped placeholder, Enter-to-send, accent send button, Stop | — |
| **`SuggestedPrompt`** | starters `:114-124` (card) / follow-ups `AnswerCard.tsx:106-119` (row) | Empty-state **starter** prompts (exist today) | Per-answer **follow-ups** (need backend `followUps` — omitted) |

**Explicitly out of this namespace / slice:** `AmbientAI` (system-initiated, embeds inside a
workspace lens → would import workspace runtime, breaking isolation) and any `AiAnswer`-structured
answer rendering (needs backend changes). Both are follow-on initiatives.

### FM visual language to adopt

- **Surface-vs-Glass:** read content sits on an opaque surface; act-through is glass. AI answers are
  *read* → the Atlas read-surface (`DataCard`, which wraps `GlassPanel`; note `GlassPanel` ships a
  `glow="ai"` recipe for a hero AI surface). **Decision R5.**
- **One AI mark:** a single 5px accent dot with a soft glow — no avatar/badge. (Production currently
  uses a `Brain` avatar; the convergence replaces it with the dot.)
- **Honesty vocabulary:** the caveat is rendered at full weight, `⌁`-marked, never de-emphasized —
  the natural home for the inlined `UNVERIFIED_FIGURE_NOTICE`.
- **Color-as-claim restraint:** accent reserved for the AI mark + ask/jump affordances; number tone
  only for real gain/loss.
- **Sticky composer** clears the BottomNav + `env(safe-area-inset-bottom)`.

---

## Part 3 — Atlas primitives required

| Kit need | Atlas primitive | Status |
|---|---|---|
| Answer / message **Panel** | **`DataCard`** (wraps `GlassPanel`; `glow="ai"` available) | **Exists** — the "Panel" for the AI kit |
| **Field** (any AI form) | `components/atlas/fields/` (`Field`/`Input`/`Select`/…`) | Exists (Wave-1) |
| **Toast** ("copied"/"regenerated") | `components/atlas/Toast.tsx` (`ToastProvider`/`useToast`) | Exists (Wave-1) |
| **InlineBanner** (AI error/notice) | `components/atlas/InlineBanner.tsx` | Exists (Wave-1) |
| **Suggested-prompt chips** | `components/atlas/Chips.tsx` (single-select radiogroup) | Exists (fits) |
| **Composer input** (auto-grow multiline) | — | **GAP — the one net-new primitive** |

**The single primitive gap:** there is **no Atlas `Textarea`/auto-grow input**. `fields/Input` is
single-line `<input>` only; five surfaces (incl. `AnalyzeClient`) hand-roll a bare `<textarea>`.
The Composer needs a new **`components/atlas/fields/Textarea`** (auto-grow, Enter-to-send-aware) —
a small, reusable promotion that also retires the five copy-pastes. This is the only new Atlas work.

*(The user's target named an Atlas "Panel"; the right primitive is `DataCard` — Atlas has no
component literally named `Panel` for cards. `components/atlas/panels/*` is an edge-drawer family,
not an answer card, and is not used here.)*

---

## Part 4 — Dead ML surface removal candidates

**None. The cleanup premise does not hold — every AI-adjacent surface is live.** Reported honestly
rather than manufacturing removals:

| Candidate | Verdict | Evidence |
|---|---|---|
| `KnowledgeAcquisitionCard` | **Live — reuse, do not move** | 2 importers: `AnalyzeClient:8` + `debt-perspective-adapters:24` |
| `AdviceBanner` | Live | `AnalyzeClient:7,304`; `notifications/registry:521` |
| `AiAdvice` (post-CLEAN-0) | No orphan leftover | live *type* across advice/notifications/purge paths; no dead UI |
| `/api/ai/chat`, `/dashboard/analyze` | Live | consumed by the UI; linked from Brief + nav + notifications |

The one thing that *could* shrink is scope, not dead code: the **ML Review tab** (`AdviceBanner` +
static engine-description cards) is a distinct concern from the chat. A conversation-first redesign
may **relocate/de-emphasize** it (e.g. fold it under a secondary view), but it is not dead. **Scope
decision, Part 6.**

---

## Part 5 — Isolation verdict

**YES — fully isolatable from workspace/runtime code.** A new `components/ai/` kit + the reshelled
route would touch only: Atlas primitives (`DataCard`/`GlassPanel`, field kit, `Toast`,
`InlineBanner`, `Chips`, + new `Textarea`), `lib/data/*` server reads, and `/api/ai/chat`. It shares
**none** of `SpaceShell` / `useSpaceData` / `useSpaceNavigation` / `WORKSPACE_REGISTRY` /
`lib/space/*`.

**The single coupling point:** `KnowledgeAcquisitionCard` is dual-consumed by `AnalyzeClient` and the
Space debt widget. The AI kit must **import it from its current location** — do **not** move or
rename it, or the debt perspective breaks.

---

## Part 6 — Migration plan (slices)

Each slice is independently shippable, verified (tsc/eslint/tests + browser), and reversible. All
backend files stay untouched.

| Slice | Scope | Depends on | Risk |
|---|---|---|---|
| **AI-0 · Composer primitive** | Promote `components/atlas/fields/Textarea` (auto-grow multiline). Optionally retire the 5 hand-rolled `<textarea>` (or defer that sweep). | — | Low — additive primitive |
| **AI-1 · `components/ai/` shells** | Build `AiShell` · `ConversationView` · `MessageCard` · `AnswerCard` · `Composer` · `SuggestedPrompt` as **pure presentation** over the existing message/response shape. `AnswerCard` renders `message` Markdown + inlined notice + `KnowledgeGap` (reused `KnowledgeAcquisitionCard`); the evidence/follow-up/jump/interpretation props exist but render nothing without data. | AI-0 | Low — no data/API touch |
| **AI-2 · Reshell the chat tab** | Rewire `AnalyzeClient`'s **AI Chat** tab to compose the new `components/ai/` shells. **Keep verbatim:** the `fetch("/api/ai/chat")` call, request/response handling, `messages` state, master/Space selector, Stop/abort, `KnowledgeAcquisitionCard` wiring. | AI-1 | Medium — touches the live chat client (presentation only) |
| **AI-3 · ML Review scope decision** | Keep the two-tab surface, or make chat primary and fold Review into a secondary view. Presentation only; `getLatestAdvice`/`AdviceBanner` untouched. | AI-2 | Low — layout choice |
| **AI-∞ · (out of scope)** | Structured grounded answers (evidence chips, follow-ups, interpretation, space-jump), streaming, conversation memory, and `AmbientAI` — **each needs backend/persistence/workspace work the constraints forbid.** The `AnswerCard` slots are built ready; lighting them is a separate initiative. | backend | — |

**Parallelism:** AI-0 stands alone. AI-1 builds after AI-0. AI-2 after AI-1. One engineer/agent
serially, or AI-0 + AI-1-scaffolding concurrently. No shared-registry write (unlike Wave 1) — the AI
surface touches no `lib/perspectives.ts`.

---

## Part 7 — Files affected

**New**
- `components/atlas/fields/Textarea.tsx` — auto-grow composer input (+ barrel export).
- `components/ai/{AiShell,ConversationView,MessageCard,AnswerCard,Composer,SuggestedPrompt}.tsx`.
- (optional) `components/ai/ai.test.ts` — presentation/source-scan guards (house pattern).

**Edited**
- `components/dashboard/AnalyzeClient.tsx` — reshell the chat tab onto `components/ai/*` (fetch/state
  verbatim). Possibly split into a thinner host if the file shrinks materially.
- (AI-3, optional) `app/(shell)/dashboard/analyze/page.tsx` / `AnalyzeClient` — Review-tab relocation.

**Reused as-is (imported, not moved)**
- `components/dashboard/KnowledgeAcquisitionCard.tsx` (the shared coupling point), `AdviceBanner.tsx`.

**Untouched (preserved)**
- `app/api/ai/chat/route.ts` and all of `lib/ai/*`, `lib/usage/record.ts`, `prisma/schema.prisma`,
  the permission gate, the context builder, answer generation, and the evidence/validator contracts.

---

## Part 8 — Risk assessment

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| **R1** | **Data mismatch** — the prototype's grounded card renders `fact/interpretation/evidence/followUps/jump` the API does not emit; the constraints forbid adding them. | **High** (defines scope) | **Omit, don't fabricate.** Build the slots into `AnswerCard`'s API but render only what exists (`message` + `KnowledgeGap` + inlined notice). The convergence is layout + visual language, not capability. Say so plainly in the UI (no empty "evidence" chrome). |
| R2 | **Composer needs a Textarea** primitive that doesn't exist. | Low | Ship `fields/Textarea` first (AI-0); small, reusable, retires 5 copy-pastes. |
| R3 | **`KnowledgeAcquisitionCard` shared** with the debt widget. | Medium | Reuse in place; never move/rename. Add a test asserting both importers still resolve. |
| R4 | **Non-streaming** while the prototype reads as fluid. | Low | Keep the buffered-response + loading-indicator model; do not design the shells around token streaming. Streaming is out of scope. |
| R5 | **Surface-vs-Glass** — prototype uses opaque `Surface`; production default is `DataCard`/glass. | Low (cosmetic) | Adopt Atlas `DataCard` (the production read-surface) for answer/message cards; optionally `glow="ai"` for the shell. One documented ruling, applied consistently. |
| R6 | **Master/Space context selector** is a permission-scoped control, not decoration. | Medium | Preserve it exactly (it drives `spaceId`; the server re-validates membership). Render it as the prototype's "Grounded in `[Space]`" chip without changing its semantics. |
| R7 | **Mobile composer** overlapping the center-slot BottomNav. | Low | Sticky offsets for BottomNav height + safe-area (prototype pattern). |
| R8 | **Scope creep into `AmbientAI`/persistence/streaming.** | Medium | Hard boundary: this slice is the `/dashboard/analyze` conversation shell only. AmbientAI touches workspace runtime (breaks isolation); memory/streaming touch the backend. Both explicitly deferred. |

---

## Part 9 — Implementation decisions (this slice)

Rulings taken when the investigation moved to implementation:

- **ML Review — conversation-first; preserve the capability, retire the dashboard chrome.** The AI
  destination becomes the conversation surface (no tabs). The one real capability in the Review tab —
  scheduled advice — is fully carried by `AdviceBanner` (its modal holds the summary, `actionReady`,
  market context, recommended actions, and full analysis), so it is **preserved** in the
  conversation's empty state. The three remaining Review cards (Advice Schedule, What the Engine
  Reviews, Action Readiness) are **retired**: evidence — Advice Schedule is hardcoded copy; What the
  Engine Reviews restates snapshot stats surfaced in the Wealth/Debt workspaces; Action Readiness
  restates `advice.actionReady`/`summary` already in the `AdviceBanner` modal. No API call, no
  action, no unique data among them. `page.tsx` drops the now-unused `getFicoScore`/
  `getRecentSnapshots` reads and the derived-stat props (they fed only those retired cards).
- **`KnowledgeGapCard` = presentation wrapper, not a duplicate.** The live knowledge-gap form
  (`KnowledgeAcquisitionCard`, which PATCHes and is dual-consumed by the debt widget) is **reused in
  place, unchanged**. `components/ai/KnowledgeGapCard` is a thin presentation frame (grounding label +
  `children`) the orchestrator wraps around the existing interactive cards, so `components/ai/`
  contains no API calls and the coupling point is never moved.
- **`AnswerCard` future-slot contract** ships as specified — `facts?/evidence?/actions?/
  relatedEntities?` typed `never[]` (present in the type, impossible to populate today) so v2.6 can
  widen them; **only `message` + the `KnowledgeGap` extras render.** No empty/fake sections.
- **AI mark:** the `Brain` avatar is replaced by the prototype's single accent dot (one brand mark,
  not an AI-only styling system). Read surfaces stay on Atlas tokens/`DataCard`; the Composer builds
  on the new Atlas `Textarea`; the context selector moves to the Atlas `Select`.
- **Non-goals held:** no streaming, no persistence/`conversationId`, no `AmbientAI`, no structured
  answer generation — all v2.6+. The panels primitive (`components/atlas/panels/`) now exists but is
  **not** wired here (answers render inline); it is the natural home for a future evidence detail.

## Constraints honored

- **Preserved:** the AI APIs, context builder, permissions, answer generation, and evidence/validator
  contracts — all backend files are untouched; the migration is presentation-only.
- **Not done:** no AI providers/managers, no AI-architecture redesign, no conversation persistence, no
  semantic-authority changes. The `AnswerCard`'s grounded slots are built inert, awaiting a separate
  backend-gated initiative.
- **Reuse over new:** the kit builds on Atlas (`DataCard`/`Field`/`Toast`/`InlineBanner`/`Chips`); the
  only new primitive is one `Textarea`. `KnowledgeAcquisitionCard` is reused in place.

**North star:** the AI destination stops being a chatbot-in-a-box and becomes a grounded, persistent
investigation *shell* in the Fourth Meridian language — as far as today's stateless, prose-only API
honestly allows, with the richer grounded affordances scaffolded and clearly waiting on the backend.
