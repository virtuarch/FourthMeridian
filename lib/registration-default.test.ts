/**
 * lib/registration-default.test.ts — SEC-008: an absent `registration_mode`
 * row means invite_only, and an uninvited registration is refused under it.
 *
 * Executes the REAL getRegistrationMode() / resolveRegistrationPolicy() with
 * the platform-setting read faked (null row, garbage row, explicit rows), then
 * pins the register route's refusal of an invite-less request in invite_only.
 *
 *     npx tsx --require ./scripts/lib/server-only-preload.cjs lib/registration-default.test.ts
 */

process.env.DATABASE_URL ??= "postgresql://none:none@127.0.0.1:1/none"; // never connected: the read is faked below

import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

let row: { value: string } | null = null;
let reads = 0;
const fakePlatformSetting = {
  async findUnique(args: { where: { key?: string } }) {
    reads++;
    return args?.where?.key === "registration_mode" ? row : null;
  },
};

async function main() {
  const { db, systemDb } = await import("@/lib/db");
  Object.defineProperty(db, "platformSetting", { value: fakePlatformSetting, configurable: true });
  // validateInvite reads BetaAccessRequest through systemDb; no token is ever passed below,
  // but pin the fake anyway so a regression that looks one up is a loud failure, not a connection.
  Object.defineProperty(systemDb, "betaAccessRequest", {
    value: { async findFirst() { throw new Error("invite lookup must not run without a token"); } },
    configurable: true,
  });
  const { getRegistrationMode, DEFAULT_REGISTRATION_MODE, REGISTRATION_MODES } = await import("@/lib/platform-settings");
  const { resolveRegistrationPolicy, decideRegistrationPolicy } = await import("@/lib/registration-policy");

  console.log("registration default (SEC-008)\n\nA. getRegistrationMode()");
  check("the code default is invite_only", DEFAULT_REGISTRATION_MODE === "invite_only");
  check("…and it is a known mode", (REGISTRATION_MODES as readonly string[]).includes(DEFAULT_REGISTRATION_MODE));

  row = null; reads = 0;
  check("ABSENT row → invite_only (was: open)", (await getRegistrationMode()) === "invite_only" && reads === 1);
  row = { value: "invite-only" };
  check("unrecognised value ('invite-only' typo) → invite_only, never open", (await getRegistrationMode()) === "invite_only");
  row = { value: "" };
  check("blank value → invite_only", (await getRegistrationMode()) === "invite_only");
  row = { value: "open" };
  check("an explicit `open` row is honoured (the operator act)", (await getRegistrationMode()) === "open");
  row = { value: "closed" };
  check("an explicit `closed` row is honoured", (await getRegistrationMode()) === "closed");

  console.log("\nB. the policy a fresh database serves");
  row = null;
  const policy = await resolveRegistrationPolicy(null);
  check("absent row + no invite → the form is gated and the visitor is steered to request-access",
    policy.mode === "invite_only" && policy.canRegister === false && policy.requiresInvite === true, JSON.stringify(policy));
  const noInvite = decideRegistrationPolicy("invite_only", { valid: false, email: null, requestId: null });
  check("invite_only without an invite cannot register", noInvite.canRegister === false);

  console.log("\nC. the register route refuses an uninvited request in invite_only");
  const route = readFileSync(path.join(process.cwd(), "app/api/auth/register/route.ts"), "utf8")
    .replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  check("route resolves the mode through getRegistrationMode() (the one default)", route.includes("await getRegistrationMode()"));
  check("invite_only + no inviteToken → 403 before any account is created",
    /invitedFlow\s*=\s*registrationMode === "invite_only"/.test(route) &&
    /if \(!inviteToken \|\| typeof inviteToken !== "string"\) \{\s*return NextResponse\.json\([\s\S]{0,200}status: 403/.test(route) &&
    route.indexOf("status: 403") < route.indexOf("$transaction"));
  const settings = readFileSync(path.join(process.cwd(), "lib/platform-settings.ts"), "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  check("no production fallback to \"open\" remains in lib/platform-settings.ts",
    !/registration_mode:\s*"open"/.test(settings) && !/:\s*"open";/.test(settings));

  if (failures > 0) { console.error(`\nregistration-default: ${failures} check(s) failed.`); process.exit(1); }
  console.log("\nregistration-default: all checks passed.");
}
main().catch((e) => { console.error(e); process.exit(1); });
