# UI Convergence Wave 2 — Identity, Entry, Intelligence Surfaces

**Status:** Investigation / roadmap. No code changed. Read-only audit of Auth,
Space Launcher, Brief, and AI, with a migration plan onto the Fourth Meridian
platform direction.

**Date:** 2026-07-18 · **Branch:** feature/v2.5-spaces-completion

---

## 0. The load-bearing discovery

The global-navigation model this whole investigation was meant to *propose*
**already exists in production**:

```
lib/space-nav.ts:140   GlobalDestId = "spaces" | "brief" | "ai" | "connections" | "settings"
lib/space-nav.ts:151   GLOBAL_NAV = [ Spaces, Brief, AI, Connections, Settings ]  // all live
```

This is byte-for-byte the prototype's DS-5/DS-6 five-destination bar
(`prototype/prototype-claude/components/shell/BottomNav.tsx`), including the
deliberate **Brief ≠ AI** split. So Wave 2 is not an architecture invention. The
skeleton is landed. The four surfaces are in four different states of dress
against it:

| Surface | Architectural home | State today |
|---|---|---|
| **Auth** | Standalone (pre-shell) | Behaviorally complete, visually pre-design-system (zero Atlas) |
| **Space Launcher** | Standalone root chooser | Already redesigned (Atlas Liquid), missing prototype's hierarchy + transition |
| **Brief** | Global intelligence surface | Already global (own route group), missing prototype's trust + action contract |
| **AI** | Global ambient surface | Working chat buried in a tab; carries a **dead** "ML Review" tab |

None of the four should become a `WorkspaceDefinition`. Three are *global
siblings to* Spaces; one (Auth) lives *before* the app. The convergence is a
**design-language migration**, not a re-architecture — and its true critical
path is a shared form/field/toast primitive kit that three of the four surfaces
are each hand-rolling today.

---

## 1. Current ownership map

### 1.1 Auth / Identity

**Routes** — `app/(auth)/` route group, **no shared layout**:

| Surface | File | LOC |
|---|---|---|
| Login (+ TOTP / recovery-code / reactivation / cancel-deletion / CAPTCHA) | `app/(auth)/login/page.tsx` | 597 |
| Register (+ invite deep-link `?invite=`) | `app/(auth)/register/page.tsx` | 372 |
| Forgot password | `app/(auth)/forgot-password/page.tsx` | 125 |
| Reset password (`?token=`) | `app/(auth)/reset-password/page.tsx` | 160 |
| Verify email (`?token=`, auto-POST) | `app/(auth)/verify-email/page.tsx` | 183 |
| Confirm email change (`?token=`) | `app/(auth)/confirm-email-change/page.tsx` | 136 |

- **APIs:** `app/api/auth/**` (`[...nextauth]`, `pre-login`, `register`,
  `forgot-password`, `reset-password`, `verify-email(+/resend)`); email-change
  confirm at `app/api/user/email/confirm`.
- **Backend:** NextAuth Credentials + JWT (`lib/auth.ts`), `pages.signIn:"/login"`.
- **Route protection:** `proxy.ts` (the Next 16 middleware replacement) —
  gates `/dashboard/*` + `/admin/*`, redirect contract
  `→ /login?callbackUrl=…`. **No `middleware.ts`.**
- **Components:** **none.** No `components/auth/`. Every screen is inline JSX +
  hardcoded Tailwind. Shared atoms are only `AppLogo.tsx` (forced dark —
  its docstring records that `(auth)` "never adopted theme tokens") and
  `TurnstileWidget.tsx`.
- **MFA:** TOTP entry is a *step inside* login (`login/page.tsx:452-560`); 2FA
  *enrollment* lives in dashboard settings. **Invite acceptance is not a page** —
  only a `?invite=` param consumed by register.

### 1.2 Space Launcher

- **Route + loader:** `app/(shell)/dashboard/spaces/page.tsx` — server component
  that *is* the loader (memberships, invites, platform grants, public spaces,
  per-space net worth via `getSpaceNetWorthSummaries`). No separate `lib/space`
  list loader.
- **UI owner:** `components/dashboard/SpacesClient.tsx` (1293 LOC) — the already-
  redesigned successor. `SpaceCard` has an Atlas **Liquid** (WebGL) path + Glass
  fallback; `PublicSpaceCard`, `InviteBanner`, `PlatformSpaceGroup`, hand-rolled
  `Sparkline`, `MemberAvatars`.
- **Switch = cookie, not URL:** `ACTIVE_SPACE_COOKIE` (`lib/space.ts:31`) written
  by `app/api/space/switch/route.ts`; `getSpaceContext` reads it per request. The
  sidebar no longer lists spaces — the launcher is the sole switch surface.
- **Create/templates/invite:** `CreateSpaceModal.tsx` (678 LOC, 4-step) mounted
  by `DashboardChrome.tsx` via window event. Templates in
  `lib/space-templates/registry.ts` (derived from `lib/space-presets.ts`).
- **Membership/roles:** `SpaceMember.role` → `derivePermissions` (`lib/space.ts`);
  deep management delegated to `components/space/manage/ManageSpaceModal`.
- **Join:** **invite-only.** Public "Join" button is intentionally inert
  ("coming soon"); no per-space access-request backend (`SpaceInvite` is grant-
  only; `BetaAccessRequest` is app-signup, unrelated).

### 1.3 Brief

- **Route:** `app/(brief)/dashboard/brief/` — **its own route group** with a
  standalone layout (no sidebar, no `SpaceShell`; only `BriefLogo` + `UserButton`
  over a full-bleed earth hero). The layout docstring states it lives in
  `(brief)` precisely so it does *not* inherit shell chrome.
- **Client:** `components/brief/DailyBriefClient.tsx` — fetches `/api/brief`,
  POSTs `/api/brief/viewed`; renders hero → ordered sections → attention.
- **Data:** `app/api/brief/route.ts` assembles content **exclusively through the
  AI Context Builder** (`buildContext(spaceId, userId, {scopeHint:"brief"})`) —
  no direct financial-table reads. **Aggregates across all eligible Spaces.**
- **"What Changed" layer:** there is no module by that name; the equivalent is
  the **AI Signals system** (`lib/ai/signals/`, e.g. `NET_WORTH_INCREASED/
  DECLINED`) plus `snapshot.netWorthTrend`.
- **Contracts:** `lib/brief-types.ts` (`BriefPayload`, `BriefSection`, `BriefItem`).
- **Notifications:** infra exists (`lib/notifications/`); `DAILY_BRIEF_READY` type
  is **registered but has no producer** — no scheduled brief job. Brief is
  on-demand by design ("the notification is 'your brief is ready', never the
  brief itself").

### 1.4 AI

- **Endpoint:** `app/api/ai/chat/route.ts` (513 LOC, decomposed from 2199) —
  `POST`, **non-streaming**, returns `{message, knowledgeGaps, knowledgeGapMode}`.
  Modes: `spaceId:"master"` (aggregate) vs specific space. Route owns no domain
  logic — orchestrates `buildContext → computeAssessment → build*SystemPrompt →
  generateChatReply → validateOutput`. Test-guarded (4 characterization suites).
- **Semantic layer (`lib/ai/*`) — all live:** `context-builder.ts`, `assemblers/*`
  (incl. `transactions.ts` = transaction intelligence), `prompts/*`,
  `intelligence/*` (`computeAssessment` = the decomposed annotations engine),
  `intent/*`, `signals/*`, `output-validator.ts`, `provider.ts` (only OpenAI
  importer, `gpt-4o-mini`).
- **UI:** `app/(shell)/dashboard/analyze/page.tsx` → `AnalyzeClient.tsx` (576
  LOC), a **two-tab** surface (`"review" | "chat"`). The composer is pinned to
  the **chat tab only** — **not** sticky/global. Nav entry:
  `lib/space-nav.ts:152` → `/dashboard/analyze`.
- **The "ML page" is a dead tab, not a page.** `AnalyzeClient.tsx:287` renders a
  tab labeled **"ML Review"** containing *no ML*: it displays `AiAdvice` (an
  advisor panel + "Action Readiness"). `AiAdvice` **has no production writer**
  (KD-14) — only `prisma/seed.ts` creates it; every reader is read-only. In
  production the tab renders its empty state. Last functional change predates
  the entire AI-ARCH era (stale 2026-06/07 vs the chat route's 2026-07-17).
- **Do not conflate with classification.** The `lib/transactions/*` classifier
  (flow-classifier, descriptor-evidence, account-classifier) is **backend-only,
  not AI-facing** — consumed by ingestion/sync; the chat only *reads its persisted
  columns* via the transactions assembler. This is the clean AI-vs-"ML" line.

---

## 2. Prototype comparison (Space Launcher & Brief & AI)

The `prototype/prototype-claude/` app is the DS-5/DS-6 reference. Critically,
**every prototype contract is a strict subset of the production contract** — so
adopting prototype design is *extraction/reskin*, never re-architecture.

### 2.1 Space Launcher

| | Prototype (`components/Launcher.tsx`, mock) | Production (`SpacesClient.tsx`, real) |
|---|---|---|
| Layout | One 720px **list** column, one metric/row ("the door", deliberately forgettable) | Responsive **grid** of large Liquid/Glass cards |
| Entry | Modeled **transition** — chosen card holds while others fade | Cookie POST + `router.refresh()`, **no transition** |
| Domains | HQ + financial spaces through the **identical** shell, differ only by data | Platform spaces are a visually distinct, non-switch group |
| Data | 100% mock (`SpaceSummary`: `members` is a count) | Real (`SpaceItem`: full `Member[]`, roles, accountCount, lifecycle) |
| Create/join | **None** | Full `CreateSpaceModal` + invite flow |

**What the prototype solved that production lacks:** narrative hierarchy
(list-not-grid), the entry *threshold* as a designed moment, and a domain-neutral
Space primitive that unifies HQ + financial. **What production has that the
prototype doesn't:** everything real (data, create, invite, templates, roles).
**Migration = graft the prototype's hierarchy + transition + domain-neutrality
onto production's real data path.** Prototype `SpaceSummary` ⊂ production
`SpaceItem`, so no contract change is forced.

### 2.2 Brief

| | Prototype (`lib/brief.ts` + `Brief.tsx`) | Production (`brief-types.ts` + `route.ts`) |
|---|---|---|
| Shape | Single narrative **lede** → changed → attention → collapsible "can wait" (urgency *decreases* down-page) | Flat section stack |
| Trust | **`basis`** per claim (`observed \| reconstructed \| mixed`) with a trust dot | `BriefTone` only — no observed/reconstructed distinction |
| Actions | **drill / ask / jump contract**: evidence chip → `PanelHost`; "Ask about this" → AI handoff; `spaceJump` → Space | Static `BriefItem.href` — no drill, no AI handoff |

**Migration path:** extend `BriefItem` with `basis`, `evidence[]`, `askId`,
`spaceJump` (all additive), then wire chips to the same `resolveActionDrill →
PanelHost` machinery and the Brief→AI handoff. The trust `basis` maps directly
onto the existing `CompletenessTier`/reconstruction vocabulary from the Trust
Surface Convergence work.

### 2.3 AI

The prototype's `AiExperience.tsx` (DS-6) **is the target the user's brief
describes**, already built as an interaction model:

- Persistent, **sticky composer** grounded to a Space context chip.
- **Recent conversations** (memory list), **suggested questions** (grounded, not
  generic), grounded **answer cards** with evidence one tap away.
- **Transitions out:** evidence → panel, jump → Space, Brief → AI handoff.
- `AmbientAI.tsx` = the `fact → interpretation → action → drill` progression as a
  quiet in-workspace element (one breathing dot, no chatbot chrome).

**What production lacks:** a sticky/global composer (today it's tab-bound), a
recent-conversations rail (no persistence — `conversationId` unbuilt by design,
AI-5), and answer-cards-with-evidence (today plain markdown bubbles). The
`lib/ai/*` layer already produces the grounded facts; the gap is entirely
**presentation + a persistence layer**, not intelligence.

---

## 3. Architecture decision (per surface)

| Surface | Workspace? | Verdict | Rationale |
|---|---|---|---|
| **Auth** | No | **Standalone redesigned surface + one net-new `(auth)/layout.tsx` shell** | Lives before the app; behavior is fixed by NextAuth/`proxy.ts`. Needs a shared shell (split-screen) it currently lacks — but that shell is a *surface* layout, not `SpaceShell`. |
| **Space Launcher** | No | **Standalone root chooser** (redesign in place) | It *selects* spaces; `SpaceShell` operates *inside* one. Already correct architecturally — pure UX redesign. |
| **Brief** | **No** (explicitly) | **Global intelligence surface** (option B) | Already global: own route group, in `GLOBAL_NAV` not `WORKSPACE_REGISTRY`, aggregates across *all* spaces. Forcing it into a per-space Workspace would break its cross-space nature. Keep standalone. |
| **AI** | No | **Global ambient intelligence surface** | Cross-space ("master" mode), always-on, sibling to Spaces. Not a Workspace, not inside a Space. |

**On Connections/Settings vs Brief/AI:** Connections and Settings *were* folded
into the universal registry as namespaced `WorkspaceDefinition`s
(`CONNECTIONS_WORKSPACES`/`SETTINGS_WORKSPACES`) because they are *configuration
surfaces* that benefit from the workspace rail. Brief and AI are *intelligence*
surfaces — narrative and conversational — that would be *degraded* by workspace
chrome. The five global destinations are correctly **not** homogeneous: two are
workspace-shaped (Connections, Settings), one is a chooser (Spaces), two are
intelligence (Brief, AI). This asymmetry is a feature.

---

## 4. The real critical path: the shared primitive kit (Wave 0)

Three of the four surfaces are independently hand-rolling the *same* missing
primitives. This is the serialization point — build it first, or three teams
build it three times.

**Missing from `components/atlas/` today:**

| Primitive | Auth needs | AI composer needs | Brief needs |
|---|---|---|---|
| `Field` / text input | ✅ (9× duplicated inline) | ✅ (composer) | — |
| `PasswordField` (show/hide) | ✅ (4× duplicated) | — | — |
| OTP / segmented code input | ✅ (TOTP) | — | — |
| Inline validation / `Notice` banner | ✅ (hand-rolled every page) | ✅ (errors) | — |
| **`Toast`** | ✅ | ✅ | ✅ | — **none exists repo-wide** |
| Evidence chip / action-chip | — | ✅ (answer cards) | ✅ (drill/ask/jump) |
| `AnswerCard` / grounded-claim card | — | ✅ | ✅ (shares the pattern) |

`GlassButton`, `GlassPanel`, `Surface`, `Dropdown`, `SegmentedControl`,
`Dialog/FormModal`, `TrustIndicator` already exist and are reusable as-is.

**This confirms the Wave-1 memory note** ("form-kit `atlas/fields` + Toast
trails") and the Roadmap's "Wave 0 = un-primitized form/table/viz layers": the
form/field/toast kit is the genuine blocker, and it is now demonstrably shared
across Wave-2 surfaces, not just Wave-1's Connections/Settings.

---

## 5. Parallel implementation plan

### 5.1 Conflict map

| Zone | Files | Isolation |
|---|---|---|
| **Auth** | `app/(auth)/**`, `app/api/auth/**` | **Fully isolated** — no shared file with other surfaces. Only outbound dependency is the Atlas kit. |
| **Space Launcher** | `SpacesClient.tsx`, `spaces/page.tsx`, `CreateSpaceModal.tsx`, `DashboardChrome.tsx` (mount) | Single big owner (`SpacesClient`), isolated from Brief/AI/Auth. |
| **Brief** | `components/brief/**`, `api/brief/route.ts`, `lib/brief-types.ts` | Isolated route group. `BriefItem` extension is one vertical slice (types + route + components together). |
| **AI** | `AnalyzeClient.tsx`, `analyze/page.tsx`; new composer/persistence | ML-tab removal is self-contained; `lib/ai/*` untouched for UI work. |
| **SHARED — Atlas kit** | `components/atlas/Field.tsx`, `PasswordField.tsx`, `OtpInput.tsx`, `Notice.tsx`, `Toast.tsx`, `AnswerCard.tsx`, `ActionChip.tsx` | **The one true shared dependency. Must land first / single owner.** |

### 5.2 Safe-to-parallelize

- **Serialize first:** the Atlas kit (§4). One owner. Everything else waits on
  `Field` + `Notice` + `Toast` at minimum.
- **Then fully parallel (zero file overlap):** Auth · Space Launcher · Brief · AI
  ML-tab removal. Four agents, four disjoint file zones.
- **Sequential *within* AI:** ML-tab removal (safe now) → composer redesign
  (needs Atlas kit) → conversation persistence (schema + route, separate concern,
  gated on a `conversationId` migration).

### 5.3 Do-not-touch (behavior / constraint guards)

- Auth: `lib/auth.ts`, `proxy.ts` redirect contract, all `app/api/auth/**`
  handlers, the login state machine's *logic* — reskin only.
- AI: `lib/ai/*` semantic layer, `lib/transactions/*` classifier — **do not merge
  AI into classification.**
- Brief: keep it standalone/global — **do not give it a `WorkspaceDefinition`.**
- Space Launcher: cookie switch mechanism (unless a deliberate URL migration is
  scoped separately — out of Wave 2).

---

## 6. Implementation slices (smallest shippable first)

Ordered by dependency. Each slice is independently shippable and behavior-neutral
unless noted.

**W2-0 · Atlas form/intelligence kit** *(blocker; single owner)*
- `Field`, `PasswordField`, `OtpInput`, `Notice` (inline validation), `Toast`
  (+ provider), `ActionChip`, `AnswerCard`. Pure primitives, no surface wiring.
- *Smallest viable subset to unblock Auth:* `Field` + `Notice` + `PasswordField`.

**W2-A · Auth redesign** *(parallel; behavior frozen)*
- Add `app/(auth)/layout.tsx` (split-screen identity shell) — net-new, no
  existing shell to modify.
- Replace inline Tailwind with the Atlas kit across all six pages; keep every
  `onSubmit`/`onClick` handler binding and the login state machine intact.
- Retire `AppLogo forceTheme="dark"` once pages carry theme tokens.
- *UI opportunity:* branded split-screen with a live "meridian" marketing panel;
  unify TOTP entry into `OtpInput`.

**W2-B · Space Launcher hierarchy** *(parallel)*
- Adopt prototype's list-first hierarchy as an option / responsive default;
  one-line identity + one-line number per space.
- Add the entry **transition** (chosen card holds, others fade) on switch.
- Fold platform-HQ spaces into the same visual primitive (domain-neutral),
  keeping the real switch/create/invite data path.
- *Product gap (not UI):* wire public-space **join** (currently inert) — needs a
  per-space access-request backend; scope separately.

**W2-C · Brief trust + action contract** *(parallel; one vertical slice)*
- Extend `BriefItem` with `basis`, `evidence[]`, `askId`, `spaceJump` (additive).
- Populate `basis` from the existing `CompletenessTier`/reconstruction vocabulary
  in `route.ts`.
- Wire evidence chips → `PanelHost` drill; "Ask about this" → AI handoff; adopt
  the single-lede narrative layout.

**W2-D · AI dead-code removal** *(parallel; independent)*
- Remove the "ML Review" tab (`AnalyzeClient.tsx:287, 301-379`), `AdviceBanner`,
  and the `getLatestAdvice`/`AiAdvice` read path from the AI surface. (Leave the
  Brief's own `aiAdvice` read decision to W2-C owners.)
- Result: AI page collapses to the single working chat experience.

**W2-E · AI ambient surface** *(gated on W2-0; after W2-D)*
- Rebuild `analyze` as the DS-6 experience: sticky grounded composer + context
  chip, suggested-questions empty state, `AnswerCard` grounded answers with
  evidence → panel and jump → Space, Brief → AI seed handoff.
- Rename the route/nav from `/dashboard/analyze` → `/dashboard/ai` (nav already
  labels it "AI").

**W2-F · AI conversation persistence** *(separate concern; schema)*
- Add `conversationId` + message store (the unbuilt AI-5 layer) to make "Recent
  conversations" real rather than mock. Streaming optional follow-on.

---

## 7. End-state

Fourth Meridian as an **intelligent financial operating system**, five global
destinations against a shell that already exists:

```
User
 └─ Spaces        ← Launcher chooses (W2-B) → SpaceShell operates inside
     Brief        ← global intelligence, initiates (W2-C)
     AI           ← global ambient, always-on, converses + grounds (W2-D/E/F)
     Connections  ← workspace-shaped config (Wave 1)
     Settings     ← workspace-shaped config (Wave 1)
```

Auth is the redesigned front door (W2-A) before any of it. The intelligence loop
closes when Brief **initiates** ("here's what changed, ask about this") and AI
**continues** (grounded answer → evidence panel → jump into the Space) — both
handing off to the same panels and Spaces the rest of the product already uses.
```
```
