/**
 * lib/space/space-runtime-ownership.test.ts  (SD-9)
 *
 * Ownership invariants for the Workspace Runtime Convergence. SpaceDashboard is a
 * COMPOSITION ROOT: it resolves navigation/time, mounts the runtime seams, and
 * dispatches the workspace renderer. It must NOT be a perspective-loading authority,
 * a trust calculator, or a trust-selection controller — those live in dedicated hooks.
 *
 * Pure source-scan, DB-free:  npx tsx lib/space/space-runtime-ownership.test.ts
 * (Comments are stripped first so a doc-comment mentioning a moved symbol never
 *  satisfies or breaks an invariant — only real code counts.)
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const count = (s: string, sub: string) => s.split(sub).length - 1;

const HOST = stripComments(read("components/dashboard/SpaceDashboard.tsx"));
const LENS = read("lib/space/use-space-lens-results.ts");
const ENV  = read("lib/space/use-active-envelope.ts");

let failures = 0;
function check(label: string, cond: boolean) {
  if (cond) { console.log(`  ✓ ${label}`); return; }
  console.error(`  ✗ ${label}`);
  failures++;
}

console.log("SD-9A — LensResults ownership");
// Host mounts the seam and does not itself load perspectives.
check("host mounts useSpaceLensResults", HOST.includes("useSpaceLensResults("));
check("host does NOT fetch the perspectives route", !HOST.includes("/perspectives`") && !HOST.includes("/perspectives?"));
check("host does NOT own lens-result state (no setLensResults)", !HOST.includes("setLensResults"));
check("host does NOT subscribe to the lens currency-refresh signal", !HOST.includes("SPACE_CURRENCY_CHANGED"));
// The hook is the authority.
check("useSpaceLensResults owns the batch fetch", LENS.includes("/perspectives"));
check("useSpaceLensResults owns the currency-refresh listener", LENS.includes("SPACE_CURRENCY_CHANGED_EVENT"));

console.log("SD-9B — Trust publication ownership");
// Host mounts the seam and neither calculates nor selects envelopes.
check("host mounts useActiveEnvelope", HOST.includes("useActiveEnvelope("));
check("host does NOT calculate envelopes (no resolvePerspectiveEnvelope in host)", !HOST.includes("resolvePerspectiveEnvelope"));
check("host does NOT own the envelope state (no setActiveEnvelope)", !HOST.includes("setActiveEnvelope"));
check("host relays the resolved envelope to the shell", HOST.includes("envelope={activeEnvelope}"));
// The hook owns the authority + the selection; the authority itself is unchanged.
check("useActiveEnvelope owns the canonical resolver", ENV.includes("resolvePerspectiveEnvelope("));
check("useActiveEnvelope owns the workspace-backed selection", ENV.includes("WORKSPACE_RENDERERS["));
check("useActiveEnvelope does NOT define a parallel tier vocabulary", !ENV.includes("CompletenessTier =") && !ENV.includes("enum "));

console.log("SD-9C — Chrome derivation");
// The Space subtitle is derived exactly once (no duplicate inline computation).
check("subtitle member-clause is derived exactly once",
  count(HOST, "} member${memberCount === 1") === 1);
check("mobile relocation reuses the canonical subtitle parts",
  HOST.includes("subtitle={chromeUpdated ? `${chromeSubtitle}"));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll SD-9 runtime-ownership invariants hold.");
