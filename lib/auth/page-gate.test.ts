/**
 * lib/auth/page-gate.test.ts — SEC-001: a TOTP-pending session cannot render
 * a server page outside its enrolment surface.
 *
 * PART A — the pure decision (executed).
 * PART B — source pins: both layouts AND the admin overview page call the
 *          server gate AFTER their session/role checks; the gate reads the
 *          proxy-stamped header through the return-to validator; the
 *          enrolment-surface prefixes equal proxy.ts's allow-list.
 *
 * Layouts cannot be rendered under a bare tsx script (next/headers, Prisma),
 * which is why the decision is pure and the wiring is pinned.
 *
 *     npx tsx lib/auth/page-gate.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { UserRole } from "@prisma/client";
import {
  ADMIN_TOTP_ENROLLMENT_SURFACE,
  USER_TOTP_ENROLLMENT_SURFACE,
  decideTotpPageGate,
  isTotpEnrollmentSurface,
  pathnameOf,
} from "./page-gate";
import { ADMIN_TOTP_ENROLLMENT_PATH, USER_TOTP_ENROLLMENT_PATH } from "@/lib/admin-totp-enrollment";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const src  = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
// Line comments FIRST: a `//` comment mentioning `/admin/*` would otherwise
// open a phantom block comment that swallows the code after it.
const code = (rel: string) => src(rel).replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

const ADMIN = UserRole.SYSTEM_ADMIN;
const USER  = UserRole.USER;

console.log("page-gate (SEC-001)");

// ── A. the pure decision ──────────────────────────────────────────────────────
console.log("\nA. decision");
check("not pending → render, whatever the path",
  decideTotpPageGate({ requireTotpSetup: false, role: ADMIN, pathname: "/admin" }).kind === "render" &&
  decideTotpPageGate({ requireTotpSetup: false, role: USER,  pathname: null }).kind === "render");

const pendingAdminOnOverview = decideTotpPageGate({ requireTotpSetup: true, role: ADMIN, pathname: "/admin" });
check("pending SYSTEM_ADMIN on /admin → REDIRECT to the admin enrolment path (the SEC-001 reproduction)",
  pendingAdminOnOverview.kind === "redirect" && pendingAdminOnOverview.to === ADMIN_TOTP_ENROLLMENT_PATH,
  JSON.stringify(pendingAdminOnOverview));
check("pending SYSTEM_ADMIN on /admin/providers (Plaid Items) → redirect",
  decideTotpPageGate({ requireTotpSetup: true, role: ADMIN, pathname: "/admin/providers" }).kind === "redirect");
check("pending SYSTEM_ADMIN on /admin/security → render (the enrolment surface itself)",
  decideTotpPageGate({ requireTotpSetup: true, role: ADMIN, pathname: "/admin/security" }).kind === "render");
check("pending SYSTEM_ADMIN on /admin/securityx (prefix lookalike) → redirect",
  decideTotpPageGate({ requireTotpSetup: true, role: ADMIN, pathname: "/admin/securityx" }).kind === "redirect");
check("pending SYSTEM_ADMIN on the USER enrolment surface → redirect (wrong role's surface)",
  decideTotpPageGate({ requireTotpSetup: true, role: ADMIN, pathname: "/dashboard/settings/security" }).kind === "redirect");

const pendingUser = decideTotpPageGate({ requireTotpSetup: true, role: USER, pathname: "/dashboard/brief" });
check("pending USER on /dashboard/brief → redirect to the user enrolment path",
  pendingUser.kind === "redirect" && pendingUser.to === USER_TOTP_ENROLLMENT_PATH, JSON.stringify(pendingUser));
check("pending USER on /dashboard/settings/security → render",
  decideTotpPageGate({ requireTotpSetup: true, role: USER, pathname: "/dashboard/settings/security" }).kind === "render");
check("pending USER on /dashboard/settings/account → redirect (other settings sections are not the surface)",
  decideTotpPageGate({ requireTotpSetup: true, role: USER, pathname: "/dashboard/settings/account" }).kind === "redirect");
check("pending USER on the ADMIN surface → redirect",
  decideTotpPageGate({ requireTotpSetup: true, role: USER, pathname: "/admin/security" }).kind === "redirect");

check("pending + unknown path (header absent/unsafe) → redirect (FAIL CLOSED)",
  decideTotpPageGate({ requireTotpSetup: true, role: ADMIN, pathname: null }).kind === "redirect" &&
  decideTotpPageGate({ requireTotpSetup: true, role: USER,  pathname: null }).kind === "redirect");

check("isTotpEnrollmentSurface accepts the surface and its sub-paths only",
  isTotpEnrollmentSurface(ADMIN, "/admin/security") && isTotpEnrollmentSurface(ADMIN, "/admin/security/x") &&
  !isTotpEnrollmentSurface(ADMIN, "/admin") && !isTotpEnrollmentSurface(USER, "/dashboard/settings"));

check("pathnameOf strips the query and fragment, keeps the path",
  pathnameOf("/admin/security?setup2fa=true") === "/admin/security" &&
  pathnameOf("/dashboard/brief#x") === "/dashboard/brief" &&
  pathnameOf(null) === null && pathnameOf("admin") === null);

// ── B. wiring pins ────────────────────────────────────────────────────────────
console.log("\nB. wiring");
check("surface constants are the PATH half of the enrolment paths",
  ADMIN_TOTP_ENROLLMENT_PATH.startsWith(`${ADMIN_TOTP_ENROLLMENT_SURFACE}?`) &&
  USER_TOTP_ENROLLMENT_PATH.startsWith(`${USER_TOTP_ENROLLMENT_SURFACE}?`));

const proxy = code("proxy.ts");
check("proxy.ts's pending allow-list is exactly these two prefixes",
  proxy.includes(`pathname.startsWith("${USER_TOTP_ENROLLMENT_SURFACE}")`) &&
  proxy.includes(`pathname.startsWith("${ADMIN_TOTP_ENROLLMENT_SURFACE}")`));

const gate = code("lib/auth/totp-page-gate.ts");
check("the server gate reads RETURN_TO_HEADER through validateReturnTo (never a raw header)",
  gate.includes("validateReturnTo((await headers()).get(RETURN_TO_HEADER))"));
check("the server gate delegates to the pure decision and redirects on its verdict",
  gate.includes("decideTotpPageGate(") && /if \(decision\.kind === "redirect"\) redirect\(decision\.to\)/.test(gate));
check("the server gate keys on session.requireTotpSetup (the DB-derived flag)",
  gate.includes("if (!session.requireTotpSetup) return;"));

const SITES: Array<[string, string]> = [
  ["app/admin/layout.tsx",               'if (session.user.role !== "SYSTEM_ADMIN") redirect("/dashboard");'],
  ["app/admin/page.tsx",                 'if (!session || session.user.role !== "SYSTEM_ADMIN") redirect("/dashboard");'],
  ["app/(shell)/dashboard/layout.tsx",   "if (!session?.user?.id) return redirectToLogin();"],
];
for (const [rel, guard] of SITES) {
  const body = code(rel);
  const guardAt = body.indexOf(guard);
  const gateAt  = body.indexOf("await enforceTotpPageGate(session)");
  check(`${rel} imports the server gate`, body.includes('from "@/lib/auth/totp-page-gate"'));
  check(`${rel} calls enforceTotpPageGate AFTER its session guard`,
    guardAt !== -1 && gateAt !== -1 && guardAt < gateAt, `guard@${guardAt} gate@${gateAt}`);
}
// The admin overview composes the inventory in one Promise.all — the gate must precede it.
const adminPage = code("app/admin/page.tsx");
check("app/admin/page.tsx gates BEFORE db.user.findMany (the inventory never composes for a pending session)",
  adminPage.indexOf("await enforceTotpPageGate(session)") < adminPage.indexOf("db.user.findMany"));

if (failures > 0) { console.error(`\npage-gate: ${failures} check(s) failed.`); process.exit(1); }
console.log("\npage-gate: all checks passed.");
