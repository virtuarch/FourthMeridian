/**
 * lib/api.ts
 *
 * Shared utilities for API route handlers.
 *
 * ─── withApiHandler ──────────────────────────────────────────────────────────
 * A lightweight wrapper that catches unexpected errors and returns a consistent
 * JSON { error: "Internal server error" } with status 500.  Known errors
 * (auth, validation) are still returned by the route handler directly —
 * withApiHandler only catches things that fall through uncaught.
 *
 * Usage:
 *   export const GET = withApiHandler(async (req) => {
 *     const [user, err] = await requireUser();
 *     if (err) return err;
 *     ...
 *     return ok(data);
 *   }, "GET /api/spaces");
 *
 * ─── getRequestMeta / getClientIp ────────────────────────────────────────────
 * getRequestMeta() returns a structured object with all request metadata:
 * IP, user-agent, Cloudflare headers (ray, country, colo), and protocol.
 * Use this as the standard source for audit log metadata and security events.
 *
 * getClientIp() is a thin wrapper around getRequestMeta() for the common
 * case where only the IP is needed.
 *
 * IP trust model: lib/security/client-ip.ts (ARCH-003) — the ONE extractor,
 * shared with the rate limiter and authorize(). Platform headers first
 * (x-vercel-forwarded-for, x-real-ip; cf-connecting-ip only when
 * CLIENT_IP_TRUST_CLOUDFLARE=true), then the LAST x-forwarded-for entry,
 * then "unknown".
 *
 * ─── Response helpers ────────────────────────────────────────────────────────
 * ok(), created(), badRequest(), notFound()
 * Thin wrappers around NextResponse.json() for the most common status codes.
 * They do not replace inline NextResponse.json() calls — use whichever is
 * clearer in context. Note: unauthorized() and forbidden() live in lib/session.ts
 * since they are auth-specific and already imported from there by all routes.
 */

import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { getClientIp as extractClientIp, FORWARDED_FOR_HEADER } from "@/lib/security/client-ip";
import { captureApiHandlerFailure } from "@/lib/monitoring/capture";

// ── Request metadata ──────────────────────────────────────────────────────────

export interface RequestMeta {
  /** Real client IP (Cloudflare > x-forwarded-for > x-real-ip > "unknown"). */
  ip:           string;
  /** HTTP User-Agent string, or null if absent. */
  userAgent:    string | null;
  /** Cloudflare Ray ID (cf-ray), useful for correlating logs with CF dashboard. */
  cfRay:        string | null;
  /** Two-letter ISO country code from Cloudflare (cf-ipcountry). */
  country:      string | null;
  /** Cloudflare or Vercel edge PoP/colo where the request arrived. */
  colo:         string | null;
  /** Full x-forwarded-for chain, for logging only — do not use for IP identification. */
  forwardedFor: string | null;
  /** Request protocol: "https" in production, "http" in local dev. */
  protocol:     string;
}

/**
 * Extracts structured request metadata from a Next.js API request.
 * Prefer this over getClientIp() when writing audit logs or security events —
 * it captures everything in one pass.
 */
export function getRequestMeta(req: NextRequest | Request): RequestMeta {
  const h = req.headers;

  return {
    // ARCH-003 — THE one extractor (lib/security/client-ip.ts): the same
    // address the limiter keys on and authorize() audits. This used to prefer
    // cf-connecting-ip, a client-writable header when no Cloudflare fronts
    // the deployment.
    ip:           extractClientIp(h),
    userAgent:    h.get("user-agent"),
    cfRay:        h.get("cf-ray"),
    country:      h.get("cf-ipcountry"),
    colo:         h.get("x-vercel-id")?.split(":")[0] ?? h.get("cf-ipcola") ?? null,
    forwardedFor: h.get(FORWARDED_FOR_HEADER),
    protocol:     h.get("x-forwarded-proto") ?? "https",
  };
}

/**
 * Returns the real client IP from a request.
 * Prefer getRequestMeta() when you need more than just the IP.
 */
export function getClientIp(req: NextRequest | Request): string {
  return getRequestMeta(req).ip;
}

// ── withApiHandler ────────────────────────────────────────────────────────────

type RouteHandler<T extends unknown[] = []> = (
  req: NextRequest,
  ...args: T
) => Promise<NextResponse> | NextResponse;

/**
 * Wraps a route handler with a top-level try/catch.
 *
 * - Expected errors (auth, 400/403/404) should be returned by the handler directly.
 * - Unexpected errors (DB failure, env var missing, etc.) are caught here,
 *   logged server-side with context, and returned as a generic 500.
 * - Stack traces and raw error messages are never sent to the client.
 *
 * @param handler  The route handler function
 * @param context  A short label for the server log (e.g. "GET /api/spaces/goals")
 */
export interface ApiHandlerDeps {
  /**
   * ARCH-004 / OPS-003 — the monitoring seam a wrapped 500 is reported
   * through. Defaults to lib/monitoring/capture.ts captureApiHandlerFailure
   * (Sentry.captureException tagged with the static route label); tests inject
   * a spy. Before this, the catch only console.error'd, so a Prisma outage
   * behind any wrapped route was a generic 500 nobody was told about.
   */
  capture?: (context: string, error: unknown) => void;
}

export function withApiHandler<T extends unknown[]>(
  handler: RouteHandler<T>,
  context: string,
  deps: ApiHandlerDeps = {},
): RouteHandler<T> {
  const capture = deps.capture ?? captureApiHandlerFailure;
  return async (req: NextRequest, ...args: T): Promise<NextResponse> => {
    try {
      return await handler(req, ...args);
    } catch (err) {
      console.error(`[api] ${context} unhandled error:`, err);
      try { capture(context, err); } catch { /* monitoring never turns one 500 into another */ }
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 },
      );
    }
  };
}
