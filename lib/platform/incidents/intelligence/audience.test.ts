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

console.log("\n3. static pins");
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
  const minters = files.filter((f) => /MINTED\.add\(|function mint\b/.test(code(f)));
  check("tokens are minted in exactly one module", minters.length === 1 && minters[0] === `${INTEL}audience.ts`, minters.join(", "));
}

if (failures > 0) { console.error(`\naudience.test: ${failures} failure(s).`); process.exit(1); }
console.log("\naudience.test: all passed.");
