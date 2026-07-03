# Space Clustering & Financial Topology — Product Investigation

**Status:** Investigation only — no code, no schema, no migrations, no implementation.
**Date:** 2026-07-03
**Authority note:** Defers to `STATUS.md` for current state and `PHASE_2_DECISION_MATRIX.md` for D1–D14. Nothing here re-litigates an approved decision; where a finding touches an approved milestone boundary (the v2.6b ambient gate, the v3.0 zero-new-surface rule, the D10 deferred list), this document says so and stays inside it.

---

## 0. The question, stated precisely

Fourth Meridian organizes finances into Spaces. The question under investigation: **should AI continuously optimize that organization** — recommending Space creation, merges, splits, account moves, ownership changes, and broader reorganization — and should it ever act automatically?

The investigation's core finding, stated up front because everything else follows from it:

> **In Fourth Meridian, Space organization is not a folder structure. It is an access-control and trust topology.** A Space determines who sees an account, at what redaction level, and what context the AI may assemble. "Move this account to your Household Space" is not a tidying suggestion — it is a proposal to change who can see your money.

Most personal-finance apps can treat auto-categorization as low-stakes because their containers are cosmetic. Fourth Meridian's containers are load-bearing: `SpaceAccountLink` (HOME/SHARED, `visibilityLevel`), member roles, read-time redaction (`lib/account-privacy.ts`), and the AI Context Builder's no-cross-Space contract all hang off Space membership. This single fact reframes every sub-question below, and it is also — see §7 Q1 — the seed of the genuinely differentiated version of this feature.

---

## 1. Current state — what the platform already knows and does

Grounding, so the proposals are evaluated against what exists rather than a blank slate:

| Capability | State | Relevance to clustering |
|---|---|---|
| Space taxonomy | 15 `SpaceCategory` values (PERSONAL, HOUSEHOLD, FAMILY, BUSINESS, PROPERTY, VEHICLE, TRIP, INVESTMENT, …), `SpaceType` PERSONAL/SHARED | The vocabulary AI would cluster *into* already exists and is user-legible |
| Account↔Space linkage | SAL dual-write live; HOME uniqueness DB-enforced (KD-5); read-cutover is v2.5 scope | "Move account" = re-point a HOME row. The primitive nearly exists; the *authorization semantics* of an AI doing it do not |
| Automatic restructuring precedent | `lib/accounts/reconcile.ts` fingerprint engine **silently auto-merges** duplicate accounts; D1 repurposed `DuplicateAccountCandidate` as an append-only ledger of what was merged | The one place the platform already acts autonomously. Note what made it acceptable: it resolves *identity* (two rows, one real-world account — a fact), not *organization* (a choice) |
| Flow data | `debtPaymentTotal` is source-side only; destination attribution exists in the DB but reaches no rollup (KD-18); flowType **with destination** is ratified v2.5.5 scope | Transfers-between-accounts are the raw material of topology. Today that material is not yet queryable |
| AI doctrine | Deterministic-first: the model narrates pre-computed, provenance-carrying facts and never calculates; validator live-enforcing (KD-2); attribution honesty doctrine (KD-18); ambient behavior gated to v2.6b entry criteria | Any clustering recommendation must arrive as a deterministic, evidence-listed finding the LLM narrates — never as LLM judgment about your org chart |
| Cross-Space AI access | Context Builder contract: no cross-Space leakage, no admin bypass | **Structural blocker for the naive design** — clustering is inherently cross-Space analysis. See §5.2 |

Also relevant: "Agents / automation workflows" is already parked in STATUS.md §8 with the unpark condition "an assistant must first never misstate a number when asked before it acts unprompted or autonomously." AI-initiated reorganization is squarely that class.

---

## 2. Financial topology — the concept, investigated

"Financial topology" is worth defining rather than vibing: **a derived graph whose nodes are accounts, Spaces, people, and (implicitly) external entities, and whose edges are ownership (`ownerType`/HOME links), access (SAL SHARED links, member roles, visibility levels), and flows (recurring transfers, debt payments, income deposits — the v2.5.5 flowType-with-destination data).**

Three properties make this the right abstraction:

1. **It already exists implicitly.** The platform stores every edge type today; nobody has drawn the graph. Topology is a *read model*, not new truth — same lifecycle category as `SpaceSnapshot` ("Derived: regenerable from canonical data, safe to discard," Freeze §11). That makes it cheap to be wrong about: a bad topology derivation is recomputed, not migrated.
2. **It converts clustering from ML mysticism into graph queries.** "Business activity inside Personal Space" = a subgraph of payroll-provider deposits and Schedule-C-pattern merchants flowing through a PERSONAL-category Space. "Duplicate Spaces" = two Spaces whose account sets overlap above a threshold. "Dormant Space" = a node with no flow edges in N months, no active goals, near-zero balances. Every example in the brief is expressible as a deterministic predicate over the graph — which is exactly the shape the existing assessment engine (AI-2) already uses for cash flow, liquidity, and debt. Clustering signals should be **new detectors in that engine**, not a new intelligence system.
3. **It has value with zero recommendations attached.** A rendered topology — "here is the map of your financial structure: 3 entities, 14 accounts, these recurring flows between them, this account is commingled" — is a deliverable in its own right (see §5.3 and §5.4: this is roughly what family offices pay to have drawn). A recommendation engine can fail; a map is just true.

**Counter-argument (taking the anti-topology side seriously):** a graph model flatters engineering sensibilities but users don't think in graphs, and the ownership model underneath is honestly too flat for real topology — `ownerType: USER | SPACE` cannot represent "this LLC is owned 60/40 by two people, held inside a trust." Rendering a confident-looking entity map on top of a two-value ownership enum risks the same class of dishonesty KD-18 exists to prevent: presenting structure the data model cannot actually attribute. Verdict: the criticism is correct about *rendering ambition* (the v1 map must show only edges the schema actually stores and must say so) but wrong as an argument against the derivation layer itself, which is also the substrate for the defensible detectors below.

---

## 3. The recommendation taxonomy — each action evaluated separately

The brief lists six candidate AI actions. They are not one feature; they span roughly three orders of magnitude of risk, and averaging them ("AI reorganization: yes/no") would be the central mistake.

| Action | Reversible? | Crosses a privacy boundary? | Primitive exists? | Verdict |
|---|---|---|---|---|
| **Suggest creating a Space** | Fully (ignore it) | No — suggestion only reveals your own data to you | Yes (Space creation + presets) | **Best candidate.** Concrete trigger, e.g. commingling detector: "9 recurring merchants in your Personal Space look like business activity — want a BUSINESS Space?" Also the natural home for onboarding: cluster *at import time* (DiscoveredAccount staging is the perfect moment to propose placement) rather than reorganizing later |
| **Suggest archiving a dormant Space** | Fully (archive/trash lifecycle exists, undo built in) | No | Yes | **Second-best.** Objective signal, low stakes, reduces clutter. Cheap trust-builder |
| **Flag duplicate/overlapping Spaces** | Flag is free; the *merge* is not | Merge can be catastrophic (see below) | **No merge primitive exists** | Flag: yes. One-click merge: no such thing yet — merging means migrating SALs, goals, dashboards, snapshots, and **member sets**. Two Spaces with different members cannot be merged without someone gaining or losing access. This is an access-control operation wearing a janitorial costume |
| **Suggest moving an account between Spaces** | Semi (re-point HOME back) | **Yes, inherently.** Moving into a SHARED Space exposes the account to its members; moving out revokes context others may rely on | Mostly (SAL) | Suggest with full consequence disclosure ("moving this here means Alex and Jordan will see it at FULL visibility"). Never framed as tidying |
| **Suggest splitting a Space** | Painful to reverse | Yes (splits sever shared context) | No | Flag the *evidence* (two disjoint flow clusters inside one Space); do not generate multi-step split plans in v1. High cognitive load, low frequency |
| **Suggest changing ownership** (`USER` ↔ `SPACE`) | Semi | Yes | Yes (field exists) | **AI should not initiate this, ever.** In-app `ownerType` is a visibility mechanism; users will read "change ownership" as a legal/tax statement. An app nudging assets between personal and entity ownership is practicing structuring advice without standing (§5.3). At most, AI may flag an *inconsistency* ("this account is titled to your LLC per its institution name but owned as USER here") and stop |

**Pattern across the table:** the defensible actions are the ones where the AI detects an objective *hygiene defect* (commingling, dormancy, duplication, titling inconsistency) and the indefensible ones are where it optimizes a *preference* (how you'd rather partition your life). This is the create/merge asymmetry: suggesting a new Space adds an option; suggesting a merge or ownership change edits the user's existing choices.

---

## 4. Confidence, cadence, autonomy

### 4.1 How confidence should work

Not a scalar. A "73% confident" badge is unfalsifiable theater the user can neither verify nor calibrate, and it contradicts the provenance doctrine the AI layer is built on. Confidence should be **evidence tiers**, mirroring the assessment engine's existing confidence-gating:

- **FACT** — deterministically true from canonical data ("this account is HOME-linked in Space A and its twin merge-ledger entry shows it was previously in Space B"; "no transaction in 14 months"). Surfaceable without hedging.
- **PATTERN** — statistical over a window, shown *with its evidence list*, KD-7-style honesty about coverage ("11 of 14 recurring merchants in this Space match business-service categories — here are the 11"). Surfaceable as a question, never an assertion.
- **INFERENCE** — LLM-flavored judgment ("this looks like a rental property"). **Does not surface in v1 at all.** If a signal can't be expressed as a deterministic detector with a listable evidence set, it isn't ready to be shown. This is the same bar KD-2/KD-18 impose on numbers and attribution, applied to structure.

Every surfaced finding carries: the predicate that fired, the rows that satisfied it, and the consequence of accepting (especially visibility changes). Every dismissal is remembered permanently against the predicate + subject pair — a suggestion ledger in the exact mold of D1's repurposed `DuplicateAccountCandidate` (append-only record of what the machine noticed, not a queue that nags).

### 4.2 Cadence: continuous vs. manual vs. periodic vs. approval-gated

**Continuous is wrong for this product**, and not for cost reasons. Organization suggestions are only valuable at *decision moments*; a continuously churning optimizer converts the user's stable mental model into a feed of second-guessing (§5.5). The defensible cadences:

1. **On-event** — at account import (DiscoveredAccount staging: "where should this live?" with a ranked suggestion) and at Space-lifecycle moments (archiving, invites). Highest acceptance likelihood: the user is already in an organizing mindset.
2. **Periodic, batched, opt-in** — a quarterly-ish "organization review" rolled into the v2.6b Daily Brief/AI Inbox substrate. All findings in one sitting, dismissible forever.
3. **Manual, always available** — "Review my organization" as an explicit ask. Ships value even for users who never opt into ambient anything.

Approval is not a cadence option — it is a constant. Everything above is suggest-then-approve.

### 4.3 Should AI ever move things automatically?

**No.** The platform's own precedent draws the line precisely: `reconcile.ts` auto-merges because two rows for one real account is a *falsehood* to be corrected, and even there the D1 decision was to leave a permanent audit ledger. Space membership is not a falsehood — it is a user's statement about trust and context. Additionally, an auto-move into a shared Space is an **automated disclosure of financial data to third parties**, which is a KD-1-class privacy event initiated by a heuristic. The parked-ideas register already gates mere *unprompted speech* behind a validator track record; unprompted *action* on access-control state is categorically further out. The only automation this investigation endorses: auto-*placing* a newly imported account into the Space the user's own prior decisions imply (same institution, same entity pattern), clearly labeled and one-tap reversible — placement of new objects, never movement of existing ones.

---

## 5. Perspective reviews

### 5.1 End User

The median user has 1–3 Spaces and will never say "financial topology." For them this feature is three moments: **import** ("we put your new business checking next to your other business account — right?"), **the occasional nudge** ("you haven't touched Trip to Lisbon since 2025 — archive it?"), and **the map** (a visual of accounts→Spaces→flows that makes them feel, for the first time, that the app understands their structure). All three are high-delight, low-load. What destroys this user's experience: recurring reorganization prompts ("Consider merging…" appearing twice), any suggestion whose acceptance changes what a partner sees without shouting that fact, and suggestion badges that gamify tidiness. Discoverability note: the *map* is the feature this user shows their spouse; the *recommendations* are plumbing. The emotional product is the map.

**Conflict with 5.2 flagged honestly:** users would love one-click "merge these Spaces." Engineering (below) says that click is a multi-entity migration with member-set semantics no one has designed. Do not let user delight arguments smuggle in the merge primitive; ship the flag without the button until the primitive is designed on its own merits.

### 5.2 Principal Engineer

Four findings, one of them a hard structural constraint:

1. **The Context Builder contract forbids the naive design.** D4's binding rule is Space-scoped assembly with no cross-Space leakage. Clustering is inherently cross-Space *and cross-visibility*: it must see everything the *user* owns across all their Spaces. The clean resolution is that topology derivation is **not an AI context path at all** — it is a deterministic, user-scoped batch job (assessment-engine class, `SpaceSnapshot` lifecycle class) whose *outputs* (findings with evidence IDs) may later be narrated by the LLM within normal Space scoping. It must run over accounts the requesting user owns or has FULL visibility into — a shared BALANCE_ONLY account contributes a node, never its transactions (the KD-1/KD-19 predicate applies to detectors, too). This wants to be written down as a D4-style contract *before* any detector is built, because it will be tempting to "just query" from inside the builder.
2. **Sequencing is forced by data availability.** The commingling and flow-cluster detectors need flowType with destination attribution — ratified v2.5.5, not started. Dormancy and duplicate-Space detectors need only data that exists today. So a v1 (dormancy, duplication, titling inconsistency) is buildable early; the interesting v2 (commingling, flow clusters) is gated on v2.5.5 landing. Building topology before flowType means building it twice.
3. **Additive and derived, therefore cheap.** No canonical table changes. A findings ledger (D1 pattern) plus detectors plus one read surface. The expensive-looking part — graph rendering — is a UI project, not an architecture one, and lands inside UI-1's design-system work naturally.
4. **Ten-year test:** the thing that ages well is the derived-graph read model and the detector contract; the thing that ages badly is any ML clustering pipeline bought before the deterministic detectors exhaust their value. There is no evidence the deterministic tier runs out of headroom before launch+1yr.

### 5.3 Professional Wealth Manager / Financial Advisor

The commingling detector is the single most professionally credible idea in this investigation — every CPA and advisor spends real hours begging clients to stop running business expenses through personal accounts, and a tool that *detects* it from transaction patterns and proposes clean separation is doing work the profession genuinely values. Same for the entity/titling inconsistency flag: "account titled to the LLC, tracked as personal" is exactly what gets found, embarrassingly late, in estate reviews.

Two hard professional objections. First, **ownership-change suggestions cross from bookkeeping into advice.** "Consider moving this asset under your LLC" has tax, liability-protection, and titling consequences; software that emits it is giving structuring advice, and STATUS.md's own v3.0 legal posture ("remove 'financial advisor' framing") points the opposite direction. Detect inconsistencies, present facts, stop. Second, **workflow realism:** a real advisor does entity mapping *once, at onboarding*, then revisits annually or on life events — never continuously. The professional workflow validates §4.2's cadence conclusion from independent grounds: import-time and periodic review are how humans who do this for a living actually do it.

### 5.4 High-Net-Worth Individual

This is the persona for whom the feature is closest to the actual job. A person with two LLCs, three properties, a brokerage, a 529, and a joint household is exactly who needs entity-aware organization, and the *map* — not the suggestions — is what they currently pay a family office to maintain in a spreadsheet. Multi-entity users also generate the most inter-account flows, so topology is richest precisely where the need is greatest. Time-efficiency framing matters: this user wants "show me my structure and flag what's inconsistent," not "let me approve 14 suggestions."

Objections from this seat: **privacy composition.** In multi-member Spaces, my reorganization suggestions must be computed only from what I can see — a detector must never let another member infer the existence or behavior of my BALANCE_ONLY accounts from a suggestion surfaced to them ("merge these two Spaces" shown to a spouse can itself leak that the Spaces overlap). Findings are private to the user whose data fired them, full stop. And **model honesty about flatness** (echoing §2): a family office user will immediately notice the ownership model can't express trusts or percentage ownership; the map must under-claim rather than fake it. This user would rather see "6 accounts, ownership edges unknown" than a confident wrong chart.

### 5.5 Wildcard: Behavioral Economist

Chosen because the entire premise — "AI should optimize the user's financial organization" — rests on an assumption behavioral economics specifically refutes. Spaces are **mental accounting** made literal (Thaler): partitions people create to govern their own behavior. The partitioning research (Cheema & Soman and successors) shows the partitions *work because the user made them* — earmarking money into a labeled envelope measurably changes spending, and the "inefficiency" of someone's idiosyncratic structure is often the mechanism of their self-control. An optimizer that normalizes a user's weird-but-functional partition ("you don't need a separate 'Never Touch' Space; it's redundant with Emergency Fund") can be *correct on category purity and harmful on behavior*. There is no clean deterministic test distinguishing a dysfunctional partition from a load-bearing one.

Consequences: (a) the optimization target must be **intent legibility, not structural elegance** — surface where the structure contradicts the user's own demonstrated behavior (business flows through Personal; a "savings" Space that's actually a pass-through), never where it merely offends taxonomy; (b) status-quo framing matters — findings should be phrased as questions about *facts* ("did you know 40% of this Space's outflows go to LLC vendors?") rather than directives ("you should split this"), because directive framing triggers reactance and question framing recruits the user's own reasoning; (c) the endowment effect predicts merge/split suggestions will be rejected at high rates regardless of quality — plan for low acceptance on those and don't read it as model failure.

**Where this perspective conflicts with the Advisor (5.3):** the advisor wants clean books; the behavioral economist defends messy-but-functional ones. The tradeoff is real and should not be averaged: resolve it by *domain* — commingling of business/personal is a case where clean wins (external consequences: taxes, liability), while purely personal partition style is a case where the user's psychology wins (no external consequence). The detector list in §3 already respects this line; keep it that way.

---

## 6. What this investigation recommends (summary of positions)

1. **Build financial topology as a deterministic, derived, user-scoped read model** — detectors in the existing assessment engine, findings in a D1-style append-only ledger, evidence-tier confidence (FACT/PATTERN surface; INFERENCE never, in v1).
2. **Recommend, never act.** Create-Space and archive-dormant suggestions first; move-account with explicit visibility-consequence disclosure; flag duplicates and titling inconsistencies without merge/ownership buttons; no AI-initiated ownership changes at all.
3. **Cadence: import-time + manual + periodic batch riding the v2.6b inbox substrate.** Not continuous. Dismissals are permanent.
4. **The map is the product; the suggestions are a feature of the map.** Rendering the topology (honestly, under-claiming where the ownership model is flat) delivers most of the differentiated value at a fraction of the trust risk.
5. **Write the topology access contract (D4-style) before any detector code**, resolving the cross-Space/cross-visibility question explicitly rather than in a PR.

---

## 7. Concluding questions

### Q1 — What would make this genuinely differentiated from every other personal finance app?

Not clustering — Mint-descendants and every "AI CFO" startup will bolt suggestion feeds onto folder structures. The differentiation is the combination Fourth Meridian is uniquely positioned to offer: **organization that is also an enforced trust boundary, mapped honestly.** No consumer product today can show a user "here is your financial structure as a graph — entities, flows, who can see what, and where reality contradicts the structure" with every edge deterministically provenanced, because no other product stores visibility, ownership, sharing, and flows as first-class, auditable data. Competitors can copy the suggestion feed in a quarter; they cannot copy the substrate. "Your money has a shape — we show it to you, and we never guess" is a ten-year sentence.

### Q2 — Biggest risk or downside?

**Trust erosion through presumption, with a privacy edge.** The failure mode is not a wrong suggestion — it's the accumulation of reorganization prompts that teach the user the app thinks it knows their life better than they do (the §5.5 mechanism), capped by the tail risk that a single suggestion, surfaced to the wrong member of a shared Space or accepted without understanding its visibility consequence, discloses financial information to another person. One such incident undoes the entire privacy reputation the KD-1/KD-15/KD-19 work was done to earn. Mitigations are in §4; the risk never goes to zero, which is itself an argument for the map-first, suggestions-second shape.

### Q3 — Ship in v2.5, v2.6, v3.0, or later?

**Later — post-v3.0 — with two narrow, already-sequenced exceptions.** The reasoning is the roadmap's own: v2.4.5–v2.5 are verification and seam closure; v2.5.5 is data semantics (and is a hard *prerequisite* — flow-based detectors need flowType destination attribution); v2.6a must make conversations coherent before v2.6b lets the system speak unprompted; v3.0 is zero new surface. A recommendation engine about the user's organizational structure is ambient intelligence with above-average trust stakes; it has no business shipping before the ladder it depends on is climbed. The exceptions: (a) **import-time placement suggestions** are not ambient — they answer a question the import flow already forces — and can ride whatever milestone finishes the DiscoveredAccount staging UX; (b) if v2.6b's AI Inbox ships on schedule, the two data-cheap detectors (dormant Space, duplicate/overlap flag) are legitimate early inbox content. The full topology map + review surface is a flagship post-launch differentiator — and commercially better there than buried pre-launch: it is the feature that upgrades a Plaid-connected checking-account user into a multi-entity power user.

### Q4 — If only one idea survives, which and why?

**The financial topology derivation layer — the deterministic, user-scoped graph read model — without any recommendation UI at all.** Because it is the only idea here that is upstream of everything else and downside-free: it makes the clustering suggestions possible later, it gives the AI analyst structural context it currently lacks (today the AI cannot answer "how do my Spaces relate?" at all), it produces the map that is the feature's emotional core, it serves the HNWI/advisor personas at their point of highest willingness to pay, and — being derived, additive, and regenerable — it can be built, thrown away, and rebuilt without touching a canonical table or a trust boundary. Recommendations are a bet on user psychology; the map is just the truth, rendered. When in doubt, ship the truth.

---

*End of investigation. No implementation, schema, or code changes proposed for the current milestone; nothing above modifies any approved decision in `PHASE_2_DECISION_MATRIX.md` or the roadmap in `STATUS.md` §5.*
