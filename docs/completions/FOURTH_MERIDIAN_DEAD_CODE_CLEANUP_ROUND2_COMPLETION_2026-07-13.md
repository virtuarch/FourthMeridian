# Fourth Meridian — Dead-Code Cleanup Round 2: Completion Summary

**Date:** 2026-07-13
**Branch:** `feature/v2.5-spaces-completion` (directly on primary — no worktree)
**Source audit:** `FOURTH_MERIDIAN_DEAD_CODE_AUDIT_2026-07-12.md` — the items round 1 did not cover, plus the repo-hygiene batch with the KD-13 root cause addressed.

Round 1 (already shipped, **not** touched here): Cluster A (`707b94b`), Cluster B (`cf8cee7`), the six `export {}` tombstones (`68a4fb2`), `computeCashResidual.ts` (`ed24d21`), `otplib` (`9bcca99`).

Three commits, one per logical cluster. `npx tsc --noEmit` + full `npm test` after each — **all green (tsc exit 0, 200/200 tests) on every commit.**

| Commit | Cluster | LOC removed |
|---|---|---|
| `6f40cd6` | C — Brief leftovers | **267** |
| `0b84d53` | D remainder — orphaned widgets | **253** |
| `e948ee3` | Repo hygiene | (assets/artifacts, not LOC) |
| | **Code total** | **520 LOC** |

---

## Cluster C — Brief leftovers (267 LOC, `6f40cd6`)

| File | LOC | Re-verification |
|---|---|---|
| `components/brief/BriefActions.tsx` | 17 | Zero importers. Only remaining mention is a `DailyBriefClient` doc-comment ("BriefActions — CTA buttons"), not an import. |
| `components/brief/UserMenu.tsx` | 250 | Zero importers by module path **or** named import. Confirmed **not rendered** in the brief layout — `app/(brief)/dashboard/brief/layout.tsx` only references it in prose comments ("kept inert for now"); its theme/region controls were absorbed elsewhere. No second-order orphans: `ThemeProvider` and `HeroRegionProvider` stay live (the latter is imported directly by the brief layout). |

The audit had UserMenu right ("nothing imports it"); the "kept (inert)" layout comment was stale — it was already fully unwired, not merely inert.

## Cluster D remainder — orphaned widgets (253 LOC, `0b84d53`)

| File | LOC | Re-verification |
|---|---|---|
| `components/dashboard/widgets/MoreMenu.tsx` | 150 | Zero references anywhere outside its own file. |
| `components/dashboard/widgets/OverviewBriefPanel.tsx` | 103 | Zero references; **not** registered in `lib/widget-registry.ts` (no key, no lazy import) — checked explicitly since these are "widgets" that a registry could load dynamically. |

## Repo hygiene (`e948ee3`)

Everything re-enumerated fresh (not trusting the audit's or STATUS's counts):

- **14 empty `" 2"` duplicate directories** — deleted. Fresh count was **14** (all empty), not the audit's 14-vs-STATUS's 19 — see the KD-13 note below on why the count fluctuates.
- **13 `tsconfig.*.tmp.tsbuildinfo`** at root — deleted. Untracked (already covered by the existing `*.tsbuildinfo` ignore).
- **`.env.bak`** — deleted. **Confirmed UNTRACKED** (gitignored via the existing `.env*` rules), so not a tracked-secret leak. Had it been tracked I would have flagged it rather than deleted it; it wasn't.
- **Two tracked background PNGs** (`fourth meridian dark background.png` 2.2 MB, `fourth meridian light background.png` 2.7 MB) — `git mv`'d to `docs/design-system/assets/`. Confirmed unreferenced by code first.
- **Three unreferenced public assets** removed: `public/atlas-card-nebula.png`, `public/atlas-card-neutral.png`, `public/logo-icon.png`. Re-verified `atlas-card-nebula-v2.png` is the **only** card texture actually referenced by code (`SpacesClient.tsx:217`). The removed three have **zero code references** — the only mentions are in `docs/archive/*` (historical) and the audit itself.
  - ⚠ **Flagged, not silent:** `atlas-card-neutral.png` (6.5 KB) is named in `docs/design-system/ATLAS_MATERIAL_LIBRARY_INVESTIGATION.md` as a *planned* drop-in fallback for a future material phase. No code uses it today, and it's recoverable from git history if that phase lands — removed per the task's explicit list and its "actually referenced" (= code-referenced) criterion.

### KD-13 root cause — what was actually fixed, and what wasn't

Added to `.gitignore` (in the macOS/sync-artifacts section):

```gitignore
# Finder / iCloud / Dropbox copy-on-conflict duplicates (KD-13): any path whose
# name ends in " 2" — e.g. "widgets 2/" (dir) or "foo 2.ts" (file). The cloud-
# sync tool keeps regenerating these. NOTE: this only suppresses the untracked-
# noise SYMPTOM inside the repo; it does NOT fix the sync tool itself, which is a
# local machine / OS-level configuration outside this repo's control.
* 2
* 2.*
```

- `* 2` matches any file or directory whose name ends in `<space>2` (the observed 14 dirs, plus extensionless files).
- `* 2.*` matches the file-with-extension variant the same tool produces (`foo 2.ts`).
- Verified against sample paths (`components/space/widgets 2`, `lib/foo 2.ts`, `docs/initiatives/d2/closeout 2` — all matched) and confirmed **no already-tracked file** matches the new patterns (git never un-tracks tracked files, but this rules out surprise).

**This is a partial fix by design.** It stops the duplicates from ever again showing as untracked noise or being accidentally committed *inside this repo*. It does **not** stop the cloud-sync tool from creating them on disk — that duplication is a local machine / OS-level configuration (Finder/iCloud/Dropbox copy-on-conflict) outside this repository's control. That's also why the count drifts (audit 14 → STATUS 19 → 14 today): it's a live, ongoing side effect, so any "delete the directories" action is inherently temporary. The gitignore rule is the durable part — the directories will keep regenerating locally, but they'll stay invisible to git and can't re-accumulate as repo noise.

---

## Re-verified vs. audit-already-correct

**Re-verified against current source** (audit is a week old; shell-nav, tab redesigns, and today's banking/accounts route retargets landed since) — used real `import`/module-path greps, not substring matches, after today's accounts-retarget surfaced a same-named-local-function false alarm:
- All 4 code files (BriefActions, UserMenu, MoreMenu, OverviewBriefPanel) — confirmed still zero-importer; UserMenu additionally confirmed not-rendered and free of second-order orphans.
- `atlas-card-nebula-v2.png` still the sole live card texture; the three removed public assets still code-unreferenced.
- `.env.bak` untracked; the 13 tsbuildinfo untracked; fresh `" 2"` dir count.

**Audit already had these right** (confirmed, no surprises): the LOC figures were within ~1 line of `wc -l` each; OverviewBriefPanel absent from the widget registry; BriefActions' only mention being a comment; the `*.tsbuildinfo` / `.env*` ignore coverage.

**Net:** 520 LOC of dead code removed across Clusters C and D, plus a hygiene pass that relocated ~4.9 MB of design PNGs, removed stray assets/artifacts, and — the substantive part — landed a durable `.gitignore` rule that neutralizes the KD-13 symptom in-repo without pretending to fix the local sync tool that causes it.
