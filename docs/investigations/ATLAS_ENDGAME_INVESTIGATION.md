# Atlas Glass — Endgame Investigation

**Status:** Investigation / planning only. No code, CSS, tokens, or doctrine edited.
**Branch context:** `feature/v2.5-spaces-completion`.
**Predecessor ADRs (governing):**
`docs/investigations/ATLAS_GLASS_UNIFICATION_STEP_A_CHECKLIST.md`,
`ATLAS_GLASS_UNIFICATION_STEP_B_CHECKLIST.md`,
`ATLAS_GLASS_STEP_C_DATAVIEW_FAMILY_CHECKLIST.md`,
`docs/design-system/ATLAS_GLASS_MODAL_DOCTRINE.md`.

> **Guardrail honored:** investigation first. This document only reports the
> measured state of the tree and proposes the *smallest* plan. It does not
> re-litigate any approved Atlas decision, and it implements nothing.

---

## 0. TL;DR

The palette ratchet baseline is now **empty (`{}`)** — every file in the three
scanned directories (`components/dashboard`, `components/space`,
`components/atlas`) is at **zero** raw-palette violations. Step A/B and the
in-scope host/page burn-down are complete. That empties the ratchet and opens
the endgame.

Two clean buckets fall out:

- **Deletable *now* (zero migration, revert-safe):** the empty baseline file,
  the dead allowlist machinery, the baseline/`--update` diff mechanism (replace
  with strict-zero), a set of genuinely-dead CSS scale tokens, and — by
  decision — the three unadopted z-index tokens.
- **Deletable *only after* a small migration:** the duplicate `widgets/GlassModal`
  shell and the two inline modal recipes it duplicates (R2 chart, R5 drawer),
  plus the raw glass-surface / blur duplication that lives *inside* those
  un-migrated recipes.

Everything else flagged (unused palette-ramp endpoints) is cosmetic and is
explicitly **kept** for ramp integrity / the still-deferred §4.1 account-type
accent decision.

---

## 1. Palette ratchet — current reality

`lib/atlas/palette-ratchet.test.ts` runs green with an **empty baseline**:

```
[palette-ratchet] OK — no new raw-palette usage (0 tracked files).
```

`lib/atlas/palette-ratchet.baseline.json` = `{}`.

Meaning: the guard is doing nothing but proving zero. In baseline/diff mode a
green run with an empty baseline is indistinguishable from **strict-zero** — so
the flip is now free of behavioral risk for the three scanned dirs.

**SCAN_DIRS today:** `["components/dashboard", "components/space", "components/atlas"]`.

**ALLOWLIST_FILES today:** `new Set<string>([])` — empty, with a stale comment
still referencing the retired `components/ui/Card.tsx`. Dead code.

---

## 2. SCAN_DIRS expansion — measured candidates

Raw-palette violations *outside* the current scan (bg/border/text-gray-\d and
text-\<hue\>-\d), measured across the tree:

| Directory | Violations | Files | Assessment |
|---|---:|---:|---|
| `components/dashboard` | 0 | 0 | scanned — clean |
| `components/space` | 0 | 0 | scanned — clean |
| `components/atlas` | 0 | 0 | scanned — clean |
| `components/plaid` | 1 | 1 | **cheap to include** (PlaidLinkButton) |
| `components/ui` | 23 | 4 | AppLogo(1), CoinIcon(6), UserButton(10), DashboardChrome(1) — small, includable |
| `components/charts` | 65 | 10 | **intentionally excluded** by ADR (chart libs carry their own palettes) |
| `components/admin` | 75 | 4 | ProviderDiagnosticsDrawer(33) etc. — ADR treats admin grays as **by decision** |
| `app` (all) | 558 | 14 | dominated by `app/admin/*` (312) and `app/(auth)/*` (56); dashboard app-pages nearly clean (accounts 1, brief 3) |

**Read:** the *dashboard* app pages are effectively already at zero, so the
scan can extend to `app/(shell)/dashboard/**` almost for free. `charts` and
`admin` are deliberately-palette'd per the Step A §7 exclusion and should **not**
be pulled into strict-zero without a separate product decision. `components/ui`
and `components/plaid` are small enough to burn down if desired, but that is a
*follow-on*, not part of the minimal endgame.

---

## 3. Strict-zero enforcement

Because the baseline is empty, strict-zero for the three cleared dirs is a
no-op at runtime and cannot wedge anything. The guard can drop the baseline
read/write + `--update` machinery entirely and simply **fail on any match** in
SCAN_DIRS.

What strict-zero removes from the file:
- baseline read / write / first-run bootstrap
- the `--update` "ratchet down" path
- the `ALLOWLIST_FILES` set and its stale comment
- the `palette-ratchet.baseline.json` artifact

What it keeps: `SCAN_DIRS`, `PATTERNS`, `walk`, `countViolations`, exit 0/1.

**Coverage caveat (unchanged from Step B §7):** the regex catches
`bg/border/text-gray-*` and `text-<hue>-*` but **not** `bg-<accent>-*` fills.
Strict-zero does not mean token-pure; accent *fills* still need grep/visual QA.
Extending `PATTERNS` with `bg-(blue|red|emerald|green|violet|yellow|amber|purple)-\d`
is an optional hardening, listed as an option not a requirement.

---

## 4. CI integration

**There is no CI.** No `.github/workflows`, no active git hooks
(`.git/hooks` are all samples), no `.husky`, and `package.json` has **no**
`test`/`ratchet`/`typecheck` script. The guard, `scripts/phase0-seam-gates.ts`,
and the other `*.test.ts` house-convention guards run **only when invoked by
hand.**

This is the single largest *engineering-completeness* gap: the ratchet cannot
protect `main` if nothing runs it. Minimum viable wiring, in order of effort:

1. Add npm scripts: `"ratchet": "tsx lib/atlas/palette-ratchet.test.ts"`,
   `"typecheck": "tsc --noEmit"`, and a `"verify"` that chains
   `ratchet && typecheck && lint`.
2. Add one CI workflow (or pre-push hook) that runs `npm run verify`.

Without at least (1), strict-zero is honor-system only.

---

## 5. Modal recipes — obsolete vs live

`ATLAS_GLASS_MODAL_DOCTRINE.md` catalogs recipes R1–R8. `OverlaySurface`
(the promoted R1 seed, with portal + focus-trap + `role`/`aria-modal` +
body-lock + panel height-cap + `var(--z-modal)`) now exists and is adopted by
the form/confirm family:

**Migrated onto `OverlaySurface` (directly or via `Dialog`/`FormModal`/`ConfirmDialog`):**
AddManualAssetModal, AddWalletModal, CreateSpaceModal, ManageSpaceModal,
AccountModal, RemoveAccountModal, TotpSection, ConfirmDialog,
AdminExpandHistoryFlow (was R8).

`Dialog`, `FormModal`, `ConfirmDialog` are **thin, correct presets** over
`OverlaySurface` — *not* duplicates. Keep.

**Still on legacy inline recipes (the endgame remainder):**

| Component | Recipe | Evidence | Duplicates |
|---|---|---|---|
| `dashboard/widgets/GlassModal` | R1 shell (pre-OverlaySurface) | consumed by 5 files (below) | **OverlaySurface** |
| `dashboard/widgets/TimelineModal` | R1 via GlassModal | `import { GlassModal }` | via GlassModal |
| `charts/NetWorthChartModal` | R2 chart inline | `fixed inset-0 z-[100] …` hand-rolled scrim | OverlaySurface scrim |
| `dashboard/AssetDrawer` | R5 raw scrim, centered (misnamed "drawer") | `fixed inset-0 z-[100] items-center` | OverlaySurface |
| `brief/BriefModal` | R7 portal (the a11y donor) | `createPortal`, `z-[9999]`, `role="dialog"` | logic now lives in OverlaySurface |
| `brief/AttentionModal`, `brief/SinceLastVisitModal` | brief family | — | OverlaySurface |
| `admin/ProviderDiagnosticsDrawer` | R8 hardcoded grays | 33 raw-gray violations | true edge-drawer; own decision |

`GlassModal` consumers to migrate before it can be deleted:
`DashboardClient`, `SpaceDashboard`, `widgets/MoreMenu`,
`widgets/PerspectiveSwitcher`, `widgets/TimelineModal`.

---

## 6. Duplicate Atlas primitives

Only one true duplicate primitive remains:

- **`components/dashboard/widgets/GlassModal.tsx`** — the R1 shell
  `OverlaySurface` was promoted *from*. Its own header even says it was left in
  place "to avoid touching working code." It duplicates the primitive's scrim,
  size ladder, and scroll structure. **Retire after its 5 consumers move to
  `OverlaySurface`** (`size="full"` covers TimelineModal).

Not duplicates (verified — keep): `Dialog`, `FormModal`, `ConfirmDialog`
(presets), `GlassPanel` (30 importers, canonical surface), `GlassButton`,
`DataCard`, `AtlasField`, `SegmentedControl`, `InlineFilter`, `tones.ts`,
`useBodyScrollLock` (shared by GlassModal *and* OverlaySurface).

**No dead utilities found** — every helper checked (`tones`,
`useBodyScrollLock`, `InlineFilter`, `SegmentedControl`, `AtlasField`,
`timeline-placeholder`) has live importers.

---

## 7. CSS variables — unused

Custom properties defined in `app/globals.css` (plain `:root` / `[data-theme]`
— **no Tailwind `@theme` block**, so "no `var()` reference" = genuinely unused
at runtime) with **zero** references in `app/ components/ lib`:

**7a. Genuinely-dead standalone tokens — safe to delete (after a final grep gate):**
`--font-ui`, `--font-data`, `--radius-xl`, `--shadow-e1`,
`--dur-ambient`, `--dur-moderate`, `--ease-exit`,
`--space-1`, `--space-2`, `--space-5`, `--space-6`, `--space-7`, `--space-8`,
`--space-9`, `--space-10`, `--space-11`, `--space-12`.
(The `--space-*` scale is almost entirely unreferenced — the app uses Tailwind
spacing utilities instead. Confirm `--space-3/4` before touching the scale.)

**7b. Unused palette-ramp *endpoints* — KEEP (do not delete):**
`--brass-100/200/500/700`, `--coral-100`, `--emerald-100`, `--violet-100/300`,
`--meridian-100/200`, `--ink-200`, `--paper-100`.
These are individual shades inside ramps whose other shades *are* used. They
exist for ramp completeness and feed the still-**deferred §4.1 account-type
accent decision**. Deleting mid-ramp shades is a cosmetic judgment call with no
engineering payoff and a re-add cost when §4.1 lands. Explicitly out of scope.

---

## 8. Dead z-index tokens

`globals.css` defines a 4-step scale; only one is adopted:

| Token | Value | Used by |
|---|---:|---|
| `--z-modal` | 100 | `OverlaySurface` (1 ref) — **live** |
| `--z-modal-nested` | 110 | none — **dead** |
| `--z-toast` | 200 | none — **dead** |
| `--z-critical` | 300 | none — **dead** |

Meanwhile the tree still carries ad-hoc `z-[…]` in un-migrated code:
`z-50`×15, `z-[100]`×9, `z-[9999]`×2, `z-[200]`×2, `z-[110]`×1, `z-[1]`×1.

**Two coherent endgames — pick one (decision, not implemented here):**
- **(A) Adopt:** migrate the un-migrated modals onto `OverlaySurface`, which
  routes nested/toast/critical through the tokens, retiring the raw ladder.
  Then the three tokens become live.
- **(B) Prune:** if nesting is being eliminated (doctrine §9 wants nesting
  minimized) and there is no toast/critical layer, delete
  `--z-modal-nested/-toast/-critical` as speculative.

They are only "dead" because §5's migration hasn't happened. Recommend (A) as
the natural close, (B) only if the modal migration is deferred indefinitely.

---

## 9. Duplicate surface & blur recipes

**Surface:** `GlassPanel` is canonical (30 importers). ~17 surfaces still
inline `bg-[var(--glass-*)]` directly (`--glass-ultrathin`×10, `--glass-thin`×3,
`--glass-thick`×3, `--glass-regular`×1). Nearly all of these live inside the
**un-migrated modal recipes of §5** (their hand-rolled panels/scrims). They are
not independent debt — they collapse when those modals adopt
`OverlaySurface`/`GlassPanel`.

**Blur:** many distinct values coexist —
`backdrop-blur-sm`×17, `backdrop-blur`×3, `backdrop-blur-xl`×2,
`backdrop-blur-md`×2, and inline `blur(8px)`×10, `blur(30px)`×11, `blur(20px)`×3,
`blur(28px)`×2, `blur(56px)`×2. The scrim/panel blurs are duplicated across the
same un-migrated recipes. The `blur(2px)` earth-background filters are a
**separate, legitimate** system (ambient globe) and are *not* duplication.

**Conclusion:** surface + blur duplication is a **symptom** of the §5 modal
remainder, not an independent deletion target. Fixing §5 removes most of it; a
follow-on "blur scale" token pass (e.g. `--blur-scrim`, `--blur-panel`) is the
only truly independent piece, and it is cosmetic.

---

## 10. What can be deleted — verdict

**Deletable NOW (no migration; revert-safe; zero rendered-pixel change):**
1. `lib/atlas/palette-ratchet.baseline.json` (the empty `{}`).
2. The `ALLOWLIST_FILES` set + its stale `Card.tsx` comment.
3. The baseline read/write + `--update` machinery in the guard (→ strict-zero).
4. Dead standalone CSS tokens in §7a (after the grep gate).
5. `--z-modal-nested/-toast/-critical` **iff** decision (B) in §8 is taken.

**Deletable ONLY AFTER a small migration (§5/§6):**
6. `components/dashboard/widgets/GlassModal.tsx` — after its 5 consumers move to
   `OverlaySurface`.
7. The R2 (`NetWorthChartModal`) and R5 (`AssetDrawer`) inline recipes, and the
   raw `var(--glass-*)`/blur duplication they contain (§9).

**Explicitly NOT deletable (keep):**
8. Unused palette-ramp endpoints (§7b) — ramp integrity + deferred §4.1.
9. `Dialog`/`FormModal`/`ConfirmDialog` presets, `GlassPanel`, and every helper
   in §6 — all live.
10. `charts`/`admin` palettes — intentional per ADR; not endgame targets.

---

## 11. Smallest implementation plan (NOT implemented)

The minimum that makes Atlas Glass "complete from an engineering standpoint"
is **strict-zero + a running gate + dead-artifact removal**. Everything visual
(the modal remainder) is a separate, larger, optional track. Four tiny,
independently revert-safe commits:

**E1 — Strict-zero the ratchet (no runtime, no pixels).**
Rewrite `lib/atlas/palette-ratchet.test.ts` to fail on any match in SCAN_DIRS;
delete the baseline read/write, `--update` path, and `ALLOWLIST_FILES`; delete
`lib/atlas/palette-ratchet.baseline.json`.
- *Impact:* the three cleared dirs; guard behavior only.
- *Rollback:* revert the commit — baseline mode returns (baseline regenerates
  green on first run by construction).
- *Validation:* `npx tsx lib/atlas/palette-ratchet.test.ts` exits 0; introduce a
  throwaway `text-gray-500` and confirm it exits 1; `npx tsc --noEmit`;
  `npm run lint`.

**E2 — Make the gate run (CI integration).**
Add `ratchet` / `typecheck` / `verify` npm scripts and one workflow (or
pre-push hook) invoking `npm run verify`.
- *Impact:* `package.json` + one CI/hook file. No app code.
- *Rollback:* delete the workflow/scripts.
- *Validation:* the gate goes red on a seeded violation, green on `main`.

**E3 — Delete confirmed-dead CSS scale tokens (§7a only).**
Remove the §7a standalone tokens after re-running the unused-var grep as the
gate. **Do not touch §7b ramp endpoints or the z-index tokens here.**
- *Impact:* `app/globals.css` only; zero references means zero rendered change.
- *Rollback:* revert; tokens are self-contained.
- *Validation:* grep proves zero `var(--<token>)` refs pre-delete; visual smoke
  of dashboard + one modal in dark & light; `npm run lint`.

**E4 — (Optional, only with the §2 decision) extend SCAN_DIRS.**
Add `app/(shell)/dashboard/**` (and optionally `components/ui`,
`components/plaid`) to SCAN_DIRS *after* confirming/*burning down* their small
counts. Keep `charts`/`admin` excluded per ADR.
- *Impact:* guard scope + whatever small burn-down the added dirs require.
- *Rollback:* revert SCAN_DIRS.
- *Validation:* ratchet green on the widened scope; targeted visual QA of any
  touched file.

**Deferred to a separate, larger track (out of the "smallest" plan):**
the modal migration (§5) that retires `widgets/GlassModal`, `NetWorthChartModal`,
`AssetDrawer`, and the brief family onto `OverlaySurface`; adoption of the
z-index tokens (§8 option A); and the surface/blur consolidation (§9) that falls
out of it. Each modal is its own revert-safe commit, gated by before/after
screenshots asserting *material changed, behavior did not* — per the doctrine's
Phase 2–8 sequencing. This document does not open that track.

---

*End of investigation. Planning only — no schema, no CSS, no guard, no modal,
no `package.json`, and no doctrine edited. Awaiting approval to begin at E1
(strict-zero flip + dead-artifact removal), which is additive-subtractive,
pixel-neutral, and revert-safe by construction. Stop here per brief.*
