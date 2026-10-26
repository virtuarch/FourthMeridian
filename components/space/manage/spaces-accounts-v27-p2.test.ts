/**
 * components/space/manage/spaces-accounts-v27-p2.test.ts  (v2.7 P2 — My Spaces + Accounts)
 *
 *   1. My Spaces has no Explore Public Spaces navigation or discovery UI; the
 *      public-Space data path (page loader, API) is untouched;
 *   2. Create Space uses the site's canonical button (GlassButton, meridian);
 *   3. Manage Space → "Accounts": the Space's accounts first (same data, same
 *      confirm-gated revoke), Add account beneath; when nothing eligible remains,
 *      a Connections note + link instead; the share panel says the same.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/space/manage/spaces-accounts-v27-p2.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const SPACES = code("components/dashboard/SpacesClient.tsx");
const FIN = code("components/space/manage/FinancesPanel.tsx");
const SHARE = code("components/space/manage/ShareExistingAccountsPanel.tsx");

console.log("1. no public-Space discovery on My Spaces");
{
  check("no Explore heading, link, preview cards, empty state or detail modal",
    !/Explore Public Spaces|spaces\/public|PublicSpaceCard|PublicEmptyState|PublicSpaceDetailModal|viewingPublicSpace|explorePublic/.test(SPACES));
  check("the prop stays in the contract (the page loader is untouched)", /publicSpaces: SpaceItem\[\];/.test(SPACES));
  check("the GET /api/spaces route still serves public Spaces (infrastructure kept)", /isPublic/.test(read("app/api/spaces/route.ts")));
}

console.log("\n2. Create Space uses the canonical button");
{
  const header = SPACES.slice(SPACES.indexOf("function SpacesHeader"), SPACES.indexOf("export function SpacesClient"));
  check("GlassButton tone=meridian, no Liquid WebGL CTA", /<GlassButton onClick=\{onCreateSpace\} tone="meridian"/.test(header) && !/AtlasLiquid|useAtlasLiquid/.test(SPACES));
  check("same behaviour: opens CreateSpaceModal via the event", /onCreateSpace=\{\(\) => window\.dispatchEvent\(new CustomEvent\(OPEN_CREATE_SPACE_EVENT\)\)\}/.test(SPACES));
}

console.log("\n3. Accounts: existing first, Add beneath, Connections when none remain");
{
  const list = FIN.indexOf("data-space-accounts");
  const add = FIN.indexOf("Add account");
  check("the Space's accounts render before the Add action", list > 0 && add > list);
  check("same data: /api/spaces/[id]/accounts; revoke still only via the ConfirmDialog",
    /fetch\(`\/api\/spaces\/\$\{spaceId\}\/accounts`\)/.test(FIN) && /onConfirm=\{\(\) => handleRevoke\(pendingRevoke\.id\)\}/.test(FIN) && (FIN.match(/handleRevoke\(/g) ?? []).length === 2);
  check("permissions unchanged: remove + add gated on canShare (OWNER/ADMIN/MEMBER)",
    /const canShare = \["OWNER", "ADMIN", "MEMBER"\]\.includes\(myRole\);/.test(FIN) && /\{canShare && \(noneEligible \?/.test(FIN));
  check("remove control visible on touch, hover-revealed only at lg", /lg:opacity-0 lg:group-hover:opacity-100/.test(FIN) && !/[^:]opacity-0 group-hover/.test(FIN));
  check("eligibility = own accounts not already in the Space; unknown ⇒ keep Add",
    /const noneEligible = myAccountIds !== null && myAccountIds\.every\(\(id\) => inSpace\.has\(id\)\);/.test(FIN) && /setMyAccountIds\(null\)/.test(FIN));
  check("none eligible ⇒ Connections note with a navigation action",
    /data-no-eligible-accounts[\s\S]{0,500}href="\/dashboard\/connections"/.test(FIN));
  check("the share panel (also used by Create Space onboarding) links to Connections when empty",
    /No accounts available to add[\s\S]{0,400}href="\/dashboard\/connections"/.test(SHARE));
  check("the share panel's add/visibility logic is unchanged", /visibilityLevel: shareVis/.test(SHARE) && /\/api\/spaces\/\$\{spaceId\}\/accounts\/share/.test(SHARE));
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
