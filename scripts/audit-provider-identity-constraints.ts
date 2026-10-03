/**
 * scripts/audit-provider-identity-constraints.ts   (PLAID identity exclusivity)
 *
 * The provider-identity CARDINALITY THEOREM, asserted against the INSTALLED
 * DATABASE rather than against migration source text. READ-ONLY.
 *
 *     provider = PLAID   → externalAccountId binds AT MOST ONE FinancialAccount
 *     provider = WALLET  → externalAccountId may bind MANY (D2 Step 1D)
 *     everything else    → INHERITS NOTHING
 *
 * ══ WHY INTROSPECTION AND NOT A GREP OF THE MIGRATION ═══════════════════════
 * A migration file proves what was WRITTEN, not what is INSTALLED. Three real
 * ways those diverge, all of which this audit catches and a source scan does
 * not: a later migration drops or replaces the index; `prisma migrate dev`
 * resets a database and the hand-written index — which no Prisma schema
 * declares — is simply gone; or a well-meaning "drift" repair removes it
 * (20260727_v26pre_b4 carries that exact warning about its own partial index).
 *
 * ⚠️ AND THIS WAS ALREADY TRUE BEFORE THIS FILE EXISTED. The KD-5 partial
 * index `SpaceAccountLink_one_home_per_account` (20260702170000) has enforced
 * "exactly one HOME link per account" since July with NO durable proof that it
 * is installed — it is named in a schema comment and in two code comments, and
 * nothing in the suite would have noticed its absence. §3 adopts it, so the
 * guard is general rather than built for one index.
 *
 * ══ THE PREDICATE CHECK IS SEMANTIC, NOT TEXTUAL ════════════════════════════
 * §2's central test does not compare strings. It takes the predicate Postgres
 * actually stored and EVALUATES it against every member of the ProviderType
 * enum, by interpolating it as an expression over a CTE whose single column is
 * named `provider`. The predicate references that bare column, so it evaluates
 * directly — no string surgery, no parsing. What comes back is the exact SET OF
 * PROVIDERS THE INSTALLED INDEX CONSTRAINS, which is the thing we care about
 * and the thing a textual match only approximates.
 *
 * That is what distinguishes the intended predicate from a broader or narrower
 * one. `WHERE provider <> 'WALLET'` admits five providers and fails here;
 * `WHERE provider = 'PLAID'` admits exactly one and passes. A denylist would
 * silently enrol MANUAL, CSV, EXCHANGE, BROKERAGE — and any provider added
 * later — into Plaid's cardinality semantics.
 *
 * (The interpolated text comes from pg_get_expr over an index this repo owns,
 * never from user input.)
 *
 * Run: npx tsx --env-file=.env.local scripts/audit-provider-identity-constraints.ts
 */

import { db } from "@/lib/db";

const bar = (s: string) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** The one index this theorem lives in. Named here so §2 can prove its shape. */
const PLAID_INDEX = "ProviderAccountIdentity_plaid_external_account_unique";
/** Kept, not replaced: the same address twice on ONE account is still an error. */
const TRIPLE_INDEX = "ProviderAccountIdentity_provider_externalAccountId_financia_key";

type IndexShape = {
  index_name: string;
  is_unique: boolean;
  key_cols: string | null;
  predicate: string | null;
};

async function shapeOf(table: string, index: string): Promise<IndexShape | null> {
  const rows = await db.$queryRawUnsafe<IndexShape[]>(
    `select i.relname                            as index_name,
            ix.indisunique                       as is_unique,
            pg_get_expr(ix.indpred, ix.indrelid) as predicate,
            (select string_agg(a.attname, ',' order by k.ord)
               from unnest(ix.indkey) with ordinality k(attnum, ord)
               join pg_attribute a on a.attrelid = ix.indrelid and a.attnum = k.attnum) as key_cols
       from pg_index ix
       join pg_class i on i.oid = ix.indexrelid
       join pg_class t on t.oid = ix.indrelid
      where t.relname = $1 and i.relname = $2;`,
    table, index,
  );
  return rows[0] ?? null;
}

async function main() {
  bar("PROVIDER-IDENTITY CARDINALITY — THE INSTALLED DATABASE, NOT THE MIGRATION");

  // ── 1. PREFLIGHT — run this against ANY environment before deploying ──────
  // This section is why the audit is safe to point at a persistent database:
  // it is the duplicate check the migration's CREATE UNIQUE INDEX would fail
  // on, asked in advance and without touching a row. A non-zero result means a
  // CONTESTED IDENTITY, and choosing a winner is an owner decision, never a
  // migration's and never this script's.
  console.log("\n1. PREFLIGHT — can the theorem hold on this corpus?");
  const population = await db.$queryRawUnsafe<{ provider: string; rows: bigint; ext: bigint; accounts: bigint }[]>(
    `select provider::text as provider, count(*) as rows,
            count(distinct "externalAccountId")  as ext,
            count(distinct "financialAccountId") as accounts
       from "ProviderAccountIdentity" group by provider order by 1;`);
  for (const p of population) {
    console.log(`     ${p.provider.padEnd(9)} rows=${String(p.rows).padStart(5)}  distinct externalAccountId=${String(p.ext).padStart(5)}  distinct account=${String(p.accounts).padStart(5)}`);
  }
  const plaidDupes = await db.$queryRawUnsafe<{ externalAccountId: string; accounts: bigint }[]>(
    `select "externalAccountId", count(distinct "financialAccountId") as accounts
       from "ProviderAccountIdentity" where provider = 'PLAID'
      group by 1 having count(distinct "financialAccountId") > 1 order by 2 desc;`);
  check(`no PLAID externalAccountId is held by more than one FinancialAccount (${plaidDupes.length} contested)`,
    plaidDupes.length === 0,
    plaidDupes.map((d) => `${d.externalAccountId}→${d.accounts} accounts`).join("; ") +
    " — CONTESTED IDENTITY. Classify these rows and return for an owner decision. Do not pick a winner, do not delete, do not repoint, do not weaken the index.");

  const plaidRows = population.find((p) => p.provider === "PLAID");
  check("the PLAID population is non-empty, so the checks below are not vacuous",
    plaidRows !== undefined && Number(plaidRows.rows) > 0,
    "zero PLAID identity rows — this audit would pass on an empty table; seed before trusting it");

  // ── 2. THE INSTALLED INDEX ────────────────────────────────────────────────
  console.log("\n2. the PLAID exclusivity index, as Postgres holds it");
  const plaid = await shapeOf("ProviderAccountIdentity", PLAID_INDEX);
  check(`${PLAID_INDEX} exists`, plaid !== null,
    "the theorem is NOT enforced by this database — a PLAID identity can bind two FinancialAccounts right now");

  if (plaid) {
    check("it is UNIQUE", plaid.is_unique === true);
    check("its key columns are exactly (provider, externalAccountId)",
      plaid.key_cols === "provider,externalAccountId", `key_cols=${plaid.key_cols}`);
    check("it is PARTIAL (it has a predicate at all)", plaid.predicate !== null,
      "no predicate — this index constrains EVERY provider, which would break WALLET multi-binding");

    // ⚠️ THE NAME IS LOAD-BEARING, NOT COSMETIC.
    // conflictKeyIsAccountScoped() in lib/accounts/provider-identity.ts decides
    // "did I collide with my OWN row or with whoever holds this identity" by
    // testing the driver's meta.target for the stem /financia/i — the STEM
    // rather than the column name because Postgres truncates index names at 63
    // characters and the triple above reads `…_financia_key`, cut mid-word. If
    // Prisma ever reports an index NAME for this index, a name carrying that
    // stem would make a GLOBAL collision parse as ACCOUNT-SCOPED, i.e. "my own
    // row" — the single misreading that turns a contested identity into a
    // silent success.
    // MEASURED on Prisma 5.22 / Postgres 16: the reported target is the
    // field-name array ["provider","externalAccountId"], so the hazard does not
    // fire today. The name is still kept clear of the stem, and pinned here,
    // because that measurement is a driver detail and not a guarantee.
    check("its name cannot be misread as account-scoped (no /financia/ stem)",
      !/financia/i.test(plaid.index_name), `name=${plaid.index_name}`);
    check(`its name is within Postgres's 63-char identifier limit, so it is not truncated (${plaid.index_name.length})`,
      plaid.index_name.length <= 63 && plaid.index_name === PLAID_INDEX);

    // ── THE SEMANTIC PREDICATE TEST ────────────────────────────────────────
    // Evaluate the stored predicate against every ProviderType member.
    const admitted = await db.$queryRawUnsafe<{ provider: string; admits: boolean | null }[]>(
      `with p(provider) as (select unnest(enum_range(null::"ProviderType")))
       select provider::text as provider, (${plaid.predicate}) as admits from p order by 1;`);
    const yes = admitted.filter((a) => a.admits === true).map((a) => a.provider).sort();
    const no = admitted.filter((a) => a.admits !== true).map((a) => a.provider).sort();
    console.log(`     predicate: ${plaid.predicate}`);
    console.log(`     constrains: [${yes.join(", ")}]   leaves free: [${no.join(", ")}]`);

    check("the predicate constrains EXACTLY ['PLAID'] — not broader, not narrower",
      JSON.stringify(yes) === JSON.stringify(["PLAID"]),
      `constrains [${yes.join(", ")}]. Broader (e.g. WHERE provider <> 'WALLET') enrols providers with no ` +
      `cardinality design into Plaid's semantics; narrower leaves PLAID unprotected.`);
    check("WALLET is explicitly NOT constrained by it (D2 Step 1D multi-binding survives)",
      no.includes("WALLET"));
    check(`every other provider inherits nothing (${no.filter((p) => p !== "WALLET").length} free besides WALLET)`,
      admitted.length > 2 && no.length === admitted.length - 1,
      `enum has ${admitted.length} members; ${no.length} are unconstrained`);
  }

  // ── 3. THE CONSTRAINTS THIS ONE DOES NOT REPLACE ──────────────────────────
  // Two partial/compound uniques that existed before this slice and are easy to
  // lose silently, because neither is declared in any Prisma schema block.
  console.log("\n3. the neighbouring invariants are still installed");
  const triple = await shapeOf("ProviderAccountIdentity", TRIPLE_INDEX);
  check(`${TRIPLE_INDEX.slice(0, 48)}… still exists (same address twice on ONE account is still refused)`,
    triple !== null && triple.is_unique === true,
    "the account-scoped triple is gone — a same-account replay would no longer collide, so SAME_ACCOUNT " +
    "would stop being reachable and WALLET would lose its only per-account guard");
  check("…and it is NOT partial (it governs every provider)",
    triple !== null && triple.predicate === null, `predicate=${triple?.predicate}`);

  const home = await shapeOf("SpaceAccountLink", "SpaceAccountLink_one_home_per_account");
  check("KD-5 SpaceAccountLink_one_home_per_account still exists (adopted: it had no durable proof)",
    home !== null && home.is_unique === true,
    "the one-HOME-per-account partial unique is missing — a concurrent HOME race can produce two HOME rows");
  if (home) {
    const homeAdmits = await db.$queryRawUnsafe<{ kind: string; admits: boolean | null }[]>(
      `with p(kind) as (select unnest(enum_range(null::"SpaceAccountLinkKind")))
       select kind::text as kind, (${home.predicate}) as admits from p order by 1;`);
    const hk = homeAdmits.filter((a) => a.admits === true).map((a) => a.kind);
    check("…and its predicate constrains exactly ['HOME']", JSON.stringify(hk) === JSON.stringify(["HOME"]),
      `constrains [${hk.join(", ")}] (predicate: ${home.predicate})`);
  }

  // ── 4. THE COROLLARY, MEASURED ON THE CORPUS ──────────────────────────────
  // The index makes a claim about what CANNOT exist. This section states what
  // DOES exist, so the proof is over a real population rather than an empty one.
  console.log("\n4. what the corpus actually holds under each theorem");
  const walletShared = await db.$queryRawUnsafe<{ n: bigint }[]>(
    `select count(*) as n from (
       select "externalAccountId" from "ProviderAccountIdentity" where provider = 'WALLET'
        group by 1 having count(distinct "financialAccountId") > 1) x;`);
  const xpub = await db.$queryRawUnsafe<{ n: bigint }[]>(
    `select count(*) as n from (
       select "financialAccountId" from "ProviderAccountIdentity" where provider = 'WALLET'
        group by 1 having count(distinct "externalAccountId") > 1) x;`);
  console.log(`     WALLET addresses held by >1 account (legitimate, D2 Step 1D): ${walletShared[0].n}`);
  console.log(`     accounts holding >1 WALLET address (legitimate, xpub v4):      ${xpub[0].n}`);
  console.log("     — both are ALLOWED by design; they are reported, never asserted to be non-zero,");
  console.log("       because a corpus with no xpub wallet is a legitimate corpus.");

  bar(failures === 0
    ? "PROVIDER-IDENTITY CARDINALITY — ALL CHECKS PASSED"
    : `PROVIDER-IDENTITY CARDINALITY — ${failures} CHECK(S) FAILED`);
  if (failures > 0) process.exit(1);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());
