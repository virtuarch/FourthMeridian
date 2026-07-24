# Space Mount Doctrine

*Governs how a Space is MOUNTED: the boundary between what the shared shell needs to
know once a Space is authorized (the mount context) and what a workspace loads for
itself (its data). These are binding rules produced by the PS-6 initiative
(PS-6A–PS-6E). If a doc here and the code disagree, the code wins — fix the doc. See
also [Space Architecture](./SPACE_ARCHITECTURE.md), [Security Model](./SECURITY_MODEL.md),
[Time Model](./TIME_MODEL.md).*

> **The one mental model.** A mount answers, once a Space is authorized: *what does the
> shared shell need to paint its first frame?* The answer is **identity, access
> summary, display metadata, workspace navigation, selected workspace, shell
> configuration, and a canonical-time capability** — and nothing else. Business
> numbers, history, operational telemetry, analytics, transactions, and AI payloads
> are **workspace** responsibilities, loaded by the workspace, never by the mount.

---

## 1. The historical problem PS-6 solved

The problem was never "too many requests." It was **duplicated authoritative work**:

```
one /dashboard mount
  → several eager client fetches (sections, accounts, member count, …)
      → each fetch independently re-ran session-revocation + SpaceMember authorization
          → concurrent authority fan-out
              → connection_limit:1 pool pressure → P2024 exposure
```

Three or more client requests each re-derived *the same* session + Space-membership
truth on mount, in parallel, against a one-connection Prisma client. Removing the
duplication — not merely lowering a count — is what relieved the pressure.

## 2. The final authority model

```
Domain authorization        is authoritative for ACCESS.
Domain mount resolver       is authoritative for MOUNT COMPOSITION.
SpaceMountContext           is authoritative for CROSS-DOMAIN mount concerns.
Workspace loaders           are authoritative for DOMAIN / WORKSPACE DATA.
SpaceShell                  is a CONSUMER, never an authority.
```

- **Finance** authorizes via `getSpaceContext()` (cookie→preferred→personal + the
  `SpaceMember` gate). **Platform** authorizes via `PlatformGrant` + `hasPlatformAccess`
  (no cookie, no `SpaceMember`, area→`Space.platformArea`). Neither is replaced or
  weakened by the mount.
- The resolvers `financialMountContext()` / `platformMountContext()` (in
  `lib/space/mount-context.server.ts`) are **pure normalizers** of an
  already-authorized input. They perform no I/O and no authorization. A test asserts
  **no `/api/**` route imports them** — a mount context is render input, never an
  authorization token.

The canonical flow:

```
UI route → domain authorization → domain mount resolver → SpaceMountContext
         → SpaceShell → selected workspace → canonical domain loader → rendered surface
```

## 3. Contract boundaries — what SpaceMountContext owns (and never owns)

`SpaceMountContext` (`lib/space/mount-context.ts`, client-safe: pure types + one pure
validator, no `server-only`, safe to serialize into the RSC payload) owns exactly:

| Field | Meaning | Producer | Consumer |
|---|---|---|---|
| `ref` | `{ id, domain, kind }` — real Space.id + loader family + ontology | both resolvers | shell/host |
| `principal` | `{ userId }` only — no session, no tokens | both resolvers | host |
| `access` | `{ canRead, canWrite, level }` — **descriptive** capability, domain-vocabulary `level` string | both resolvers | shell (what to render) |
| `display` | `{ name, label?, subtitle? }` — neutral chrome text, no balances/currency/counts | both resolvers | shell header |
| `workspaces` | `{ available[], selectedKey }` — a serializable NAV PROJECTION of the ONE registry | both resolvers | rail |
| `shell` | `{ variant }` — the frame rendering axis | both resolvers | SpaceShell |
| `time` | canonical time as an OPTIONAL capability (`supported:false` when the selected workspace declares none) | both resolvers | shell/workspace |

It **never** owns: business projections, historical series (snapshots/valuation),
operational telemetry, workspace analytics/perspectives, unbounded transactions,
optional panels, or AI payloads. A test asserts the context interfaces name no
`balance`/`amount`/`holdings`/`snapshot`/metric field.

### `SpaceRef.kind` (ontology) ≠ `shell.variant` (presentation) — separate axes

`ref.kind` describes the **nature** of the Space (`personal` | `shared` | `utility`).
`shell.variant` describes **how the frame renders** (`space` | `utility`). They are
**independent** and one must never be inferred from the other. The concrete proof:
a **platform** Space is `kind: "utility"` (its nature) yet renders `variant: "space"`
(it delegates identity to the ContextualNavbar exactly like finance). Deriving
`variant` from `kind` would have suppressed the rail on single-Overview platform areas
(the PS-6C defect). `"utility"` variant is reserved for lone GLOBAL-nav destinations
(Connections/Settings) that render their own header. The resolver values are pinned by
`mount-context.test.ts`.

## 4. Hydration doctrine

A resource may enter a domain's **initial mount payload** only when **ALL** hold:

1. it is **required for the initial visible render**, and
2. it is **structural and bounded** (a small, identity-like set — not unbounded, not
   historical), and
3. hydrating it **removes duplicate eager authoritative work** the client would
   otherwise re-run.

> **Reducing a request count alone is NOT sufficient justification for hydration.**

Rejection categories (these stay workspace-owned, lazy, canonical): workspace
analytics/perspectives · historical series (snapshots, valuation, time-machine) ·
unbounded transactions · operational/platform metrics · optional/below-the-fold
panels · AI payloads.

`FinancialInitialWorkspacePayload` = `{ sections, accounts, memberCount }` — and it is
an **enforced allowlist** (`mount-payload-boundary.test.ts`): adding a field fails the
build until it is added to the allowlist with a justification against the three rules.
Each current field earns its place: `sections` (the section stack painted first),
`memberCount` (the header count), `accounts` (the bounded, structural roster whose
eager fetch re-ran a duplicate authority). Snapshots/perspectives/view-context/
transactions are **not** hydrated — the consumer keeps them lazy behind
`wantSnapshots`/`wantTransactions` gates.

## 5. Domain asymmetry is deliberate

Shared architecture does **not** require identical loading behavior.

- **Finance** composes a bounded initial payload (`composeFinancialInitialWorkspace`)
  because doing so **removes duplicated mount-time authority** — the payload pays for
  itself under rule 3.
- **Platform** intentionally **self-loads** its operational widgets (`dataNeeds:[]`,
  separate `/api/platform/*` authorities). That data is workspace-owned and is **not a
  mount concern**, so Platform composes **no** initial payload.

Do not erase this asymmetry in pursuit of symmetry. Same mount contract, same shell;
different, deliberate data strategies.

### Representability ≠ consumption (the settled PS-6F decision)

`SpaceMountContext` is a domain-neutral mount **representation**. Two distinct claims:

- **Representability** — finance **and** platform can each *produce* a valid
  `SpaceMountContext` (`financialMountContext()` / `platformMountContext()` yield the
  identical shape; the resolvers and their tests are the proof).
- **Consumption** — **Platform consumes it directly** because it *consolidates real
  authority*: the context replaced platform's scattered identity (`area→label`,
  `grant→level`) and a duplicate registry walk for its single-axis rail. **Finance
  does not consume it**, by design: the financial shell reads identity/nav from typed
  native props + the bounded payload, its navigation is two-axis (tabs *and*
  perspectives) and richer than the context models, and direct consumption would add
  **indirection without consolidating any authority**.

So finance is *provably representable* by the contract but *uses its richer native
route contract*. This is not an unfinished migration. **Do not wire finance to consume
`SpaceMountContext`** — PS-6F removed that plumbing after proving it was dead weight.
The `platform-mount-adoption` test encodes both claims so the asymmetry cannot be
"corrected" by accident.

## 6. Loader doctrine

```
A route handler and a server composition MAY consume the same canonical loader.
Neither may duplicate the underlying query.
Authorization stays at the ENTRYPOINT (the route keeps its guard; the composition has none).
Loaders compose data; they do not silently widen authorization.
```

`loadSpaceSections` / `loadSpaceAccounts` live once in `lib/space/mount-composition.ts`.
The `/api/spaces/[id]/sections` and `/accounts` routes **delegate** to them (keeping
their own `requireSpaceAction`/`requireSpaceRole` guards); the server composition calls
the same loaders for the ALREADY-authorized `/dashboard` page. One query definition,
two callers, one authorization site each.

## 7. Navigation doctrine

- The `WORKSPACE_REGISTRY` (`lib/perspectives.ts`, with `PLATFORM_WORKSPACES` unioned
  in) remains the **single authority** for workspace identity.
- Mount resolvers **project** the registry into a serializable
  `workspaces.available` summary (`{ key, label, icon-name, kind }`) + a validated
  `selectedKey`.
- Consumers read `workspaces.available` / `selectedKey`. They must **not** independently
  walk the registry to rebuild navigation. `PlatformSpaceDashboard` builds its rail
  from the contract projection (icon name→component resolved locally); the operational
  section-key *composition* it renders the body from stays Platform-owned (data-needs,
  not mount context).

## 8. Prefetch doctrine

Route prefetch is **not** universally good. Disable or constrain it where a hidden
route render would reproduce **expensive mount authorization concurrently** with no
demonstrated interaction benefit; keep it where it materially improves a **primary**
navigation without causing mount-time authority fan-out.

Applied: the desktop mount is already clean (in a Space the ContextualNavbar is in
SpaceMode, so its global links aren't rendered — measured **0** RSC prefetch). The
mobile `BottomNav` stays rendered during a Space mount, so its five global links carry
`prefetch={false}` — dropping only the eager viewport prefetch (each a full-context
sibling RSC render re-running the shell layout's `getSpaceContext`); tap/hover
navigation is unchanged. The desktop launcher's `GlobalMode` prefetch is left intact
(primary nav, not rendered during a Space mount).

## 9. Historical measurements

Environment: production `fourthmeridian.com`, authenticated USER, desktop viewport,
Resource Timing API. Commit range PS-6B `2caef00` → PS-6D/6E `041d973`.

| Metric | Before | After | Verified |
|---|---|---|---|
| Cold `/dashboard` API requests | 11 | 8 | runtime measured |
| Duplicate session + `SpaceMember` authority sets | 3 | 0 | runtime measured |
| Eager `/sections`, `/accounts`, member-count on mount | 3 | 0 | runtime measured (`041d973`) |
| Desktop RSC prefetch on mount | 0 | 0 | runtime measured |
| `/dashboard` document payload | — | 7.7 KB transfer / 38.5 KB decoded | runtime measured |

**Not presented as measured:** the mobile `BottomNav` prefetch delta is **source-verified**
(`prefetch={false}`), not runtime-measured (no reliable mobile empty-cache repro in the
verification environment). **Cold-mount SQL query counts are unmeasured** — there is no
production DB SQL instrumentation available; do not estimate them.

## 10. Closure state

| Slice | What it did | Commit |
|---|---|---|
| PS-6A | Domain-neutral `SpaceMountContext` contract (constructed, not yet consumed) | `11fbc36` |
| PS-6B | Financial hydration cutover; removed duplicate mount-time authority | `2caef00` |
| PS-6C | Platform adoption — consumes the shared contract; corrected `shell.variant` | `0f4a241` |
| PS-6D | Mobile prefetch containment + enforced hydration-boundary guardrail | `041d973` |
| PS-6E | Cross-domain runtime verification, this doctrine, dead-envelope removal | `d078a0a` |
| PS-6F | Removed the dead financial mount plumbing; settled representability ≠ consumption | *(this slice)* |

**Verdict: PASS.**

**Achieved:** one shared shell contract (both domains render through `SpaceShell`);
domain-specific data ownership (finance payload+loaders / platform self-fetch); the
duplicate-authority elimination that was the actual P2024 remediation (measured);
a proven-neutral `SpaceMountContext` **consumed end-to-end by Platform**; and, per §5,
a **settled** finance/platform asymmetry — finance is provably representable by the
context but uses its richer native route contract (PS-6F removed the dead plumbing
that made this ambiguous). The former "financial context consumption" follow-up is
**resolved, not deferred**: finance is not meant to consume the context.

**Known limitations (verification/environmental only):**

- **Platform runtime render.** The rendered Platform mount path is **compile- and
  test-verified**; its **auth gate is runtime-verified** (a non-granted USER is
  redirected `/dashboard/platform/[area] → /dashboard/spaces`). Full **rendered**
  runtime observation is **blocked** — no production `PlatformGrant` exists for the
  verifying user, and one must never be manufactured. Do not report the rendered
  Platform path as runtime-observed until a legitimate grant is available.
