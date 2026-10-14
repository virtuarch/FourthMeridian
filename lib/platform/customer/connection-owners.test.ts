/**
 * lib/platform/customer/connection-owners.test.ts  (UX-P1 — owner decision D4)
 *
 * The pure half of the owner reader, DB-free:
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/customer/connection-owners.test.ts
 *
 * Pinned: the label fallback order (username → name → opaque), that an email
 * on the input never reaches the output, that unknown refs are omitted rather
 * than guessed, that a Plaid id is looked up in the Plaid table and a wallet
 * id in the Connection table, and the request-shape rules the route answers
 * 400 with.
 */

import { CONNECTION_OWNERS_MAX, parseConnectionRefs, projectConnectionOwners } from "./connection-owners";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("label fallback order — username, then name, then an opaque reference; never email");
{
  const users = {
    withUsername: { id: "user_abcdef123456", username: "chris", name: "Chris H", ...({ email: "chris@example.com" } as object) },
    nameOnly:     { id: "user_zzzzzz654321", username: null, name: "Pat Example", ...({ email: "pat@example.com" } as object) },
    bare:         { id: "user_qqqqqq999999", username: "  ", name: "", ...({ email: "bare@example.com" } as object) },
  };
  const owners = projectConnectionOwners(
    [{ source: "PLAID", id: "p1" }, { source: "WALLET", id: "w1" }, { source: "EXCHANGE", id: "x1" }],
    [{ id: "p1", user: users.withUsername }],
    [{ id: "w1", user: users.nameOnly }, { id: "x1", user: users.bare }],
  );
  const by = new Map(owners.map((o) => [`${o.source}:${o.id}`, o.owner.label]));
  check("username first", by.get("PLAID:p1") === "chris");
  check("name when no username", by.get("WALLET:w1") === "Pat Example");
  check("opaque reference when neither (blank username is not a username)", by.get("EXCHANGE:x1") === "user …999999");
  const json = JSON.stringify(owners);
  check("no email in the output, even though every input carried one", !json.includes("@") && !json.includes("example.com"));
  check("no user id in the output", !json.includes("user_abcdef123456") && !json.includes("user_zzzzzz654321"));
  check("exactly { source, id, owner: { label } } per row", owners.every((o) => Object.keys(o).sort().join() === "id,owner,source" && Object.keys(o.owner).join() === "label"));
}

console.log("lookups are per table and unknown refs are omitted");
{
  const user = { id: "user_000000111111", username: "sam", name: null };
  const owners = projectConnectionOwners(
    [{ source: "PLAID", id: "same" }, { source: "WALLET", id: "same" }, { source: "PLAID", id: "missing" }],
    [{ id: "same", user }],
    [],
  );
  check("a Plaid ref resolves against Plaid rows only", owners.some((o) => o.source === "PLAID" && o.id === "same"));
  check("a wallet ref with the same id does NOT borrow the Plaid row", !owners.some((o) => o.source === "WALLET"));
  check("an unknown ref is omitted, not guessed", !owners.some((o) => o.id === "missing") && owners.length === 1);
  check("requested order is kept", projectConnectionOwners([{ source: "WALLET", id: "b" }, { source: "WALLET", id: "a" }], [], [{ id: "a", user }, { id: "b", user }]).map((o) => o.id).join() === "b,a");
}

console.log("request shape — the route's 400 rules");
{
  const ok = parseConnectionRefs(["PLAID:abc", "WALLET:def-123", "PLAID:abc"]);
  check("parses source:id pairs and collapses duplicates", "refs" in ok && ok.refs.length === 2 && ok.refs[0].source === "PLAID" && ok.refs[1].id === "def-123");
  check("empty ⇒ error", "error" in parseConnectionRefs([]));
  check("unknown source ⇒ error", "error" in parseConnectionRefs(["USER:abc"]));
  check("missing separator ⇒ error", "error" in parseConnectionRefs(["abc"]));
  check("malformed id ⇒ error", "error" in parseConnectionRefs(["PLAID:a b"]) && "error" in parseConnectionRefs(["PLAID:"]));
  check("bounded at CONNECTION_OWNERS_MAX", CONNECTION_OWNERS_MAX === 50 && "error" in parseConnectionRefs(Array.from({ length: 51 }, (_, i) => `PLAID:i${i}`)) && "refs" in parseConnectionRefs(Array.from({ length: 50 }, (_, i) => `PLAID:i${i}`)));
  check("an email-shaped token is not an id", "error" in parseConnectionRefs(["PLAID:chris@example.com"]));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
