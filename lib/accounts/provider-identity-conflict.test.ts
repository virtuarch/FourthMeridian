/**
 * lib/accounts/provider-identity-conflict.test.ts  (PROVIDER-IDENTITY)
 *
 * A UNIQUENESS COLLISION IS CLASSIFIED, THE THREE VERDICTS ARE DISTINGUISHABLE,
 * AND THE CATCH NO LONGER HAS A CATCH-ALL.
 *
 * ── WHAT THIS FILE CAN AND CANNOT PROVE ─────────────────────────────────────
 * It proves the LOGIC: that `SAME_ACCOUNT`, `DIFFERENT_ACCOUNT` and
 * `INDETERMINATE` are reachable, that each one is reached for its own reason,
 * and — the part that matters — that forcing one branch does NOT fire the
 * others. A classifier that collapses two verdicts into one is the original
 * swallow in a new costume, and it would pass a test that only ever asserted
 * "it threw".
 *
 * It proves NOTHING about database authority. The claim that an empty reread is
 * what a tenant client actually SEES when the conflicting row belongs to
 * someone else is a policy claim, and a fake cannot make one — it answers
 * whatever it was written to answer. That is case 81 of
 * scripts/rls-app-acceptance.ts, on a real provisioned `fm_app` role, with the
 * owner connection standing as its denominator.
 *
 * ⚠️ Every absence claim below asserts a denominator first, and every source
 * scan shows its needle MATCHING something before any zero is read.
 *
 *   npx tsx lib/accounts/provider-identity-conflict.test.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ProviderType } from "@prisma/client";

import {
  classifyProviderIdentityConflictRows,
  conflictKeyIsAccountScoped,
  isAuthorityRefusal,
  isUniqueCollision,
  ProviderIdentityConflictError,
} from "@/lib/accounts/provider-identity";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROOT = join(__dirname, "..", "..");
const IDENT = "lib/accounts/provider-identity.ts";
const raw = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
/** Comments stripped, so a header EXPLAINING a hazard never satisfies a scan for it. */
const code = (rel: string) => raw(rel).replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

/** A Prisma-shaped error, built the way the driver actually builds one. */
function prismaError(message: string, code?: string, meta?: unknown): Error {
  const e = new Error(message) as Error & { code?: string; meta?: unknown };
  if (code !== undefined) e.code = code;
  if (meta !== undefined) e.meta = meta;
  return e;
}

/** The VERBATIM tail Prisma produced for a refused model write on a real fm_app role. */
const RLS_REFUSAL = prismaError(
  'Invalid `prisma.providerAccountIdentity.create()` invocation:\n\n' +
  'Raw query failed. Code: `42501`. Message: `ERROR: new row violates row-level security policy ' +
  'for table "ProviderAccountIdentity"`',
);

const OURS    = "acct_ours";
const FOREIGN = "acct_theirs";
const OTHER2  = "acct_theirs_2";

// ═════════════════════════════════════════════════════════════════════════════
// A — THE TWO PREDICATES ARE DISJOINT, AND NEITHER IS A SUBSTRING TEST
// ═════════════════════════════════════════════════════════════════════════════

console.log("A. isUniqueCollision / isAuthorityRefusal — DISJOINT, AND EACH POSITIVE ON ITS OWN SHAPE");
{
  const p2002 = prismaError("Unique constraint failed", "P2002", { target: ["provider", "externalAccountId", "financialAccountId"] });
  const untyped23505 = prismaError(
    'Raw query failed. Code: `23505`. Message: `ERROR: duplicate key value violates unique constraint ' +
    '"ProviderAccountIdentity_provider_externalAccountId_financia_key"`',
  );

  check("P2002 IS a uniqueness collision", isUniqueCollision(p2002));
  check("an UNTYPED 23505 is a uniqueness collision too — the deferred/raw shape that let a refusal through this catch once already",
    isUniqueCollision(untyped23505));
  check("a typed NOT-FOUND (P2025) is NOT a collision", !isUniqueCollision(prismaError("not found", "P2025")));
  check("a plain Error is not a collision", !isUniqueCollision(new Error("socket hang up")));
  check("a non-Error is not a collision", !isUniqueCollision("P2002"));

  // THE DISJOINTNESS, BOTH WAYS. If either predicate claimed the other's shape
  // the catch would relabel an authority failure as an identity conflict, or
  // hide a conflict inside an authority report.
  check("the RLS refusal IS an authority refusal (the denominator for the two zeros below)", isAuthorityRefusal(RLS_REFUSAL));
  check("the RLS refusal is NOT a uniqueness collision", !isUniqueCollision(RLS_REFUSAL));
  check("P2002 is NOT an authority refusal", !isAuthorityRefusal(p2002));
  check("the untyped 23505 is NOT an authority refusal", !isAuthorityRefusal(untyped23505));
}

// ═════════════════════════════════════════════════════════════════════════════
// B — THE CONFLICTING KEY, INCLUDING THE SHAPE POSTGRES TRUNCATES
// ═════════════════════════════════════════════════════════════════════════════

console.log("\nB. conflictKeyIsAccountScoped — ALL THREE meta.target SHAPES, AND THE TRUNCATED ONE");
{
  const scoped = (target: unknown) => conflictKeyIsAccountScoped(prismaError("x", "P2002", { target }));

  check("field-name array including financialAccountId → ACCOUNT-SCOPED",
    scoped(["provider", "externalAccountId", "financialAccountId"]));
  check("the LIVE index name, which Postgres TRUNCATES mid-word at 63 chars → still ACCOUNT-SCOPED",
    scoped(["ProviderAccountIdentity_provider_externalAccountId_financia_key"]),
    "a needle of `financialAccountId` would miss this and misread an own-row collision as a foreign one");
  check("the same name as a BARE STRING rather than an array → ACCOUNT-SCOPED",
    scoped("ProviderAccountIdentity_provider_externalAccountId_financia_key"));

  check("the LEGACY global key's field array → NOT account-scoped",
    !scoped(["provider", "externalAccountId"]));
  check("the LEGACY global index name → NOT account-scoped",
    !scoped(["ProviderAccountIdentity_provider_externalAccountId_key"]));
  check("absent metadata → NOT account-scoped, i.e. FAILS CLOSED toward treating a foreign row as a conflict",
    !conflictKeyIsAccountScoped(prismaError("x", "P2002")));
  check("a null target → fails closed the same way", !scoped(null));
}

// ═════════════════════════════════════════════════════════════════════════════
// C — THE DECISION TABLE, FORCED BRANCH BY BRANCH
//
// ⚠️ EACH CASE ASSERTS THE VERDICT IT WANTS **AND** THAT THE OTHER TWO DID NOT
// FIRE. "It returned DIFFERENT_ACCOUNT" is satisfied by a function that returns
// DIFFERENT_ACCOUNT unconditionally; the pairing is what rules that out.
// ═════════════════════════════════════════════════════════════════════════════

console.log("\nC. classifyProviderIdentityConflictRows — EVERY BRANCH FORCED, EVERY OTHER BRANCH PROVEN SILENT");

type Row = { financialAccountId: string };
const classify = (rows: Row[], provider: ProviderType, accountScopedKey: boolean) =>
  classifyProviderIdentityConflictRows({ rows, financialAccountId: OURS, provider, accountScopedKey });

/** Assert the verdict AND the two it is not. */
function verdict(
  name: string,
  got: { verdict: string; conflictingAccountCount: number },
  want: "SAME_ACCOUNT" | "DIFFERENT_ACCOUNT" | "INDETERMINATE",
  wantCount?: number,
) {
  const others = (["SAME_ACCOUNT", "DIFFERENT_ACCOUNT", "INDETERMINATE"] as const).filter((v) => v !== want);
  check(name,
    got.verdict === want
      && others.every((v) => got.verdict !== v)
      && (wantCount === undefined || got.conflictingAccountCount === wantCount),
    `verdict=${got.verdict} want=${want} count=${got.conflictingAccountCount}${wantCount === undefined ? "" : ` wantCount=${wantCount}`}`);
}

// ── SAME_ACCOUNT — the replay, and the ONLY non-fatal verdict ───────────────
verdict("our own row, own-key collision (the concurrent-create loser / the xpub sibling) → SAME_ACCOUNT",
  classify([{ financialAccountId: OURS }], ProviderType.PLAID, true), "SAME_ACCOUNT", 0);
verdict("our own row, GLOBAL-key collision → still SAME_ACCOUNT: the key changes who may be there, not who is",
  classify([{ financialAccountId: OURS }], ProviderType.PLAID, false), "SAME_ACCOUNT", 0);

// ── DIFFERENT_ACCOUNT — the conflict ───────────────────────────────────────
verdict("a foreign holder under a GLOBAL key → DIFFERENT_ACCOUNT",
  classify([{ financialAccountId: FOREIGN }], ProviderType.PLAID, false), "DIFFERENT_ACCOUNT", 1);
verdict("a foreign holder under an OWN-KEY collision, for an EXCLUSIVE provider → still DIFFERENT_ACCOUNT",
  classify([{ financialAccountId: OURS }, { financialAccountId: FOREIGN }], ProviderType.PLAID, true),
  "DIFFERENT_ACCOUNT", 1);
verdict("two distinct foreign holders are counted as TWO",
  classify([{ financialAccountId: FOREIGN }, { financialAccountId: OTHER2 }, { financialAccountId: OURS }],
    ProviderType.PLAID, false), "DIFFERENT_ACCOUNT", 2);
verdict("the SAME foreign holder twice (an xpub's many addresses) is counted ONCE — the count is holders, not rows",
  classify([{ financialAccountId: FOREIGN }, { financialAccountId: FOREIGN }], ProviderType.PLAID, false),
  "DIFFERENT_ACCOUNT", 1);

// ── THE PROVIDER DISTINCTION — D2 Step 1D is honoured, and only for WALLET ──
verdict("WALLET: a co-owner's row beside ours under an OWN-KEY collision is LEGITIMATE coexistence → SAME_ACCOUNT",
  classify([{ financialAccountId: OURS }, { financialAccountId: FOREIGN }], ProviderType.WALLET, true),
  "SAME_ACCOUNT", 1);
verdict("WALLET under a GLOBAL key is a real conflict again — the constraint, not the provider, decides exclusivity there",
  classify([{ financialAccountId: OURS }, { financialAccountId: FOREIGN }], ProviderType.WALLET, false),
  "DIFFERENT_ACCOUNT", 1);
verdict("an UNRECOGNISED provider fails CLOSED — sharing is an allowlist, never an assumption",
  classify([{ financialAccountId: OURS }, { financialAccountId: FOREIGN }], ProviderType.BROKERAGE, true),
  "DIFFERENT_ACCOUNT", 1);

// ── INDETERMINATE — the one that must not degrade to "carry on" ────────────
verdict("AN EMPTY REREAD IS NOT 'NO CONFLICT' → INDETERMINATE, which is what RLS blindness will look like after the tenant conversion",
  classify([], ProviderType.PLAID, true), "INDETERMINATE", 0);
verdict("…and an empty reread under the legitimately-shared provider is equally INDETERMINATE",
  classify([], ProviderType.WALLET, false), "INDETERMINATE", 0);
verdict("WALLET, own-key collision, only a FOREIGN row visible: coexistence is legal but our own row is unaccounted for → INDETERMINATE",
  classify([{ financialAccountId: FOREIGN }], ProviderType.WALLET, true), "INDETERMINATE", 1);

// ── C2. THE COLLISION THE DATABASE CAN NOW ACTUALLY PRODUCE ────────────────
// Until 20261004000000 the PLAID global key DID NOT EXIST: D2 Step 1D had
// replaced it with the account-scoped triple, so every branch above that takes
// `accountScopedKey: false` for PLAID was reachable only by HAND. The partial
// unique index makes those branches live, and these three pin the MEASURED
// shapes rather than the imagined ones.
//
// Measured on Prisma 5.22 / Postgres 16 by inserting a second PLAID binding and
// reading `meta.target` off the real driver error:
//
//   second account, same owner      → ["provider","externalAccountId"]
//   second account, different owner → ["provider","externalAccountId"]
//   same account again (replay)     → ["provider","externalAccountId","financialAccountId"]
//
// ⚠️ THE REPLAY REPORTS THE TRIPLE BECAUSE BOTH INDEXES ARE VIOLATED AND
// POSTGRES CHECKS THE OLDER ONE FIRST. That is an index-OID ordering detail, not
// a contract, so the verdict must not depend on it — C's pair at "our own row,
// GLOBAL-key collision → still SAME_ACCOUNT" is exactly that independence, and
// this block names why it is now load-bearing rather than hypothetical.
{
  const target = (t: unknown) => prismaError("Unique constraint failed", "P2002", { target: t });
  const GLOBAL = ["provider", "externalAccountId"];
  const TRIPLE = ["provider", "externalAccountId", "financialAccountId"];

  check("the MEASURED global-key target reads as NOT account-scoped, so a foreign holder counts",
    !conflictKeyIsAccountScoped(target(GLOBAL)));
  check("the MEASURED replay target reads as ACCOUNT-SCOPED",
    conflictKeyIsAccountScoped(target(TRIPLE)));

  // Whichever index Postgres happens to report for a replay, the answer is the
  // same. This is the assertion that makes the verdict OID-order independent.
  const replayUnderEitherKey = [true, false].map((scoped) =>
    classify([{ financialAccountId: OURS }], ProviderType.PLAID, scoped).verdict);
  check("a PLAID replay classifies SAME_ACCOUNT under EITHER reported key — index order cannot change the verdict",
    JSON.stringify(replayUnderEitherKey) === JSON.stringify(["SAME_ACCOUNT", "SAME_ACCOUNT"]),
    `got ${JSON.stringify(replayUnderEitherKey)}`);

  // And the cross-tenant case, which is the whole reason the index is allowed to
  // be the authority: Postgres refuses the second binding without the writer
  // ever being able to SEE the row it collided with, and the classifier turns
  // that blindness into a refusal rather than into "no conflict, carry on".
  verdict("a PLAID global collision whose holder is INVISIBLE to the writer's own role → INDETERMINATE, fail closed",
    classify([], ProviderType.PLAID, false), "INDETERMINATE", 0);
}

// ── C3. [source] THE INDEX NAME CANNOT BE MISREAD AS ACCOUNT-SCOPED ─────────
// `conflictKeyIsAccountScoped` tests meta.target for the stem /financia/i,
// because Postgres truncates index names at 63 characters and the triple reads
// `…_financia_key`, cut mid-word. The measurement above says this driver reports
// field arrays, not names — but that is a driver detail, and if it ever reports
// the NAME, a new index carrying that stem would make a GLOBAL collision parse
// as "my own row", the one misreading that turns a contested identity into a
// silent success. Pinned at the migration, which is where the name lives.
{
  const mig = raw("prisma/migrations/20261004000000_plaid_identity_global_exclusivity/migration.sql");
  const created = /CREATE\s+UNIQUE\s+INDEX\s+"([^"]+)"/i.exec(mig);
  check("the migration creates exactly one named UNIQUE index", created !== null);
  if (created) {
    check(`its name carries no /financia/ stem (${created[1]})`, !/financia/i.test(created[1]));
    check("its name is within Postgres's 63-char limit, so it cannot be truncated INTO that stem",
      created[1].length <= 63);
    check("…and conflictKeyIsAccountScoped would read that name as NOT account-scoped",
      !conflictKeyIsAccountScoped(prismaError("x", "P2002", { target: created[1] })));
  }
  // The predicate is an allowlist. A denylist would enrol MANUAL, CSV, EXCHANGE
  // and BROKERAGE — and any future provider — into Plaid's cardinality.
  // ⚠️ SQL COMMENTS ARE STRIPPED FIRST. The migration's own prose DISCUSSES the
  // `<> 'WALLET'` spelling in order to reject it, so a scan of the raw file
  // reports the denylist it exists to forbid. Measured: this needle failed on
  // its first run for exactly that reason.
  const sql = mig.replace(/^\s*--.*$/gm, "");
  check("DENOMINATOR: stripping comments leaves the statement, not an empty string",
    /CREATE\s+UNIQUE\s+INDEX/i.test(sql) && sql.replace(/\s/g, "").length > 80);
  check("the predicate names PLAID positively and is not a `<> 'WALLET'` denylist",
    /WHERE\s+provider\s*=\s*'PLAID'/i.test(sql) && !/provider\s*(<>|!=)/i.test(sql));
}

// ═════════════════════════════════════════════════════════════════════════════
// D — THE ERROR DISCLOSES NOTHING ABOUT THE OTHER TENANT
// ═════════════════════════════════════════════════════════════════════════════

console.log("\nD. ProviderIdentityConflictError — CARRIES THE VERDICT, NOT THE OTHER TENANT");
{
  const SECRET_EXTERNAL = "plaid-account-id-DO-NOT-LOG";
  const e = new ProviderIdentityConflictError(
    OURS, ProviderType.PLAID, "DIFFERENT_ACCOUNT", 1,
    prismaError(`Unique constraint failed on ${SECRET_EXTERNAL}`, "P2002"),
  );
  const text = `${e.name} ${e.message}`;

  // DENOMINATOR FIRST: the message is non-empty and does name OUR account, so
  // the two absences below are read off a string that demonstrably says things.
  check("DENOMINATOR: the message is substantial and names the account the caller passed",
    text.length > 200 && text.includes(OURS), `len=${text.length}`);
  check("it does NOT contain the provider's external account id", !text.includes(SECRET_EXTERNAL));
  check("it does NOT contain the conflicting account's id", !text.includes(FOREIGN));
  check("it DOES carry the holder count, which is operational signal without being an identity", /\b1 OTHER FinancialAccount/.test(text));
  check("the verdict is machine-readable, so a caller can degrade on it without parsing prose",
    e.verdict === "DIFFERENT_ACCOUNT" && e.conflictingAccountCount === 1 && e.financialAccountId === OURS);
  check("the originating collision is preserved as `cause` rather than discarded",
    (e as { cause?: unknown }).cause instanceof Error);

  const ind = new ProviderIdentityConflictError(OURS, ProviderType.WALLET, "INDETERMINATE", 0, new Error("x"));
  check("the INDETERMINATE message says explicitly that an empty reread is not evidence of no conflict",
    /NOT evidence of no conflict/i.test(ind.message));
}

// ═════════════════════════════════════════════════════════════════════════════
// E — THE CATCH IS NARROW, AND THE REREAD DOES NOT ESCALATE
// ═════════════════════════════════════════════════════════════════════════════

console.log("\nE. [source] THE SWALLOW IS GONE AND THE CLASSIFICATION DOES NOT ESCALATE");
{
  const src = code(IDENT);
  const header = raw(IDENT);

  // DENOMINATOR for every scan below: the file was read, comments were
  // stripped, and the stripped text still contains the function under test.
  check("DENOMINATOR: the stripped source is non-trivial and still contains the function",
    src.length > 1500 && /export async function dualWriteProviderAccountIdentity/.test(src),
    `strippedLen=${src.length} ofRaw=${header.length}`);

  // The needle is shown to MATCH BEFORE a zero is read off it: `console.warn`
  // still exists in the codebase's vocabulary — just not here.
  check("NEEDLE CONTROL: `console.warn(` matches in a module that legitimately still has one",
    /console\.warn\(/.test(code("lib/accounts/wallet-connection.ts")));
  check("…and provider-identity.ts now contains NO console.warn at all — the catch-all return is gone",
    !/console\.warn/.test(src), src.match(/console\.warn[^\n]*/)?.[0]);

  check("the catch ends in a bare rethrow, so an unknown operational failure reaches the caller",
    /\n\s*throw e;\s*\n\s*\}/.test(src), "no terminal `throw e;` found");

  check("NEEDLE CONTROL: `systemDb` matches in a module that legitimately uses it",
    /systemDb/.test(code("lib/db.ts")));
  check("…and provider-identity.ts never reaches for systemDb or any other privileged client to classify",
    !/systemDb|bypassDb|adminDb/.test(src));

  check("the reread is of ProviderAccountIdentity, keyed on the provider identity, selecting only the account id",
    /providerAccountIdentity\.findMany\(\{[\s\S]{0,220}where:\s*\{\s*provider,\s*externalAccountId\s*\}[\s\S]{0,120}select:\s*\{\s*financialAccountId:\s*true\s*\}/.test(src));
  check("NEEDLE CONTROL: `financialAccount.` matches where a FinancialAccount read legitimately happens",
    /financialAccount\./.test(code("lib/plaid/syncTransactions.ts")));
  check("…and the classifier never reads FinancialAccount, so it cannot perform an owner lookup",
    !/financialAccount\.(find|count|aggregate)/.test(src));

  check("`dualWriteProviderAccountIdentity` still takes NO client parameter — the tenant conversion is a separate slice",
    /export async function dualWriteProviderAccountIdentity\(\s*financialAccountId: string,\s*provider: ProviderType,\s*externalAccountId: string,/.test(src)
    && !/dualWriteProviderAccountIdentity\([^)]*client/.test(src));

  // The connection to the defence in depth is stated in the file, not only in a
  // commit message that nobody reads from here.
  check("the header names the downstream FK boundary it stops feeding, by its own identifiers",
    /FK_UNCHANGED_PROVEN/.test(header) && /syncTransactions\.ts/.test(header) && /case 79/.test(header));
}

console.log(
  failures === 0
    ? "\n✅ provider-identity conflict semantics: a collision is classified, the three verdicts are distinguishable, and the catch has no catch-all.\n"
    : `\n❌ ${failures} failure(s)\n`,
);
process.exit(failures === 0 ? 0 : 1);
