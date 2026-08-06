/**
 * lib/accounts/display-identity.authority.test.ts
 *
 * v2.6-TRUTH-10 (completed) — the account-identity authority is the ONLY
 * implementation of the account-name resolution order.
 *
 * ── Why a source-scan guard ─────────────────────────────────────────────────
 *
 * The order `displayName ?? officialName ?? plaidName ?? name` was documented in
 * schema.prisma and implemented FIVE times inline. One copy (the admin drawer)
 * had already drifted — it omitted `plaidName`. TRUTH-10 converged them onto
 * `accountDisplayName`, and the convergence proof said so.
 *
 * It was not complete. Two copies survived the proof and were found by a later
 * audit:
 *
 *   lib/ai/assemblers/transactions.ts   a TWO-rung `displayName ?? name` in the
 *                                       AI drilldown, reading a `select` that
 *                                       fetched only those two columns — so the
 *                                       authority was structurally unable to
 *                                       answer even if called. A Chase card the
 *                                       whole product calls "Ultimate Rewards®"
 *                                       was narrated to the model as "CREDIT CARD".
 *   lib/investments/connection-import-accounts.ts
 *                                       a correct-but-duplicated four-rung copy.
 *
 * A convergence that is asserted in prose gets re-broken. This asserts it in code
 * and fails CLOSED: a new inline copy, or a name `select` that omits a column, is
 * a change to a converged authority and gets reviewed rather than merged quietly.
 *
 * ── The two failure shapes it catches ───────────────────────────────────────
 *
 *   1. INLINE RESOLUTION — any `?? `-chain over two or more name columns outside
 *      the authority. Both the four-rung duplicate and the two-rung downgrade.
 *   2. PARTIAL SELECT — a Prisma select that fetches SOME name columns but not
 *      all four. This is the subtler one and the reason TRUTH-10 missed a case:
 *      the resolution can be correct while the evidence is incomplete, and the
 *      result is a silent downgrade with no code smell at the call site.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolveAccountIdentity } from "@/lib/accounts/display-identity";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const ROOT = process.cwd();
const AUTHORITY = path.join("lib", "accounts", "display-identity.ts");

/** Source roots that may read accounts. */
const SCAN_ROOTS = ["lib", "app", "components", "jobs"];

function walk(rel: string): string[] {
  const abs = path.join(ROOT, rel);
  let entries: string[];
  try { entries = readdirSync(abs); } catch { return []; }
  const out: string[] = [];
  for (const e of entries) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const childRel = path.join(rel, e);
    const st = statSync(path.join(ROOT, childRel));
    if (st.isDirectory()) { out.push(...walk(childRel)); continue; }
    if (!/\.(ts|tsx)$/.test(e) || /\.test\.tsx?$/.test(e)) continue;
    out.push(childRel);
  }
  return out;
}

/** Strip comments — the resolution order is DOCUMENTED in several headers, and
 *  prose describing the rule is not a second implementation of it. */
function codeOf(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
}

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
      const code = codeOf(file);
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
      const code = codeOf(file);
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
