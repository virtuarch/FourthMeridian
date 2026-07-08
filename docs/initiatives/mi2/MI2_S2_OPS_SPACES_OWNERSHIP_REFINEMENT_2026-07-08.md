> **INVESTIGATION / DESIGN REFINEMENT ONLY — no code, no schema, no migration, no STATUS.md change was made to produce this document.** Nothing here is authorized to build. For current project state see `STATUS.md`.

# MI2 S2 — Ownership Refinement: "Fourth Meridian operating Fourth Meridian" through Spaces

**Date:** 2026-07-08
**Branch:** feature/v2.5-spaces-completion
**Prompt:** Re-evaluate the Merchant Merge Review Queue's host through the Platform Operations doctrine — internal operations built on the *same primitives customers use*, with **SYSTEM_ADMIN as the authority, Spaces as the workspace**. Should the queue live as `Fourth Meridian HQ → Merchant Operations Space → Merge Review Queue` instead of `/admin/merchants`?
**Refines:** `MI2_S2_MERCHANT_MERGE_REVIEW_QUEUE_INVESTIGATION_2026-07-08.md` (§8 ownership).

---

## 0. Bottom line (opinionated)

**The doctrine is right, and I want to move toward it — but not by making MI2 S2 its proving ground, and not by pretending today's Spaces can host operational work as-is.**

Two things are true at once, and the whole recommendation hinges on separating them:

1. **The *authority + workspace* primitives of Spaces generalize cleanly** — `Space`, `SpaceMember` (OWNER/ADMIN/MEMBER/VIEWER), `SpaceInvite`, soft-membership lifecycle, and per-space `AuditLog`. Using **membership in an internal Space as the access-control list**, with SYSTEM_ADMIN as the grantor, is strictly better than a hardcoded `role === "SYSTEM_ADMIN"` route gate. **Adopt this now.** It is cheap and it is the durable half of the vision.

2. **The *content + rendering* primitives of Spaces do NOT generalize** today. The Space shell is a **financial-planning compositor**, not a generic application shell: every widget declares a `DataRequirement` keyed on `account.type` + account visibility (`lib/widget-registry.ts`); the widget primitives are `AssetValue / Progress / Breakdown / Summary / Timeline`; `SpaceDashboardTab` is a **closed enum** of financial tabs (`OVERVIEW/GOALS/ACCOUNTS/DEBT/INVESTMENTS/RETIREMENT/ACTIVITY/SETTINGS`); and a member's data access is scoped to the space's **linked financial accounts** via `SpaceAccountLink` visibility (`lib/ai/visibility.ts`). A "Merge Review Queue" is none of those things and operates on **global** merchant data, not the member's accounts. Rendering it *as a Space widget* requires inventing a non-financial section/widget capability and an accountless, global-data Space — a large, separate framework initiative.

So my recommendation is a **seam, not a destination**: in MI2 S2, make the **authorization** Space-shaped immediately, keep the **surface** deliberately minimal and host-agnostic, and put all merge logic in MI libraries so the eventual lift into a real Space section is a *re-host with zero logic change*. Do **not** build a bespoke `/admin/merchants` admin-panel page (it entrenches exactly the "separate admin application" you want to avoid), and do **not** build the generic-Spaces shell inside S2 (it would explode S2's scope for one queue).

---

## 1. HQ → Merchant Operations Space → Merge Review Queue vs `/admin/merchants` — the tradeoffs

| | Internal **Space** host (the vision) | `/admin/merchants` (traditional admin panel) | **Host-agnostic + Space-authz (recommended interim)** |
|---|---|---|---|
| **Nav / shell / UI framework** | Reuses the product shell — *if* the shell is generalized beyond finance (it isn't yet). | New admin nav + admin shell — a second UI framework to maintain. | No new shell. Minimal server page (or CLI) whose only job is list + Merge + Dismiss; explicitly temporary. |
| **Authorization model** | Space membership = ACL. SYSTEM_ADMIN grants. Access is **data**, not code. ✅ | `role === SYSTEM_ADMIN` baked into each route. Coarse, all-or-nothing. ❌ | **Space membership = ACL now** (the durable half), even though rendering isn't a Space yet. ✅ |
| **Data scoping** | Space members are scoped to the space's *accounts*; a merge queue reads *global* merchant tables — the scoping model **inverts** and must be deliberately replaced. ⚠️ (hidden problem, §7) | Admin routes already bypass tenant scoping; global reads are "normal admin." ✅ but reinforces admin-app pattern. | Ops capability reads global MI tables under an explicit, audited grant — designed once, reused by future ops. ✅ |
| **Scope to ship now** | Large: generic sections/widgets + accountless Space + global-data capability. ❌ for S2. | Small but wrong-direction: fastest to a page, hardest to unwind. ⚠️ | Small **and** directionally correct: MI substrate + Space-based gate + throwaway view. ✅ |
| **Re-home cost later** | Already home. | High — logic tends to leak into admin route handlers/components. ❌ | ~Zero — logic lives in MI libs; the view is a shell over `mergeMerchants` + decision helpers. ✅ |

**Verdict:** `Fourth Meridian HQ → Merchant Operations Space → Merge Review Queue` is the correct *destination*. `/admin/merchants` is the wrong destination (it grows the admin application you're trying not to build). But the destination isn't reachable in one S2-sized step, so ship the **interim** column: Space-shaped authority now, host-agnostic surface now, Space-rendered later.

---

## 2. Do the boundaries stay clean? (Principle 1)

Yes — and they get **cleaner**, because the refinement splits two roles the original §8 fused into "admin":

```
Authority          SYSTEM_ADMIN          creates internal Spaces, assigns membership,
                                          controls access & feature availability
Host / Workspace   Merchant Operations   WHERE the work happens + WHO may do it
                   (an internal Space)    (a Platform-Operations concept)
Owner (logic)      Merchant Intelligence  the detector, decision store, pair-key,
                                          deny-list, evidence model
Execution          merge engine           mergeMerchants(...) — the only write path
```

Four distinct axes, no overlap:
- **SYSTEM_ADMIN owns authority only** — it never contains merge logic and is not the workspace. It grants membership and creates the ops Space. This directly realizes "SYSTEM_ADMIN is the authority, not the workspace."
- **Merchant Operations is the host** — a workspace context (who works, where), not a code owner. It is a Platform-Operations surface.
- **Merchant Intelligence remains the owner** — all merchant logic stays in `lib/transactions/` regardless of host. (Unchanged from S2.)
- **The merge engine owns execution** — frozen. (Unchanged from S2.)

This is a strict improvement over "admin panel hosts, MI owns," which quietly made the admin panel both authority *and* host.

---

## 3. Can internal Spaces host Merchant Ops / Support / Security / … on the *same* shell, sections, widgets, permissions, nav? (Principle 2)

**Split the answer by primitive, because the honest answer differs:**

- **Permissions & nav & membership & lifecycle & audit → YES, today.** `SpaceMember` + roles + invites + `AuditLog` are domain-neutral. An internal Space is a first-class `Space` row; granting a support agent access is a `SpaceMember` insert. This *reinforces* Spaces — internal ops becomes "another tenant," exactly as intended, and every access grant is auditable through the machinery that already exists.

- **Sections & widgets & data-scoping → NO, not today.** These are finance-coupled by construction:
  - Widgets gate on `DataRequirement.accountTypes` + visibility — a merge queue has no account type.
  - The widget primitives (`AssetValue/Progress/Breakdown/Summary/Timeline`) are financial visualizations; a review queue, a merchant detail, an alias explorer are none of them → they need **new primitives**, which the "Widget Primitive Rule" in the registry deliberately makes expensive (~200 lines + a new mental model each).
  - `SpaceDashboardTab` is a **closed enum** — operational tabs ("Queue", "History") aren't expressible without changing it.
  - A member's data is scoped to the space's linked accounts (`SpaceAccountLink` visibility); ops content reads **global** tables, so the scoping model doesn't apply and must be **replaced**, not reused.

**Conclusion:** internal Spaces host operational work *if and only if* the shell is first generalized to render non-financial, non-account-scoped sections. That generalization is a real initiative (call it "Operational Space Shell / accountless Spaces + global-data capability"), and it is the **true enabler** of the whole vision. Naively reusing today's shell would force operational work to masquerade as financial widgets — which would *bypass* the spirit of Spaces while nominally reusing them, the worst of both. So: reinforce Spaces by generalizing the shell deliberately — not by smuggling ops work through the finance compositor.

---

## 4. Authorization mental model (Principle 3) — why Space-membership beats hardcoded admin pages

The correct model is exactly the one you sketched:

```
SYSTEM_ADMIN
   │  creates internal Spaces (e.g. "Merchant Operations")
   │  assigns membership + role
   │  controls access & feature availability
   ▼
Operational users  ──work──▶  inside those Spaces, on that domain's tooling
```

Why this scales better than hardcoded admin pages:

- **Access becomes data, not code.** Granting/revoking is a `SpaceMember` row, not a new `role ===` gate shipped in a route. New ops domains don't require new authorization code — they require a new Space and memberships.
- **Fine-grained, least-privilege.** "SYSTEM_ADMIN" is all-or-nothing and dangerous; Space membership scopes a person to *Merchant* Operations without handing them Security or User Operations. Roles (OWNER/ADMIN/MEMBER/VIEWER) give read-only reviewers vs. actioning operators for free.
- **Auditable by construction.** Membership changes and in-space actions already flow through `AuditLog` (`spaceId`, `performedByAdminId`). Hardcoded admin pages have to re-implement this per page.
- **Delegation without escalation.** SYSTEM_ADMIN stays a small, guarded set (the authority); day-to-day operators are ordinary members of an ops Space (the workforce). You stop minting SYSTEM_ADMINs to get work done — the precise failure mode of admin-panel architectures.
- **Uniform mental model.** One authorization system (Space membership) for customers *and* staff, instead of two (tenant ACLs + admin RBAC) drifting apart.

This is the strongest, most durable part of the vision, and it is **cheap to adopt now**: an internal Space is just a `Space`; "is this user allowed to review merges?" becomes "is this user an ACTIVE member (role ≥ MEMBER) of the designated Merchant Operations Space?" — a trivial indexed query. The one seam it needs is a way to *designate* which Space is the ops space; see §7 (do it without schema first).

---

## 5. What a Merchant Operations Space eventually contains — and the minimal first version (Principle 4)

**Eventual (illustrative, not authorized):**

```
Merchant Operations (internal Space)
├─ Merge Review Queue      ← pending candidates, evidence, Merge / Dismiss / Later
├─ Merge History           ← the MerchantMergeDecision ledger (free once the table exists)
├─ Merchant Search         ← find by name / canonicalKey / alias
├─ Merchant Detail         ← one merchant: aliases, rules, txn counts, entity id
├─ Alias Explorer          ← alias → merchant mappings; spot rail-wrapped variants
└─ Merchant Statistics     ← catalog size, unresolved rate, merge cadence
```

**Minimal first version (my recommendation): the Merge Review Queue + a read-only Merge History**, nothing else. History is *almost free* — it is just a list view over the `MerchantMergeDecision` table that S2 already introduces. Everything else (search, detail, alias explorer, stats) is a separate, later slice and must not be pulled into S2. Even the queue's rich review UI is optional for S2 (see §6): the durable substrate + CLI is the true minimum.

---

## 6. Does this change MI2 S2's ownership conclusions? (Principle 5)

**It refines the *host* and *authorization*; it does not touch the *owner*, the *execution path*, or the *schema*.**

| Dimension | Original S2 conclusion | Refined conclusion |
|---|---|---|
| **Owner (logic)** | Merchant Intelligence (`lib/transactions/`) | **Unchanged** — Merchant Intelligence. |
| **Execution** | `mergeMerchants(...)` only | **Unchanged** — frozen engine. |
| **Schema** | one table `MerchantMergeDecision` | **Unchanged** — same table. |
| **Host** | the admin panel (`app/admin/merchants`) | **Merchant Operations** — an internal Space (destination); a host-agnostic minimal surface (interim). |
| **Authorization** | `role === SYSTEM_ADMIN` route gate | **Membership in the Merchant Operations Space**, granted by SYSTEM_ADMIN. |

So, to your explicit question — **"Does Merchant Operations become the host while Merchant Intelligence remains the owner?"** — **Yes. That is exactly the right separation.** Merchant Operations = *host/workspace* (Platform Operations); Merchant Intelligence = *owner* (logic); the engine = *execution*; SYSTEM_ADMIN = *authority*. The original "admin hosts, MI owns" wasn't wrong so much as it collapsed *host* and *authority* into one word ("admin"); this refinement pulls them apart, which is the cleaner model.

**Concrete S2 shape under the refinement (smallest durable):**
1. `MerchantMergeDecision` table + decision helpers (MI-owned) — as S2 planned.
2. Pure detector (MI-owned) — as S2 planned.
3. Accept/dismiss operations that call `mergeMerchants` / write a dismissal — as S2 planned, but **gated by ops-Space membership**, not raw SYSTEM_ADMIN.
4. Surface: the existing merge **CLI** + (optionally) one deliberately-minimal, clearly-temporary review page carrying **zero logic**. **No new admin nav, no admin shell.**
5. SYSTEM_ADMIN creates the "Merchant Operations" Space and assigns members (authority).

Nothing here changes the engine or the decision schema; it changes *who is allowed* and *where it nominally lives*.

---

## 7. Future operational work — does it fit the same internal-Space architecture? (Principle 6)

**The container fits; the content is per-domain; the shell generalization is the shared prerequisite.**

Support, Security, Compliance, Platform Health, Financial Operations, Fraud Review, User Review — each maps naturally to **an internal Space with scoped membership**: same authority model (SYSTEM_ADMIN grants), same audit, same least-privilege delegation. That is genuinely uniform and desirable — a growing set of internal Spaces, one per operational domain, all governed by the customer membership machinery.

But each also needs **its own operational sections/widgets**, which do not exist and are not financial. So the pattern that generalizes *now* is the **authorization/workspace container**; the **content** for each domain is its own initiative. The moment two of these (say Merchant Ops and Fraud Review) both want a "review queue" section, you've discovered the real shared primitive: a **generic operational section/widget capability** on a generalized Space shell. That capability — not any single queue — is the initiative that makes "FM operates FM through Spaces" real. Sequence it as its own track, *after* MI2 S2, and let the merge queue be its first *tenant*, not its *guinea pig*.

### Hidden problems to name (be honest)

1. **The Space shell is finance-coupled.** Widgets gate on `account.type`; tabs are a closed financial enum; primitives are financial. Non-financial ops content needs new section/widget machinery — a real, sizeable investment. Do not underestimate this by pointing at "we already have Spaces."
2. **Accountless Spaces are a new object shape.** An internal ops Space has no financial accounts, which touches widget `DataRequirement` gating, `reportingCurrency` semantics, snapshots, and AI context assumptions — all of which currently presume accounts. Each needs an explicit "N/A for internal Spaces" stance.
3. **Data-scoping inverts — the biggest security risk.** Customer Spaces scope a member to *their* linked accounts (`SpaceAccountLink` visibility, `lib/ai/visibility.ts`, fail-closed). A Merchant Operations Space operates on **global, cross-tenant** merchant tables. Reusing the Space shell must **not** reuse the tenant-scoped data layer, or you get one of two failures: the ops Space sees *nothing* (scoping denies global reads) or you disable scoping and risk seeing *everything*. The correct design is an explicit, narrow **ops capability** ("members of Merchant Operations may read the global Merchant/Alias/Decision tables") that is separate from Space account visibility and independently audited. This must be designed once, deliberately, before any ops Space reads global data.
4. **AI-context bleed.** Spaces feed AI assemblers. An internal ops Space must be structurally excluded from tenant AI context so global merchant data never leaks into a customer's chat. (Fail-closed, like the existing visibility predicate.)
5. **Designating the ops Space without schema.** To gate on membership you must identify *which* Space is "Merchant Operations." Prefer **no schema**: an env/config pointer to a known Space id, or a naming/`category` convention, resolved in one helper. Promote to a real field only if an indexed query ever needs it. (Consistent with the house "no schema until a query demands it" discipline.)
6. **Premature generality vs. under-investment — the tightrope.** Building the whole internal-Spaces framework to host one queue is over-engineering; building a bespoke admin page is under-investing and hard to unwind. The refinement threads the needle: **Space-shaped authz now, host-agnostic minimal surface now, shell generalization later.**

---

## 8. Recommendation (opinionated)

1. **Adopt the doctrine as the North Star.** "FM operates FM through Spaces," with SYSTEM_ADMIN as authority and Spaces as workspace, is the correct long-term architecture. It unifies staff and customer authorization, keeps SYSTEM_ADMIN small, and avoids a second UI/RBAC framework. Endorse it.
2. **Refine MI2 S2's authorization now, cheaply.** Gate merge-review on **membership in a SYSTEM_ADMIN-created "Merchant Operations" Space**, not on a raw `SYSTEM_ADMIN` check. This realizes the authority/workspace split for *access* immediately and makes future re-hosting a no-op for authz. Designate the ops Space via config/convention — **no schema**.
3. **Keep the S2 surface minimal and host-agnostic.** Do **not** build `/admin/merchants` as a bespoke admin page. Ship the MI substrate (decision table, detector, accept/dismiss) with all logic in `lib/transactions/`, operable via the existing **CLI**; add at most one deliberately-temporary, logic-free review page. The engine and the `MerchantMergeDecision` schema are unchanged from the S2 investigation.
4. **Do NOT make S2 the proving ground for generic Spaces.** Ratify a **separate** initiative — "Operational Space Shell: accountless internal Spaces + non-financial sections + a scoped global-data ops capability" — sequenced *after* S2. When it lands, the Merge Review Queue lifts into `Merchant Operations` as a section with **zero logic change**, because §2–§6 kept host and owner separate.
5. **Ownership, final:** **Merchant Operations = host (Platform Operations). Merchant Intelligence = owner (logic). Merge engine = execution. SYSTEM_ADMIN = authority.** Four clean axes.

**Net:** this approach aligns better with the long-term architecture than either `/admin/merchants` or a premature Spaces build. It captures the durable half of the vision (Space-based authority) at near-zero cost today, refuses to entrench an admin application, and defers the expensive half (a generalized operational shell) to a deliberate initiative — with the genuine risks (finance-coupled shell, accountless Spaces, inverted/global data scoping, AI bleed) named so they are designed, not stumbled into.

---

## 9. Stop point

Investigation/refinement only. No code, schema, migration, or `STATUS.md` change. Recommended next actions for a human: (a) accept the authorization refinement into the MI2 S2 scope (Space-membership gate + host-agnostic surface, no schema change); (b) open a separate initiative for the Operational Space Shell as the true enabler of "FM operates FM through Spaces." The engine stays frozen; MI keeps ownership; SYSTEM_ADMIN stays the authority, not the workspace.
