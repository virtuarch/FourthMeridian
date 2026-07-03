# STATUS.md Reconciliation Plan

**Type:** Investigation / plan only. No files modified. STATUS.md **not** edited.
**Date:** 2026-07-03
**HEAD:** `37f96f3 fix(ai): create missing space agents`
**Branch:** `feature/v2.5-spaces-completion`  ·  **Latest tag:** `v2.4.5` (merge commit `6b517fa`)
**Purpose:** Give the author an exact, apply-ready diff plan to bring STATUS.md back in sync with the code, before any edit is made.

---

## 0. Summary of drift

Since STATUS.md was last verified (against `e17c699`), **13 commits** landed plus a large working tree. STATUS.md's own governance rule ("any behavior-changing PR updates this file") lapsed during the design sprint. Net state:

- **§2 is wrong on all four version fields** — it still describes a pre-merge v2.4 world.
- **Two shipped, committed initiatives are absent from the ledger** — the Atlas Material Engine (UI-1, mislabeled "Planned") and the Perspective Engine (not present at all).
- **The v2.4.5 gate was tagged without meeting its stated exit criteria** (named test suites + observability counters never landed) — a "complete" claim that the code contradicts.
- **A whole design/experimental workstream lives only in the working tree**, including a concluded-negative Liquid experiment that added two npm deps.
- A partial reconciliation is already in flight: the working-tree STATUS.md diff **adds MC1** (§3/§4/§5) but touches nothing else.

---

## 1. Completed initiatives MISSING from STATUS.md

| Initiative | Evidence in code | Current STATUS treatment | Should be |
|---|---|---|---|
| **Perspective Engine** | `lib/perspective-engine/` (tracked): `engine.ts`/`index.ts`/`registry.ts`/`types.ts`, `lenses/{debt,liquidity}.core.ts`, 4 guard tests (`engine`/`debt`/`liquidity`/`route`), API `app/api/spaces/[id]/perspectives/route.ts`. README cites "implemented 2026-07-03". Reads only through the KD-19 visibility-enforced data layer. | **Absent** — "perspective" appears nowhere in STATUS.md | New ledger entry (propose `PE1` under a new track, or fold under AI-x). Status: **Functionally complete** (2 lenses shipped; more lenses + UI surfacing remain) |
| **Atlas Material Engine / design foundation** | Committed: `feat(atlas): add material engine depth tokens`, `wire GlassPanel to material depth filters`, `add Fresnel edge and depth bloom`, overlay primitives, M/C/H migration series; `lib/atlas/palette-ratchet.*` (tracked, with test + baseline); per-depth `--glass-filter-*` in `globals.css` | **UI-1 = "Planned"** in §3 "Other" | Upgrade UI-1 to **Active / In progress**; add evidence + phase state (1A landed, 1B deferred, adoption partial) |
| **AiAgent auto-creation fix** | `37f96f3` — `app/api/spaces/route.ts`, `app/api/brief/route.ts`, `prisma/seed.ts` now create missing Space agents | Not noted anywhere | One-line note under **D4** (agentScope/AiAgent) and/or a closed KD entry |
| **MC1 Multi-Currency** | Charter + investigation docs (untracked); no code | Already being added in the **working-tree STATUS diff** (§3 MC-x block, §4 namespace, §5 roadmap block) | Keep the in-flight addition — it is correct. Confirm it lands |

---

## 2. Initiatives marked complete/closed that are actually INCOMPLETE

| Claim in STATUS | Reality in code | Reconciliation |
|---|---|---|
| **§5 v2.4.5 exit criteria** list test suites ("merchant normalization, window/rollup math, follow-up heuristics") and observability counters as gate conditions; the milestone is effectively treated as passed (tag `v2.4.5` cut) | Only **14 test files** exist; none are the named merchant-normalization, window/rollup, or follow-up-heuristic suites. No fallback/sync/token **observability counters** found. The "max-50 → user-facing copy" fix is not evidenced | Do **not** silently mark v2.4.5 "complete." Either (a) mark tagged-with-residual-debt and move the missing suites/counters/copy fix to an explicit **carry-forward list**, or (b) reopen those as v2.4.5 defects. Recommend (a) |
| **§6 blocker 6** ("thin test coverage… still absent") | Still accurate — but it now co-exists with a cut v2.4.5 tag, which reads as contradiction | Keep the blocker; add a line noting the tag was cut ahead of these suites, so they are carried debt, not done |
| **§1 header** "Last verified against `e17c699`" | HEAD is `37f96f3`, 13 commits later | Update to current HEAD |
| **§2** "architecture-complete; only branch merge/closeout remains", branch `feature/phase-2-architecture` | Merge **happened** (tag `v2.4.5` = `Merge branch 'feature/phase-2-architecture'`); active branch is now `feature/v2.5-spaces-completion` | Rewrite §2 entirely (see §5 below) |

No D1–D14 ledger row is *falsely* "Complete" — the schema/migration evidence for D3/D11/D13/D14 holds. The incompleteness is at the **roadmap/gate layer**, not the decision layer.

---

## 3. Experimental workstreams living ONLY in the working tree

**Code (untracked / uncommitted):**

- **Liquid material experiment — CONCLUDED NEGATIVE, not cleaned up.** `components/atlas/LiquidButton.tsx`, `components/brief/Brief{LiquidCard,LiquidCta,OgtirthButton,OgtirthCard,ButtonRefraction,GlassLens,HeroRefractionSpike}.tsx`, `components/dashboard/SpaceHeroRefractionSpike.tsx`, `app/material-lab/`. `BriefHeroRefractionSpike` is already an inert passthrough documenting that `liquid-glass-web-react` is unsuitable. **Two npm deps** (`@ogtirth/liquid-glass-oss`, `liquid-glass-web-react`) were added for this dead-end and remain in `package.json`.
- **Atlas material adoption + Daily Brief redesign (in-progress diffs):** modified but uncommitted — `globals.css`, `components/atlas/{GlassPanel,OverlaySurface,AtlasField}.tsx`, `components/brief/{BriefHero,BriefInsight,BriefModal,BriefSinceLastVisit,BriefAttention,EarthBackground}.tsx`, `components/charts/NetWorthChartModal.tsx`, `components/dashboard/{SpaceDashboard,widgets/GlassModal}.tsx`, `components/ui/DashboardChrome.tsx`.
- **STATUS.md itself** — uncommitted MC1 addition (partial reconciliation).

**Docs (untracked — the entire paper trail is uncommitted):** ~45 files under `docs/` including the design doctrines (`ATLAS_GLASS_MATERIAL_DOCTRINE.md`, `MATERIAL_ENGINE_PHASE_1A_CHECKLIST.md`), `ATLAS_OVERLAY_AUDIT.md`, the KD-4/5/7/10/11/17 investigations, `PERSPECTIVES_INVESTIGATION.md`, `MULTI_CURRENCY_ARCHITECTURE_INVESTIGATION.md`, `DEBT_PAYMENT_ATTRIBUTION_INVESTIGATION.md`, the D2.x/MC1 initiative folders, and the prior `V2.5_STATUS_AUDIT_2026-07-03.md`.

**Filesystem residue (KD-13, still present):** six untracked Finder-duplicate dirs on disk — `lib/ai/{assemblers,context-priority,intelligence,intent,signals} 2/` and `lib/providers/plaid 2/`. STATUS §7 KD-13 claims this is "effectively resolved"; it is not.

**Scripts (untracked):** `scripts/kd17-audit-jan-other.ts`, `scripts/reset-chase-history-test.ts`.

---

## 4. Bucketing — which items belong where

### v2.4.5 (Stabilization gate — tagged, carries residual debt)
- Missing named test suites: merchant normalization, window/rollup math, follow-up/drilldown heuristics **(carry-forward debt — tag already cut)**
- Observability counters (fallback hits, sync stats, LLM tokens) **(carry-forward)**
- "Too many messages (max 50)" → user-facing copy **(carry-forward)**
- `.env.example` flag documentation: `AI_OUTPUT_VALIDATION_MODE`, `RATE_LIMIT_ENABLED`, `RATE_LIMIT_SHADOW` **(carry-forward)**
- KD-13 duplicate-dir residue (reopen — claim of resolution is false)

### v2.5a (Seam closure — essentially complete)
- WorkspaceAccountShare retirement ✅ (`e17c699`)
- KD-19 account/holdings metadata redaction ✅
- Two-user BALANCE_ONLY proof ✅
- Legacy `Account` retirement → **NOT here** (deferred to future, approval-gated)

### v2.5 (Spaces Completion + Design Foundation — Active)
- Atlas Material Engine adoption (UI-1): commit/prune the Liquid dead-end + remove its npm deps; DataCard Step B; finish material-engine primitive adoption; Daily Brief visual redesign
- **Perspective Engine** (Space-level AI surface — belongs to v2.5's "Space-level AI surfaces" scope)
- AiAgent auto-creation fix (`37f96f3`)
- Commit the untracked design/investigation docs
- D2.x Initial Sync Experience — v2.5 flagship, **not started in code**

### Future roadmap (queued / not v2.5)
- MC1 Multi-Currency (foundational, queued after D2.x)
- v2.5.5 Financial Intelligence (flowType, semantics doctrine, KD-6)
- v2.6a AI-5 Advisor · v2.6b Ambient (scheduler, AiAdvice write path — KD-14) · v3.0 Launch
- Liquid/refraction material direction → **park as rejected** (documented dead-end)
- Legacy `Account` retirement (separate approval-gated milestone)

---

## 5. Exact STATUS sections needing updates + proposed wording

### §1 — Header table
**Change** the "Last verified" row.
> | Last verified | 2026-07-03, against commit `37f96f3` (AiAgent auto-creation fix; v2.5 design-foundation in progress) |

### §2 — Current version (replace the whole table)
Proposed:
> | Architecture phase | **v2.5 — Spaces Completion + Design Foundation — IN PROGRESS.** v2.4/v2.4.5 merged and tagged; foundation closed |
> | package.json | `2.4.5` |
> | Latest tag | `v2.4.5` (merge of `feature/phase-2-architecture`, commit `6b517fa`) |
> | Active branch | `feature/v2.5-spaces-completion` (working tree **not** clean — design-foundation WIP + concluded Liquid experiment uncommitted) |
> | Baseline of record | `v2.4.5` |

Also update the §2 prose paragraph ("What does not exist yet…") only if needed — it remains broadly accurate; add that scheduled AI-advice generation is still stubbed (KD-14).

### §3 ledger — three edits
1. **Upgrade UI-1** row (currently line 92, "Planned"):
> | UI-1 | Design system (Atlas Glass) | **Active** | Overlay primitives + Material Engine Phase 1A (per-depth `--glass-filter-*`, Fresnel edge, `floating` tier) landed; modal/chrome migration (M/C/H series) landed; `lib/atlas/palette-ratchet` guard shipped. Remaining: DataCard Step B, primitive material adoption, Phase 1B unified light model, Daily Brief redesign, commit/prune Liquid experiment | `components/atlas/*`, `lib/atlas/palette-ratchet.*`, `app/globals.css`, `docs/design-system/ATLAS_GLASS_MATERIAL_DOCTRINE.md` | Complete adoption; settle single Brief card/CTA architecture |

2. **Add a new ledger entry** for the Perspective Engine (new track or AI-x member):
> | PE1 | Perspective Engine | **Functionally complete** | Deterministic, non-persistent lens layer: typed `LensResult` (verdict + headline metric + assumptions + provenance), guard-tested (determinism, no direct Prisma, visibility-enforced reads via KD-19 layer). Debt + liquidity lenses shipped; API wired | `lib/perspective-engine/`, `app/api/spaces/[id]/perspectives/route.ts` | More lenses + UI surfacing (v2.5) |

3. **Add a D4 note** (or a closed KD) for the AiAgent fix:
> D4 note: `37f96f3` closes a gap where Spaces could exist without an `AiAgent` row — `spaces`/`brief` routes and the seed now create the missing agent.

*(MC1 §3/§4/§5 additions are already in the working-tree diff and are correct — let them land.)*

### §5 roadmap — three edits
- **v2.4 heading:** change "ARCHITECTURE-COMPLETE (merge/closeout pending)" → **"MERGED & TAGGED v2.4.5 (`6b517fa`)."**
- **v2.4.5 heading:** change "**NEXT**" → **"TAGGED `v2.4.5` — with carry-forward verification debt"**, and append a Carry-forward line: *"Tagged ahead of these exit criteria: named test suites (merchant/rollup/heuristic), observability counters, max-50 copy, `.env.example` flag docs — tracked as v2.4.5 debt, not complete."*
- **v2.5 heading:** change to **"IN PROGRESS."** Add to scope the concrete design-foundation reality (Atlas Material Engine adoption, Perspective Engine, Daily Brief redesign) and note the Liquid experiment concluded negative.

### §7 known defects — one edit
- **KD-13:** reopen or downgrade the "effectively resolved" claim — six `… 2` duplicate dirs are still on disk untracked.

### §6 production readiness — one edit
- Reconcile the contradiction: blocker 6 (thin tests) is true *and* v2.4.5 is tagged. Add: *"v2.4.5 was tagged ahead of its test-suite/observability exit criteria; these remain open as carry-forward debt."*

---

## 6. Proposed completion percentages

| Track | Proposed % | Basis |
|---|---|---|
| v2.4 / v2.4.5 (gate) | **~90%** | Tagged & merged; residual test-suite + observability + copy debt |
| v2.5a (seam closure) | **~95%** | WAS retired, KD-19 done, two-user proof green; only deferred legacy-`Account` retirement remains (out of scope) |
| v2.5 — design foundation (UI-1/Atlas) | **~60%** | Primitives + Phase 1A + migrations committed; adoption, cleanup, Brief redesign, Phase 1B outstanding |
| Perspective Engine (PE1) | **~90%** | Engine + 2 lenses + API + tests shipped; more lenses + UI surfacing remain |
| D2.x Initial Sync (flagship) | **~5%** | Investigation only; no code |
| **v2.5 overall** | **~65%** | Weighted across seam-closure (done) + design foundation (mid) + flagship (not started) |
| MC1 / v2.5.5 / v2.6+ | **0%** | Approved/planned; no code |

---

## 7. Version corrections (at a glance)

| Field | STATUS.md now | Correct value |
|---|---|---|
| Architecture phase | v2.4 (merge pending) | v2.5 in progress (v2.4.5 merged) |
| package.json | 2.4.0 | **2.4.5** |
| Latest tag | v2.4.0 | **v2.4.5** (`6b517fa`) |
| Active branch | feature/phase-2-architecture | **feature/v2.5-spaces-completion** |
| Baseline of record | v2.3.0 | **v2.4.5** |
| Last verified commit | e17c699 | **37f96f3** |

## 8. Roadmap corrections (at a glance)

- v2.4 → **merged & tagged** (not "pending").
- v2.4.5 → **tagged with carry-forward debt** (not the clean gate the exit-criteria prose implies).
- v2.5 → **Active/in progress**, and its design-foundation half is real work (Atlas Material Engine, Perspective Engine, Brief redesign), not the single "UI-1 tokens" line.
- Add PE1 (Perspective Engine) to the ledger.
- Keep MC1 (already being added).
- Park the Liquid/refraction material direction as a **documented rejected** experiment.
- KD-13 reopened.

*End of plan. No files modified; STATUS.md not edited.*
