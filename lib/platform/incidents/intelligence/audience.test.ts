/**
 * lib/platform/incidents/intelligence/audience.test.ts  (PB-1 Phase 2 — the tier gate)
 *
 * The audience is an unforgeable token: minted only from a guard result, the
 * SYSTEM token only for lib/alerts/, and the pure core told "CUSTOMER_SUCCESS"
 * only by the accessors / minter.
 *
 * Run: npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/incidents/intelligence/audience.test.ts
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { UserRole } from "@prisma/client";
import { assertAudienceToken, incidentAudienceFor, systemIncidentAudience, IncidentAudienceError } from "./audience";
import type { CoreAudience, IncidentAudience } from "./types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const throws = (f: () => unknown) => { try { f(); return false; } catch (e) { return e instanceof IncidentAudienceError; } };

const ROOT = process.cwd();
const code = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
function walk(dir: string, out: string[] = []): string[] {
  let entries;
  try { entries = readdirSync(path.join(ROOT, dir), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".next") continue;
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(rel);
  }
  return out;
}

console.log("1. minting follows the route's guard result, never more");
{
  const ops = incidentAudienceFor({ user: { role: UserRole.USER }, grant: { area: "PLATFORM_OPS", level: "READ" } });
  const cs = incidentAudienceFor({ user: { role: UserRole.USER }, grant: { area: "CUSTOMER_SUCCESS", level: "READ" } });
  const sa = incidentAudienceFor({ user: { role: UserRole.SYSTEM_ADMIN }, grant: null });
  check("a PLATFORM_OPS grant mints a PLATFORM_OPS token — never a CS one", ops?.audience === "PLATFORM_OPS");
  check("a CUSTOMER_SUCCESS grant mints a CS token", cs?.audience === "CUSTOMER_SUCCESS");
  check("SYSTEM_ADMIN break-glass mints a CS token (lead decision: SA already has CS READ)", sa?.audience === "CUSTOMER_SUCCESS");
  check("a non-admin with no grant gets nothing", incidentAudienceFor({ user: { role: UserRole.USER }, grant: null }) === null);
  check("another area's grant gets nothing", incidentAudienceFor({ user: { role: UserRole.USER }, grant: { area: "SECURITY_OPS", level: "CONTROL" } }) === null);
  check("tokens are frozen", Object.isFrozen(ops));
  check("a level below READ (or unknown) mints nothing",
    incidentAudienceFor({ user: { role: UserRole.USER }, grant: { area: "CUSTOMER_SUCCESS", level: "NONE" as never } }) === null
    && incidentAudienceFor({ user: { role: UserRole.USER }, grant: { area: "PLATFORM_OPS", level: "" as never } }) === null);
  check("every PlatformAccessLevel in the schema is a READ-or-above level",
    (() => { const m = readFileSync("prisma/schema.prisma", "utf8").match(/enum PlatformAccessLevel \{([^}]*)\}/); return !!m && m[1].split(/\s+/).filter(Boolean).every((l) => ["READ", "WRITE", "CONTROL"].includes(l)); })());
}

console.log("\n2. the runtime gate refuses anything it did not mint");
{
  const forged = { audience: "CUSTOMER_SUCCESS" };
  check("a hand-built object is refused", throws(() => assertAudienceToken(forged, ["CUSTOMER_SUCCESS"])));
  check("a copy of a real token is refused", throws(() => assertAudienceToken({ ...systemIncidentAudience() }, ["SYSTEM"])));
  const ops = incidentAudienceFor({ user: { role: UserRole.USER }, grant: { area: "PLATFORM_OPS", level: "WRITE" } });
  check("a PLATFORM_OPS token cannot pass a CS-only gate", throws(() => assertAudienceToken(ops, ["CUSTOMER_SUCCESS"])));
  check("a PLATFORM_OPS token passes its own gate", assertAudienceToken(ops, ["PLATFORM_OPS", "CUSTOMER_SUCCESS"]) === "PLATFORM_OPS");
  check("a SYSTEM token cannot read a CS-only surface", throws(() => assertAudienceToken(systemIncidentAudience(), ["CUSTOMER_SUCCESS"])));
}

/** Every incidentAudienceFor(x) whose x is not destructured from `await require(Fresh)PlatformAccess(` in the same function. */
function provenanceViolations(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/incidentAudienceFor\(([^)]*)\)/g)) {
    const arg = m[1].trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(arg)) { out.push(`incidentAudienceFor(${arg || "<empty>"}) — not a guard-result identifier`); continue; }
    const before = src.slice(0, m.index);
    const fnStart = Math.max(before.lastIndexOf("function "), before.lastIndexOf("=> {"));
    const body = before.slice(Math.max(0, fnStart));
    const guard = new RegExp(`const\\s*\\[\\s*${arg}\\s*,[^\\]]*\\]\\s*=\\s*await\\s+require(Fresh)?PlatformAccess\\(`);
    if (!guard.test(body)) { out.push(`incidentAudienceFor(${arg}) — ${arg} is not destructured from await require(Fresh)PlatformAccess( in this function`); continue; }
    if (new RegExp(`(^|[^\\w$.])${arg}\\s*=(?!=)`).test(body.replace(guard, ""))) out.push(`incidentAudienceFor(${arg}) — ${arg} is reassigned`);
  }
  return out;
}

console.log("\n3. the provenance scanner itself (fixtures)");
{
  const good = `export async function GET() {\n  const [auth, err] = await requirePlatformAccess("CUSTOMER_SUCCESS", "READ");\n  if (err) return err;\n  const t = incidentAudienceFor(auth);\n}`;
  const fresh = `export async function POST() { const [a, e] = await requireFreshPlatformAccess("PLATFORM_OPS", "WRITE"); const t = incidentAudienceFor(a); }`;
  const forged = `export async function GET() { const t = incidentAudienceFor({ user: { role: "SYSTEM_ADMIN" }, grant: null }); }`;
  const smuggled = `export async function GET() { const fake = { user: { role: "SYSTEM_ADMIN" }, grant: null }; const t = incidentAudienceFor(fake); }`;
  const otherFn = `async function a() { const [auth] = await requirePlatformAccess("CUSTOMER_SUCCESS", "READ"); }\nasync function b(auth) { return incidentAudienceFor(auth); }`;
  const reassigned = `export async function GET() { let [auth, err] = await requirePlatformAccess("PLATFORM_OPS", "READ"); auth = { grant: null }; incidentAudienceFor(auth); }`;
  check("a guard result destructured in the same function passes", provenanceViolations(good).length === 0, provenanceViolations(good).join());
  check("…including requireFreshPlatformAccess", provenanceViolations(fresh).length === 0);
  check("a literal object is caught", provenanceViolations(forged).length === 1);
  check("a hand-built variable is caught", provenanceViolations(smuggled).length === 1);
  check("a guard result from ANOTHER function is caught", provenanceViolations(otherFn).length === 1);
  check("a reassigned guard result is caught", provenanceViolations(reassigned.replace("let [", "const [")).length === 1);
}

console.log("\n4. static pins");
{
  const files = [...walk("lib"), ...walk("app"), ...walk("jobs"), ...walk("components"), ...walk("scripts")];
  const INTEL = "lib/platform/incidents/intelligence/";
  const sysImporters = files.filter((f) => /systemIncidentAudience/.test(code(f)) && !f.startsWith(INTEL));
  check("only lib/alerts/ may mint or use the SYSTEM token",
    sysImporters.every((f) => f.startsWith("lib/alerts/")), sysImporters.join(", "));
  const alertableCallers = files.filter((f) => /\.alertable\(|\balertable\(\s*(sys|token|systemIncidentAudience)/.test(code(f)) && !f.startsWith(INTEL));
  check("the alertable accessor is called only from lib/alerts/",
    alertableCallers.every((f) => f.startsWith("lib/alerts/")), alertableCallers.join(", "));
  const csCoreCallers = files.filter((f) => /deriveIncidentVerdicts\([^)]*audience:\s*"CUSTOMER_SUCCESS"/.test(code(f)) || /audience:\s*"CUSTOMER_SUCCESS"/.test(code(f)))
    .filter((f) => !/^lib\/platform\/incidents\/intelligence\/(index|audience)\.ts$/.test(f));
  check("only the accessors and the minter tell the core CUSTOMER_SUCCESS",
    csCoreCallers.length === 0, csCoreCallers.join(", "));
  // GUARD PROVENANCE — every incidentAudienceFor(x) call passes the value destructured
  // from `await require(Fresh)PlatformAccess(` earlier in the same function body.
  const mintCallers = files.filter((f) => /incidentAudienceFor\(/.test(code(f)) && !f.startsWith(INTEL));
  const badMints = mintCallers.flatMap((f) => provenanceViolations(code(f)).map((v) => `${f}: ${v}`));
  check("incidentAudienceFor is only ever given a guard result destructured in the same function",
    badMints.length === 0, badMints.join("; "));
  const importers = files.filter((f) => /from\s+["']@\/lib\/platform\/incidents\/intelligence\/audience["']|from\s+["']\.\/audience["']/.test(code(f)));
  // Platform Intelligence retrieval (Phase 3 slice 1) imports ONLY the runtime gate and the
  // downgrade (assertAudienceToken, atOpsTier): it never mints (no incidentAudienceFor, no SYSTEM token).
  const RETRIEVAL = "lib/platform/intelligence/metrics/retrieve-core.ts";
  const retrievalOk = (f: string) => f === RETRIEVAL && !/incidentAudienceFor|systemIncidentAudience/.test(code(f))
    && [...code(f).matchAll(/import\s*\{([^}]*)\}\s*from\s*["']@\/lib\/platform\/incidents\/intelligence\/audience["']/g)]
      .flatMap((mm) => mm[1].split(",").map((x) => x.trim().replace(/^type\s+/, "")).filter(Boolean))
      .every((n) => ["assertAudienceToken", "atOpsTier", "CsToken", "OpsToken"].includes(n));
  const strayImporters = importers.filter((f) => !f.startsWith(INTEL) && !f.startsWith("lib/alerts/") && !mintCallers.includes(f) && !retrievalOk(f));
  check("the minter is imported only by the accessors, lib/alerts/ and guarded routes that mint",
    strayImporters.length === 0, strayImporters.join(", "));
  const minters = files.filter((f) => /MINTED\.add\(|function mint\b/.test(code(f)));
  check("tokens are minted in exactly one module", minters.length === 1 && minters[0] === `${INTEL}audience.ts`, minters.join(", "));
}

console.log("\n5. MEMBER — a pure-core-only audience (PB-1 Phase 3, S2 conditions)");
{
  const files = [...walk("lib"), ...walk("app"), ...walk("jobs"), ...walk("components"), ...walk("scripts")];
  // (a) NOT a token tier: the type says so at compile time…
  const memberIsNotATier: "MEMBER" extends IncidentAudience ? never : true = true;
  const memberIsCore: "MEMBER" extends CoreAudience ? true : never = true;
  check("MEMBER is a CoreAudience but NOT an IncidentAudience (no AudienceToken<\"MEMBER\"> can exist)", memberIsNotATier && memberIsCore);
  // (b) …and the minter never names it: no token type, no mint path.
  const minter = code("lib/platform/incidents/intelligence/audience.ts");
  check("audience.ts has no MEMBER token type and no MEMBER mint path", !/MEMBER/.test(minter));
  // (c) no accessor accepts it.
  const accessors = code("lib/platform/incidents/intelligence/index.ts");
  check("no accessor's allowed list (or any accessor) names MEMBER", !/MEMBER/.test(accessors));
  check("…and a MEMBER-shaped object is refused by the runtime gate", throws(() => assertAudienceToken({ audience: "MEMBER" }, ["CUSTOMER_SUCCESS", "PLATFORM_OPS", "SYSTEM"])));
  // (d) only the member activity feed's pure path tells the core MEMBER (like SYSTEM is lib/alerts/ only).
  const memberCallers = files.filter((f) => /audience:\s*"MEMBER"/.test(code(f)) && !/\.test\.tsx?$/.test(f));
  check("only lib/activity/member-incidents.ts tells the core MEMBER", memberCallers.join() === "lib/activity/member-incidents.ts", memberCallers.join(", "));
}

if (failures > 0) { console.error(`\naudience.test: ${failures} failure(s).`); process.exit(1); }
console.log("\naudience.test: all passed.");
