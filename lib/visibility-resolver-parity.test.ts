/**
 * lib/visibility-resolver-parity.test.ts — V25-CLOSE-2
 *
 * INVARIANT: every Space-scoped "what may this Space see in detail?" resolver
 * asks the SAME question, and the detail tier has exactly ONE definition.
 *
 * WHY. Fourth Meridian shares real financial accounts between real people, so
 * this is the boundary where a bug is a family member reading another's private
 * account. The predicate itself (`TRANSACTION_DETAIL_VISIBILITY`) is already
 * canonical and correctly reused. What is NOT centralised is the QUERY: three
 * resolvers hand-roll the traversal three different ways —
 *
 *   lib/data/transaction-query.ts      resolveVisibleAccountIds
 *   lib/accounts/space-account-link.ts resolveFullVisibleAccountIds
 *   lib/investments/account-scope.ts   resolveSpaceInvestmentAccountIds
 *
 * — and each is unit-tested only against itself. They agree today. Nothing
 * asserted that they keep agreeing, and the realistic regression is not someone
 * deleting the predicate; it is a fourth reader (or an edit to a third) that
 * quietly drops `status: ACTIVE` or the soft-delete filter and so returns a
 * slightly larger set than its siblings.
 *
 * DELIBERATELY NOT DONE: no new visibility abstraction. The architecture is
 * fine; what was missing was enforcement. These are assertions over the existing
 * code, not a wrapper the resolvers must now route through.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

const ROOT = process.cwd();

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

/** Strip comments — a rule must be satisfied by code, never by prose about it. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Slice a named function's BODY.
 *
 * Naively taking the first `{` after the declaration is wrong: a return type
 * annotation can contain braces, e.g.
 *   `): Promise<{ accountIds: string[]; spaceId: string | null }> {`
 * where the first `{` opens the TYPE, not the body. That mistake silently
 * hands back a type literal to assert against — which passes or fails for
 * reasons unrelated to the code. So: walk past the parameter list, then take
 * the first `{` seen at generic-depth zero.
 */
function functionBody(src: string, name: string): string {
  const start = src.search(new RegExp(`(export\\s+)?(async\\s+)?function\\s+${name}\\b`));
  assert.notEqual(start, -1, `Could not find function ${name} — was it renamed? Update this guard.`);

  // Step past the parameter list.
  const paramOpen = src.indexOf("(", start);
  let parens = 0;
  let i = paramOpen;
  for (; i < src.length; i++) {
    if (src[i] === "(") parens++;
    else if (src[i] === ")" && --parens === 0) break;
  }

  // Then find the body brace, ignoring any braces nested inside `<...>`.
  let angles = 0;
  let open = -1;
  for (i += 1; i < src.length; i++) {
    const ch = src[i];
    if (ch === "<") angles++;
    else if (ch === ">") angles = Math.max(0, angles - 1);
    else if (ch === "{" && angles === 0) { open = i; break; }
  }
  assert.notEqual(open, -1, `Could not locate the body of ${name} — update this guard.`);

  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) {
      const body = src.slice(open, j + 1);
      // Self-check: a body contains statements. A type literal does not. This
      // is what would have caught the bug above rather than shipping it.
      assert.ok(
        /\b(const|let|return|await|if)\b/.test(body),
        `Extracted "body" of ${name} contains no statements — the slicer ` +
          `matched a type annotation instead of the function body.`,
      );
      return body;
    }
  }
  throw new Error(`Unbalanced braces reading ${name}`);
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "prototype") continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel, acc);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) acc.push(rel);
  }
  return acc;
}

/**
 * The Space-scoped detail resolvers, and the four constraints each must apply.
 * Adding a resolver here is how a new reader enrols (see the enrolment test).
 */
const SPACE_SCOPED_RESOLVERS = [
  { file: "lib/data/transaction-query.ts", fn: "resolveVisibleAccountIds" },
  { file: "lib/accounts/space-account-link.ts", fn: "resolveFullVisibleAccountIds" },
  { file: "lib/investments/account-scope.ts", fn: "resolveSpaceInvestmentAccountIds" },
] as const;

const CONSTRAINTS: { id: string; re: RegExp; why: string }[] = [
  {
    id: "spaceId scoping",
    re: /\bspaceId\b/,
    why: "without it the resolver answers for every Space at once",
  },
  {
    id: "status ACTIVE",
    re: /status:\s*(?:ShareStatus\.ACTIVE|"ACTIVE"|'ACTIVE')/,
    why: "a REVOKED or pending link must not grant detail",
  },
  {
    id: "canonical detail predicate",
    re: /TRANSACTION_DETAIL_VISIBILITY/,
    why: "the tier must come from the shared predicate, never a hand-written level",
  },
  {
    id: "soft-delete filter",
    re: /deletedAt:\s*null/,
    why: "a soft-deleted account must leave every visible set",
  },
];

for (const { file, fn } of SPACE_SCOPED_RESOLVERS) {
  test(`parity — ${fn} applies all four visibility constraints`, () => {
    const body = functionBody(stripComments(read(file)), fn);
    for (const c of CONSTRAINTS) {
      assert.ok(
        c.re.test(body),
        `${file} → ${fn}() is missing "${c.id}" — ${c.why}.\n` +
          `All Space-scoped detail resolvers must apply the same four ` +
          `constraints, or one of them returns a wider set than its siblings ` +
          `and the difference is a privacy leak.`,
      );
    }
  });
}

test("the detail tier is expressed ONLY through the shared predicate", () => {
  const offenders: string[] = [];
  for (const root of ["lib", "app"]) {
    for (const file of walk(root)) {
      const src = stripComments(read(file));
      // A Prisma where-clause gating on visibilityLevel must reference the
      // shared constant, not an inline array of levels.
      for (const m of src.matchAll(/visibilityLevel:\s*\{\s*(?:in|notIn):\s*([^}]+)\}/g)) {
        if (!m[1].includes("TRANSACTION_DETAIL_VISIBILITY")) {
          offenders.push(`${file} — visibilityLevel: { in: ${m[1].trim().slice(0, 48)} }`);
        }
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Detail-tier gating must use TRANSACTION_DETAIL_VISIBILITY (lib/ai/visibility.ts). ` +
      `An inline level array is a second definition of the tier and will drift:\n  ` +
      offenders.join("\n  "),
  );
});

test("the detail predicate is pinned — widening it must be a deliberate act", () => {
  const src = stripComments(read("lib/ai/visibility.ts"));
  const decl = src.match(/TRANSACTION_DETAIL_VISIBILITY[^=]*=\s*\[([^\]]*)\]/);
  assert.ok(decl, "Could not read TRANSACTION_DETAIL_VISIBILITY — update this guard.");

  const levels = decl![1].split(",").map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(
    levels,
    ["VisibilityLevel.FULL"],
    `TRANSACTION_DETAIL_VISIBILITY changed to [${levels.join(", ")}].\n\n` +
      `This is not automatically wrong, but it is load-bearing far beyond the ` +
      `Prisma queries: several surfaces still gate detail with an IN-MEMORY ` +
      `comparison against VisibilityLevel.FULL rather than the shared ` +
      `grantsTransactionDetail() predicate. Those sites will NOT see a widened ` +
      `tier and will silently disagree with the database queries:\n` +
      `  lib/ai/assemblers/accounts.ts   (isFullView / isFull / !== FULL guards)\n` +
      `  lib/activity/account-name-privacy.ts\n` +
      `  lib/activity/scrub-account-name.ts\n\n` +
      `Convert those to grantsTransactionDetail() in the same change, then ` +
      `update this assertion.`,
  );
});

test("enrolment — every Space-scoped detail reader is a known authority", () => {
  // The files that reference the predicate IN CODE. Note this is 11, not the ~20
  // that `grep TRANSACTION_DETAIL_VISIBILITY` reports: nine more name it only in
  // prose (they call a resolver or grantsTransactionDetail instead), and comments
  // are stripped before this scan. Enrolling a commented-only file would make the
  // floor below unfalsifiable, so the two numbers must not be conflated.
  const known = new Set<string>([
    ...SPACE_SCOPED_RESOLVERS.map((r) => r.file),
    // The predicate's own definition.
    "lib/ai/visibility.ts",
    // Consumers that inline the gated join rather than calling a resolver. Each
    // was reviewed in V25-CLOSE-2 and carries the constraints its query shape
    // requires; listed so a NEW one cannot appear unnoticed.
    "lib/data/transactions.ts",
    "lib/data/accounts.ts",
    "lib/transactions/detail-query.ts",
    "lib/transactions/transfer-resolution.ts",
    "lib/investments/legacy-crypto-holdings.ts",
    "lib/investments/space-data.ts",
    "lib/ai/assemblers/transactions.ts",
  ]);

  const found: string[] = [];
  for (const root of ["lib", "app"]) {
    for (const file of walk(root)) {
      if (stripComments(read(file)).includes("TRANSACTION_DETAIL_VISIBILITY")) found.push(file);
    }
  }

  const unknown = found.filter((f) => !known.has(f));
  assert.deepEqual(
    unknown,
    [],
    `New reader(s) of the detail-visibility predicate found:\n  ${unknown.join("\n  ")}\n\n` +
      `This guard fails CLOSED on purpose. A new detail-gated read is a change ` +
      `to the privacy boundary, so it gets reviewed rather than merged quietly. ` +
      `Confirm the query carries spaceId + status ACTIVE + the shared predicate ` +
      `+ a soft-delete filter, then add the file to the known set above.`,
  );

  // Anti-vacuity: if the scan or matcher breaks, `unknown` is trivially empty
  // and this test would "pass" while checking nothing.
  assert.ok(
    found.length >= 10,
    `Expected the known detail-visibility readers (11 at V25-CLOSE-2), found ` +
      `${found.length}. The scan is broken — fix it rather than lowering this floor.`,
  );
});

/**
 * resolveSingleAccountScope is deliberately NOT in SPACE_SCOPED_RESOLVERS: it
 * answers a DIFFERENT question ("may this account be read in detail at all?",
 * for account-centric callers that may have no Space context — its own tests
 * exercise it with a null spaceIdHint). It therefore cannot be held to spaceId
 * scoping without changing its meaning.
 *
 * It must still never be looser than its siblings on the constraints that do
 * apply, so those are pinned here. The known gap — that it ignores the caller's
 * spaceIdHint when one IS supplied, so an account FULL in Space A can resolve
 * while reading in Space B — is recorded in the V25-CLOSE-2 audit as a follow-up
 * rather than silently blessed. It is not currently reachable with an
 * attacker-chosen account id (no route accepts one on this path).
 */
test("account-centric scope resolver is not looser than the Space-scoped ones", () => {
  const body = functionBody(stripComments(read("lib/investments/account-scope.ts")), "resolveSingleAccountScope");
  const detailBranch = body.slice(body.indexOf('scope === "detailEligible"'));

  assert.ok(
    /status:\s*(?:ShareStatus\.ACTIVE|"ACTIVE"|'ACTIVE')/.test(detailBranch),
    "resolveSingleAccountScope's detailEligible branch dropped status: ACTIVE.",
  );
  assert.ok(
    /TRANSACTION_DETAIL_VISIBILITY/.test(detailBranch),
    "resolveSingleAccountScope's detailEligible branch dropped the shared detail predicate.",
  );
});
