/**
 * components/space/manage/user-search-floor.test.ts  (SEC-005 client follow-up)
 *
 * UserSearchInput fired /api/users/search from the first keystroke, although the
 * server answers [] below 3 characters (and every call counts against the 60/h
 * limit). Pinned:
 *   1. isSearchableQuery agrees with the server's parseSearchTerm on every probe
 *      (≥ 3-char substring, or exact @username), and the floors are equal
 *   2. the fetch is reachable only past isSearchableQuery; a hint explains why
 *      nothing happens below the floor; the input is labelled
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/space/manage/user-search-floor.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CLIENT_MIN_SEARCH_CHARS, isSearchableQuery, UserSearchInput } from "./UserSearchInput";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

async function main() {
  const { parseSearchTerm, MIN_SEARCH_CHARS } = await import("@/app/api/users/search/route");

  console.log("1. Client floor == server rule");
  check("floors are equal", CLIENT_MIN_SEARCH_CHARS === MIN_SEARCH_CHARS);
  const probes = ["", " ", "a", "ab", " ab ", "abc", "  abc", "abcd", "@", "@ ", "@a", "@ann", " @bo", "a@b", "ab@", "Ann Lee"];
  for (const q of probes) {
    const server = parseSearchTerm(q).kind !== "too-short";
    check(`"${q}" ⇒ client ${isSearchableQuery(q)} == server ${server}`, isSearchableQuery(q) === server);
  }

  console.log("2. Wiring");
  const src = readFileSync(path.join(process.cwd(), "components/space/manage/UserSearchInput.tsx"), "utf8");
  check("search() returns before fetch below the floor",
    /if \(!isSearchableQuery\(q\)\) \{ setResults\(\[\]\); setOpen\(false\); return; \}[\s\S]{0,120}fetch\(`\/api\/users\/search/.test(src));
  check("exactly one fetch site", (src.match(/fetch\(/g) ?? []).length === 1);
  check("no first-keystroke floor left (`q.length < 1`)", !src.includes("q.length < 1"));
  const html = renderToStaticMarkup(createElement(UserSearchInput, { spaceId: "s1", onSelect: () => {} }));
  check("input is labelled", html.includes('aria-label="Search users by name or @username"'));
  check("no hint on an empty field", !html.includes("user-search-floor-hint"));
  check("hint copy names the rule", src.includes("Type at least {CLIENT_MIN_SEARCH_CHARS} characters, or an exact @username."));

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll user-search floor checks passed.");
}
void main();
