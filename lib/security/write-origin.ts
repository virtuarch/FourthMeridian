/**
 * lib/security/write-origin.ts — the browser-write Origin boundary for /api/**.
 *
 * WHY SameSite IS NOT ENOUGH. The session cookie is SameSite=Lax. "Site" means
 * registrable domain, so fourthmeridian.com, app.fourthmeridian.com,
 * preview.fourthmeridian.com and preview-app.fourthmeridian.com are all the
 * SAME site: a page on any of them can send a credentialed POST to any other
 * and the browser attaches the cookies. Today that sibling is Preview (branch
 * code) beside Production; after the split it is the public website beside the
 * app. Host-only `__Host-` cookies stop a sibling PLANTING a session; they do
 * not stop a sibling's page USING the victim's session. This check does.
 *
 * THE RULE — a state-changing request is accepted only from the deployment's
 * OWN origin:
 *   - safe methods (GET, HEAD, OPTIONS) are not judged here;
 *   - MACHINE_WRITE_PATHS (provider webhooks) are not judged here — they carry
 *     no browser cookie authority and authenticate by signature;
 *   - `Origin` present  ⇒ it must equal the request's own origin exactly
 *     (scheme + host + port). `Origin: null` is refused;
 *   - `Origin` absent, `Sec-Fetch-Site` present ⇒ it must be "same-origin";
 *   - both absent ⇒ allowed: not a browser. Every current browser sends Origin
 *     on a cross-origin POST/PUT/PATCH/DELETE, so a forged cross-site write
 *     always arrives WITH one. Server-side callers (scripts/ai-baseline/*,
 *     curl) send neither, and authenticate as themselves.
 *
 * ENVIRONMENT-LOCAL BY CONSTRUCTION. The trusted origin is not configured — it
 * is the origin the request was served on. Production on app.fourthmeridian.com
 * trusts only https://app.fourthmeridian.com; Preview on
 * preview-app.fourthmeridian.com trusts only itself; an ephemeral *.vercel.app
 * deployment trusts only its own URL. No environment can be made to trust
 * another's origin by a missing or copied env var, and a sibling public site
 * is never trusted. (The session cookie is host-only to the same host, so the
 * cookie scope and the write scope coincide.)
 *
 * WHAT THIS IS NOT. It is not authorization — lib/session.ts is. It decides
 * only whether a browser write came from the app's own pages.
 *
 * Pure: no imports. proxy.ts keeps a zero-dependency graph.
 */

/** Methods that must not change state; not judged by this boundary. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Inbound machine-to-machine writes. Each authenticates by its own mechanism
 * and carries no browser cookie authority, so a browser-only CSRF defence must
 * not stand in its way. Exact paths only — never a prefix.
 *
 *   /api/plaid/webhook — Plaid; verified by the `plaid-verification` JWT
 *                        (app/api/plaid/webhook/route.ts).
 *
 * Cron (/api/jobs/*) is GET with `Authorization: Bearer CRON_SECRET` and is
 * therefore already outside this check; it needs no entry.
 */
export const MACHINE_WRITE_PATHS: readonly string[] = ["/api/plaid/webhook"];

export type WriteOriginVerdict =
  | { allowed: true; basis: "safe-method" | "machine-path" | "same-origin" | "sec-fetch-same-origin" | "non-browser" }
  | { allowed: false; reason: "origin-mismatch" | "origin-null" | "cross-site-fetch" };

export interface WriteOriginInput {
  method: string;
  pathname: string;
  /** The origin the browser addressed (selfOriginOf), or null if unknown. */
  selfOrigin: string | null;
  /** The `Origin` request header, or null when absent. */
  origin: string | null;
  /** The `Sec-Fetch-Site` request header, or null when absent. */
  secFetchSite: string | null;
}

function normaliseOrigin(o: string): string | null {
  try {
    const u = new URL(o);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

export function evaluateWriteOrigin(input: WriteOriginInput): WriteOriginVerdict {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return { allowed: true, basis: "safe-method" };
  if (MACHINE_WRITE_PATHS.includes(input.pathname)) return { allowed: true, basis: "machine-path" };

  if (input.origin !== null) {
    if (input.origin.trim().toLowerCase() === "null") return { allowed: false, reason: "origin-null" };
    const claimed = normaliseOrigin(input.origin);
    const self = input.selfOrigin === null ? null : normaliseOrigin(input.selfOrigin);
    if (claimed !== null && self !== null && claimed === self) return { allowed: true, basis: "same-origin" };
    return { allowed: false, reason: "origin-mismatch" };
  }

  if (input.secFetchSite !== null) {
    return input.secFetchSite.toLowerCase() === "same-origin"
      ? { allowed: true, basis: "sec-fetch-same-origin" }
      : { allowed: false, reason: "cross-site-fetch" };
  }

  return { allowed: true, basis: "non-browser" };
}

/**
 * The origin the BROWSER addressed: scheme + Host as received.
 *
 * Deliberately not `req.nextUrl.origin`: a self-hosted Next server builds that
 * from its own bind hostname and port (next-server.js attachRequestMeta), so a
 * browser on 127.0.0.1 — or any proxy-fronted host — would be refused for
 * every write. The Host header is what the browser sent, and a cross-site page
 * cannot forge it (nor X-Forwarded-Host: a custom header forces a CORS
 * preflight this app never answers; on Vercel the platform sets it). The
 * first entry of a comma-joined forwarded header wins. No host ⇒ null, and
 * any write that carries an Origin is then refused (fail closed).
 */
export function selfOriginOf(
  headers: { get(name: string): string | null },
  fallbackProtocol: string,
): string | null {
  const first = (v: string | null) => (v ?? "").split(",")[0].trim();
  const host = first(headers.get("x-forwarded-host")) || first(headers.get("host"));
  if (!host) return null;
  const proto = (first(headers.get("x-forwarded-proto")) || fallbackProtocol).replace(/:$/, "").toLowerCase();
  if (proto !== "https" && proto !== "http") return null;
  return `${proto}://${host.toLowerCase()}`;
}

/** Body of the 403 a refused write receives — distinct from every authz error. */
export const WRITE_ORIGIN_REFUSED_ERROR = "cross_origin_write_refused";
