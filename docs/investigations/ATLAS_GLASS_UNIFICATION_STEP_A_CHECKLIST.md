# Atlas Glass Unification — Step A Implementation Checklist

**Status:** Checklist only — investigation/planning. **No code, tokens, components, schema, or migrations written yet.** Approval gate before any implementation.
**Date:** 2026-07-03
**Scope (approved):** Tokens + `DataCard` foundation **only**. No card migrations, no Debt instrument, no Liquid Glass effects, no visual redesign, no schema, no migrations.
**Predecessors:** `SPACE_DASHBOARD_INTERACTION_DOCTRINE.md` (two-card-material finding; affordance-is-a-contract), `SPACE_DASHBOARD_FEEL_AND_LIVING_INTERFACE_INVESTIGATION.md` (material unification as prerequisite), and the chat plan that defined Steps A/B/C.
**Evidence base (read for this checklist):** `app/globals.css` (token definitions, dark `:root` + light override block), `components/atlas/GlassPanel.tsx` (the target primitive), `components/ui/Card.tsx` + `components/dashboard/AccountCard.tsx` (the legacy source and a representative consumer).

**Governing principle for Step A:** *Everything here is purely additive and renders nothing new on screen.* New tokens are defined but unconsumed; `DataCard` is created but mounted nowhere; the ratchet is introduced in baseline mode. Step A cannot change a single rendered pixel. That property is what makes it zero-risk and is asserted by the validation below.

---

## 1. Files likely touched

| File | Change | Nature |
|---|---|---|
| `app/globals.css` | Add the tokens in §2 to the dark `:root` block **and** the light-theme override block. Nothing removed, nothing edited. | Additive only |
| `components/atlas/DataCard.tsx` | **New file.** The wrapper in §3. | New |
| `components/atlas/index.ts` | Add `DataCard` export **only if a barrel already exists** (verify first; do not create a new barrel in Step A). | Additive / conditional |
| `lib/atlas/palette-ratchet.test.ts` | **New file.** Standalone `tsx` guard, house test convention (exit 0/1), baseline mode. §7. | New (guard) |
| `docs/design-system/…` | *Optional, deferred:* record the new tokens in the design-language reference. Not required for Step A; flag for Step B. | Docs only |

**Explicitly NOT touched in Step A:** `components/atlas/GlassPanel.tsx`, `components/ui/Card.tsx`, `components/dashboard/AccountCard.tsx`, and every other legacy consumer. No dashboard host (`DashboardClient.tsx`, `SpaceDashboard.tsx`). No `prisma/schema.prisma`, no migrations, no `package.json`.

---

## 2. Exact token additions

Verified already present and reused untouched (do **not** re-add): `--ink-0..950`, `--radius-xs/sm/md/lg/xl/full`, `--space-1..12`, `--shadow-e1..e4`, `--bg-base/deep`, `--text-primary` (ink-50), `--text-secondary` (ink-300), `--text-muted` (ink-400), `--border-hairline(-strong)`, `--glass-ultrathin/thin/regular/thick`, `--specular-edge`, `--surface-hover(-strong)`, accent ramps `--meridian/emerald/coral/violet/brass-*`, `--dur-*`, `--ease-*`.

Only the following are genuinely missing for the legacy-card interiors and must be **added**. Values are proposals for review, not final; each must be defined in **both** the dark `:root` and the light-override block.

### 2.1 Missing primitives (2)

```
/* Quietest text tier — for timestamps / "Updated {date}" (replaces text-gray-500).
   Existing tiers stop at --text-muted (ink-400); gray-500 is one step quieter. */
--text-faint: var(--ink-500);            /* dark */
--text-faint: var(--ink-400);            /* light-override block — review value */

/* Inset chip surface — the icon chip behind a card glyph (replaces bg-gray-800).
   A recessed fill that reads as inset on glass, distinct from --surface-hover. */
--surface-inset: rgba(255,255,255,.06);  /* dark — review vs --surface-hover */
--surface-inset: rgba(17,21,31,.06);     /* light-override block — review value */
```

### 2.2 Semantic accent aliases (4) — mechanism only, no rainbow

These alias existing ramps so `DataCard` consumers reference *meaning*, never a raw hue. They encode only what the design language already treats as unambiguous (gain/loss/neutral/info). They do **not** decide the account-type palette (deferred — §4.1).

```
--accent-positive: var(--emerald-400);   /* real gain only (Law 7) */
--accent-negative: var(--coral-400);     /* real loss only (Law 7) */
--accent-neutral:  var(--ink-300);        /* default / non-signalling */
--accent-info:     var(--meridian-400);   /* interactive/informational */
```

Light-override values: same ramp references (the ramps already carry both themes); confirm the -400 steps read correctly on light glass during validation, adjust to -500 if contrast fails.

**Total additions:** 2 primitives + 4 aliases = **6 tokens**, each in 2 blocks. No other token work.

---

## 3. `DataCard` API proposal

New primitive at `components/atlas/DataCard.tsx`, composing `GlassPanel` (it does **not** re-implement glass). Defaults reproduce the legacy `Card` box exactly, so a later migration is a *material swap, not a layout change*.

```ts
import type { ElementType, ReactNode, CSSProperties } from "react";
import type { GlassDepth, GlassElevation, GlassRadius } from "@/components/atlas/GlassPanel";

export interface DataCardProps {
  children: ReactNode;

  /** Optional uppercase label slot — replaces the legacy <CardTitle>. */
  title?: ReactNode;

  /** Material — locked, sensible defaults; overridable narrowly. */
  depth?: GlassDepth;         // default "thin"
  elevation?: GlassElevation; // default "e2"
  radius?: GlassRadius;       // default "lg"  (≈ legacy rounded-2xl)
  padding?: string;           // default "var(--space-4)" (≈ legacy p-4)

  /** Affordance — SEPARATE from material. Default inert. */
  interactive?: boolean;      // default false; when true → GlassPanel hover lift
  onClick?: () => void;       // required-ish companion to interactive
  as?: ElementType;           // polymorphic passthrough (div | Link | button)

  /** Accent — SEMANTIC ONLY. Never accepts a raw color string. */
  accent?: "none" | "positive" | "negative" | "neutral" | "info"; // default "none"

  className?: string;
  style?: CSSProperties;
}
```

Also export a small `DataCardTitle` (or render via the `title` prop) so `CardTitle` has a replacement path later.

**API principles (each is an anti-chaos rule):**

1. **Defaults = the legacy box.** `thin` glass, `radius-lg`, `space-4` padding → migrating a card changes its *material*, not its geometry, so surfaces don't reflow.
2. **Motion is opt-in and orthogonal to material** (`interactive` defaults `false`). A card does not move just because it became glass — the exact failure the Interaction Doctrine warns about. Inert display cards (balances) stay inert.
3. **No `glow` exposed.** Brass/AI/meridian glow stays scarce and reserved for Briefing/premium (Law 7). `DataCard` is for *data*; it must not be able to borrow the AI accent.
4. **Accent is token-only.** `DataCard` never takes a hex/Tailwind color — only the four semantic names, which resolve to §2.3 tokens. This is the structural guard against the account-type rainbow creeping back.
5. **No Liquid Glass surface.** No `displacement`, `refraction`, `chromaticAberration`, `curvature`, or draggable props exist on this API. Out of scope by construction.
6. **Composition, not fork.** It wraps `GlassPanel`; any future token change still happens in one place.

---

## 4. Legacy classes `DataCard` replaces **later** (Step B — documented now, not executed)

Recorded so Step B is mechanical and the ratchet (§7) has a target list. **None of these are touched in Step A.**

| Legacy (in `Card.tsx` / consumers) | Replaced later by |
|---|---|
| `rounded-2xl border border-gray-700 bg-gray-900 p-4` (the `Card` container) | `<DataCard>` (defaults) |
| `bg-gray-800` (icon chip, e.g. `AccountCard` L40) | `background: var(--surface-inset)` |
| `text-white` | `var(--text-primary)` |
| `text-gray-400` | `var(--text-secondary)` (or `--text-muted` where quieter) |
| `text-gray-500` (e.g. "Updated {date}") | `var(--text-faint)` |
| `text-xs uppercase tracking-widest text-gray-400` (`CardTitle`) | `DataCard` `title` slot / `DataCardTitle` |
| account-type hues `text-blue/emerald/violet/yellow/red-400` (`AccountCard` `colors` map) | `accent` semantic prop — **decision deferred, §4.1** |

### 4.1 Deferred decision (out of Step A scope) — the account-type palette

`AccountCard` maps `checking→blue, savings→emerald, investment→violet, crypto→yellow, debt→red, other→gray`. Two of these have no clean Atlas token and encode a *design* choice, so they are **not** resolved in Step A:

- **crypto = yellow** has no Atlas equivalent; the nearest ramp is `--brass-*`, which is **reserved for AI/premium/mark only** (Law 7). Mapping crypto to brass would spend that scarcity. Needs a deliberate call (dedicated token vs. fold to neutral vs. new restrained hue).
- **checking = blue** collides conceptually with `--meridian` (the interaction accent). Reusing meridian for an account type muddies "meridian = interactive."

These are a Step-B (or a small dedicated) decision. Step A only ships the *four unambiguous* accents (§2.3) and the mechanism; it does not commit the account-type map.

---

## 5. Rollback plan

Step A is additive and inert, so rollback is trivial and total:

- **Nothing consumes the new tokens** → reverting the `globals.css` additions removes them with zero runtime effect (no selector references them yet).
- **`DataCard` is mounted nowhere** → reverting the new file removes it with zero effect; no import graph depends on it.
- **The ratchet is baseline/CI-only** → reverting it changes no runtime behavior; if it were ever to block CI on pre-existing violations, it ships in warn/allowlist mode (§7) so it cannot wedge the pipeline.
- **Mechanism:** plain `git revert` of the Step-A commit(s), in any order, with no data risk and no schema involvement. Because there is no rendered change, there is also no visual regression to reverse.

Commit shape (providers before any consumer — there are no consumers in Step A): (1) token additions, (2) `DataCard` + optional export, (3) ratchet guard in baseline mode + docs note. Each compiles and lints independently; the stack is revert-safe at any prefix.

---

## 6. Validation

Per project working style:

- `npx prisma generate` → **must be a no-op diff** (confirms no schema touched).
- `npx prisma migrate dev` → **N/A; its absence is the check** (no schema change).
- `npx tsc --noEmit` → clean (DataCard types resolve; GlassPanel prop types imported, not redefined).
- `npm run lint` → clean.
- `npx tsx lib/atlas/palette-ratchet.test.ts` → passes; **baseline captured** (current violation set recorded, §7).
- **Additive-only proof:** `git diff --stat` shows exactly the files in §1 and *no* change to `GlassPanel.tsx`, `Card.tsx`, `AccountCard.tsx`, or any consumer/host.
- **Zero-pixel proof:** grep confirms no existing selector or component references the six new tokens or `DataCard`; therefore no rendered surface changes. (If a storybook/scratch route is used to eyeball `DataCard` in isolation, it must be a throwaway not merged into a shipped route.)
- **Theme parity:** each new token exists in **both** the dark `:root` and light-override block; render `DataCard` once in each theme in isolation to confirm `--text-faint`/`--surface-inset` contrast (adjust proposed values if they fail; values in §2 are provisional).
- **Reduced-motion:** `DataCard` at `interactive={false}` has no transition; at `interactive={true}` it inherits `GlassPanel`'s existing reduced-motion behavior (no new motion introduced).

---

## 7. Lint / grep ratchet proposal

**Goal:** prevent *new* raw-palette usage in dashboard components while allowing the existing ~15 known-legacy files to be burned down during Step B. It must not block CI on day one.

- **Location:** `lib/atlas/palette-ratchet.test.ts`, standalone `tsx`, exit 0/1 (house convention, mirrors `lib/space-nav.test.ts`).
- **Scan scope:** `components/dashboard/**`, `components/space/**`, `components/atlas/**` (extendable).
- **Forbidden patterns (regex):**
  - `bg-gray-[0-9]{2,3}`
  - `border-gray-[0-9]{2,3}`
  - `text-gray-[0-9]{2,3}`
  - `text-(blue|red|emerald|green|violet|yellow|amber|purple)-[0-9]{2,3}`
- **Ratchet mechanism:** on first run, record a **baseline allowlist** (a committed `palette-ratchet.baseline.json` of `{file: matchCount}` for current violators). The test **fails only if** a file's count *increases* or a *new* file appears. Step B lowers counts; the baseline ratchets down and never up.
- **Modes:** ship in **baseline mode** in Step A (green immediately, records reality). A later flip to strict-zero happens only when Step B has cleared the list.
- **Out of scope for the regex (intentionally):** raw palette inside `components/ui/Card.tsx` itself is allowlisted until Card is retired in Step B; `components/admin/**` and `components/charts/**` are out of the initial scan (chart libraries carry their own palettes) — expand later by decision.

---

## 8. What must explicitly NOT change in Step A

- **No consumer migrated.** `AccountCard`, `InvestmentsCard`, `NetWorthCard`, `DebtCard`, `FicoCard`, `AssetDrawer`, and all others render exactly as today.
- **`components/ui/Card.tsx` untouched and not deleted.** It keeps working; retirement is Step B.
- **`GlassPanel.tsx` untouched.** No new props, no behavior change.
- **Zero rendered-pixel change** anywhere in the app. Adding unused tokens and an unmounted component is invisible by construction.
- **No motion/hover behavior change.** `DataCard` defaults inert; nothing existing gains a lift.
- **No account-type accent decision** (crypto/brass, checking/meridian) — deferred (§4.1).
- **No Liquid Glass** — no refraction, displacement, chromatic aberration, curvature, specular-beyond-existing, or draggable anything.
- **No Debt living-instrument** — no slider, no `simulatePayoff` wiring (Step C).
- **No schema, no migration, no new runtime dependency, no `package.json` change.**
- **No dashboard-host edits** — the two-host split is not addressed here; `DataCard` is built once so it can *later* anchor convergence, but neither host is touched in Step A.
- **No design-language visual redesign** — spacing, radii, elevation, and the account-type look are unchanged; Step A only makes the *token + wrapper substrate* exist.

---

*End of checklist. Investigation/planning only — no implementation performed. Awaiting approval to implement Step A (token additions + `DataCard` + baseline ratchet), which is additive, inert, and revert-safe by construction. Stop here per brief.*
