# SD-9 — Workspace Runtime Convergence (Investigation)

**Status:** Investigation only — no code changes (2026-07-18)
**Companion to:** `docs/architecture/WORKSPACE_CONTRACT_DOCTRINE.md`
**Predecessors:** SD-0…SD-8 (SpaceDashboard decomposition), Trust Surface Convergence (752e366)

> **Goal:** move the *last three* runtime responsibilities still living in the
> `SpaceDashboard` host body — **LensResults loading, Trust publishing, Chrome
> publishing** — onto the established Workspace contract, so the host becomes a
> **composition root** rather than an application controller. **No providers,
> managers, resolvers, factories, or new authority layers.** The seams are plain
> hooks, the same shape as the already-extracted `useSpaceData` / `useSpaceNavigation`.

---

## 0. What is already converged (do not touch)

The decomposition is 90% done. These authorities are canonical and the host merely *consumes* them:

| Concern | Authority | Host's relationship |
|---------|-----------|--------------------|
| **Identity / capability** | `WORKSPACE_REGISTRY` (`lib/perspectives.ts:529`) | reads (`getWorkspaceDefinition`) |
| **Renderer** | `WORKSPACE_RENDERERS` (`components/space/workspaces/workspaceRenderers.tsx:92`) | dispatches (`SpaceDashboard.tsx:876`) |
| **Navigation** | `useSpaceNavigation` (`lib/space/use-space-navigation.ts`) | consumes `activeTab` / `activePerspectiveId` / `selectLens` |
| **Time** | `usePerspectiveShellState` → `{asOf, compareTo, preset}` + `shell.derived` | consumes; never computes windows |
| **Data (shared)** | `useSpaceData` (`lib/space/use-space-data.ts:68`) | consumes `accounts` / `snapshots` / `transactions` |
| **Data (per-workspace)** | `WealthResult` / `InvestmentsSpaceData` / `CashFlowSpaceData` / `DebtSpaceData` / `LiquiditySpaceData` | never computes — each workspace owns its own |
| **Trust authority** | `resolvePerspectiveEnvelope` / `PerspectiveEnvelope` / `CompletenessTier` / `TrustIndicator` | **canonical, not in host** |

**Nothing above moves in SD-9.** The three targets below are the *residual orchestration* around them.

---

## 1. Current Runtime Map (with exact ownership)

```
                         WORKSPACE_REGISTRY  (identity/capability authority)
                                   │  read-only
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  SpaceDashboard.tsx  (1061 LOC — still an application controller)          │
│                                                                            │
│  useSpaceNavigation() ──► activeTab, activePerspectiveId, selectLens  ✅   │
│  usePerspectiveShellState() ──► asOf, compareTo, preset, derived     ✅   │
│  useSpaceData() ──► accounts, snapshots, transactions, ctx           ✅   │
│                                                                            │
│  ▓▓ RESIDUAL HOST ORCHESTRATION (SD-9 targets) ▓▓                         │
│                                                                            │
│  ① lensResults                                                            │
│     useState<Record<string,LensResult>|null>            :163              │
│     useEffect currency-nonce + SPACE_CURRENCY_CHANGED    :467-476         │
│     useEffect fetch /api/spaces/[id]/perspectives        :482-504         │
│        (batch, all lenses; target-currency param; fail→null)             │
│        └► renderCtx.lensResults :706  ──► Debt/Liquidity presentLens      │
│        └► perspective CARD verdicts  :235                                 │
│        └► non-workspace envelope fallback :848                            │
│                                                                            │
│  ② activeEnvelope (trust relay)                                           │
│     useState<PerspectiveEnvelope>({})                    :424              │
│     onEnvelopeChange: setActiveEnvelope (into renderCtx)  :711             │
│     SELECTION TERNARY (workspace-backed ? activeEnvelope                   │
│        : resolvePerspectiveEnvelope({...}))               :840-850         │
│                                                                            │
│  ③ chrome                                                                 │
│     catLabel :535 · chromeSubtitle :546 · chromeUpdated :549               │
│     publishSpace({identity,…}) effect → ContextualNavbar :551-564          │
│     SpaceShell title/subtitle props (mobile) :776-782  ◄ subtitle 2×!      │
│     railOptions from SPACE_TAB_LABELS (NOT registry)   :214-220            │
│     lensSelectorItems from CORE_LENS_IDS + registry label :325-333         │
│                                                                            │
│  builds ONE renderCtx :687-714 ──► WORKSPACE_RENDERERS[id](ctx) :876       │
└──────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
        WORKSPACE_RENDERERS ──► Workspace (owns data+FX+as-of trust, emits envelope↑)
                                   │
                                   ▼
        PerspectiveShell ──► ShellContextRow ──► TrustIndicator   (consumes envelope)
        SpaceChrome bridge ──► ContextualNavbar                   (consumes chrome)
```

### 1.1 The three targets, precisely

**① LensResults loading** — `SpaceDashboard.tsx:163, 467-504, 706`.
One batch fetch of the present-day Perspective-Engine verdicts for *every* lens, with its own
currency-refresh listener (`perspectivesCurrencyNonce` + `SPACE_CURRENCY_CHANGED_EVENT`) and
`?target=` view-as param. It has **two distinct consumers**:
- **Summary/navigation chrome** — the Perspective *cards* read `lensResults[p.lensId]` for their
  headline verdict (`:235`). This is orchestration, not the Workspace contract.
- **Workspace data input** — Debt & Liquidity receive `presentLens = lensResults[id]` through
  `renderCtx` (`workspaceRenderers.tsx:129, 162`). But those two workspaces *already* own a data
  authority (`useDebtSpaceData` / `useLiquiditySpaceData`) that fetches their as-of lens
  independently. The present-day lens is a second, host-threaded input.

**② Trust publishing** — `SpaceDashboard.tsx:424, 711, 840-850`.
The trust *authority* is fully canonical and outside the host. What remains is a **relay**: a
`useState` that catches each workspace's emitted envelope (`onEnvelopeChange`), plus the one
**selection ternary** that decides *workspace-backed → use the emitted envelope* vs *lens-only
(goals) → call `resolvePerspectiveEnvelope`*. That ternary is the single remaining place the host
"knows how trust is chosen."

**③ Chrome publishing** — `SpaceDashboard.tsx:214-220, 325-333, 535-564, 776-782`.
Two kinds of chrome are conflated:
- **Space identity** (name / `catLabel · N members` subtitle / "Updated 2h ago") — genuinely
  host-derived Space-level facts, **not** in the registry. Published twice: once to the desktop
  ContextualNavbar via `publishSpace` (`:551`), once as `SpaceShell` `title`/`subtitle` props for
  the mobile relocation (`:776`). **The subtitle string is computed twice** (`chromeSubtitle:546`
  vs the inline JSX `:777-782`) — a real duplication.
- **Workspace identity** (rail tab labels, lens-selector labels, active-workspace title) — the
  registry (`WorkspaceDefinition.label` / `.icon`) already owns this, yet `railOptions` is built
  from a *parallel* `SPACE_TAB_LABELS` map (`lib/space-nav`), not `getWorkspaceDefinition`.

---

## 2. Proposed Runtime Map (after SD-9)

```
                    WorkspaceDefinition  (WORKSPACE_REGISTRY — one identity authority)
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  SpaceDashboard.tsx  (composition root — resolve → mount → render)         │
│                                                                            │
│   resolve navigation   useSpaceNavigation()                               │
│   resolve time         usePerspectiveShellState()                         │
│   resolve workspace    getWorkspaceDefinition(activePerspectiveId)        │
│   mount runtime        useSpaceData()                                      │
│                        useSpaceLensResults(spaceId, targetCurrency)  ①    │
│                        useActiveEnvelope({activePerspectiveId, …})   ②    │
│                        useSpaceWorkspaceChrome(def, spaceFacts)      ③    │
│   render shell         <SpaceShell> + WORKSPACE_RENDERERS[id](ctx)        │
└──────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
            WORKSPACE_RENDERERS ──► Workspace ──► Envelope + Chrome + Data
                                   │
                                   ▼
                              SpaceShell  (consumes; owns no derivation)
```

The host stops *knowing* how lenses load, how trust is selected, or how workspace chrome is
derived. Each becomes a hook it *mounts*, exactly like `useSpaceData`. **Every seam is a hook —
no `WorkspaceProvider`, `WorkspaceContext`, `WorkspaceManager`, `WorkspaceResolver`, or
`WorkspaceConfig`/`Meta`/`Presenter`.** (`SpaceChromeContext` already exists as the app-global
chrome *bridge*; it is reused, not extended.)

---

## 3. True owner of each capability

| Capability | Current owner | Intended owner | Move |
|------------|---------------|----------------|------|
| **LensResults loading** | host `useState` + 2 effects (`SpaceDashboard.tsx:163,467,482`) | `useSpaceLensResults` hook (runtime seam) — verbatim relocation | **SD-9A** |
| — its per-workspace `presentLens` | host threads into `renderCtx` (`:706`) | each workspace's own data authority (`useDebtSpaceData`/`useLiquiditySpaceData`) | SD-9A follow-on (optional) |
| **Trust publishing** | host `activeEnvelope` state + selection ternary (`:424,840`) | `useActiveEnvelope` hook — holds state, owns the ternary; **authority stays `resolvePerspectiveEnvelope`** | **SD-9B** |
| **Chrome — Workspace identity** | `SPACE_TAB_LABELS` + local (`:214`) | `WORKSPACE_REGISTRY` via `getWorkspaceDefinition` | **SD-9C** |
| **Chrome — Space identity** | host, computed *twice* (`:546,777`) | host, computed **once**, fed to both mount points | **SD-9C** |
| Navigation | `useSpaceNavigation` ✅ | unchanged | — |
| Time | `usePerspectiveShellState` ✅ | unchanged | — |
| Data | `useSpaceData` + per-workspace authorities ✅ | unchanged | — |

**Answer to the framing question — "Is `lensResults` part of the Workspace contract or merely
navigation/runtime orchestration?"** It is **both today, and that dual-use is why it is stuck in
the host.** The *batch card verdict* is summary/navigation orchestration (→ a runtime seam hook);
the *per-workspace `presentLens`* is a data-authority input that Debt/Liquidity should ideally
pull through their own authorities. SD-9A separates the two: extract the loader as-is first
(mechanical, safe), then optionally fold `presentLens` into the two workspace authorities.

---

## 4. Implementation Plan (isolated commits, no new abstractions)

Each slice: **preserves tests, preserves runtime behavior, reduces host responsibility, adds no
abstraction.** Ordered so each is independently shippable and independently revertible.

### SD-9A — LensResults runtime ownership
- **Extract** `lensResults` state + both effects (currency-nonce listener + fetch) into
  `lib/space/use-space-lens-results.ts` → `useSpaceLensResults(spaceId, perspectiveTargetCurrency)`
  returning `Record<string, LensResult> | null`. **Verbatim relocation** — same route, same
  `?target=` param, same fail→null, same `SPACE_CURRENCY_CHANGED_EVENT` listener.
- Host calls the hook; `renderCtx.lensResults`, card verdicts, and the envelope fallback read its
  return unchanged.
- **Net:** ~45 LOC + 2 effects leave the host body. Behavior byte-identical.
- *(Optional follow-on, separate commit)*: give Debt/Liquidity their present-day lens through their
  own authority and drop `presentLens` from `renderCtx` — removes `lensResults` from the render
  context entirely. Defer if it changes any fetch timing.
- **Tests:** existing perspective-card + Debt/Liquidity workspace tests must stay green;
  add a focused hook test mirroring the current effect (currency-nonce bump → refetch).

### SD-9B — Trust publishing convergence
- **Extract** the `activeEnvelope` state **and the selection ternary** into
  `lib/space/use-active-envelope.ts` → `useActiveEnvelope({ activePerspectiveId, lensResults })`
  returning `{ envelope, onEnvelopeChange }`. The hook internally decides
  *workspace-backed (`id in WORKSPACE_RENDERERS`) → the emitted envelope* vs
  *lens-only → `resolvePerspectiveEnvelope(...)`* — **the exact ternary from `:840-850`, moved,
  not rewritten.**
- Host wires `onEnvelopeChange` into `renderCtx` and passes `envelope` to `PerspectiveShell`.
- **Authority untouched:** `resolvePerspectiveEnvelope`, `PerspectiveEnvelope`, `CompletenessTier`,
  `TrustIndicator` are imported by the hook exactly as the host imports them now. No trust logic is
  duplicated or created.
- **Net:** the host no longer contains any envelope-selection branch.
- **Tests:** the trust/envelope tests (`lib/perspectives/envelope.test.ts`, workspace envelope
  tests) are unaffected (authority unchanged); add a hook test for the workspace-backed-vs-resolver
  branch.

### SD-9C — Chrome publishing convergence
Two independent, low-risk edits (could be one commit or two):
1. **Workspace identity from the registry.** Build `railOptions` labels/icons from
   `getWorkspaceDefinition(tab)?.label`/`.icon` instead of `SPACE_TAB_LABELS`, so the registry is
   the single source of workspace identity. Keep `SPACE_TAB_LABELS` only if a tab has no registry
   entry (there should be none — verify against `WORKSPACE_REGISTRY`).
2. **Dedupe Space identity.** Compute the Space subtitle **once** (`chromeSubtitle`) and feed both
   the `publishSpace` payload *and* the `SpaceShell` `subtitle` prop from that one value — removing
   the second inline computation (`:777-782`). Optionally lift the small Space-facts derivation
   (`catLabel`/`chromeSubtitle`/`chromeUpdated`) into `lib/space/use-space-workspace-chrome.ts` so
   the host reads one object.
- **No new metadata object** — reuse `WorkspaceDefinition` and the existing `SpaceChrome*` channels.
- **Tests:** shell/chrome rendering tests stay green; the subtitle string is unchanged (dedupe is
  behavior-preserving).

### Suggested order & rationale
`SD-9A → SD-9B → SD-9C`. 9A is the largest LOC win and fully mechanical; 9B depends on nothing but
benefits from 9A already owning `lensResults` (the ternary reads it); 9C is orthogonal and safest
last. Each leaves `SpaceDashboard` strictly smaller and never introduces an abstraction.

---

## 5. Success Criteria

After SD-9, `SpaceDashboard`'s body reads as a composition root:

```
resolve navigation  →  resolve workspace  →  mount runtime  →  render shell
```

It should **no longer know**:
- how trust is created (→ `resolvePerspectiveEnvelope`, mounted via `useActiveEnvelope`)
- how lenses load (→ `useSpaceLensResults`)
- how workspace identity is assembled (→ `WORKSPACE_REGISTRY` / `getWorkspaceDefinition`)
- how workspace chrome is derived (→ registry + one Space-facts seam)

It **still owns** (correctly, as a composition root): overlay open-state (Manage/Leave/AddGoal),
the one `renderCtx` materialization, and the JSX layout. Those are composition, not control.

### Guardrails (what this slice must NOT do)
- ❌ create `WorkspaceProvider` / `WorkspaceContext` / `WorkspaceManager` / `WorkspaceResolver`
- ❌ create a generic `WorkspaceData` interface or merge `WealthResult` / `InvestmentsSpaceData` / `CashFlowSpaceData`
- ❌ move navigation into data, or move the shell time authority
- ❌ bypass the registry or add a second identity/metadata object
- ✅ only relocate residual host orchestration into hooks of the established shape

---

## Appendix — Evidence index (file:line)

| Target | Symbol | Location |
|--------|--------|----------|
| LensResults state | `lensResults` | `SpaceDashboard.tsx:163` |
| LensResults currency refresh | `perspectivesCurrencyNonce` + `SPACE_CURRENCY_CHANGED_EVENT` | `SpaceDashboard.tsx:467-476` |
| LensResults fetch | `/api/spaces/[id]/perspectives` batch | `SpaceDashboard.tsx:482-504` |
| LensResults → render | `renderCtx.lensResults` | `SpaceDashboard.tsx:706` |
| presentLens consumers | Debt/Liquidity `ctx.lensResults?.[id]` | `workspaceRenderers.tsx:129,162` |
| Trust relay state | `activeEnvelope` / `setActiveEnvelope` | `SpaceDashboard.tsx:424,711` |
| Trust selection ternary | workspace-backed vs `resolvePerspectiveEnvelope` | `SpaceDashboard.tsx:840-850` |
| Chrome — Space identity | `chromeSubtitle` / `publishSpace` | `SpaceDashboard.tsx:546-564` |
| Chrome — mobile duplicate subtitle | `SpaceShell subtitle` prop | `SpaceDashboard.tsx:777-782` |
| Chrome — rail labels (parallel map) | `SPACE_TAB_LABELS` | `SpaceDashboard.tsx:214-220` |
| Chrome bridge (pre-existing, reuse) | `SpaceChromeProvider` / `useSpaceChromePublisher` | `lib/space/space-chrome-context.tsx` |
| Shell consumer (thin already) | `SpaceShell` | `components/space/shell/SpaceShell.tsx` |
| Trust consumer (canonical) | `PerspectiveShell` → `ShellContextRow` → `TrustIndicator` | `components/space/shell/PerspectiveShell.tsx:85` |
