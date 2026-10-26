/**
 * components/space/manage/manage-space-v27-p1.test.ts  (v2.7 P1 — Manage Space overhaul)
 *
 *   1. the General name field edits the name customers SEE (displaySpaceName),
 *      sends `name` only when changed, and a rename reaches the header/chrome
 *      (host override + router.refresh), My Spaces and the sidebar lists (event);
 *   2. no customer-facing public publishing: General never offers Public and
 *      never sends isPublic except to narrow an already-public Space to private;
 *      Create Space has no Privacy picker; the server routes are untouched;
 *   3. a Personal Space's category is fixed ("Personal", never sent); other
 *      types keep the allowlisted picker;
 *   4. the Overview tab is gone; the sections API remains.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/space/manage/manage-space-v27-p1.test.ts
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { displaySpaceName } from "@/lib/format";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const GEN = code("components/space/manage/GeneralSettingsPanel.tsx");
const SHELL = code("components/space/manage/ManageSpaceModal.tsx");
const HOST = code("components/dashboard/SpaceDashboard.tsx");

console.log("1. one name, everywhere");
{
  check("the Preview legacy row: stored \"Chris's Dashboard\" is shown as \"Chris' Space\"", displaySpaceName("Chris's Dashboard") === "Chris' Space");
  check("General starts from the DISPLAYED name (it used to show the raw stored string)",
    /const shownName = displaySpaceName\(space\.name\);/.test(GEN) && /useState\(shownName\)/.test(GEN) && !/useState\(space\.name\)/.test(GEN));
  check("dirty/send compare against the displayed name; name sent only when changed (no silent legacy rewrite)",
    /const nameChanged\s+= name\.trim\(\) !== shownName;/.test(GEN) && /\.\.\.\(nameChanged \? \{ name: name\.trim\(\) \} : \{\}\)/.test(GEN) && !/name:\s+name\.trim\(\),/.test(GEN));
  check("a rename refreshes the server tree and broadcasts the Space-list event",
    /if \(currencyChanged \|\| nameChanged\) settingsRouter\.refresh\(\);/.test(GEN) && /window\.dispatchEvent\(new CustomEvent\(SPACE_LIST_CHANGED_EVENT\)\)/.test(GEN));
  check("the modal title follows the loaded (renamed) Space", /title=\{displaySpaceName\(space\?\.name \?\? spaceName\)\}/.test(SHELL));
  check("the modal reports a rename to its host", /if \(updated\.name !== undefined\) onRenamed\?\.\(updated\.name\);/.test(SHELL));
  check("the dashboard header + Space chrome use the renamed name at once (override while the prop is stale)",
    /spaceName: storedSpaceName,/.test(HOST)
      && /const spaceName = renamed && renamed\.spaceId === spaceId && renamed\.from === storedSpaceName \? renamed\.to : storedSpaceName;/.test(HOST)
      && /onRenamed=\{\(to\) => setRenamed\(\{ spaceId, from: storedSpaceName, to \}\)\}/.test(HOST)
      && /name: displaySpaceName\(spaceName\)/.test(HOST) && /title=\{displaySpaceName\(spaceName\)\}/.test(HOST));
}

console.log("\n2. no customer-facing public publishing");
{
  check("General has no Public/Private chooser", !/setIsPublic|"Public"|Anyone can view/.test(GEN));
  check("isPublic is sent only as false, only for an already-public Space being narrowed",
    /\.\.\.\(makePrivate \? \{ isPublic: false \} : \{\}\)/.test(GEN) && /\{space\.isPublic && \(/.test(GEN) && !/isPublic: true/.test(GEN));
  const create = code("components/dashboard/CreateSpaceModal.tsx");
  check("Create Space has no Privacy picker and never sends isPublic (server default: private)", !/isPublic|Privacy|"Public"/.test(create));
  check("the server keeps its isPublic handling (schema/infra untouched)",
    /isPublic\s+!== undefined && \{ isPublic \}/.test(read("app/api/spaces/[id]/route.ts")) && /isPublic:\s+!!isPublic/.test(read("app/api/spaces/route.ts")));
}

console.log("\n3. Personal Space category is fixed");
{
  check("a Personal Space shows a read-only \"Personal\" category", /isPersonal \? \(\s*<div[^>]*data-category-fixed>[\s\S]{0,400}CATEGORY_LABELS\[SpaceCategory\.PERSONAL\]/.test(GEN));
  check("its category is never sent", /const categoryChanged = !isPersonal && category !== space\.category;/.test(GEN) && /\.\.\.\(categoryChanged \? \{ category \} : \{\}\)/.test(GEN));
  check("other Space types keep the allowlisted picker", /const allCategories = RECATEGORIZE_CATEGORIES;/.test(GEN) && /allCategories\.map/.test(GEN));
  check("description and reporting currency are preserved", /setDescription/.test(GEN) && /currencyChanged \? \{ reportingCurrency \} : \{\}/.test(GEN));
}

console.log("\n4. the Overview tab is gone; the infrastructure stays");
{
  check("no Overview tab / panel in the shell", !/"dashboard"|OverviewSectionsPanel|label:\s*"Overview"/.test(SHELL));
  check("the sections API remains", existsSync(path.join(process.cwd(), "app/api/spaces/[id]/sections/route.ts")));
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
