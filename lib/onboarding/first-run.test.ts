/**
 * lib/onboarding/first-run.test.ts  (Connections pass PR 2 — first-time onboarding)
 *
 * The rule (pure) and the wiring (source pins): who is redirected, once; who is
 * invited; that established users never are; that it fails open; and that the
 * markers are durable, private and not product events.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { decideFirstRun, ONBOARDING_HREF, type FirstRunFacts } from "@/lib/onboarding/first-run.core";
import { AuditAction, PRODUCT_EVENT_ACTIONS, USER_SECURITY_HISTORY_ACTIONS } from "@/lib/audit-actions";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const code = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const NEW: FirstRunFacts = { sourcesEver: 0, sourcesLive: 0, sharedMemberships: 0, presented: false, dismissed: false };

console.log("the rule");
{
  check("brand-new user ⇒ redirect once, no invitation on top", JSON.stringify(decideFirstRun(NEW)) === JSON.stringify({ redirect: true, invite: false }));
  check("welcome already shown ⇒ no second redirect; invited instead", JSON.stringify(decideFirstRun({ ...NEW, presented: true })) === JSON.stringify({ redirect: false, invite: true }));
  check("dismissed ⇒ neither, ever", JSON.stringify(decideFirstRun({ ...NEW, dismissed: true })) === JSON.stringify({ redirect: false, invite: false })
    && JSON.stringify(decideFirstRun({ ...NEW, presented: true, dismissed: true })) === JSON.stringify({ redirect: false, invite: false }));
  check("established (any source, even revoked / errored / deleted) ⇒ never redirected", !decideFirstRun({ ...NEW, sourcesEver: 1 }).redirect);
  check("…and a disconnected-everything user is only invited", JSON.stringify(decideFirstRun({ ...NEW, sourcesEver: 3, sourcesLive: 0 })) === JSON.stringify({ redirect: false, invite: true }));
  check("a member of someone else's Space ⇒ not redirected (multi-Space respected)", !decideFirstRun({ ...NEW, sharedMemberships: 1 }).redirect);
  check("live sources ⇒ no invitation", !decideFirstRun({ ...NEW, sourcesEver: 1, sourcesLive: 1, presented: true }).invite);
  check("the redirect lands on Connections with the greeting", ONBOARDING_HREF === "/dashboard/connections?welcome=1");
}

console.log("markers");
{
  check("two durable markers exist", AuditAction.ONBOARDING_PRESENTED === "ONBOARDING_PRESENTED" && AuditAction.ONBOARDING_DISMISSED === "ONBOARDING_DISMISSED");
  check("not product events (those are purged at 13 months; a dismissal must not expire)",
    !PRODUCT_EVENT_ACTIONS.includes(AuditAction.ONBOARDING_PRESENTED) && !PRODUCT_EVENT_ACTIONS.includes(AuditAction.ONBOARDING_DISMISSED));
  check("not in the user's security history", !USER_SECURITY_HISTORY_ACTIONS.includes(AuditAction.ONBOARDING_DISMISSED));
}

console.log("the reader");
{
  const r = code("lib/onboarding/first-run.ts");
  check("reads as the user (withTenantDb), never systemDb", /withTenantDb\(userId/.test(r) && !/systemDb/.test(r));
  check("fails OPEN — a failed read returns NO_ONBOARDING", /catch[\s\S]{0,120}return NO_ONBOARDING;/.test(r));
  check("'ever' counts every Item and wallet regardless of state", /plaidItem\.count\(\{ where: \{ userId \} \}\)/.test(r) && /connection\.count\(\{ where: \{ userId \} \}\)/.test(r));
  check("shared membership = ACTIVE in a non-PERSONAL Space", /status: "ACTIVE", space: \{ type: \{ not: "PERSONAL" \} \}/.test(r));
  check("marker writes are idempotent", /findFirst\(\{ where: \{ userId, action \}/.test(r) && /if \(already\) return;/.test(r));
  check("counts and existence only — no names, balances or values selected", !/balance|institutionName|name: true|currentValue/.test(r));
}

console.log("the wiring");
{
  const brief = code("app/(shell)/dashboard/brief/page.tsx");
  const gate = brief.indexOf("readFirstRun(ctx.userId)");
  check("only the post-login landing (the Brief) redirects, before any Brief read", gate > -1 && gate < brief.indexOf("readBriefResponse("));
  check("…never on a router prefetch", /\.redirect && !\(await isRouterPrefetch\(\)\)\) redirect\(ONBOARDING_HREF\)/.test(brief));
  const layout = code("app/(shell)/dashboard/layout.tsx");
  check("the layout does not gate on onboarding (direct links keep working)", !/onboarding|readFirstRun/i.test(layout));
  const route = code("app/api/onboarding/route.ts");
  check("route: signed-in user, POST only, closed event vocabulary", /requireUser\(\)/.test(route) && !/export async function (GET|PUT|PATCH|DELETE)/.test(route)
    && /event !== "presented" && event !== "dismissed"/.test(route));
  const view = code("components/connections/ConnectionsOnboarding.tsx");
  check("three ways in: Plaid, wallet, real asset", /openLink\(\)/.test(view) && /<AddWalletModal/.test(view) && /<AddManualAssetModal/.test(view));
  check("a way out: Explore My Space records the dismissal and goes to My Space", /Explore My Space/.test(view) && /postOnboarding\("dismissed"\)/.test(view) && /router\.push\("\/dashboard"\)/.test(view));
  check("the welcome records itself as shown (so the redirect never repeats)", /if \(!welcome \|\| presentedRef\.current\) return;/.test(view) && /postOnboarding\("presented"\)/.test(view));
  check("never asks for a seed phrase or key; says connecting is optional", /Never enter a seed phrase or private key/.test(view) && /Connecting is optional/.test(view));
  const dash = code("components/connections/ConnectionsSpaceDashboard.tsx");
  check("Connections' empty state is the onboarding view", /<ConnectionsOnboarding/.test(dash));
}

if (failures > 0) {
  console.error(`\nfirst-run: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nfirst-run: all checks passed.");
