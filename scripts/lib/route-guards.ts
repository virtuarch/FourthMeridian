/**
 * scripts/lib/route-guards.ts — TEST-002, the route-guard CENSUS (pure).
 *
 * The question: does every exported handler of every `app/api/**\/route.ts`
 * pass through an authorization guard before it does anything? Before this
 * census the answer was "by review": 187 route files, 6 route tests, and no
 * statement anywhere that a new route cannot ship without a guard.
 *
 * What counts as a guard is CLOSED and named here, never inferred:
 *   · the session guards in lib/session.ts — requireUser, requireFreshUser,
 *     requireSystemAdmin, requireFreshSystemAdmin, requireSpaceRole;
 *   · the Space / platform authorization guards — requireSpaceAction,
 *     requirePlatformAccess, requireFreshPlatformAccess;
 *   · the CRON bearer check (`process.env.CRON_SECRET` compared against an
 *     `Authorization: Bearer` header) on the job routes;
 *   · the Plaid webhook signature verifier (verifyPlaidWebhook / the receiver
 *     that calls it) on the webhook route;
 *   · the NextAuth handler itself (the `[...nextauth]` catch-all);
 *   · an explicit `// PUBLIC: <reason>` annotation in the route file, for a
 *     route that is unauthenticated BY DESIGN (registration, password reset,
 *     health, token-credential confirmations). The reason is mandatory.
 *
 * A guard may be DELEGATED one hop: a route whose handler calls into a sibling
 * module (`./handlers`, `./deps`, `../x`) is credited with the guard that
 * module names, so the seam pattern (app/api/ai/memory) stays auditable
 * without rewriting it. Two hops are not followed — a guard that far away is
 * a guard the route is not visibly responsible for.
 *
 * Guards are matched on COMMENT-STRIPPED source so a comment that mentions
 * `requireUser` cannot satisfy the census; the PUBLIC annotation is matched on
 * the raw source because it IS a comment.
 *
 * Per-method: each exported HTTP method (GET/POST/PUT/PATCH/DELETE/HEAD/
 * OPTIONS) is checked on its own block — from its `export` to the next
 * top-level `export` — or, when it is `export { fn as GET }` / `export const
 * GET = fn`, on the body of the local function it names. A route with two
 * methods of which only one is guarded is a finding, not a pass.
 *
 * PUBLIC_ROUTES is the closed allowlist of the routes that were public before
 * this census existed and whose files belong to other owners during the
 * remediation wave. It is EXACT: an entry whose file is gone, or whose file
 * now carries a guard or its own `// PUBLIC:` annotation, fails the audit so
 * the list can only shrink deliberately. New public routes use the in-file
 * annotation; nothing is added here.
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, relative, resolve, sep } from "node:path";

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** The named session / Space / platform guards (lib/session.ts, lib/spaces, lib/platform). */
export const SESSION_GUARDS = [
  "requireUser", "requireFreshUser", "requireSystemAdmin", "requireFreshSystemAdmin",
  "requireSpaceRole", "requireSpaceAction", "requirePlatformAccess", "requireFreshPlatformAccess",
] as const;

/** Every recogniser, named. Order is irrelevant; any one satisfies a block. */
export const GUARD_RECOGNISERS: ReadonlyArray<{ name: string; test: (strippedSource: string) => boolean }> = [
  ...SESSION_GUARDS.map((g) => ({ name: g, test: (s: string) => new RegExp(`\\b${g}\\s*\\(`).test(s) })),
  {
    name: "cron-bearer",
    // The job routes compare the request's Authorization header against
    // CRON_SECRET; both halves must be present in the same block.
    test: (s) => /process\.env\.CRON_SECRET\b/.test(s) && /Bearer/.test(s),
  },
  // SEC-009: the job routes delegate the bearer comparison to the timing-safe
  // helper (lib/jobs/cron-auth.ts → lib/security/cron-secret.ts).
  { name: "cron-bearer-helper", test: (s) => /\bisAuthorizedCronRequest\s*\(/.test(s) && /process\.env\.CRON_SECRET\b/.test(s) },
  { name: "plaid-webhook-verifier", test: (s) => /\b(verifyPlaidWebhook|handlePlaidWebhook)\s*\(/.test(s) },
  { name: "nextauth-handler", test: (s) => /\bNextAuth\s*\(/.test(s) },
];

/** `// PUBLIC: <reason>` — reason mandatory (≥ 12 characters), on its own comment line. */
export const PUBLIC_ANNOTATION = /^\s*\/\/\s*PUBLIC:\s*(.{12,})$/m;

/**
 * Routes public by design before the census existed (2026-10-22), with the
 * reason each would carry as an in-file annotation. Paths are repo-relative,
 * POSIX separators. See the header for the exactness rule.
 */
export const PUBLIC_ROUTES: Readonly<Record<string, string>> = {
  "app/api/access-request/route.ts":
    "beta access request intake — the visitor has no account yet; rate-limited per IP, Turnstile-gated",
  "app/api/auth/forgot-password/route.ts":
    "password reset request — logged-out flow by definition; constant-time response, rate-limited",
  "app/api/auth/pre-login/route.ts":
    "advisory pre-login probe before NextAuth signIn — creates no session; rate-limited per IP and id",
  "app/api/auth/register/route.ts":
    "account registration — governed by registration_mode + invite token, rate-limited; no session exists yet",
  "app/api/auth/reset-password/route.ts":
    "consumes a single-use hashed reset token — the token is the credential; revokes all sessions after",
  "app/api/auth/verify-email/resend/route.ts":
    "re-sends the verification mail by token or identifier — rotates the token; rate-limited per IP",
  "app/api/auth/verify-email/route.ts":
    "consumes a hashed email-verification token — the token is the credential; grants nothing else",
  "app/api/health/route.ts":
    "unauthenticated uptime probe for external monitoring — exposes status, db ok, short commit only; rate-limited",
  "app/api/registration-policy/route.ts":
    "public read of the registration mode so the register page can render — token-bound email only to its holder",
  "app/api/user/email/confirm/route.ts":
    "consumes the hashed email-change token, usually logged out — the token is the credential; revokes sessions",
};

export interface MethodFinding { file: string; method: HttpMethod; reason: string }
export interface RouteGuardReport {
  routes: number;
  methods: number;
  guarded: number;          // method count satisfied by a recogniser (direct or delegated)
  publicByAnnotation: string[];
  publicByAllowlist: string[];
  findings: MethodFinding[];
  allowlistErrors: string[];
}

/** Strip line and block comments. Good enough for guard-token detection; not a parser. */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

/** Which recognisers a piece of (stripped) source satisfies. */
export function recognisedGuards(stripped: string): string[] {
  return GUARD_RECOGNISERS.filter((r) => r.test(stripped)).map((r) => r.name);
}

/** The exported HTTP methods of a route file and, per method, the source to inspect. */
export function exportedMethods(stripped: string): Array<{ method: HttpMethod; block: string }> {
  const out: Array<{ method: HttpMethod; block: string }> = [];
  const isMethod = (m: string): m is HttpMethod => (HTTP_METHODS as readonly string[]).includes(m);

  // Top-level export positions, to bound each method's own block.
  const exportRe = /^export\s/gm;
  const exportStarts = [...stripped.matchAll(exportRe)].map((m) => m.index ?? 0);
  const blockFrom = (i: number) => {
    const next = exportStarts.find((p) => p > i);
    return stripped.slice(i, next ?? stripped.length);
  };

  // Local function bodies by name, for `export { fn as GET }` / `export const GET = fn`.
  const localBody = (name: string): string => {
    const declRe = new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(|^(?:export\\s+)?const\\s+${name}\\s*=`, "m");
    const m = declRe.exec(stripped);
    if (!m) return "";
    return blockFrom(m.index);
  };

  // export async function GET(...) / export function GET(...)
  for (const m of stripped.matchAll(/^export\s+(?:async\s+)?function\s+([A-Z]+)\s*\(/gm)) {
    if (isMethod(m[1])) out.push({ method: m[1], block: blockFrom(m.index ?? 0) });
  }
  // export const GET = <expr>
  for (const m of stripped.matchAll(/^export\s+const\s+([A-Z]+)\s*=\s*([A-Za-z_$][\w$]*)?/gm)) {
    if (!isMethod(m[1])) continue;
    const block = blockFrom(m.index ?? 0);
    // `export const GET = handler;` — a bare identifier: inspect its body too.
    const bare = m[2] && new RegExp(`^export\\s+const\\s+${m[1]}\\s*=\\s*${m[2]}\\s*;?\\s*$`, "m").test(block.split("\n")[0] + "\n");
    out.push({ method: m[1], block: bare ? block + "\n" + localBody(m[2]!) : block });
  }
  // export { handler as GET, handler as POST }
  for (const m of stripped.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const [local, alias] = part.trim().split(/\s+as\s+/).map((s) => s.trim());
      const name = alias ?? local;
      if (local && isMethod(name)) out.push({ method: name, block: localBody(local) });
    }
  }
  return out;
}

/** Relative imports of a route (`./x`, `../x`) resolved to existing .ts files — one hop. */
export function siblingImports(routeFile: string, stripped: string): string[] {
  const dir = dirname(routeFile);
  const out: string[] = [];
  for (const m of stripped.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const base = resolve(dir, m[1]);
    for (const cand of [base + ".ts", join(base, "index.ts")]) {
      if (existsSync(cand) && statSync(cand).isFile()) { out.push(cand); break; }
    }
  }
  return out;
}

/** Every app/api/**\/route.ts under `root`, repo-relative with POSIX separators, sorted. */
export function routeFiles(root: string): string[] {
  const apiDir = join(root, "app", "api");
  if (!existsSync(apiDir)) return [];
  const found: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === "route.ts") found.push(relative(root, full).split(sep).join("/"));
    }
  };
  walk(apiDir);
  return found.sort();
}

/**
 * The census. `root` is the repository root (or a fixture tree with its own
 * app/api). `publicRoutes` defaults to PUBLIC_ROUTES; a fixture passes its own.
 */
export function auditRouteGuards(root: string, publicRoutes: Readonly<Record<string, string>> = PUBLIC_ROUTES): RouteGuardReport {
  const files = routeFiles(root);
  const report: RouteGuardReport = {
    routes: files.length, methods: 0, guarded: 0,
    publicByAnnotation: [], publicByAllowlist: [], findings: [], allowlistErrors: [],
  };
  const seen = new Set<string>();

  for (const rel of files) {
    const abs = join(root, rel);
    const raw = readFileSync(abs, "utf8");
    const stripped = stripComments(raw);
    const annotated = PUBLIC_ANNOTATION.test(raw);
    const listed = Object.prototype.hasOwnProperty.call(publicRoutes, rel);
    const fileGuards = recognisedGuards(stripped);
    const delegated = siblingImports(abs, stripped)
      .flatMap((f) => recognisedGuards(stripComments(readFileSync(f, "utf8"))));
    const methods = exportedMethods(stripped);
    report.methods += methods.length;

    if (methods.length === 0 && fileGuards.length === 0 && !annotated && !listed) {
      report.findings.push({ file: rel, method: "GET", reason: "exports no recognisable HTTP method and names no guard" });
      continue;
    }

    if (listed) {
      seen.add(rel);
      if (fileGuards.length > 0) {
        report.allowlistErrors.push(`${rel} is in PUBLIC_ROUTES but now calls a guard (${fileGuards.join(", ")}) — remove it from the allowlist`);
      } else if (annotated) {
        report.allowlistErrors.push(`${rel} is in PUBLIC_ROUTES and also carries its own // PUBLIC: annotation — remove it from the allowlist`);
      } else {
        report.publicByAllowlist.push(rel);
      }
      continue;
    }
    if (annotated) {
      report.publicByAnnotation.push(rel);
      if (fileGuards.length > 0) {
        // Not a failure: a route may be public for one method and guarded for
        // another, but it must say so. The annotation makes the author's
        // intent explicit either way.
      }
      continue;
    }

    for (const { method, block } of methods) {
      const own = recognisedGuards(block);
      if (own.length > 0 || delegated.length > 0) { report.guarded++; continue; }
      // A method whose block names a local helper that carries the guard.
      const helpers = [...block.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]);
      const viaHelper = helpers.some((h) => {
        const decl = new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${h}\\s*\\(|^(?:export\\s+)?const\\s+${h}\\s*=`, "m").exec(stripped);
        if (!decl) return false;
        const next = stripped.slice(decl.index).search(/\n(?:export\s|(?:async\s+)?function\s|const\s)/);
        const body = stripped.slice(decl.index, next < 0 ? undefined : decl.index + next + 1);
        return recognisedGuards(body).length > 0;
      });
      if (viaHelper) { report.guarded++; continue; }
      report.findings.push({
        file: rel, method,
        reason: `no recognised guard in its handler (direct, delegated one hop, or via a local helper) and no // PUBLIC: <reason> annotation`,
      });
    }
  }

  for (const rel of Object.keys(publicRoutes)) {
    if (!seen.has(rel)) report.allowlistErrors.push(`${rel} is in PUBLIC_ROUTES but no such route exists — remove the entry`);
  }
  return report;
}
