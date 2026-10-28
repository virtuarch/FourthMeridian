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
  // A SPACE-owned account in the user's personal Space reaches sourcesEver through accountsOf (see the reader pins).
  check("a user whose only source is a SPACE-owned account ⇒ counted, never redirected, never invited",
    JSON.stringify(decideFirstRun({ ...NEW, sourcesEver: 1, sourcesLive: 1 })) === JSON.stringify({ redirect: false, invite: false }));
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
  check("marker writes are one idempotent statement with no read-back (INSERT … WHERE NOT EXISTS)",
    /INSERT INTO "AuditLog"[\s\S]*WHERE NOT EXISTS \(SELECT 1 FROM "AuditLog" WHERE "userId" = \$\{userId\}::text AND "action" = \$\{action\}::text\)/.test(r) && !/auditLog\.create/.test(r));
  check("accounts count by EVERY ownership answer (owner, creator, owned Space, connector) — SPACE-owned accounts in a personal Space included",
    /\{ ownerUserId: userId \}/.test(r) && /\{ createdByUserId: userId \}/.test(r)
      && /ownerSpace: \{ members: \{ some: \{ userId, role: "OWNER", status: "ACTIVE" \} \} \}/.test(r) && /connectedByUserId: userId/.test(r));
  check("the invitation uses the same ownership rule", /financialAccount\.findFirst\(\{ where: accountsOf\(userId, true\)/.test(r));
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
  check("a way out: Explore My Space records the dismissal and goes to My Space", /Explore My Space/.test(view) && /dismissNotice\("connect"\)/.test(view) && /router\.push\("\/dashboard"\)/.test(view));
  const conn = code("app/(shell)/dashboard/connections/page.tsx");
  check("the welcome records itself as shown SERVER-side (a blocked client call cannot cause repeat redirects)",
    /if \(welcome && !\(await isRouterPrefetch\(\)\)\) \{\s*await recordOnboardingEvent\(userId, "presented"\)\.catch\(/.test(conn) && !/"presented"/.test(view));
  check("Explore hides the rail invitation in this tab too (the rail outlives the client navigation)",
    /import \{ dismissNotice \} from "@\/components\/notices\/NoticeRail"/.test(view) && !/fetch\("\/api\/onboarding"/.test(view));
  check("the empty-state heading never claims a first account (manual assets now list in Connections)", !/"Add your first account"/.test(view));
  check("starting a first connection leaves the one-shot ready handoff", (view.match(/noteFirstConnectStarted\(\)/g) ?? []).length === 2);
  check("never asks for a seed phrase or key; says connecting is optional", /Never enter a seed phrase or private key/.test(view) && /Connecting is optional/.test(view));
  const wallet = code("components/dashboard/AddWalletModal.tsx");
  check("wallet dialog intro follows the chosen chain (no 'Bitcoin address' on Solana)",
    /chain === "BTC"\s*\?\s*<>Enter a public Bitcoin address/.test(wallet) && /Enter a public Solana address\./.test(wallet) && /Enter a public Ethereum address/.test(wallet)
    && /Never enter a seed phrase or private key\./.test(wallet));
  const dash = code("components/connections/ConnectionsSpaceDashboard.tsx");
  check("Connections' empty state is the onboarding view", /<ConnectionsOnboarding/.test(dash));
  // Connections 2.0 (owner-approved) — real assets are now LISTED in Connections,
  // so a user whose only entries are manual assets sees the list with the Real
  // assets category instead of "Connect an account": the onboarding view stays
  // the empty state only when there is nothing at all. (The rule above — the
  // heading does not claim "first account" — still holds for that empty state.)
  check("only-manual-assets ⇒ the list (Real assets), not the onboarding view",
    /const hasConnections = status\.connections\.length > 0 \|\| manualAssets\.length > 0;/.test(dash)
      && /hasConnections \? \(\s*<ConnectionsList[\s\S]*?manualAssets=\{manualAssets\}/.test(dash));
}

if (failures > 0) {
  console.error(`\nfirst-run: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nfirst-run: all checks passed.");
