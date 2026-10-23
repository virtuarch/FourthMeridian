/**
 * lib/accounts/display-identity.test.ts   (v2.6-TRUTH-10)
 *
 * One account, one name — and the guards that keep it that way.
 *
 * The live defect: a Chase card rendered "CREDIT CARD" on Cash Flow and
 * "Ultimate Rewards®" on the Credit page. Both were real columns on one row.
 *
 * Also carries the completed-TRUTH-10 authority guards (merged from
 * lib/accounts/display-identity.authority.test.ts): the five-site convergence
 * scan (no inline resolution anywhere), the partial name-select guard, and the
 * behavioural floor on the four-rung order. Those scans share this file's
 * read/strip/walk helpers.
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

// ── merged from lib/accounts/display-identity.authority.test.ts ──────────────
// v2.6-TRUTH-10 (completed) — the account-identity authority is the ONLY
// implementation of the account-name resolution order.
//
// Why a source-scan guard: the order `displayName ?? officialName ?? plaidName
// ?? name` was documented in schema.prisma and implemented FIVE times inline.
// One copy (the admin drawer) had already drifted — it omitted `plaidName`.
// TRUTH-10 converged them onto `accountDisplayName`, and the convergence proof
// said so. It was not complete. Two copies survived the proof and were found by
// a later audit:
//
//   lib/ai/assemblers/transactions.ts   a TWO-rung `displayName ?? name` in the
//                                       AI drilldown, reading a `select` that
//                                       fetched only those two columns — so the
//                                       authority was structurally unable to
//                                       answer even if called. A Chase card the
//                                       whole product calls "Ultimate Rewards®"
//                                       was narrated to the model as "CREDIT CARD".
//   lib/investments/connection-import-accounts.ts
//                                       a correct-but-duplicated four-rung copy.
//
// A convergence that is asserted in prose gets re-broken. This asserts it in
// code and fails CLOSED: a new inline copy, or a name `select` that omits a
// column, is a change to a converged authority and gets reviewed rather than
// merged quietly. (Comments are stripped before scanning — prose describing the
// rule is not a second implementation of it.)

const AUTHORITY = "lib/accounts/display-identity.ts";
/** Source roots that may read accounts. */
const SCAN_ROOTS = ["lib", "app", "components", "jobs"];
const NAME_COLUMNS = ["displayName", "officialName", "plaidName"] as const;

test("TRUTH-10: no inline account-name resolution outside the authority", () => {
  // A `??` chain that reaches a name column from another name column. Matches
  // both `displayName ?? officialName ?? plaidName ?? name` (the duplicate) and
  // `displayName ?? name` (the downgrade).
  //
  // `resolvedMerchant.displayName` is a MERCHANT name, a different noun on a
  // different model, so the pattern requires a second ACCOUNT name column or a
  // bare `.name` on the same expression — which merchant code never writes.
  const inline = /\bdisplayName\s*\?\?\s*[\w.?]*\s*\.?\s*(officialName|plaidName|name)\b/;

  const offenders: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of walk(root)) {
      if (file === AUTHORITY) continue;
      const code = strip(read(file));
      if (inline.test(code)) offenders.push(file);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Inline account-name resolution found outside lib/accounts/display-identity.ts:\n` +
    offenders.map((f) => `  ${f}`).join("\n") +
    `\n\nUse accountDisplayName() (and ACCOUNT_NAME_SELECT on the read). ` +
    `This rule had five implementations before TRUTH-10 and two survived its ` +
    `convergence proof; a sixth is how one account gets two names again.`,
  );
});

test("TRUTH-10: no account read selects SOME name columns but not all four", () => {
  // The subtler failure: correct resolution over INCOMPLETE EVIDENCE. The call
  // site looks right and the answer is silently downgraded.
  //
  // ── Identity evidence vs FINGERPRINT evidence ─────────────────────────────
  //
  // The trigger is `displayName`, deliberately. `displayName` is the user's own
  // override — the identity rung — so a select that asks for it is trying to
  // name the account, and must therefore be able to reach all four rungs.
  //
  // A read that asks for `officialName`/`plaidName`/`name` WITHOUT `displayName`
  // is a different question: provider-fingerprint matching (duplicate-account
  // detection, app/api/accounts/[id]/restore/route.ts → resolveAccountByFingerprint).
  // Excluding `displayName` there is CORRECT, not an omission — two accounts a
  // user happened to rename identically are not the same account, and matching on
  // a user-supplied label would merge them. This guard caught that read on its
  // first run; the rule now encodes the distinction instead of allowlisting it.
  //
  // Scanned per `select: { … }` block so an unrelated select elsewhere in the
  // same file cannot mask a partial one.
  const offenders: string[] = [];

  for (const root of SCAN_ROOTS) {
    for (const file of walk(root)) {
      if (file === AUTHORITY) continue;
      const code = strip(read(file));
      // Every `select: {` … balanced-ish block. A non-greedy match to the next
      // `}` is enough: name columns are scalars and never nest.
      for (const m of code.matchAll(/select:\s*\{([^{}]*)\}/g)) {
        const block = m[1];
        if (/ACCOUNT_NAME_SELECT/.test(block)) continue;      // uses the authority
        const present = NAME_COLUMNS.filter((c) => new RegExp(`\\b${c}:\\s*true`).test(block));
        const hasName = /\bname:\s*true/.test(block);
        // Only IDENTITY-shaped reads are in scope — see the note above.
        if (!present.includes("displayName")) continue;
        // A merchant / instrument / resolved-entity select carries `displayName`
        // alone with no `name`: a different model, not an account read.
        if (present.length === 1 && !hasName) continue;
        if (present.length === NAME_COLUMNS.length && hasName) continue; // complete
        offenders.push(`${file}  →  { ${present.join(", ")}${hasName ? ", name" : ""} }`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Account read(s) selecting an INCOMPLETE set of name columns:\n` +
    offenders.map((f) => `  ${f}`).join("\n") +
    `\n\nSpread ACCOUNT_NAME_SELECT instead. A partial select makes ` +
    `accountDisplayName() unable to answer, and it degrades SILENTLY — the call ` +
    `site looks correct. This is precisely how the AI drilldown kept narrating ` +
    `"CREDIT CARD" for an account every other surface calls "Ultimate Rewards®".`,
  );
});

test("TRUTH-10: the authority still resolves all four rungs, in order", () => {
  // Cheap behavioural floor beside the source scans, so the guard cannot pass on
  // a file that merely LOOKS converged while the rule itself has been gutted.
  const base = { name: "STORED", plaidName: "PROVIDER", officialName: "OFFICIAL", displayName: "USER" };
  assert.equal(resolveAccountIdentity(base).basis, "USER_OVERRIDE");
  assert.equal(resolveAccountIdentity({ ...base, displayName: null }).basis, "OFFICIAL_NAME");
  assert.equal(resolveAccountIdentity({ ...base, displayName: null, officialName: null }).basis, "PROVIDER_NAME");
  assert.equal(resolveAccountIdentity({ name: "STORED" }).basis, "STORED_NAME");
  // Blank is absence, not a name — a cleared rename must not render empty.
  assert.equal(resolveAccountIdentity({ ...base, displayName: "   " }).displayName, "OFFICIAL");
});
