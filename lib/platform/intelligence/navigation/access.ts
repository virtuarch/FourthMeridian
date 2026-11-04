/**
 * lib/platform/intelligence/navigation/access.ts  (Platform Intelligence — foundation step 3, the accessor)
 *
 * READ-ONLY. `listNavigationTargets` and `resolveNavigationTarget` are the ONLY
 * way out of the navigation registry (./registry.ts). ⚠️ Future AI / chat /
 * copilot consumers get an href ONLY from `resolveNavigationTarget` and never
 * compose a URL themselves — no string concatenation, no "the path looks like".
 *
 * AUTHORITY — NO MINT, NO ISSUE (S2 binding 6)
 *   The caller passes the MetricAccessToken its route ALREADY minted from its
 *   own guard result (`metricAccessFor(auth)`, lib/platform/intelligence/metrics/access.ts).
 *   This module never issues a token (pinned). `surface` — the Platform area
 *   whose page the caller is on — is a server-side STRING LITERAL as the FIRST
 *   argument at every call site (pinned by a source scan, as for retrieveMetric).
 *
 * VISIBILITY (S2 bindings 2 + 7) — a target is listed / resolved only when ALL hold:
 *   1. the token is one this repository issued (isMetricAccessToken);
 *   2. it carries exactly ONE grant — the caller's own page grant. A
 *      break-glass token (every area, from grant null) sees NOTHING: every
 *      destination here refuses break-glass (the [area] page redirects on
 *      grant null and proxy.ts sends a SYSTEM_ADMIN off /dashboard/*), so a
 *      link would only ever 403. This is where navigation differs from the
 *      metric DEFINITIONS idiom (break-glass sees every definition) and agrees
 *      with its VALUES idiom (never more than the page would serve);
 *   3. the grant satisfies the destination page's own guard (hasPlatformAccess:
 *      same area, rank ≥ the level the page requires; ANY_GRANT pages accept any);
 *   4. the destination's identity tier ≤ tokenTierOnSurface(surface, token) — the
 *      SAME downgrade-only helper retrieve-core's atSurface uses — so a Customer
 *      Success destination is invisible on every other surface.
 *
 * ONE FAILURE SHAPE (S2 binding 5): a forged token, a break-glass token, an
 * unknown id, an invisible target, an unknown / repeated / non-string /
 * non-canonical param or an unsafe value all return the same `null`, with no
 * reason.
 *
 * PARAMS (S2 binding 4): an allowlist per target. A key outside it ⇒ null (never
 * dropped). A value must be safe (no "..", "//", "\", "@", "%", scheme or
 * control character, ≤ 200 chars) AND survive the owner module's own parser
 * byte-for-byte (the registry's group `canonical`). Values reach the URL only
 * through URLSearchParams (space-url.ts buildSpaceUrl); the path is a fixed
 * segment template. The result is a same-origin RELATIVE path starting with
 * exactly one "/", re-checked with `new URL(href, origin)` before it is returned.
 *
 * Pure (no I/O). Mint the token per request; never cache or serialise it.
 */

import type { PlatformArea } from "@prisma/client";
import { ALL_PLATFORM_AREAS, hasPlatformAccess } from "@/lib/platform/policy";
import { describeMetric, isMetricAccessToken, type MetricAccessToken } from "@/lib/platform/intelligence/metrics/access";
import { TIER_RANK, tokenTierOnSurface } from "@/lib/platform/intelligence/metrics/retrieve-core";
import {
  NAVIGATION_PARAM_GROUPS, NAVIGATION_TARGETS, buildNavigationHref,
  type NavigationTarget, type NavigationTargetKind,
} from "./registry";

/** The Platform area whose page the caller is on. A server-side literal at every call site (pinned). */
export type NavigationSurface = PlatformArea;

export interface ListNavigationFilter {
  /** Only targets in this area (platform pages have none and are then excluded). */
  area?: PlatformArea;
  kind?: NavigationTargetKind;
  /** Only targets linked to this metric ("id@version" or bare "id"). */
  metric?: string;
}

/** Deep-link params: key → raw value. Validated, never passed through. */
export type NavigationParams = Readonly<Record<string, string>>;

const MAX_VALUE = 200;
const UNSAFE = /\.\.|\/\/|\\|@|%|[\u0000-\u001f\u007f]|^[a-z][a-z0-9+.-]*:/i;
const PROBE_ORIGIN = "https://navigation.invalid";

interface Scope { token: MetricAccessToken; grant: MetricAccessToken["grants"][number]; tierRank: number }

function scopeOf(surface: NavigationSurface, token: MetricAccessToken): Scope | null {
  if (!isMetricAccessToken(token)) return null;
  if (!(ALL_PLATFORM_AREAS as readonly string[]).includes(surface)) return null;
  // Exactly the caller's own page grant; break-glass (every area) reaches no destination here.
  // Definitions describe; navigation must work — area pages redirect a null grant and proxy.ts sends SYSTEM_ADMIN off /dashboard.
  if (token.grants.length !== 1) return null;
  return { token, grant: token.grants[0], tierRank: TIER_RANK[tokenTierOnSurface(surface, token)] };
}

function visible(s: Scope, t: NavigationTarget): boolean {
  if (TIER_RANK[t.tier] > s.tierRank) return false;
  if (t.guard.kind === "ANY_GRANT") return true;
  return hasPlatformAccess(t.guard.area, t.guard.level, [{ ...s.grant, status: "ACTIVE" as const }]);
}

/** The target as this caller may see it: metric links narrowed to the metrics the token can describe. */
function project(s: Scope, t: NavigationTarget): NavigationTarget {
  return { ...t, metrics: t.metrics.filter((id) => describeMetric(s.token, id) !== null) };
}

/** Targets visible to the caller on `surface`, in registry order. A forged or break-glass token lists nothing. */
export function listNavigationTargets(
  surface: NavigationSurface,
  token: MetricAccessToken,
  filter: ListNavigationFilter = {},
): NavigationTarget[] {
  const s = scopeOf(surface, token);
  if (!s) return [];
  const out: NavigationTarget[] = [];
  for (const t of NAVIGATION_TARGETS) {
    if (filter.area && t.area !== filter.area) continue;
    if (filter.kind && t.kind !== filter.kind) continue;
    if (!visible(s, t)) continue;
    const p = project(s, t);
    if (filter.metric) {
      const want = filter.metric;
      if (!p.metrics.some((k) => k === want || k.slice(0, k.indexOf("@")) === want)) continue;
    }
    out.push(p);
  }
  return out;
}

/** The validated params, or null. Every key in the allowlist, every value safe and canonical for its owner. */
function validParams(t: NavigationTarget, params: unknown, nowMs: number): Record<string, string> | null {
  if (params === undefined) return {};
  if (typeof params !== "object" || params === null || Array.isArray(params)) return null;
  const proto = Object.getPrototypeOf(params);
  if (proto !== Object.prototype && proto !== null) return null;
  const given: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (!t.params.includes(k) || typeof v !== "string") return null;
    if (v.length === 0 || v.length > MAX_VALUE || UNSAFE.test(v)) return null;
    given[k] = v;
  }
  for (const g of NAVIGATION_PARAM_GROUPS) {
    if (!t.paramGroups.includes(g.id)) continue;
    const mine = g.keys.filter((k) => k in given);
    if (mine.length === 0) continue;
    const search = new URLSearchParams(mine.map((k) => [k, given[k]])).toString();
    const canonical = g.canonical(search, { viewId: t.viewId, nowMs });
    // Byte-for-byte both ways: nothing the parser changed, dropped or added.
    for (const k of g.keys) if ((given[k] ?? null) !== (canonical[k] ?? null)) return null;
  }
  return given;
}

/** A same-origin relative path on exactly the target's fixed pathname. */
function isSafeRelative(href: string, pathname: string): boolean {
  if (!href.startsWith("/") || href.startsWith("//") || href.includes("\\")) return false;
  try {
    const u = new URL(href, PROBE_ORIGIN);
    return u.origin === PROBE_ORIGIN && u.pathname === pathname && u.username === "" && u.hash === "";
  } catch {
    return false;
  }
}

/**
 * The relative href for target `id` with deep-link `params`, or null — the ONE
 * failure shape for unknown, invisible, a bad param and a forged token.
 * `now` bounds time-valued params exactly as the owning route does.
 */
export function resolveNavigationTarget(
  surface: NavigationSurface,
  token: MetricAccessToken,
  id: string,
  params?: NavigationParams,
  opts: { now?: Date } = {},
): { href: string } | null {
  const s = scopeOf(surface, token);
  if (!s || typeof id !== "string") return null;
  const t = NAVIGATION_TARGETS.find((x) => x.id === id);
  if (!t || !visible(s, t)) return null;
  const nowMs = opts.now ? opts.now.getTime() : Date.now();
  if (!Number.isFinite(nowMs)) return null;
  const valid = validParams(t, params, nowMs);
  if (!valid) return null;
  const href = buildNavigationHref(t, valid);
  return isSafeRelative(href, t.pathname) ? { href } : null;
}
