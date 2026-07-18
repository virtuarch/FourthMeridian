# Experience Convergence — Daily Brief + Space Launcher

**Slice:** v2.5 experience-layer convergence toward the `prototype/prototype-claude`
design language. Presentation-only. **No backend, no new authorities, no
contract changes to Space data.** Uncommitted.

## Decision rule outcome

This was **mostly a reskin** — the production Atlas primitives already are a port
of the prototype's read-surface kit (`components/atlas/Surface.tsx` header:
"the prototype's read-surface design language … brought into production"), and
the data each surface needs already exists on the current contracts. So both
surfaces were implemented fully, with **presentational slots** left where the
prototype depicts intelligence production doesn't have yet.

---

## Daily Brief — `/dashboard/brief`

### What moved
- **Retired the cinematic Earth hero** in favour of the prototype's text-first
  editorial header (dated greeting → lede → what changed → what needs you →
  what can wait). Density/urgency decrease down the page.
- `components/brief/DailyBriefClient.tsx` reshelled onto Atlas `Surface`/`Figure`.
  The **same `BriefPayload`** is bucketed into the editorial hierarchy:
  - `insight` → the **lede** (containerless, FM's one read for today)
  - `since_last_visit` → **"Since you were last here"** (the metric strip)
  - `attention` → **"Worth your attention"** (accent rows) / all-clear line
  - `opportunity` (+ non-new-user `onboarding`) → **"Can wait"** (folded)
- `components/brief/BriefNewUser.tsx` reshelled from `GlassPanel` → `Surface`.
- Rich detail still opens the **same modals** (`SinceLastVisitModal`,
  `AttentionModal`) — unchanged.
- Two portals (`Continue to Spaces`, `View AI Analysis`) kept at the top since
  the Brief route is chrome-less.

### Preserved (untouched)
- `/api/brief` builder, `buildContext()` AI context path, `/api/brief/viewed`,
  the `BriefPayload`/`BriefSection`/`BriefItem` contract, permissions/eligibility.

### Presentational slots (render only when data exists — nothing fabricated)
- **Trust dot** (`TrustDot`) — renders only when a `BriefItem.basis` is present.
  Added `BriefBasis` + optional `basis?` to `lib/brief-types.ts` as a **reserved
  seam**; `/api/brief` does **not** emit it, so no dot shows today.
- **Jump chip** — renders only when an item/section has an `href` (the builder
  already emits real hrefs, e.g. `/dashboard?tab=accounts`).
- **Ask / View AI Analysis** — opens the existing conversational AI at
  `/dashboard/analyze` (the Brief→AI handoff). Browser-verified.

### Deferred to v2.6 (needs backend — prototype-only)
- Per-item **provenance envelopes** to light the trust dot (the prototype's
  `basis`), from the Brief pipeline.
- **Structured evidence** (`InsightAction[]` → filtered drill panels) attached to
  each insight (entity linking).
- **Generated per-item actions** (`spaceJump`/`askId` with a *seeded* AI question
  — a `?q=` seam into `AnalyzeClient` was scoped but not built; the handoff is a
  plain link for now).
- LLM-generated grounded **fact → interpretation → caveat** ledes and
  conversation **memory**.

---

## Space Launcher — `/dashboard/spaces`

### What moved
- `components/dashboard/SpacesClient.tsx` — the Space **card grid → editorial
  list** ("rooms you already own", prototype `Launcher.tsx`):
  - `SpaceCard` rewritten as a solid Atlas **`Surface` row**: identity chip,
    name + `Active`/`Shared` chips, one meta line (`category · N members ·
    updated`), sparkline (hidden `<md`), one real `Figure` (compact net worth)
    + a **derived** delta% (computed from the same `trend` series — not a new
    number), enter arrow, active-row left-rail accent.
  - Header gained the manifesto line ("Each Space is a separate financial world.
    Nothing leaks between them.").
  - **Platform group → "Fourth Meridian HQ"** editorial rows (HQ badge, no
    financial figure) — same shell, distinct section.
- Removed the now-dead avatar-stack helpers (`MemberAvatars`/`avatarColor`).
  Editorial rows use a text member count.

### Preserved (untouched)
- Space **creation** (`OPEN_CREATE_SPACE_EVENT` → `CreateSpaceModal`),
  **manage** (`ManageSpaceModal`), **invites** (`InviteBanner`/`InviteRow`),
  **public** preview + `PublicSpaceDetailModal`, **cookie switch**
  (`/api/space/switch` → `/dashboard`), "Show N more", personal-pinned-first,
  the `SpaceItem` contract, registries, access controls, membership.
- `SpaceShell` boundary intact — the launcher chooses Spaces; the shell operates
  inside them. No `SpaceShell` duplication.

### Browser-verified
Brief (populated + all-clear attention + lede + metric strip + SinceLastVisit
modal + Brief→AI handoff), Spaces (personal row with Active chip + derived
delta, HQ section, Create Space modal, enter-into-Space routing). Mobile is
responsive by construction (centered `max-w` column, `flex-wrap`, `sm/md`
breakpoints); the browser tool's screenshot viewport is fixed at 1568px, so
mobile was not visually captured.

### Verification
`tsc` (no errors in touched files; pre-existing investments-test type errors are
unrelated), `eslint` clean on all touched files, `283/283` unit tests pass.

---

## Orphans (v2.6 cleanup, left on disk — not bundled, fully reversible)
`components/brief/`: `BriefHero.tsx`, `EarthBackground.tsx`,
`BriefSinceLastVisit.tsx`, `BriefInsight.tsx`, `BriefAttention.tsx`,
`BriefCard.tsx`, `BriefModal.tsx` — no importers after this slice.
(`SinceLastVisitModal`, `AttentionModal`, `BriefLogo`, `HeroRegionProvider`
remain in use.)
