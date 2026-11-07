/**
 * UI-001 / UI-002 (Ops widgets) — write controls render only for WRITE holders;
 * the users widget records only a reason the operator chose.
 * Rendered with react-dom/server like the other widget tests; the fetch hook is
 * not exercised (static markup of the first render), so these are paired with
 * source pins on the gate itself.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
let f = 0;
const check = (n: string, ok: boolean) => { if (!ok) f++; console.log(`  ${ok ? "✓" : "✗"} ${n}`); };
const src = (w: string) => readFileSync(join(process.cwd(), `components/platform/widgets/${w}.tsx`), "utf8");

for (const [w, line] of [["OpsProviderCleanupWidget", "OPS_CLEANUP_READ_ONLY_LINE"]] as const) {
  const s = src(w);
  check(`${w}: accepts the host's access prop`, new RegExp(`function ${w}\\(\\{ section, access \\}`).test(s));
  check(`${w}: absent access fails safe to read-only`, /const canWrite = access\?\.canWrite === true;/.test(s));
  check(`${w}: a READ holder gets the explanatory line`, new RegExp(`!canWrite[\\s\\S]{0,160}${line}`).test(s));
}
// PLATFORM OPS VISUAL SPEC §3 (2026-10-30) — OpsManualOperationsWidget is gone:
// its Run / Dry-run controls live on the unified Jobs rows and detail
// (components/platform/ops-visual/UnifiedJobs.tsx). The same gates, pinned at
// their new home (behaviour is rendered in ops-visual/ops-visual.test.ts):
const ops = readFileSync(join(process.cwd(), "components/platform/ops-visual/UnifiedJobs.tsx"), "utf8");
check("unified jobs: absent access fails safe to read-only", /canWrite: access\?\.canWrite === true, canControl: access\?\.canControl === true/.test(ops));
check("unified jobs: a READ holder gets the read-only line instead of any button", /if \(!a\.canWrite\) return \{ dry: null, run: null, note: READ_ONLY_LINE \};/.test(ops));
check("unified jobs: a fleet-wide Run renders only with canControl; otherwise the Control line",
  /const runAllowed = c\.run && \(!isFleetRun\(c\.run\) \|\| a\.canControl\) \? c\.run : null;/.test(ops) && /note: c\.run && !runAllowed \? NEEDS_CONTROL_LINE : null/.test(ops));
check("unified jobs: the fleet confirm collects a reason and blocks without one", /OperatorReasonField/.test(ops) && /confirmDisabled=\{confirming\.requires\.reason && reasonPayload\(reason\) === null\}/.test(ops));
const cleanup = src("OpsProviderCleanupWidget");
// PB-5 (S2): also hidden while an operator removal is inside its grace window.
check("Retry cleanup renders only when canWrite (and not while a removal is in progress)", /!o\.itemGone && !o\.inProgress && canWrite && \(/.test(cleanup));
// SEC-PLAT-4 — the Growth users widget has no write control at all (deactivate /
// reactivate moved to Customer Success, gated on CS WRITE with a chosen reason).
const users = src("OpsUsersWidget");
check("Growth users widget renders no button and posts nothing", !/<button|method:\s*"POST"|fetch\(/.test(users));
const cs = src("CsCustomersWidget");
check("Customer Success deactivate is gated on canWrite and a chosen reason",
  /detail\?\.actions\.deactivate && canWrite &&/.test(cs) && /onClick=\{toggleActive\} disabled=\{acting !== null \|\| !reason\}/.test(cs));
if (f) process.exit(1);
console.log("\nall checks passed");
