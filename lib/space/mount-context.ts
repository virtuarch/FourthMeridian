/**
 * lib/space/mount-context.ts  (PS-6A — domain-neutral mount contract)
 *
 * THE smallest truthful shell-facing contract that answers: "once a Space has
 * been RESOLVED and AUTHORIZED, what does the shared SpaceShell need to know —
 * regardless of whether that Space is Financial or Platform?"
 *
 * CLIENT-SAFE BY CONSTRUCTION. This module is pure types + a pure validator; it
 * imports nothing server-only and no Prisma runtime values (only string-literal
 * unions), so it is safe to serialize into an RSC payload and import from client
 * components. The RESOLVERS that build these values live in
 * lib/space/mount-context.server.ts (server-only) and compose the existing
 * per-domain authorities — they are not part of this contract surface.
 *
 * WHAT THIS IS NOT (PS-6P boundary):
 *   - NOT the initial-Workspace data payload. This context owns identity, access
 *     summary, Workspace AVAILABILITY, and shell configuration. Domain data
 *     (accounts, snapshots, perspectives for finance; ops metrics, provider
 *     health, growth funnels for platform) is a SEPARATE, typed
 *     InitialWorkspacePayload delivered by domain loaders (deferred to PS-6B/6C).
 *   - NOT an authorization authority. `SpaceMountAccess` is DESCRIPTIVE render
 *     output; it must never be used to authorize a server operation. Every
 *     protected route re-authorizes through its own domain authority
 *     (SpaceMember for finance, PlatformGrant for platform).
 *
 * INVARIANT (also stated in the server module):
 *   Hydrated mount capabilities inform RENDERING; they do not AUTHORIZE server
 *   operations. Client-provided mount context is never trusted.
 */

// ── Identity ───────────────────────────────────────────────────────────────────

/** The loader/authority family a Space belongs to. Distinct from
 *  WorkspaceDefinition.domain (which classifies a *workspace*); this classifies
 *  the *Space* and thus which resolver + authority produced this context. */
export type SpaceDomain = "finance" | "platform";

/**
 * Shell-facing classification, derived from existing canonical facts:
 *  - finance PERSONAL SpaceType → "personal"
 *  - finance SHARED   SpaceType → "shared"
 *  - platform Space             → "utility"
 * It drives shell presentation (see shell.variant); it is NOT the raw SpaceType
 * and NOT a new persisted enum. Domain-specific locators (the raw SpaceType, or
 * a PlatformArea) are deliberately KEPT OUT of the shared ref — they live with
 * their domain (getSpaceContext for finance; the [area] route for platform).
 */
export type SpaceKind = "personal" | "shared" | "utility";

/** The smallest domain-neutral resolved identity of a REAL canonical Space row. */
export interface SpaceRef {
  /** Real Space.id (both domains are backed by canonical Space rows). NEVER a
   *  platform area key — the area is a resolution detail, not the identity. */
  id: string;
  domain: SpaceDomain;
  kind: SpaceKind;
}

// ── Principal (shell-relevant, non-sensitive) ──────────────────────────────────

/** Minimal authenticated-principal facts the shell needs. No session, no raw
 *  user row, no tokens. Only the id the shell already threads through today. */
export interface MountPrincipalSummary {
  userId: string;
}

// ── Access (DESCRIPTIVE capability — never authorization input) ─────────────────

/**
 * Resolved, client-consumable capability summary. It is the NORMALIZED output of
 * a domain authority (SpaceMember role for finance; PlatformGrant level for
 * platform), collapsed to what the shell needs to decide what to RENDER (e.g.
 * show/hide a manage affordance). It is descriptive only.
 *
 * `level` is a domain-vocabulary label ("OWNER"/"ADMIN"/"MEMBER"/"VIEWER" for
 * finance, "READ"/"WRITE" for platform), kept as a string ON PURPOSE so this
 * contract never fabricates a universal role enum that falsely merges
 * SpaceMemberRole and PlatformAccessLevel.
 */
export interface SpaceMountAccess {
  canRead: boolean;
  canWrite: boolean;
  /** Descriptive label of the resolved level (domain vocabulary). Not a role enum. */
  level: string;
}

// ── Display (shared shell chrome only) ─────────────────────────────────────────

/** Neutral display facts. No balances, currency values, account counts, or
 *  operational statistics — those are domain payloads, not shell context. */
export interface SpaceMountDisplay {
  name: string;
  label?: string;
  subtitle?: string | null;
}

// ── Workspace availability (from the ONE universal registry) ───────────────────

/**
 * A serializable NAVIGATION PROJECTION of a WorkspaceDefinition — the minimum
 * the shell rail needs. The full definition stays in WORKSPACE_REGISTRY (the
 * authority); this never duplicates dataNeeds/routing/envelope/temporal metadata.
 */
export interface MountWorkspaceSummary {
  /** WorkspaceDefinition.id — the registry key. */
  key: string;
  label: string;
  /** Lucide icon NAME; the consuming surface resolves it to a component. */
  icon: string;
  kind: "standard" | "perspective";
}

export interface SpaceMountWorkspaceContext {
  /** Domain-filtered Workspace summaries (finance perspectives for the Space's
   *  category; platform workspaces for the area) — all sourced from the ONE
   *  WORKSPACE_REGISTRY. */
  available: readonly MountWorkspaceSummary[];
  /** The initially-selected Workspace key. Validated against `available` by the
   *  resolver; each domain picks its own default (finance "overview", platform
   *  "platform-overview") — no universal default is hard-coded here. */
  selectedKey: string;
}

// ── Shell configuration (canonical facts, not presentation props) ──────────────

/**
 * The smallest domain-neutral shell configuration. Deliberately NOT a mirror of
 * SpaceShellProps: no callbacks (onManage/onSelectTab), no React nodes
 * (overlays/currencyControl/headerActions), no derived presentation. `variant`
 * is the one canonical fact the shell frame needs — the frame rendering axis,
 * INDEPENDENT of SpaceRef.domain/kind. Both finance AND platform Spaces render
 * "space" (they delegate identity to the ContextualNavbar's Space mode);
 * "utility" is reserved for lone GLOBAL-nav destinations (Connections / Settings)
 * that render their own header and take over no navbar. (A platform Space is
 * kind:"utility" by NATURE yet still renders variant:"space" — the two axes do
 * not co-vary.)
 */
export interface SpaceMountShellConfig {
  variant: "space" | "utility";
}

// ── Canonical time (OPTIONAL capability, not universal) ────────────────────────

/**
 * Canonical shell time as an optional capability. `supported` is derived from
 * the SELECTED workspace's temporalCapability (workspaceConsumesShellTime) — so
 * a platform/ops workspace reports { supported: false } and never fabricates an
 * asOf, while a time-capable finance perspective carries the current
 * asOf/compareTo (sourced from the existing URL time authority, not a new one).
 */
export type SpaceMountTime =
  | { supported: true; asOf: string; compareTo?: string | null }
  | { supported: false };

// ── The context + payload envelope ─────────────────────────────────────────────

/** THE domain-neutral shell mount context. */
export interface SpaceMountContext {
  ref: SpaceRef;
  principal: MountPrincipalSummary;
  access: SpaceMountAccess;
  display: SpaceMountDisplay;
  workspaces: SpaceMountWorkspaceContext;
  shell: SpaceMountShellConfig;
  time: SpaceMountTime;
}

/**
 * Part K — the envelope that keeps context and domain data SEPARATE. The initial
 * Workspace payload is typed per domain and is DEFERRED (PS-6B finance / PS-6C
 * platform). Platform may continue with no server-composed initial payload. This
 * is intentionally NOT a discriminated union of every Workspace DTO.
 */
export interface SpaceMountPayload<TInitialWorkspace = never> {
  context: SpaceMountContext;
  initialWorkspace?: TInitialWorkspace;
}

// ── Shared validator (pure; used by both resolvers) ────────────────────────────

/**
 * Validate a requested Workspace key against the domain-filtered availability,
 * falling back to the domain default. Keeps "selectedKey is always a real,
 * available Workspace" true without either resolver re-implementing it.
 */
export function resolveSelectedWorkspaceKey(
  available: readonly MountWorkspaceSummary[],
  requested: string | null | undefined,
  domainDefault: string,
): string {
  if (requested && available.some((w) => w.key === requested)) return requested;
  if (available.some((w) => w.key === domainDefault)) return domainDefault;
  return available[0]?.key ?? domainDefault;
}
