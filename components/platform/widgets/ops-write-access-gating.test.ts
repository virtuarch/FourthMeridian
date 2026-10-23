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

for (const [w, line] of [["OpsManualOperationsWidget", "OPS_OPERATIONS_READ_ONLY_LINE"], ["OpsProviderCleanupWidget", "OPS_CLEANUP_READ_ONLY_LINE"], ["OpsUsersWidget", "OPS_USERS_READ_ONLY_LINE"]] as const) {
  const s = src(w);
  check(`${w}: accepts the host's access prop`, new RegExp(`function ${w}\\(\\{ section, access \\}`).test(s));
  check(`${w}: absent access fails safe to read-only`, /const canWrite = access\?\.canWrite === true;/.test(s));
  check(`${w}: a READ holder gets the explanatory line`, new RegExp(`!canWrite[\\s\\S]{0,160}${line}`).test(s) || (w === "OpsUsersWidget" && /!canWrite && <p[^>]*>\{OPS_USERS_READ_ONLY_LINE\}/.test(s)));
}
const ops = src("OpsManualOperationsWidget");
check("Run / Dry-run buttons render only when canWrite", /\{canWrite && g\.commands\.map\(/.test(ops));
const cleanup = src("OpsProviderCleanupWidget");
check("Retry cleanup renders only when canWrite", /!o\.itemGone && canWrite && \(/.test(cleanup));
const users = src("OpsUsersWidget");
check("Deactivate / Reactivate gated on canWrite", /: !canWrite \?[\s\S]{0,140}Read-only[\s\S]{0,40}: u\.deactivatedAt \?/.test(users));
check("UI-002: no pre-selected reason", /useState<ReasonCode \| "">\(""\)/.test(users) && !/useState<ReasonCode>\("SUPPORT_REQUEST"\)/.test(users));
check("UI-002: confirm disabled until a reason is chosen", /disabled=\{acting !== null \|\| reasonCode === ""\}/.test(users));
check("UI-002: a placeholder option makes 'no reason' visible", /<option value="" disabled>Choose a reason…<\/option>/.test(users));
if (f) process.exit(1);
console.log("\nall checks passed");
