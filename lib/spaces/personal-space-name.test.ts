/**
 * lib/spaces/personal-space-name.test.ts  (2026-10-07)
 *
 * A generated Personal Space name follows a first-name correction; a name the
 * owner chose never does. Preview: "Brandom's Space" outlived the fix to
 * "Brandon".
 *
 *   npx tsx lib/spaces/personal-space-name.test.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { followedPersonalSpaceName, generatedPersonalSpaceName } from "./personal-space-name";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("Generated names follow the first name");
check("REGRESSION: Brandom's Space + Brandom→Brandon ⇒ Brandon's Space",
  followedPersonalSpaceName("Brandom's Space", "Brandom", "Brandon") === "Brandon's Space");
check("uses the canonical possessive: Chri → Chris ⇒ Chris' Space",
  followedPersonalSpaceName("Chri's Space", "Chri", "Chris") === "Chris' Space");
check("from an s-name: Chris' Space + Chris→James ⇒ James' Space",
  followedPersonalSpaceName("Chris' Space", "Chris", "James") === "James' Space");
check("legacy unconditional 's form still counts as generated (Chris's Space)",
  followedPersonalSpaceName("Chris's Space", "Chris", "Alex") === "Alex's Space");
check("legacy Dashboard form counts as generated",
  followedPersonalSpaceName("Brandom's Dashboard", "Brandom", "Brandon") === "Brandon's Space");
check("registration's generator is the same function", generatedPersonalSpaceName(" Brandon ") === "Brandon's Space");

console.log("Customized names are never touched");
check("a chosen name is preserved", followedPersonalSpaceName("Household", "Brandom", "Brandon") === null);
check("a chosen name containing the first name is preserved",
  followedPersonalSpaceName("Brandom's Space Project", "Brandom", "Brandon") === null);
check("a generated name for a DIFFERENT first name is not this user's generated name",
  followedPersonalSpaceName("Alex's Space", "Brandom", "Brandon") === null);
check("case differs ⇒ treated as customized", followedPersonalSpaceName("brandom's space", "Brandom", "Brandon") === null);

console.log("No-ops");
check("first name unchanged ⇒ null", followedPersonalSpaceName("Brandon's Space", "Brandon", "Brandon") === null);
check("cleared first name ⇒ null (never 's Space)", followedPersonalSpaceName("Brandom's Space", "Brandom", "  ") === null);
check("no previous first name ⇒ null", followedPersonalSpaceName("'s Space", null, "Brandon") === null);

console.log("Profile route wiring");
{
  const src = readFileSync(join(process.cwd(), "app/api/user/profile/route.ts"), "utf8");
  check("previous first name is read inside the update transaction", /previousFirstName = data\.firstName !== undefined/.test(src));
  check("only PERSONAL Spaces the user actively OWNS",
    /type: "PERSONAL", members: \{ some: \{ userId: user\.id, role: "OWNER", status: "ACTIVE" \} \}/.test(src));
  check("the rename goes through the shared rule and is audited",
    /followedPersonalSpaceName\(space\.name, previousFirstName, data\.firstName\)/.test(src) && /action: "SPACE_UPDATE"/.test(src));
  const reg = readFileSync(join(process.cwd(), "app/api/auth/register/route.ts"), "utf8");
  check("registration still generates `${possessive(first)} Space` (the form this rule recognizes)",
    /name: `\$\{possessive\(firstName\.trim\(\)\)\} Space`/.test(reg));
}

if (failures > 0) { console.error(`\npersonal-space-name.test: ${failures} failure(s).`); process.exit(1); }
console.log("\npersonal-space-name.test: all passed.");
