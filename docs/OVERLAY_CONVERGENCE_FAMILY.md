# Overlay Convergence — Implementation Checklist

**Status:** Checklist / proposal. **No code changed.** Awaiting approval before any implementation.
**Source:** `docs/ATLAS_OVERLAY_AUDIT.md` — this bundles audit families **F1 + F2 + F6** into one coherent family and **excludes** F3, F4, F5.
**Governing rule:** additive before subtractive; migrate onto the existing `OverlaySurface` primitive; do not touch unrelated UI.

---

## 0. Why these three bundle (and why F3/F4/F5 don't)

F1, F2, and F6 are the same job wearing three hats: **re-home every overlay that can be expressed with today's three intents (`dialog` / `form` / `workspace`) onto `OverlaySurface`.** None of them requires a *new structural capability* — only migration and, for F6, two minor additive props.

- **F1** — inline token modals already have the right material + panel-level height cap; they only lack the behavioural layer the primitive owns.
- **F2** — the two shared shells (`GlassModal`, `NetWorthChartModal`) are ~80% the primitive already; retiring them re-homes their whole consumer set at once.
- **F6** — `BriefModal` is the reference-correct portal modal; converging it proves the primitive can absorb the app's most bespoke surface and deletes the last parallel portal implementation.

Deliberately **out of this family:**
- **F3** (hardcoded-gray surfaces) — adds color-token substitution risk; different review surface.
- **F4** (`ProviderDiagnosticsDrawer`) — needs a new `anchor="edge"` primitive variant first.
- **F5** (nested / full-screen bespoke) — needs overlay-nesting/restructuring decisions.

Converging first means F3/F4/F5 later migrate onto a primitive that is already the single source of truth, instead of a moving target.

---

## 1. Scope — exact surfaces

**F1 — migrate inline token modals → `FormModal` / `Dialog`**

1. `DebtClient` transaction modal → `FormModal` (`size="lg"`)
2. `InvestmentsClient` activity modal → `FormModal` (`size="md"`) — *also gains clickable backdrop*
3. `SpacesClient` space-preview modal → `Dialog` (`size="sm"`) — *also normalises the `z-[200]` outlier*
4. `AssetDrawer` → `FormModal`/`Dialog` (centered; **rename resolves the "drawer" misnomer**)
5. `SpaceDashboard` TrashDrawer → `Dialog` (mobile bottom-sheet intent)
6. `SpaceDashboard` Add-Goal modal → `FormModal` — *also gains backdrop close*

**F2 — fold shared shells into the primitive**

7. `widgets/GlassModal` → re-base on `OverlaySurface` (or retire), carrying its `toolbar`/`footer`/`size` slots to the primitive's equivalents. Transitively re-homes:
   - `widgets/TimelineModal` (`size="full"` → workspace intent)
   - all KPI-detail / Perspective-detail modals
8. `charts/NetWorthChartModal` (inline twin of the GlassModal recipe) → `OverlaySurface` workspace intent (`size="lg"`) — *also gains body-lock + scroll-preserve*

**F6 — converge `BriefModal` + finish parity**

9. Primitive additions (small, additive): `headerRight` slot (control opposite the title, as BriefModal has) and a per-instance material/glow override (BriefModal's documented "liquid glass" tuning).
10. `brief/BriefModal` → re-base on `OverlaySurface` using (9); keep the liquid-glass tuning as a scoped override. Transitively covers `AttentionModal` + `SinceLastVisitModal` (unchanged — they only consume BriefModal).

---

## 2. Ordered implementation plan

Each numbered step is one commit. **Additive steps land before subtractive ones.** Do not implement all in one branch/commit.

**Phase A — primitive readiness (additive, no consumer changes)**
- A1. Add `headerRight?: ReactNode` to `OverlaySurface` header row (renders left of the close button; mobile drops to its own row, mirroring BriefModal's dual-render). Default `undefined` → zero change for existing consumers.
- A2. Add an optional material override (panel `style`/`glow` passthrough) so a consumer can reproduce BriefModal's blur/opacity without editing the shared token.
- A3. Confirm the `--z-modal` / `--z-modal-nested` / `--z-toast` token scale exists in `globals.css`; if any literal target is missing, add the token (additive).

**Phase B — F1 migrations (one commit each, lowest-risk first)**
- B1. `SpacesClient` space-preview → `Dialog` (kills the `z-[200]` outlier).
- B2. `SpaceDashboard` TrashDrawer → `Dialog`.
- B3. `SpaceDashboard` Add-Goal → `FormModal` (+ backdrop close).
- B4. `InvestmentsClient` activity modal → `FormModal` (+ backdrop close).
- B5. `DebtClient` transaction modal → `FormModal`.
- B6. `AssetDrawer` → preset + rename export/usages.

**Phase C — F2 shell convergence**
- C1. `charts/NetWorthChartModal` → `OverlaySurface` workspace (independent inline copy; migrate before touching the shell).
- C2. Re-base `widgets/GlassModal` on `OverlaySurface` (keep its public prop shape so `TimelineModal` + detail modals need no edits), OR migrate each consumer and retire the shell. **Verify each consumer renders identically before removing the shell.**

**Phase D — F6 BriefModal convergence**
- D1. Re-base `BriefModal` on `OverlaySurface` using A1/A2; preserve portal, ESC, body-lock, dual header render; `max-h-85vh` → `dvh`; drop `z-[9999]` onto the token; **add the Tab focus-trap it lacks** (comes free from the primitive).
- D2. Smoke-test `AttentionModal` + `SinceLastVisitModal` (no code change expected).

**Phase E — subtractive cleanup (only after B–D verified)**
- E1. Delete now-dead shells / inline recipes and any orphaned `fixed inset-0` scaffolding.
- E2. Grep for stray overlay z-index literals in the touched files; confirm all on tokens.

---

## 3. Impact map

| Area | Touched | Risk | Notes |
|---|---|---|---|
| `components/atlas/OverlaySurface.tsx` | A1, A2 | Med | Shared primitive — additive props only, defaults preserve current behaviour. Highest blast radius; land + verify first. |
| `components/dashboard/DebtClient.tsx`, `InvestmentsClient.tsx`, `SpacesClient.tsx`, `SpaceDashboard.tsx`, `AssetDrawer.tsx` | B1–B6 | Low | Self-contained per file; behaviour *improves* (Esc/trap/lock/portal gained). |
| `components/charts/NetWorthChartModal.tsx` | C1 | Low | Standalone consumer; no shared deps. |
| `components/dashboard/widgets/GlassModal.tsx`, `TimelineModal.tsx`, KPI/Perspective detail modals | C2 | **High** | Shell used by several detail modals — regressions fan out. Prefer re-base-in-place (stable prop shape) over consumer-by-consumer rewrite. |
| `components/brief/BriefModal.tsx` (+ Attention/SinceLastVisit) | D1–D2 | Med | Bespoke glass + headerRight; depends on A1/A2 landing correctly. |
| `app/globals.css` | A3, E2 | Low | Token additions only. |
| Unrelated UI, schema, API, Prisma | — | — | **Not touched.** Pure client/UI convergence. |

**Explicitly not in scope:** `HoldingsDonutChart` popup, all `admin/security` modals, `ProviderDiagnosticsDrawer`, `AccountModal` nested chart overlay, `AdviceBanner`, `DebtPayoffSection`, and all anchored popovers/menus (F3/F4/F5 + popover doctrine).

---

## 4. Rollback plan

- **Per-commit revert:** every step is one commit against one surface (except the two shared-primitive commits A1/A2 and the shell commit C2). Any single migration reverts cleanly without affecting the others.
- **Primitive guard:** A1/A2 are additive with behaviour-preserving defaults — reverting them is safe even after B–D land *as long as* no migrated consumer passes the new props; sequence so `headerRight`/material-override consumers (D1) revert together with A1/A2 if needed.
- **Shell guard (C2):** keep `GlassModal`'s public prop signature identical while re-basing, so a revert of C2 restores the old shell with zero consumer edits. Do **not** delete the shell (E1) until C2 is verified in all consumers.
- **Subtractive last:** Phase E is gated on B–D passing validation, so a rollback before E is a pure code revert with no dead references.
- **Tag before start:** cut a checkpoint tag on `feature/v2.5-spaces-completion` before A1 so the whole family can be unwound in one move.

---

## 5. Validation checklist

Run per migrated surface, then once for the whole family:

**Build / static**
- [ ] `npx tsc --noEmit` — clean (no schema/Prisma step; this family touches no schema).
- [ ] `npm run lint` — clean.

**Per-surface behavioural (the twelve audit criteria)**
- [ ] Opens **centered on desktop**, correct **mobile presentation** (sheet vs full-screen per intent).
- [ ] **Portal** — inspect DOM: panel is a child of `document.body`, not the invoking card.
- [ ] **Body lock + page-scroll preservation** — scroll the page, open, close: no jump-to-top.
- [ ] **Focus trap** — Tab/Shift+Tab cycle within the panel; focus returns to trigger on close.
- [ ] **Escape** closes (and is correctly *blocked* on the guarded flows).
- [ ] **Backdrop** click closes where intended (now including InvestmentsClient + Add-Goal).
- [ ] **Scroll correctness** — force tall content; body scrolls, header/footer pinned, no clip.
- [ ] **Z-index** — from token; nested cases (e.g. Add Wallet inside Create Space) still stack right; `z-[200]` / `z-[9999]` outliers gone.

**Family-level regression**
- [ ] `TimelineModal` + every KPI/Perspective detail modal render pixel-equivalent to pre-migration (screenshot diff) before the shell is deleted.
- [ ] `BriefModal` retains its liquid-glass look and header filter placement; `AttentionModal` + `SinceLastVisitModal` unaffected.
- [ ] Grep: no remaining hand-rolled `fixed inset-0` overlay scaffolding in the touched files.
- [ ] **Verification step:** targeted UI pass on desktop + mobile widths for all nine migrated surfaces; spot-check `prefers-reduced-motion` (no positional movement).

---

## 6. Deliverable sequencing

Per project working style: **this checklist is the deliverable. No schema/API/UI/application code is edited yet.** On approval, implement **Phase A first, in isolation**, validate, then proceed one commit at a time through B → C → D → E — pausing for review after the two high-blast-radius commits (A1/A2 primitive props, C2 shell re-base).

*End of checklist. No code was modified.*
