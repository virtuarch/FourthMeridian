# Fourth Meridian — Portfolio Master Plan (Re-sequencing from First Principles)

**Date:** 2026-07-06 · **Baseline:** working tree at `8abf081` (MC1 closed `38f213c`; MC1 QA Q1 committed `e0a2ced`, **Q2–Q6 in flight — 9 files uncommitted in the working tree**; TI Phase 1 committed `c4458dd`; OPS-1/TI-vs-MI/prelaunch-audit docs committed `8abf081`)
**Nature:** ARCHITECTURE & SEQUENCING RECOMMENDATION ONLY — no code, no schema, no edits to STATUS.md or any existing document. Per house rule, **STATUS.md remains the sole current-state authority**; this document becomes binding only by being ratified into STATUS §3/§5. It is a planning input, deliberately written to be ratifiable as-is.
**Method:** every claim checked against the repository at the baseline commit; speculation labeled inline.
**Revision:** **Rev B (final)** — Rev A re-reviewed as chief architect before ratification; the Event Vocabulary proposal ruled on; amendments marked **[Rev B]** inline. Rev B is the canonical version.

---

## REV B — FINAL ARCHITECTURAL REVIEW & THE EVENT VOCABULARY RULING

### R.1 Review verdict on Rev A

Re-examined from first principles, the three-lane graph, the version reconstruction, the PO1–PO4 consolidation, the L-2/L-3 fold, and the never-overlap rules all survive review unchanged — each is anchored to repository evidence rather than preference, and no new evidence contradicts them. Three findings did emerge, and they amend the plan:

**Finding 1 — the proposed "EV1 — Event Vocabulary" name is an ID collision.** `EV-1` is already allocated and **shipped**: the domain event seam (`lib/events/emit.ts`, `types.ts`, handlers — STATUS §3, v2.5 foundation table, "Complete (seam laid)"). Under the house freeze-not-renumber rule the name cannot be reused. The idea survives; the name cannot. Ruling in R.2.

**Finding 2 — the vocabulary problem is not hypothetical; the drift already exists in the repo, in three grammars.** Verified today: `lib/audit-actions.ts` mixes tenses *within itself* (`SPACE_CREATE`, `SPACE_UPDATE` — imperative — beside `SPACE_ARCHIVED`, `GOAL_CREATED` — past); `lib/events/types.ts` uses PascalCase past (`SpaceCreated`, `GoalCheckedIn`); `SyncIssueKind` uses SCREAMING_SNAKE noun phrases (`BALANCE_TX_MISMATCH`). And duplicate semantics across vocabularies is already live: `GOAL_CREATED`/`GoalCreated`, `GOAL_CHECKED_IN`/`GoalCheckedIn`, `SPACE_CREATE`/`SpaceCreated` — EV-1's own header acknowledges a `type→AuditAction` mapping to bridge the fork. A fourth vocabulary (telemetry kinds, PO1) is about to be born. The proposal is therefore not premature abstraction — it is remediation of an observed defect class, arriving at the last cheap moment.

**Finding 3 — Rev A left one ordering ambiguity the vocabulary exposes.** OPS-1 S1 (email seam, which emits delivery outcomes "from birth") can land before PO1 P1 (telemetry seam). Without a naming/ownership rule in place first, OPS-1's email events would be christened ad hoc — the exact birth defect the vocabulary exists to prevent. Fixed by the placement ruling below.

### R.2 Ruling: the Event Vocabulary exists — as **PO1 Phase 0**, not a standalone initiative

**Should it exist? Yes** (Finding 2). **Standalone? No.** It has no independent cutover, no independent rollback semantics, and no value except through its consumers — it is a substrate slice by the plan's own definitions, and a standalone initiative would burn a WIP slot (limit: 2) on a types-and-doctrine module. **Placement: PO1 P0 — "Event Grammar & Registry,"** landing immediately after MC1 QA, in parallel with OPS-1 S0/S1, so every subsequently-born event (OPS-1 email outcomes included) is canonical from its first emission. If a ledger alias is wanted for discoverability, allocate **EV-2** in the de facto EV-x track pointing at PO1 P0 via the §4 alias table — the mechanism built for exactly this.

**Scope (one slice, zero runtime behavior):**

1. **One grammar, forward-only:** cross-system event identifiers are `DOMAIN_OBJECT_EVENT` in past-tense SCREAMING_SNAKE (`USER_REGISTERED`, `EMAIL_SENT`, `SYNC_COMPLETED`, `AI_REQUEST_COMPLETED`) — the majority grammar of the existing audit registry, made law. Typed PascalCase unions (EV-1 style) remain the *in-code representation* with a mandatory 1:1 registry mapping; they are a syntax, not a second vocabulary.
2. **One registry entry per event:** canonical id · single producer · payload contract (typed) · one-line semantic meaning · lifecycle status. The lifecycle states already exist in the codebase's own idiom — EV-1's `PROVISIONAL`/`EXERCISED` markers — extend with `DEPRECATED`. This is `lib/audit-actions.ts`'s registry pattern generalized, not an invention.
3. **Grandfather, never rename:** existing audit action strings are historical data in an append-only table — renaming constants would fork query history (pre-rename rows unreachable by the new name), violating the same history-immutability doctrine as FxRate and snapshots. Legacy names are registered as-is, marked `LEGACY_GRAMMAR`, and die only by natural deprecation. **No opportunistic refactor of `lib/audit-actions.ts` or `lib/events/types.ts` is authorized by this slice.**
4. **Source-of-record assignment kills cross-vocabulary duplication:** each real-world fact gets exactly one recording vocabulary — *audit records* (security/accountability), *domain events trigger* (in-process consequences), *telemetry counts* (operational aggregates) — and any second vocabulary needing that fact **references the canonical id** rather than coining its own. This resolves Finding 3 mechanically: `EMAIL_SENT` is coined once in the registry; OPS-1's audit path and PO1's telemetry path both cite it.
5. **Seeded lazily, grown by producers:** the registry ships containing only events whose producers are being instrumented in the current window (OPS-1 email/auth, PO1's four chokepoints). A speculative platform-wide taxonomy is explicitly out of scope — the ProviderAdapter lesson (STATUS §8: generalization before a second consumer is speculation) applies to nouns as much as to interfaces.

**Validation gate:** registry module type-checks; grammar doctrine documented in the module header; a lint-style check (grep-grade is fine) that new emission sites reference registry ids; zero runtime diff — the slice is provably behavior-neutral because nothing executes.

### R.3 Amendments to the plan (all marked [Rev B] at their sites)

1. Part 9 runway: **PO1 P0 inserted at position ③**, parallel with OPS-1 S0/S1 (Finding 3).
2. Part 9 runway: **L-2 (landing) and L-3 S1 (request-capture only) may ship as early as the floor's first slices** — collecting beta demand is harmless ahead of the floor (a rate-limited form + table), while *invites* remain hard-gated on OPS-1 blockers B1–B10. The market lane starts warming the funnel months earlier at zero risk. *(Review self-correction: Rev A over-serialized the market lane.)*
3. Part 6: the vocabulary ownership ruling added; EV-x formally proposed for the §4 prefix list at ratification (it is a de facto track already).
4. Alias table entry at ratification: *"EV1 — Event Vocabulary" (2026-07-06 proposal) → PO1 P0 (optional ledger alias EV-2).*

Everything else in Rev A stands. The rest of this document is Rev A's text with [Rev B] amendments applied at the affected lines only.

---

## PART 1 — CURRENT STATE (the architecture, not the ledger)

### 1.1 Foundations that now exist (verified)

The platform has finished its **data-semantics foundations**: tenancy with graduated visibility enforced by one predicate family (`lib/ai/visibility.ts` + KD-1/15/19 closures); money with row-level currency provenance, an immutable FX archive, read-time conversion, and stamped never-rewritten snapshots (MC1, all phases); transaction flow as a single semantic authority (`classifyFlow`, P5 closed); centralized Space authorization (`lib/spaces/policy.ts`); a hardened sync engine with an integrity gate (`SyncIssue`); HKDF encryption with zero legacy ciphertexts; a live-enforcing AI output validator; a test runner + CI (D-TEST). **TI Phase 1 just added the last missing read primitive: a canonical single-row serializer and the product's first per-row endpoint (`GET /api/transactions/[id]`), retiring the four-way DTO copy-paste** (980-line commit, golden-tested byte-identical list output — the KD-10 "one definition site" doctrine applied to DTOs).

### 1.2 What is genuinely complete vs claimed complete

Complete and verified: MC1 (0–4 + closeout), FlowType (P1–P5), D2.x, DB1/LC1, SP-2, D-TEST, KD-1/2/3/4/5/7/10/11/15/17/18 fixes, TI Phase 1. **In flight and blocking:** MC1 QA Q2–Q6 — the uncommitted 9-file working tree (`DashboardClient`, `DebtClient`, debt lenses, KPI cards) is the single most dangerous object in the repo right now: it is exactly the "uncommitted design-foundation working tree" failure mode KD-13 already documented once. Nothing new should start until it commits or reverts.

### 1.3 Debt, by kind

**Technical:** Float money under the MC1 precision doctrine (Decimal migration still parked — every new golden baseline raises its cost); dual account models with 3 legacy-`Account` read sites (unmet v2.5 exit criterion — note: TI P1 touched `app/api/accounts/[id]/transactions` but the legacy-read status of that site needs re-verification at v2.5 exit **[speculation until checked]**); the 51-row category↔flow value desync + 650 input-stale rows (scoped, runbook written, unapplied — a named MI entry gate); three merchant normalizers; the 16-value category enum collapsing six PFC primaries to `Other`; `FLOW_COST` triplication; 2,164-line chat route and 2,538-line `SpaceDashboard` monoliths (decomposition "not yet started" per STATUS).

**Operational:** everything the OPS-1/PO investigations catalogued — no email, no deletion/export, no monitoring, no job ledger (`startScheduler()` never invoked; `sync-crypto.ts` = `export {}`), rate limiting off by default, sessions "informational" by the schema's own admission, no security headers, no legal surface, cron budget exhausted at 2 Hobby slots, secrets in a cloud-synced folder.

**Product:** no external user has ever touched the system; no transaction detail surface (TI P2); no correction loop (MI M5); no landing page (`/` redirects into the app); no beta mechanics; the README still sells "local-first" while prod is Vercel+Supabase.

**The architectural reading:** the product's *data plane* is finished to a standard most funded teams never reach, while its *operational plane* and *market plane* are near-zero. The portfolio question is therefore not "which intelligence next" but **how fast the two empty planes reach the minimum bar while the data plane's momentum (TI/MI) is kept warm at low cost.**

---

## PART 2 — INITIATIVE INVENTORY

| Initiative | Purpose | Depends on | Consumers | Arch. value | Risk if delayed | Risk if premature | Reuse | 10-yr importance |
|---|---|---|---|---|---|---|---|---|
| **MC1 QA** (Q2–Q6) | Fix mislabeled currency displays; zero value changes | MC1 (done) | Every mixed-currency surface | Closes MC1 honestly | Uncommitted tree rots; blocks everything (dirty-tree rule) | n/a — already open | — | Low (cleanup) |
| **TI** (P2–P4: detail overlay, provenance display, AI actions) | The canonical per-row inspection surface; where trust is rendered | TI P1 ✅; MC1 QA (shared components) | MI M5, receipts, audit display, AI explanations, `?tx=` deep links | High — first per-row read surface; every future intelligence renders into it | Low — product depth for zero users | Low — read-only, zero schema by charter | Very high (the surface) | High |
| **MI** (M0–M6: categorySource, enum expansion, Merchant/Alias/Rule, overrides, read cutover) | Merchant identity spine + category provenance + correction loop | Desync remediation (entry gate); M5 wants TI P2 as host | AI rollups, cadence/budget/subscription futures, Ambient | High — deepest data primitive left | Medium — category quality caps AI quality | **Medium-high** — M5 without TI's detail surface = rework (the one proven rework path, per the 2026-07-06 TI-vs-MI investigation) | Very high (identity spine) | Very high |
| **OPS-1** (floor: email→reset→verification→rate-on→headers→monitoring→export/delete→legal→beta gate) | Minimum operational floor before any external user | Nothing (root) | LP-1, BETA-1, PO-track alerting, every future user | Critical-path | **Highest in portfolio** — every week of delay is a week beta cannot open | None — it is overdue | High (email/token/flag seams) | High |
| **PO1** (telemetry seam + chokepoint emissions) | Capture what cannot be reconstructed (tokens, outcomes, durations) | None technically; OPS-1 S6 (Sentry) adjacent | PF1, POR1, POS1, v2.6b exit gates | High — irreversibility makes it urgent | **Irreversible data loss daily** (LLM cost history discarded at the provider boundary today) | Low — additive, zero readers by design | Very high | Very high |
| **PF1** (job substrate: run ledger + dispatcher + fact streams) | Every scheduled unit leaves a corpse; cron ceiling solved once | PO1 (emission shape); OPS-1 S6 helpful | POR1, v2.6b scheduler needs (D5/KD-14), purge-trash truth | High | Medium — silent cron death undetectable until it bites | Low | Very high | Very high |
| **POR1** (rollups + analytics read layer) | Frozen daily platform facts; one definition site per metric | PO1+PF1 (raws must exist) | POS1, v2.6b exit certification, pricing model | High | Low pre-beta; high post-beta | **Medium — rollups before raws = vanity metrics with no provenance** | High | High |
| **POS1** (ops console panels, alerting, ops intelligence, D12 flip) | Operations as surfaces + levers | POR1; OPS-1 email (alert delivery) | The operator; eventually employees | Medium now | Low — hand-run queries suffice at 20 users | **High — panels before questions = navel-gazing (audit risk §9)** | Medium | High (flip is post-launch) |
| **LP-1** (landing/marketing surface) | Public face; converts curiosity → beta requests | OPS-1 legal pages (links), BETA-1 form target | BETA-1 funnel | Low arch. / high market | Beta can't recruit strangers without it | Low — static pages | Low | Medium |
| **BETA-1** (request→approve→invite→cohorts) | First contact machinery | OPS-1 S1/S3/S10 (email, verification, gate substrate) | The entire company thesis | Medium arch. / **highest information value in portfolio** | Every internal-polish month is unpriced assumption risk | Only prematurity: opening before OPS-1 blockers B1–B10 | Medium | High (the funnel outlives beta) |
| **AI-5 / Advisor** (v2.6a, charter exists) | Conversation coherence | v2.5 seams; KD-16 scope | v2.6b (hard gate) | High | Medium | Medium — building on the unsplit 2,164-line chat route multiplies its cost **[architectural note, not in its charter]** | High | High |
| **Ambient** (v2.6b) | Scheduled intelligence; speaks unprompted | AI-5 (STATUS entry criterion) + **PF1/POR1 de facto** — its exit criteria ("one week of briefs, zero validator failures, bounded audit growth") are literally POR1 queries | Users | High | Low | **High — the roadmap's own gate ("may not speak unprompted until…") says so** | High | Very high |
| **Decimal/cents migration** (parked, unnamed track) | Retire Float money | A quiet schema window; golden-baseline regeneration plan | Everything numeric | Very high | **Compounds daily** — each golden check pins f64 | High if collided with any open seam — exclusive-lock initiative | n/a | **Decade-critical** |

---

## PART 3 — THE REAL DEPENDENCY GRAPH

The linear chain in the prompt (MC1→QA→OPS-1→PO1→PF1→POR1→POS1→Ambient) is wrong in one important way: **it serializes three planes that are structurally parallel.** The real graph has three lanes joined at two events:

```
LANE A (product/data)        LANE B (operational)         LANE C (market)
─────────────────────        ─────────────────────        ──────────────────
MC1 ✅ → MC1 QA (Q2–Q6)      OPS-1 (root; no deps)        LP-1 (needs OPS-1
        │                        │        │                legal pages only)
Desync remediation           PO1 ◄────────┘                    │
(51 rows; MI entry gate)     (telemetry — may start           BETA-1
        │                     with late OPS-1)                (needs OPS-1
TI P2–P3 ∥ MI M0–M4              │                            S1/S3/S10 + LP-1)
(bounded parallel:           PF1 (jobs/facts)                  │
 TI=read, MI=schema)             │                             │
        │                    POR1 (rollups/read)               │
TI P4 ⇄ MI M5 ───────┐           │                             │
(the designed join:  │       POS1 (demand-pulled               │
 correction loop     │        panels + alerting)               │
 ships INTO detail)  │           │                             │
        │            │           │                             │
        ▼            ▼           ▼                             ▼
   ══════ EVENT 1: PRIVATE BETA OPENS ══════════════════════════
   gate = OPS-1 blockers B1–B10 + PO1 capturing + PF1 S1 (ledger)
   NOT gated on: TI P4, MI M5–M6, POR1, any AI version
                         │
              AI-5 (v2.6a) — unchanged
                         │
   ══════ EVENT 2: AMBIENT ELIGIBLE (v2.6b entry) ═══════════════
   gate = AI-5 exit + POR1 live (exit-criteria measurement rig)
                         │
              Ambient (v2.6b) → v3.0 Launch (L-1)
                         │
              POS1 D12 flip — post-launch, gated on headcount
```

Load-bearing edges, with evidence: **MC1 QA blocks all lanes** (dirty working tree; house rule). **Desync remediation → MI** (named entry gate, `FLOWTYPE_CATEGORY_REWRITE_DESYNC_INVESTIGATION`). **TI⇄MI converge at M5-into-detail** (the 2026-07-06 investigation's verdict C — endorsed; it found the file sets nearly disjoint and identified M5-without-TI as the only concrete rework in either direction). **PO1 has no true dependency on OPS-1** — telemetry capture must not wait for identity work (irreversibility); only alert *delivery* needs email. **POR1 → Ambient** is the edge nobody has written into STATUS yet: v2.6b's exit criteria are unmeasurable without rollups — Ambient cannot certify its own completion without the PO-track. **Beta does not depend on TI/MI/POR1 at all** — the floor, not the intelligence, gates first contact.

---

## PART 4 — MAJOR VERSIONS (reconstructed, each with an architectural objective)

Existing labels are kept (freeze-not-renumber culture); one point milestone is inserted. Versions close in order; initiatives within them may interleave per Part 9's parallel rules.

| Version | Architectural objective (one sentence) | Contents | Exit criteria (headline) |
|---|---|---|---|
| **v2.5** (close it now) | Every read path speaks the canonical models | MC1 QA Q2–Q6 · commit/revert the working tree · 3 legacy-`Account` read sites retired · (already-landed: SP-2, EV-1, D2.x, DB1, MC1, FlowType, TI P1) | Existing STATUS v2.5 exits met — the legacy-read criterion is the one still open |
| **v2.5.5 — Financial Semantics** (already allocated) | One truthful semantic layer over transactions: identity, category provenance, correction | Desync remediation → TI P2–P4 ∥ MI M0–M6 (bounded parallel, TI-vs-MI investigation's boundary) · semantics doctrine tests · metadata-depth decision | Correction loop live in the detail surface; categorySource on every write path; zero new surface beyond detail+correction |
| **v2.5.7 — Operational Foundation** *(new point milestone)* | The platform becomes operable, observable, and externally touchable | OPS-1 (all blockers) · PO1 · PF1 · LP-1 · BETA-1 substrate | **EVENT: private beta opens.** A stranger can be invited, verified, rate-limited, monitored, exported, deleted — and telemetry has been capturing since before their first request |
| **v2.6a — Advisor Intelligence** (unchanged) | Conversations become coherent | AI-5 charter · KD-8/KD-16 · *recommended entry addition:* chat-route decomposition as Slice 0 **[recommendation, not in the AI-5 charter]** | STATUS v2.6a exits unchanged |
| **v2.6b — Ambient Intelligence** (unchanged + one new entry criterion) | The system earns the right to speak unprompted — and can prove it | STATUS v2.6b scope + **POR1 as entry criterion** (the measurement rig) · POS1 alerting slice · KD-9/12/14 close | STATUS v2.6b exits, now mechanically certifiable via rollups |
| **v3.0 — Launch (L-1)** (unchanged) | A stranger can pay and be supported | Billing (D10 lifts) · Plaid production · counsel-reviewed legal · POS1 launch-subset panels (health/security/costs) · **Decimal migration executes in this window's quiet start, before billing lands** **[re-sequencing recommendation: STATUS parks it "post-v2.6b" — schedule it, don't re-park it]** | STATUS v3.0 exit + zero new surface |
| **post-3.0** | Fourth Meridian operates Fourth Meridian | POS1 D12 flip (gated on headcount condition) · provider expansion by demand · marketplace stays parked | — |

---

## PART 5 — INITIATIVE DESIGN (MC1 doctrine, generalized)

Every initiative above is already designed, or is hereby required to be designed, to this template — **the MC1 lifecycle as company standard:**

1. **Investigation** (immutable doc, `docs/investigations/` or the initiative folder): current-state inventory with file:line evidence; the "cannot be reconstructed later" list; rejected alternatives recorded.
2. **Charter/Plan** (initiative folder): phases → slices; each slice states *one responsibility, one seam, one cutover, one validation gate, one rollback*; behavior-neutral substrate slices precede every cutover slice; deferred scope is *named* with its owner track (the D2.x "scope boundary" pattern).
3. **Implementation** by approved slice only, each slice: additive-first → grep/test-proven neutral → cutover → gate green (`tsc`/lint/`npm test` minimum, plus slice-specific proofs) → commit with the naming convention (Part 7).
4. **Closeout report**: guarantees re-proven at closeout (MC1's "full-initiative guarantees re-proven" pattern), residual ledger with named owners, STATUS ledger row updated in the same PR.

Per-initiative notes where the template needs teeth: **TI** — charter already forbids schema; keep it absolute (any TI slice proposing a column is an MI slice mislabeled). **MI** — sole owner of transaction-domain schema during its window; every category writer it touches must stamp `categorySource` from birth (the FlowType writer-stamping lesson). **OPS-1** — slices are independently shippable *and the blocker list is the closeout gate*, not slice completion. **PO1/PF1/POR1** — zero-readers doctrine per layer: PO1 ships with no consumers, PF1's ledger with no dashboard, POR1's rollups with recompute-verification before any panel reads them (the FxRate `--verify` idiom). **POS1** — demand-pulled: a panel may not be built until its underlying query has been hand-run three times (anti-navel-gazing gate, from the PO investigation §9). **AI-5** — add Slice 0 = extract the chat route's intent/window/serializer stages into `lib/ai/` modules with characterization tests *before* building conversation state on top; the KD-11/KD-16 defect class lives in that file's size.

---

## PART 6 — INITIATIVE OWNERSHIP (merge / split / demote decisions)

**Endorse as standalone:** OPS-1 (root, cross-cutting), TI, MI (the investigation's disjoint-file-set finding justifies two tracks), AI-5, Ambient, L-1.

**Demote to phases of one track — PO1/PF1/POR1/POS1 should NOT be four track prefixes.** The house namespace rule (STATUS §4) is *track prefix + number*: prefixes denote domains, numbers denote initiatives. Four prefixes for one domain (platform operations) recreates the flat-namespace collision problem the rule was written to kill. **Recommendation: one `PO-x` track** — PO1 = Telemetry (emission seam + chokepoint instrumentation), PO2 = Facts & Jobs (run ledger, dispatcher, fact streams — the "PF1" scope), PO3 = Rollups & Read Layer ("POR1"), PO4 = Operations Surface ("POS1": alerting → panels → ops intelligence → D12 flip as its phases). Same content, correct naming physics: each is separately chartered, tagged, closable — but the track reads as one architectural arc, exactly like MC1's phases did. *(If the four names are already emotionally load-bearing, keep them as aliases in the §4 alias table — the mechanism exists for exactly this.)*

**Fold into the L-track:** LP-1 and BETA-1 are not architecture initiatives — they are launch operations. `L-x` already exists (L-1 = launch readiness). **Recommendation: LP-1 → L-2 (Landing Surface), BETA-1 → L-3 (First Contact).** They get the full doctrine treatment (slices, gates) but live where launch work lives; this also keeps the D10-adjacent discipline (no billing, no marketing sprawl) under one track's eye.

**Split:** nothing currently chartered needs splitting — but two future splits are pre-registered: POS1's D12 flip is its own gated phase (never merged into panel work), and the Decimal migration must be its own exclusive-lock initiative (recommend allocating it now as `DB2` in the existing DB-x hygiene track, so it stops being an unnumbered parked idea and starts appearing in sequencing decisions — visibility is the first step to it actually happening).

**Merge:** none. The one tempting merge — OPS-1 + PO1 ("both operational") — is wrong: OPS-1 is user-facing floor (email, deletion, legal), PO1 is internal capture; different seams, different gates, different rollback semantics.

**[Rev B] Vocabulary ownership:** the Event Grammar & Registry is **PO1 P0**, not a standalone initiative and not "EV1" (ID collision with the shipped EV-1 domain event seam — see Rev B §R.1/R.2). Optional ledger alias EV-2; `EV-x` should be formally added to the STATUS §4 prefix list at ratification, since EV-1 already made it a de facto track.

---

## PART 7 — PROGRAM MANAGEMENT (the portfolio operating model)

**Roles:** you own the roadmap — ratify charters, approve slices, cut versions. Claude executes approved slices and produces investigations/closeouts. The unit of delegation is **the slice, never the initiative** — every slice arrives as a paste-ready implementation prompt with scope, constraints, and gates (the convention already working: MC1 QA §4's Q1 prompt, OPS-1 §6).

**Numbering (three levels, already half-adopted — formalize):**
- *Track prefix* — allocated only in STATUS §4, folder reserved at allocation: `D, AI, UI, L, MC, PE, DB, TI, MI, PO` (TI and MI need §4 allocation — they're in commit messages but not the alias table yet).
- *Initiative* — prefix+integer (MC1, PO2, L-3). Frozen forever once allocated; aliases table absorbs renames.
- *Phase / slice* — `P<n>` phases, `S<n>` slices within (QA phases use `Q<n>`, the MC1 QA precedent). Full address: `PO2 P1 S3`.

**Commit convention:** `<INIT> P<n> S<n>: <imperative summary>` (exactly what `c4458dd` "TI Phase 1: …" and `348b6f2` "MC1 Phase 3 Slices 2-6: …" already do — write it down so it survives). Docs-only commits: `docs:` prefix (current practice). One slice = one commit wherever possible; a slice that can't land in one commit is usually two slices.

**Branch strategy:** keep the current model — one long-lived version branch (`feature/v2.5-spaces-completion` pattern) receiving slice commits; cut and tag at version exit; short-lived branches only for exclusive-lock work (DB-x migrations, DB2/Decimal) where a revert must be surgical. **Add one rule the working tree currently violates: no initiative starts while the tree is dirty.** Multi-slice work-in-progress belongs in commits, not in an uncommitted pile — Q2–Q6 today is the cautionary example.

**Version tagging:** tags at version exits only (`v2.5`, `v2.5.5`, …); initiatives close via closeout report + STATUS row, not tags. Never tag ahead of exit criteria again — the v2.4.5 "tagged with carry-forward debt" episode is the anti-pattern, and STATUS itself flagged it.

**Documentation structure (with a hard budget — the 283-doc weight is a named risk):** per initiative, exactly three durable documents — investigation, charter/plan, closeout. Working notes live in the PR description, not new files. Investigations that reject a direction are filed once and never rewritten (immutability discipline already in place). STATUS.md stays the only living status document; **add a §12 "Portfolio runway"** — the next three approved initiatives in order, so sequencing decisions are visible without re-litigating.

**Status tracking cadence:** the existing maintenance rule (every behavior-changing PR updates STATUS or says why) extends to: every *closeout* updates the ledger row, the defect register, and the runway in the same PR. **WIP limit: 2 active initiatives, at most one owning schema** (Part 9 rule 4) — enforced by the runway section refusing a third Active row.

**Closeout/investigation report standards:** closeouts re-prove initiative-level guarantees (not just slice gates) and end with a residual ledger where every residual has an owner track — the MC1 closeout is the canonical example; investigations open with baseline commit, sources, and labeled assumptions — the TI-vs-MI investigation is the canonical example. Both exist; canonize them by reference.

---

## PART 8 — LONG-TERM ARCHITECTURE (the five-year projection)

Assume it works: employees operate inside Fourth Meridian, customers pay, the company's own finances run in a BUSINESS Space (the D12 parked-note already prescribes this dogfooding). What today's sequencing must protect:

1. **The boundary survives success.** The single most valuable architectural asset in five years is the same one today: no privileged path into customer tenancy. Every ops capability built between now and then must pass the "structurally incapable of reading product content" test (PO-track doctrine), because the day there are employees, the threat model becomes *insider with a dashboard* — and the defense must already be in the schema, not in vigilance.
2. **Facts outlive features.** Append-only dated facts (AuditLog, FxRate, SyncIssue, snapshots, telemetry, job ledger) plus frozen rollups are the substrate that survives every UI rewrite, every framework migration, and eventually becomes compliance evidence (SOC 2 evidence collection is a query over exactly these tables). Today's cheapest decision with five-year consequences: PO1 capture starts before the first external user, so the company's entire operating history exists from customer #1.
3. **Money must be exact before money is revenue.** Float survives 20 beta users; it must not survive billing. The Decimal migration (DB2) executing at v3.0's quiet start — before the billing tables land — is the last cheap moment in the product's life for that migration. **[speculation on effort, not on direction: the direction is already conceded by the parked-ideas row.]**
4. **The AI ladder's discipline is the durable brand.** honest answers → coherent conversations → earned ambience → (only then) autonomy, with the validator as the permanent floor. In five years the products that survive the agent-hype cycle will be the ones that can *prove* restraint; the ladder is that proof, and no sequencing decision should let a surface skip a rung.
5. **Enterprise is a decision, not a drift.** Nothing in this roadmap builds SSO, org hierarchies, or residency. That is deliberate: the identity/tenancy assumptions those require are rebuild-grade, and the consumer wedge (multi-currency households, shared Spaces) doesn't need them. The five-year fork — stay prosumer vs go B2B — should be decided by beta evidence (POR1's cohort data), not by architecture accreting toward whoever asked loudest.

---

## PART 9 — EXECUTIVE RECOMMENDATION

**1. Initiative ordering (the runway) [Rev B — amended]:**
① MC1 QA Q2–Q6 — *commit or revert the working tree; nothing else moves first* → ② Desync remediation (51 rows; small, runbook exists; unblocks MI) → ③ **PO1 P0 (Event Grammar & Registry — types + doctrine, zero runtime) ∥ OPS-1 S0/S1** so every OPS-1 emission is born canonical; **L-2 (landing) and L-3 S1 (request-capture only) may also open here** — demand collection is safe ahead of the floor; invites stay gated → ④ **OPS-1** (primary track) with **MI M0–M2 in bounded parallel** (schema-only, behavior-neutral, file-disjoint from OPS-1) → ⑤ PO1 P1+ (telemetry seam + chokepoint emissions, overlapping late OPS-1) → ⑥ TI P2–P3 ∥ MI M3–M4 → ⑦ PO2 (jobs/facts) → ⑧ MI M5 shipped INTO TI's detail surface (the designed join) + L-3 (invites/approval live) → **EVENT: private beta** → ⑨ POR1 → ⑩ AI-5 (with the Slice-0 route decomposition) → ⑪ Ambient (POR1-certified) → ⑫ v3.0 window opening with DB2/Decimal, then billing → launch.

**2. Version ordering:** v2.5 (close) → v2.5.5 (Financial Semantics) → **v2.5.7 (Operational Foundation — new)** → v2.6a → v2.6b → v3.0, as specified in Part 4. Beta is an **event gated on OPS-1 blockers B1–B10 + PO1 + PO2-S1**, not a version — it will most likely fall inside the v2.5.7 window, but if v2.5.5 runs long, beta does not wait for TI P4/MI M6 (they are not on its gate).

**3. Immediately after MC1 QA:** the desync remediation (hours, not days — it's a scoped runbook), then **OPS-1 Slice 0/1 as the primary track.** This overrides STATUS's "Next initiative: Merchant Intelligence" note — and the override has a principled basis: MI deepens the product for zero users; OPS-1 is the critical path to the first user, and MI's schema-only opening slices lose nothing by riding second-track in parallel. Feature excitement says MI; the dependency graph says OPS-1.

**4. Bounded parallel (allowed, with boundaries):** TI ∥ MI under the TI-vs-MI investigation's ownership rule (MI owns all schema/writes; TI zero schema; converge at M5) · OPS-1 ∥ MI M0–M2 (disjoint files; both additive) · PO1 ∥ late OPS-1 (different seams) · L-2 landing ∥ anything (static, out-of-app) · POS1 panels ∥ v2.6 work (demand-pulled, read-layer-only).

**5. Never overlap:** any two schema-owning initiatives on the same domain (MI is sole owner of transaction-domain schema in its window — TI's charter enforces the other half) · DB-x physical migrations with *anything* (DB1 precedent: exclusive, hand-authored, metadata-only) · **DB2/Decimal with any open seam whatsoever** — it is the portfolio's one full-stop initiative · MC1 QA with TI P2 (both touch dashboard display components — the current dirty tree is the live demonstration) · Ambient with an uncertified POR1 (it would be shipping unprompted speech without its measurement rig — the exact failure STATUS's gate exists to prevent).

**6. The complete roadmap** is Parts 3–4 read together: three lanes, two events, six versions, with the PO-track renamed PO1–PO4 and LP/BETA folded into L-2/L-3 per Part 6.

**7. The reusable management model** is Part 7: slice-level delegation via paste-ready prompts, three-level numbering under STATUS §4's existing rule, one-commit-one-slice, version-exit tagging only, three-document initiative budget, WIP limit 2 with one schema owner, dirty-tree rule, and closeout/investigation canon by reference to MC1 and TI-vs-MI. Nothing in it is new invention — it is the MC1 practice, written down and bounded so it costs less than it earns.

**The one-paragraph verdict:** the data plane won its race; stop feeding it first. Finish the QA tree, remediate the 51 rows, then put the portfolio's primary lane on the operational floor while merchant/transaction intelligence advances on the second track in schema-safe slices — and let the private beta open on the floor's gates, not on the intelligence roadmap's. Every initiative in flight today already follows the MC1 doctrine; the only thing this plan changes is *which lane is allowed to be the reason the calendar moves.*

---

*Evidence base: git log `348b6f2..8abf081` + working-tree status; `docs/investigations/NEXT_INITIATIVE_TI_VS_MI_INVESTIGATION_2026-07-06.md`; `docs/initiatives/mc1/MC1_QA_CURRENCY_PROPAGATION_AUDIT_2026-07-05.md`; `docs/initiatives/ops1/OPS1_OPERATIONAL_FLOOR_PLAN.md`; `docs/initiatives/platops/PLATOPS_ARCHITECTURE_ROADMAP.md`; STATUS.md §§1–8; `PRELAUNCH_AUDIT_2026-07-06.md`; commit `c4458dd` (TI P1). Speculation labeled inline. This document edits nothing and becomes authoritative only via STATUS ratification.*
