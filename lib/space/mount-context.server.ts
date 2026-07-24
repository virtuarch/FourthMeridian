/**
 * lib/space/mount-context.server.ts  (PS-6A)
 *
 * Server-side resolvers that COMPOSE the domain-neutral SpaceMountContract
 * (lib/space/mount-context.ts) from each domain's EXISTING authorities. They do
 * not re-authorize, replace, or weaken any authority — they NORMALIZE an
 * already-authorized result into the shared shape.
 *
 *   Financial: getSpaceContext() has already run the cookie → preferred → personal
 *              → active fallback resolution AND the SpaceMember authorization
 *              (it throws for an unauthenticated principal and only ever returns
 *              a Space the user is an ACTIVE member of). financialMountContext()
 *              normalizes that SpaceContext.
 *
 *   Platform:  the [area] page has already validated the PlatformArea, checked
 *              the ACTIVE PlatformGrant via hasPlatformAccess (non-disclosing
 *              redirect otherwise), and loaded the canonical Space.platformArea
 *              row. platformMountContext() normalizes those authorized inputs.
 *
 * The normalizers are PURE (no I/O) so they unit-test without a DB. The auth
 * chains stay exactly where they are; nothing here reads a cookie, a grant, or a
 * membership row.
 *
 * ── THE INVARIANT ──────────────────────────────────────────────────────────────
 *   Hydrated mount capabilities inform RENDERING; they do NOT authorize server
 *   operations. SpaceMountAccess is descriptive output. Every protected route
 *   MUST continue to re-authorize through its own domain authority (SpaceMember
 *   for /api/spaces/*, PlatformGrant/platform policy for /api/platform/*). A
 *   client-provided SpaceMountContext is never trusted.
 */

import "server-only";

import type { SpaceContext } from "@/lib/space";
import type { PlatformArea, PlatformAccessLevel } from "@prisma/client";
import {
  getPerspectivesForCategory,
  getWorkspaceDefinition,
  workspaceConsumesShellTime,
} from "@/lib/perspectives";
import { getPlatformAreaWorkspaces, getPlatformWorkspace } from "@/lib/platform/workspaces";
import {
  type SpaceMountContext,
  type MountWorkspaceSummary,
  type SpaceMountTime,
  resolveSelectedWorkspaceKey,
} from "@/lib/space/mount-context";

/** Domain default Workspace keys — each domain owns its own; no universal default. */
const FINANCE_DEFAULT_WORKSPACE  = "overview";
const PLATFORM_DEFAULT_WORKSPACE = "platform-overview";

/**
 * Canonical-time projection for the SELECTED workspace. Supported iff the
 * workspace actually consumes shell time (workspaceConsumesShellTime) AND the
 * caller supplied the current asOf — we never fabricate an asOf for a workspace
 * (platform/ops workspaces therefore always report { supported: false }).
 */
function timeForSelected(
  selectedKey: string,
  asOf: string | undefined,
  compareTo: string | null | undefined,
): SpaceMountTime {
  const def = getWorkspaceDefinition(selectedKey);
  const consumes = def ? workspaceConsumesShellTime(def) : false;
  if (consumes && asOf) return { supported: true, asOf, compareTo: compareTo ?? null };
  return { supported: false };
}

// ── Financial ──────────────────────────────────────────────────────────────────

export interface FinancialMountOptions {
  /** Requested initial Workspace (e.g. from the URL `perspective`/`tab`). */
  selectedKey?: string | null;
  /** Current canonical time from the existing URL authority (`asof`/`compareto`). */
  asOf?: string;
  compareTo?: string | null;
}

/**
 * Normalize an ALREADY-AUTHORIZED financial SpaceContext (the return of
 * getSpaceContext()) into the domain-neutral contract. Pure.
 */
export function financialMountContext(
  ctx: SpaceContext,
  opts: FinancialMountOptions = {},
): SpaceMountContext {
  const available: MountWorkspaceSummary[] = getPerspectivesForCategory(ctx.space.category).map((p) => ({
    key:   p.id,
    label: p.label,
    icon:  p.icon,
    kind:  p.kind,
  }));
  const selectedKey = resolveSelectedWorkspaceKey(available, opts.selectedKey, FINANCE_DEFAULT_WORKSPACE);

  return {
    ref: {
      id:     ctx.spaceId,
      domain: "finance",
      kind:   ctx.space.type === "PERSONAL" ? "personal" : "shared",
    },
    principal: { userId: ctx.userId },
    access: {
      canRead:  ctx.permissions.canRead,
      canWrite: ctx.permissions.canWrite,
      level:    ctx.role, // SpaceMemberRole vocabulary — descriptive label only
    },
    display: { name: ctx.space.name },
    workspaces: { available, selectedKey },
    shell: { variant: "space" },
    time: timeForSelected(selectedKey, opts.asOf, opts.compareTo),
  };
}

// ── Platform ─────────────────────────────────────────────────────────────────

export interface PlatformMountInputs {
  /** Real canonical Space.platformArea row id — NOT the area key. */
  spaceId:     string;
  spaceName:   string;
  area:        PlatformArea;
  areaLabel:   string;
  /** The ACTIVE grant's level, already authorized (READ was required to render). */
  accessLevel: PlatformAccessLevel;
  userId:      string;
}

export interface PlatformMountOptions {
  selectedKey?: string | null;
}

/**
 * Normalize ALREADY-AUTHORIZED platform inputs (area validated, grant checked,
 * canonical Space.platformArea loaded) into the SAME domain-neutral contract.
 * Pure. Does NOT call getSpaceContext, read a cookie, or touch SpaceMember.
 */
export function platformMountContext(
  input: PlatformMountInputs,
  opts: PlatformMountOptions = {},
): SpaceMountContext {
  const available: MountWorkspaceSummary[] = getPlatformAreaWorkspaces(input.area)
    .map((c) => getPlatformWorkspace(c.workspaceId))
    .filter((d): d is NonNullable<typeof d> => Boolean(d))
    .map((d) => ({ key: d.id, label: d.label, icon: d.icon, kind: d.kind }));
  const selectedKey = resolveSelectedWorkspaceKey(available, opts.selectedKey, PLATFORM_DEFAULT_WORKSPACE);

  return {
    ref: {
      id:     input.spaceId,
      domain: "platform",
      kind:   "utility",
    },
    principal: { userId: input.userId },
    access: {
      canRead:  true,                         // READ gate already passed to reach here
      canWrite: input.accessLevel === "WRITE",
      level:    input.accessLevel,            // PlatformAccessLevel vocabulary — descriptive only
    },
    display: { name: input.spaceName, label: input.areaLabel },
    workspaces: { available, selectedKey },
    // Platform renders through the "space" variant, NOT "utility": it delegates
    // identity to the ContextualNavbar's Space mode (publishSpace) exactly like a
    // financial Space — it is not a lone GLOBAL-nav destination (Connections /
    // Settings) that renders its own header. The shipped shell behavior "a single-
    // Overview Platform area KEEPS its one pill" only holds under "space" (the
    // "utility" branch suppresses a single-workspace rail). `ref.kind` stays
    // "utility" (the Space's NATURE); the shell VARIANT is a separate axis.
    shell: { variant: "space" },
    // Platform workspaces declare no temporalCapability ⇒ always { supported: false }.
    time: timeForSelected(selectedKey, undefined, undefined),
  };
}
