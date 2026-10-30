/**
 * lib/platform/nav.ts  (Platform Operations 2.0 — R1, three-destination navigation)
 *
 * The Platform context has exactly THREE global destinations, on every width:
 *
 *   Overview       /dashboard/platform             the command center
 *   AI             /dashboard/platform/ai          the (not yet available) Platform AI
 *   Current Space  /dashboard/platform/<AREA>      the selected granted Platform Space
 *
 * PURE and client-safe (no Prisma client, no `server-only`, no cookie API): the
 * same functions run in the dashboard layout (SSR — the right label on first
 * paint) and in the client nav provider (after every navigation).
 *
 * ── CURRENT SPACE SELECTION (`fm_platform_space`) ──────────────────────────
 * The last visited granted area is remembered in a first-party cookie holding
 * ONLY a PlatformArea enum value — no identity, no grant, no level. It is a
 * DISPLAY preference, never an authority:
 *   · it is read only through `resolveCurrentPlatformSpace`, which intersects it
 *     with the viewer's ACTIVE grants (the rows the server loaded as the tenant).
 *     An unknown, forged or no-longer-granted value is simply not found and the
 *     first granted Space is used instead;
 *   · the Space page itself (app/(shell)/dashboard/platform/[area]) re-checks the
 *     grant through the shared guard on every request, whatever the cookie says,
 *     so a cookie can at most change which LABEL a link carries.
 */

import { ALL_PLATFORM_AREAS } from "@/lib/platform/policy";
import { platformAreaHref } from "@/lib/platform/directory";
import { PLATFORM_DIRECTORY_HREF } from "@/lib/space-nav";

/** The Platform AI page — a static route segment, never an area (areas are UPPER_CASE enums). */
export const PLATFORM_AI_HREF = `${PLATFORM_DIRECTORY_HREF}/ai`;

/** The first-party cookie that remembers the selected Platform Space (an area enum only). */
export const PLATFORM_SPACE_COOKIE = "fm_platform_space";

/** Readable by the dashboard layout on every /dashboard request (the layout is
 *  shared, so a personal page load must already know the Platform label). */
export const PLATFORM_SPACE_COOKIE_PATH = "/dashboard";

/** One year: a preference, refreshed on every Space visit. */
export const PLATFORM_SPACE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** A granted Platform Space as the navigation needs it (server-authorized rows only). */
export interface PlatformSpaceOption {
  id:   string;
  name: string;
  area: string;
}

/** Is this string a known PlatformArea enum value? (Case-sensitive: "ai" is not.) */
export function isPlatformAreaValue(value: string | null | undefined): value is string {
  return typeof value === "string" && (ALL_PLATFORM_AREAS as readonly string[]).includes(value);
}

/**
 * The area a pathname stands in, or null. Only `/dashboard/platform/<AREA>` and
 * deeper, where <AREA> is a known enum value — so the directory, the AI page and
 * an unknown segment are all "no area". A ROUTE fact, never an access fact.
 */
export function platformAreaFromPath(pathname: string | null | undefined): string | null {
  if (typeof pathname !== "string") return null;
  const prefix = `${PLATFORM_DIRECTORY_HREF}/`;
  if (!pathname.startsWith(prefix)) return null;
  const segment = pathname.slice(prefix.length).split(/[/?#]/, 1)[0];
  return isPlatformAreaValue(segment) ? segment : null;
}

/** Is the pathname the Platform AI page (or below it)? */
export function isPlatformAiPath(pathname: string | null | undefined): boolean {
  return typeof pathname === "string" && (pathname === PLATFORM_AI_HREF || pathname.startsWith(`${PLATFORM_AI_HREF}/`));
}

/**
 * The Current Space, chosen ONLY among the granted rows:
 *   1. the area the pathname stands in, when granted;
 *   2. else the remembered area (cookie), when granted;
 *   3. else the first granted Space (registry order — the rows' order);
 *   4. no grants ⇒ null.
 * A value outside the grants is never returned, whatever its source.
 */
export function resolveCurrentPlatformSpace(
  spaces: readonly PlatformSpaceOption[],
  pathArea: string | null | undefined,
  remembered: string | null | undefined,
): PlatformSpaceOption | null {
  const find = (area: string | null | undefined) => (area ? spaces.find((s) => s.area === area) ?? null : null);
  return find(pathArea) ?? find(remembered) ?? spaces[0] ?? null;
}

/** The Set-Cookie / document.cookie string for a remembered area (validated first). */
export function platformSpaceCookie(area: string, secure: boolean): string | null {
  if (!isPlatformAreaValue(area)) return null;
  return [
    `${PLATFORM_SPACE_COOKIE}=${area}`,
    `Path=${PLATFORM_SPACE_COOKIE_PATH}`,
    `Max-Age=${PLATFORM_SPACE_COOKIE_MAX_AGE}`,
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export type PlatformDestinationId = "overview" | "ai" | "space";

export interface PlatformDestination {
  id:    PlatformDestinationId;
  label: string;
  href:  string;
  on:    boolean;
}

/** Label of the third destination before any granted Space is known. */
export const CURRENT_SPACE_FALLBACK_LABEL = "Space";

/**
 * EXACTLY three destinations, in this order, for the bar and the rail alike.
 * Overview lights only on the directory itself; AI on the AI page; Current Space
 * on any `/dashboard/platform/<AREA>` path (any granted area — the page guard
 * decides access, the path decides the light). With no granted Space known the
 * third item still exists (the count never changes) and points at Overview.
 */
export function platformDestinations(
  pathname: string | null | undefined,
  current: PlatformSpaceOption | null,
): PlatformDestination[] {
  const path = pathname ?? "";
  return [
    { id: "overview", label: "Overview", href: PLATFORM_DIRECTORY_HREF, on: path === PLATFORM_DIRECTORY_HREF },
    { id: "ai",       label: "AI",       href: PLATFORM_AI_HREF,        on: isPlatformAiPath(path) },
    {
      id:    "space",
      label: current?.name ?? CURRENT_SPACE_FALLBACK_LABEL,
      href:  current ? platformAreaHref(current.area) : PLATFORM_DIRECTORY_HREF,
      on:    platformAreaFromPath(path) !== null,
    },
  ];
}
