/**
 * lib/admin-totp-enrollment-surface.test.ts
 *
 * PO-1A — SOURCE-SCAN companion to admin-totp-enrollment.test.ts (house
 * pattern, same shape as lib/security-surface.test.ts): reads module source as
 * text and asserts the enrolment structure cannot silently regress.
 *
 * The pure tests prove the RULES are right. These prove production still uses
 * them — and, critically, that the enrolment surface never re-acquires a
 * dependency on gated admin data. That dependency is the entire bug: it is
 * invisible to a unit test because nothing about it is wrong in isolation. It
 * only deadlocks when a pending session meets a 403 on the one page it is
 * permitted to visit.
 *
 * Covers:
 *   1. The admin security APIs are still guarded — nothing weakened.
 *   2. /api/user/totp/* are the ONLY pending-session APIs.
 *   3. The guards delegate to the tested rule.
 *   4. /admin/security resolves enrolment BEFORE composing gated data.
 *   5. No loading dead-end: the enrolment surface fetches no gated endpoint
 *      and can hand control back once enrolment completes.
 *   6. The settings loaders no longer bypass the gate.
 *   7. proxy.ts and the path constants agree.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  ADMIN_TOTP_ENROLLMENT_PATH,
  USER_TOTP_ENROLLMENT_PATH,
} from "@/lib/admin-totp-enrollment";

const ROOT = process.cwd();
const src = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/**
 * Source with comments removed. The "surface X never calls Y" assertions below
 * must test CODE, not prose — these files necessarily *discuss* the endpoints
 * they must not call, and a naive substring scan reads a doc comment explaining
 * the deadlock as the deadlock itself.
 */
const code = (rel: string) =>
  src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")   // block comments
    .replace(/^\s*\/\/.*$/gm, "");      // line comments

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("admin-totp-enrollment surface (PO-1A)");

// ── 1. The admin security APIs are still guarded ──────────────────────────────
console.log("\n1. Admin security APIs remain guarded");
const ADMIN_SECURITY_ROUTES = [
  "app/api/admin/security/settings/route.ts",
  "app/api/admin/security/admin-status/route.ts",
  "app/api/admin/security/users/route.ts",
  "app/api/admin/security/users/[userId]/recovery-codes/route.ts",
  "app/api/admin/security/users/[userId]/2fa-reset/route.ts",
  "app/api/admin/security/users/[userId]/sessions/route.ts",
];
for (const rel of ADMIN_SECURITY_ROUTES) {
  const body = code(rel);
  check(
    `${rel} calls a SYSTEM_ADMIN guard`,
    /require(Fresh)?SystemAdmin\(/.test(body),
  );
  check(
    `${rel} does NOT opt out of the enrolment gate`,
    !body.includes("allowTotpSetupPending"),
    "an admin route must never accept a pending session",
  );
}

// ── 2. /api/user/totp/* are the ONLY pending-session APIs ─────────────────────
console.log("\n2. /api/user/totp/* are the only pending-session APIs");
function collectRoutes(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collectRoutes(rel));
    else if (entry.name === "route.ts") found.push(rel);
  }
  return found;
}
const EXPECTED_PENDING_ROUTES = [
  "app/api/user/totp/setup/route.ts",
  "app/api/user/totp/verify/route.ts",
  "app/api/user/totp/status/route.ts",
].sort();

const actualPendingRoutes = collectRoutes("app/api")
  .filter((rel) => code(rel).includes("allowTotpSetupPending"))
  .sort();

check(
  "exactly the three enrolment endpoints accept a pending session",
  JSON.stringify(actualPendingRoutes) === JSON.stringify(EXPECTED_PENDING_ROUTES),
  `found: ${actualPendingRoutes.join(", ") || "(none)"}`,
);
check(
  "every pending-capable route is under /api/user/totp/",
  actualPendingRoutes.every((rel) => rel.startsWith(path.join("app", "api", "user", "totp"))),
);

// ── 3. The guards delegate to the tested rule ────────────────────────────────
console.log("\n3. Session guards delegate to the tested rule");
const session = code("lib/session.ts");
check(
  "lib/session.ts imports decideAdminApiAccess",
  session.includes("decideAdminApiAccess") &&
    session.includes('from "@/lib/admin-totp-enrollment"'),
);
for (const guard of ["requireSystemAdmin", "requireFreshSystemAdmin"]) {
  const start = session.indexOf(`export async function ${guard}(`);
  const body  = session.slice(start, session.indexOf("\n}", start));
  check(
    `${guard} decides via decideAdminApiAccess`,
    start !== -1 && body.includes('decideAdminApiAccess(user) !== "ALLOW"'),
  );
  check(
    `${guard} takes no options parameter (cannot be opted out of the gate)`,
    start !== -1 && session.slice(start).startsWith(`export async function ${guard}(): Promise<`),
  );
}
check(
  "the shared enrolment gate still exists for the non-admin guards",
  session.includes("function totpSetupPending("),
);

// ── 4. /admin/security resolves enrolment BEFORE gated data ──────────────────
console.log("\n4. /admin/security resolves enrolment before composing gated data");
const page = code("app/admin/security/page.tsx");
check(
  "the route is a server component (no \"use client\")",
  !page.includes('"use client"'),
  "the phase must resolve server-side, before any client fetch is mounted",
);
check(
  "it branches on resolveAdminTotpPhase",
  page.includes("resolveAdminTotpPhase"),
);
check(
  "the ENROLLING branch returns the enrolment surface",
  /phase === "ENROLLING"[\s\S]{0,80}AdminTotpEnrollment/.test(page),
);
check(
  "the enrolment branch returns BEFORE the console is reached",
  page.indexOf("AdminTotpEnrollment") < page.indexOf("<AdminSecurityConsole"),
);
check(
  "the route itself fetches no admin data",
  !code("app/admin/security/page.tsx").includes("/api/admin/"),
);

// ── 5. No loading dead-end ───────────────────────────────────────────────────
console.log("\n5. No loading dead-end on the enrolment surface");
const enrollment = code("components/admin/AdminTotpEnrollment.tsx");
check(
  "the enrolment surface calls NO admin endpoint",
  !code("components/admin/AdminTotpEnrollment.tsx").includes("/api/admin/"),
  "any gated fetch here recreates the deadlock",
);
check(
  "the enrolment surface issues no fetch of its own at all",
  !/\bfetch\s*\(/.test(code("components/admin/AdminTotpEnrollment.tsx")),
  "all enrolment I/O must go through TotpSection's /api/user/totp/* calls",
);
check(
  "the enrolment surface renders the enrolment widget",
  enrollment.includes("<TotpSection"),
);
check(
  "it forces enforced mode rather than trusting the setup2fa query param",
  /<TotpSection[^>]*\senforced\b/.test(enrollment),
);
check(
  "it re-resolves the surface once enrolment completes",
  enrollment.includes("onEnrolled") && enrollment.includes("router.refresh()"),
  "without this the admin is stranded on the enrolment screen after enrolling",
);

const totp = code("components/dashboard/TotpSection.tsx");
check(
  "TotpSection fires onEnrolled AFTER clearing the pending flag",
  totp.indexOf("updateSession({ requireTotpSetup: false })") < totp.indexOf("onEnrolled?.()"),
  "refreshing before the JWT updates would re-resolve ENROLLING and bounce back",
);
check(
  "TotpSection's enforced prop ORs with the query param (existing callers unchanged)",
  totp.includes('enforcedProp || searchParams.get("setup2fa") === "true"'),
);

const console_ = code("components/admin/AdminSecurityConsole.tsx");
check(
  "the console still gates its own body on adminStatus (unchanged)",
  console_.includes("!adminStatus ?"),
);
check(
  "…but is no longer the surface a pending admin lands on",
  !page.includes("AdminSecurityConsole") || page.includes("ENROLLING"),
);

// ── 5b. Exactly one enrolment entry point ────────────────────────────────────
console.log("\n5b. Exactly one enrolment entry point for a pending SYSTEM_ADMIN");

// Every file that RENDERS the enrolment widget. Three is correct; what matters
// is which are reachable while pending.
const RENDER_SITES = [
  "components/admin/AdminTotpEnrollment.tsx",  // pending SYSTEM_ADMIN — the entry point
  "components/admin/AdminSecurityConsole.tsx", // enrolled SYSTEM_ADMIN — ongoing management
  "components/settings/SecuritySettings.tsx",  // USER — proxy.ts never routes a SYSTEM_ADMIN here
];
const actualRenderSites = ["app", "components"]
  .flatMap((root) => {
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const e of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...walk(rel));
        else if (e.name.endsWith(".tsx") && code(rel).includes("<TotpSection")) out.push(rel);
      }
      return out;
    };
    return walk(root);
  })
  .sort();

check(
  "the enrolment widget renders in exactly the three known places",
  JSON.stringify(actualRenderSites) === JSON.stringify([...RENDER_SITES].sort()),
  `found: ${actualRenderSites.join(", ")}`,
);
// The console is gated behind phase ENROLLED (section 4). SecuritySettings
// lives under /dashboard, and proxy.ts bounces every SYSTEM_ADMIN off
// /dashboard/* to /admin BEFORE its TOTP block runs — so a SYSTEM_ADMIN,
// pending or not, never reaches it.
//
// Both landmarks are asserted PRESENT before their order is compared: a bare
// indexOf comparison passes vacuously when a pattern goes missing (-1 < n), so
// deleting the redirect would silently satisfy an order-only check.
const proxySrc      = code("proxy.ts");
const roleRedirectI = proxySrc.indexOf('token.role === "SYSTEM_ADMIN" && pathname.startsWith("/dashboard")');
const totpBlockI    = proxySrc.indexOf("token.requireTotpSetup && !totpSetupAllowed");
check(
  "proxy.ts still bounces every SYSTEM_ADMIN off /dashboard/*",
  roleRedirectI !== -1,
  "without this, /dashboard/settings/security becomes a second entry point",
);
check(
  "proxy.ts still has its forced-enrolment block",
  totpBlockI !== -1,
);
check(
  "the ONLY surface a pending SYSTEM_ADMIN can reach is the enrolment surface",
  roleRedirectI !== -1 && totpBlockI !== -1 && roleRedirectI < totpBlockI,
  "the role redirect must precede the TOTP block, or /dashboard/settings/security becomes a second entry point",
);
check(
  "the admin enrolment surface has no sub-routes that could bypass the phase check",
  readdirSync(path.join(ROOT, "app/admin/security")).join(",") === "page.tsx",
);

// ── 5c. No duplicate 2FA state ───────────────────────────────────────────────
console.log("\n5c. No duplicate 2FA state");
check(
  "the console does NOT read 2FA facts from the admin-status endpoint",
  !console_.includes("adminStatus.totpEnabled") &&
    !console_.includes("adminStatus.recoveryCodesRemaining"),
  "two sources refreshed on different events go stale against each other",
);
check(
  "the console derives 2FA state from TotpSection, the component that mutates it",
  console_.includes("<TotpSection onStatusChange={setTotpStatus}"),
);
check(
  "TotpSection publishes status on every resolved read",
  totp.includes("onStatusChangeRef.current?.(data)"),
);
check(
  "the status callback is held in a ref (an inline arrow must not re-trigger the fetch loop)",
  totp.includes("const onStatusChangeRef = useRef(onStatusChange)") &&
    /const fetchStatus = useCallback\([\s\S]*?\}, \[\]\);/.test(totp),
);

// ── 6. The settings loaders no longer bypass the gate ────────────────────────
console.log("\n6. Settings loaders honour the enrolment gate");
const loaders = code("lib/settings/loaders.ts");
check(
  "requireUserId checks the pending flag",
  /requireTotpSetup && !opts\?\.allowTotpSetupPending/.test(loaders),
);
check(
  "pending users are redirected to their role's enrolment surface",
  loaders.includes("totpEnrollmentPathFor(session.user.role)"),
);
check(
  "ONLY getSecurity opts out (it hosts the enrolment widget)",
  (loaders.match(/allowTotpSetupPending: true/g) ?? []).length === 1 &&
    /getSecurity[\s\S]{0,400}allowTotpSetupPending: true/.test(loaders),
);

// ── 7. proxy.ts agrees with the path constants ───────────────────────────────
console.log("\n7. proxy.ts agrees with the enrolment path constants");
const proxy = code("proxy.ts");
check(
  "proxy redirects SYSTEM_ADMIN to ADMIN_TOTP_ENROLLMENT_PATH",
  proxy.includes(`"${ADMIN_TOTP_ENROLLMENT_PATH}"`),
  `expected ${ADMIN_TOTP_ENROLLMENT_PATH}`,
);
check(
  "proxy redirects USER/ADMIN to USER_TOTP_ENROLLMENT_PATH",
  proxy.includes(`"${USER_TOTP_ENROLLMENT_PATH}"`),
  `expected ${USER_TOTP_ENROLLMENT_PATH}`,
);
check(
  "proxy no longer tests /api paths its matcher can never see",
  !proxy.includes('pathname.startsWith("/api/'),
  "dead branches: the matcher is scoped to /dashboard/* and /admin/*",
);
check(
  "the matcher is still page-only",
  /matcher:\s*\[\s*"\/dashboard\/:path\*",\s*"\/admin\/:path\*",?\s*\]/.test(proxy),
);
check(
  "the pending allow-list is narrowed to the enrolment sections",
  proxy.includes('pathname.startsWith("/dashboard/settings/security")') &&
    !proxy.includes('pathname.startsWith("/dashboard/settings")'),
);

if (failures > 0) {
  console.error(`\nadmin-totp-enrollment surface: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nadmin-totp-enrollment surface: all checks passed.");
