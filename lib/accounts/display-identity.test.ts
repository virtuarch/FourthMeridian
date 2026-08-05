/**
 * lib/accounts/display-identity.test.ts   (v2.6-TRUTH-10)
 *
 * One account, one name — and the guards that keep it that way.
 *
 * The live defect: a Chase card rendered "CREDIT CARD" on Cash Flow and
 * "Ultimate Rewards®" on the Credit page. Both were real columns on one row.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  resolveAccountIdentity, accountDisplayName, formatAccountMask, ACCOUNT_NAME_SELECT,
  compareAccountsByDisplayName,
} from "./display-identity";

/** The exact live row that produced the divergence. */
const CHASE_CARD = {
  name: "CREDIT CARD", plaidName: "CREDIT CARD",
  officialName: "Ultimate Rewards®", displayName: null,
};

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
const walk = (d: string, out: string[] = []): string[] => {
  let entries: string[] = [];
  try { entries = readdirSync(join(process.cwd(), d)); } catch { return out; }
  for (const e of entries) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const rel = `${d}/${e}`;
    if (statSync(join(process.cwd(), rel)).isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(rel);
  }
  return out;
};

// ── 1 ────────────────────────────────────────────────────────────────────────

test("1. one account id resolves to exactly one display name", () => {
  // Every surface calls the same function on the same row, so it cannot differ.
  assert.equal(accountDisplayName(CHASE_CARD), "Ultimate Rewards®");
  assert.equal(resolveAccountIdentity(CHASE_CARD).basis, "OFFICIAL_NAME");
  assert.equal(resolveAccountIdentity(CHASE_CARD).isUserNamed, false);
  // Repeated calls are stable — no clock, no randomness, no order dependence.
  assert.equal(accountDisplayName(CHASE_CARD), accountDisplayName({ ...CHASE_CARD }));
});

test("1b. the precedence is user > official > provider > stored, and records which answered", () => {
  const base = { name: "STORED", plaidName: "PROVIDER", officialName: "OFFICIAL", displayName: "USER" };
  assert.equal(resolveAccountIdentity(base).basis, "USER_OVERRIDE");
  assert.equal(resolveAccountIdentity({ ...base, displayName: null }).basis, "OFFICIAL_NAME");
  assert.equal(resolveAccountIdentity({ ...base, displayName: null, officialName: null }).basis, "PROVIDER_NAME");
  assert.equal(resolveAccountIdentity({ name: "STORED" }).basis, "STORED_NAME");
  // A blank rename is ABSENT, not an empty label.
  assert.equal(accountDisplayName({ ...base, displayName: "   " }), "OFFICIAL");
  // And an account with nothing at all still gets a word, never "".
  assert.equal(accountDisplayName({ name: "  " }), "Account");
});

// ── 2 ────────────────────────────────────────────────────────────────────────

test("2. React components never derive account names", () => {
  const offenders = ["components", "app"].flatMap((r) => walk(r))
    .filter((f) => !f.startsWith("prototype/"))
    .filter((f) => {
      const code = strip(read(f));
      // The retired shape: any inline walk of the name columns.
      return /displayName\s*\?\?[^;]*officialName/.test(code)
          || /officialName\s*\?\?[^;]*plaidName/.test(code);
    });
  assert.deepEqual(offenders, [], "these components resolve an account name themselves");
});

// ── 3 ────────────────────────────────────────────────────────────────────────

test("3. descriptors never become account names", () => {
  // The authority sees only the account's own name columns — there is no
  // merchant, description or transaction in its input type or its body.
  const code = strip(read("lib/accounts/display-identity.ts"));
  for (const forbidden of [/\bmerchant\b/i, /\bdescription\b/i, /transaction/i, /\bcategory\b/i]) {
    assert.ok(!forbidden.test(code), `the identity authority reads a descriptor: ${forbidden}`);
  }
});

// ── 4 ────────────────────────────────────────────────────────────────────────

test("4. an institution name is never substituted for an account name", () => {
  // "Chase" names a bank that may hold five accounts. It is context, not identity.
  const code = strip(read("lib/accounts/display-identity.ts"));
  assert.ok(!/institution/i.test(code.replace(/institutionName\s+who holds it/g, "")),
    "the authority consults an institution");
  // Structural: an account whose only name is stored keeps it, and never
  // borrows the institution it belongs to.
  assert.equal(accountDisplayName({ name: "Joint Checking" }), "Joint Checking");
});

// ── 5 ────────────────────────────────────────────────────────────────────────

test("5. a nickname overrides ONLY when explicitly configured", () => {
  // `displayName` IS the nickname — a user-editable override, null until set.
  assert.equal(accountDisplayName(CHASE_CARD), "Ultimate Rewards®");
  assert.equal(accountDisplayName({ ...CHASE_CARD, displayName: "Travel card" }), "Travel card");
  assert.equal(resolveAccountIdentity({ ...CHASE_CARD, displayName: "Travel card" }).isUserNamed, true);
  // Clearing it falls back — it never strands the account nameless.
  assert.equal(accountDisplayName({ ...CHASE_CARD, displayName: "" }), "Ultimate Rewards®");
});

// ── 6 · 7 · 8 ────────────────────────────────────────────────────────────────

test("6-8. every account reader resolves through the ONE authority", () => {
  // Exports, the AI payload and every grouped debt account all flow from these
  // readers, so proving the readers is proving the surfaces.
  const READERS = [
    "lib/data/accounts.ts",          // Credit page, account lists
    "lib/data/transactions.ts",      // transaction DTOs, drawers, exports
    "lib/space/mount-composition.ts",// EVERY Space surface — Cash Flow, Debt Payments
    "lib/connections/space-data.ts", // connections
    "lib/investments/space-data.ts", // investments
    "lib/ai/assemblers/accounts.ts", // AI payload
  ];
  for (const f of READERS) {
    const code = strip(read(f));
    assert.ok(/accountDisplayName\(/.test(code), `${f} does not resolve through the authority`);
    assert.ok(!/displayName\s*\?\?[^;]*officialName/.test(code), `${f} still inlines the order`);
  }
});

test("6b. a reader that resolves must also SELECT the columns", () => {
  // The root cause was `loadSpaceAccounts` selecting `name` alone — it could not
  // resolve, so it silently emitted the provider's raw label.
  for (const f of [
    "lib/space/mount-composition.ts", "lib/connections/space-data.ts",
    "lib/investments/space-data.ts", "lib/ai/assemblers/accounts.ts",
  ]) {
    const code = strip(read(f));
    assert.ok(/ACCOUNT_NAME_SELECT/.test(code),
      `${f} resolves an identity without selecting the columns it needs`);
  }
  assert.deepEqual(Object.keys(ACCOUNT_NAME_SELECT).sort(),
    ["displayName", "name", "officialName", "plaidName"]);
});

// ── 9 ────────────────────────────────────────────────────────────────────────

test("9. the mask is disambiguation, never identity", () => {
  assert.equal(formatAccountMask("0202"), "••••0202");
  assert.equal(formatAccountMask(null), null);
  assert.equal(formatAccountMask("  "), null);
  // It is not blended into the name.
  assert.equal(accountDisplayName(CHASE_CARD), "Ultimate Rewards®");
});

test("10. the authority has no runtime dependencies", () => {
  // Pure by construction: it must stay usable from a React component, a server
  // read, a tsx script and a test without dragging anything behind it.
  const code = read("lib/accounts/display-identity.ts");
  const imports = [...code.matchAll(/^import .*$/gm)].map((m) => m[0]);
  assert.deepEqual(imports, [], "the identity authority grew an import");
});

// ── sorting (v2.6-TRUTH-10b) ────────────────────────────────────────────────

test("11. accounts order by the name a user SEES, not the stored one", () => {
  // The live case: "CREDIT CARD" displays "Ultimate Rewards®" and belongs LAST
  // among the debt accounts, not fourth.
  const rows = [
    { id: "a", name: "Beacon Mortgage" },
    { id: "b", name: "CREDIT CARD", officialName: "Ultimate Rewards®" },
    { id: "c", name: "Example CU Credit Card" },
  ];
  const sorted = [...rows].sort(compareAccountsByDisplayName);
  assert.deepEqual(sorted.map((r) => accountDisplayName(r)),
    ["Beacon Mortgage", "Example CU Credit Card", "Ultimate Rewards®"]);
  // The stored order would have put it in the middle.
  assert.notDeepEqual(sorted.map((r) => r.id), [...rows].sort((x, y) => x.name.localeCompare(y.name)).map((r) => r.id));
});

test("12. the comparator is deterministic when two accounts share a name", () => {
  const a = { id: "z", name: "Checking" };
  const b = { id: "a", name: "Checking" };
  assert.ok(compareAccountsByDisplayName(a, b) > 0);
  assert.ok(compareAccountsByDisplayName(b, a) < 0);
  assert.equal(compareAccountsByDisplayName(a, { ...a }), 0);
});

test("13. snapshot summation order is NOT re-sorted", () => {
  // lib/snapshots/space-accounts.ts states that summation order fixes the exact
  // float result. That is a financial artifact, not a label, and must not move.
  const snap = read("lib/snapshots/space-accounts.ts");
  assert.ok(!/sortAccountsForDisplay|compareAccountsByDisplayName/.test(snap),
    "the snapshot reader was re-sorted — its float totals can now drift from live");
  assert.ok(/name: "asc"/.test(snap), "the snapshot reader lost its stored-name order");
});
