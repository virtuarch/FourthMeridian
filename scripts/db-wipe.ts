/**
 * scripts/db-wipe.ts
 *
 * Deliberately destroy every application table in a database, leaving a clean
 * schema for `prisma migrate deploy` to rebuild from scratch.
 *
 *   ALLOW_DESTRUCTIVE_DB=true npm run db:wipe
 *
 * This exists for ONE legitimate workflow: taking a database that holds
 * throwaway/stale data back to zero before a fresh start (e.g. wiping a
 * pre-launch production database so the founder can register a clean account).
 * It is NOT part of any routine flow. `docs/operations/database-safety.md` is
 * binding, and this script is written to satisfy it rather than route around it.
 *
 * ── Why not `prisma migrate reset`? ──────────────────────────────────────────
 * Two reasons, both practical:
 *   1. On hosted Postgres (Supabase/Neon) `migrate reset` commonly FAILS or does
 *      collateral damage: it targets more than the app's own schema, and the
 *      connecting role usually cannot touch `auth` / `storage` / `extensions` /
 *      `graphql_public`. Those are the provider's, not ours.
 *   2. It also re-runs migrations AND the seed. `prisma/seed.ts` creates DEV-ONLY
 *      accounts with a hardcoded password — the last thing that should ever be
 *      auto-created in production.
 * So this script drops ONLY the `public` schema and stops. Applying migrations
 * afterwards is a separate, deliberate step you run yourself.
 *
 * ── Safety layers (all four must pass) ───────────────────────────────────────
 *   1. `ALLOW_DESTRUCTIVE_DB=true` — the same explicit opt-in db-guard.ts uses.
 *   2. A successful `pg_dump` backup FIRST. Refuses to continue if it fails.
 *      A backup is not optional here: no restore drill has ever been performed
 *      against this project, so the dump is the only recovery path that exists.
 *   3. A typed confirmation of the exact `host/database`. The env flag alone is
 *      too weak — it may still be exported in your shell from an earlier command,
 *      whereas typing the target proves you know which database you are aimed at.
 *   4. An inventory of what is about to be destroyed (table + row counts), shown
 *      BEFORE the prompt, so "empty and disposable" is something you verify
 *      rather than assume.
 *   5. A Plaid teardown (removePlaidItemsBeforeWipe) that closes out every
 *      PlaidItem via /item/remove while its access_token still exists. Without
 *      this, wiping strands live Items on Plaid: they keep billing a monthly
 *      subscription and the only token that could remove them has just been
 *      dropped. Blocks the wipe if Items exist but cannot be torn down; override
 *      with ALLOW_STRANDED_PLAID_ITEMS=true.
 *
 * Credentials are never printed — only `host/database`.
 */

import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

function fail(lines: string[]): never {
  console.error("\n╔════════════════════════════════════════════════════════════════╗");
  console.error("║  DATABASE WIPE BLOCKED                                          ║");
  console.error("╚════════════════════════════════════════════════════════════════╝");
  for (const l of lines) console.error("  " + l);
  console.error("");
  process.exit(1);
}

/** `host/dbname` — never the user, never the password. */
function targetOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    fail(["The connection URL could not be parsed.",
          "If you pasted it from a provider dashboard, check the password",
          "placeholder was actually replaced — literal brackets break parsing."]);
  }
}

// ── Connection ───────────────────────────────────────────────────────────────
// DDL prefers DIRECT_URL: a pooled connection (pgbouncer, transaction mode)
// cannot reliably run schema DDL. DIRECT_URL is exactly the session-mode
// connection Prisma already reserves for migrations, so reuse it when present.
const pooled = process.env.DATABASE_URL;
const direct = process.env.DIRECT_URL;
const raw = direct ?? pooled;

if (!raw) {
  fail(["Neither DIRECT_URL nor DATABASE_URL is set.",
        "Export them for the database you intend to wipe, then re-run."]);
}
if (!pooled) fail(["DATABASE_URL is not set — db:backup needs it."]);

const connUrl = raw.split("?")[0]; // psql rejects Prisma-only params (?pgbouncer, ?schema)
const target  = targetOf(raw);
const usingDirect = Boolean(direct);

// ── Layer 1: explicit opt-in ─────────────────────────────────────────────────
if (process.env.ALLOW_DESTRUCTIVE_DB !== "true") {
  fail([
    `This DESTROYS every application table in:  ${target}`,
    "",
    "If you truly intend this:",
    "  ALLOW_DESTRUCTIVE_DB=true npm run db:wipe",
  ]);
}

function psql(sql: string): string {
  try {
    return execFileSync("psql", ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql, connUrl],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const err = e as { stderr?: Buffer | string };
    const detail = err.stderr ? String(err.stderr).trim() : "(no stderr)";
    fail([`psql failed against ${target}.`, "", detail]);
  }
}

/**
 * Call Plaid's /item/remove for every PlaidItem in the database that is about
 * to be destroyed, so no Item is left orphaned (and billing) on Plaid's side.
 *
 * Best-effort by design, with one hard gate: if there ARE Items but we have no
 * way to tear them down (no ENCRYPTION_KEY, no Plaid credentials), the wipe is
 * BLOCKED rather than silently stranding them. `ALLOW_STRANDED_PLAID_ITEMS=true`
 * overrides that for the case where you genuinely don't care (a scratch DB whose
 * Items were sandbox-only, say). Individual removal failures are reported loudly
 * but do not block — the schema drop is what the operator asked for, and the
 * backup taken above still holds every token, so a failed removal is recoverable
 * via scripts/remove-orphaned-plaid-items-from-backup.ts.
 */
async function removePlaidItemsBeforeWipe(): Promise<void> {
  // Read straight from psql: Prisma would need a generated client pointed at a
  // schema this script is about to drop, and psql is already the transport here.
  let raw: string;
  try {
    raw = execFileSync(
      "psql",
      ["-X", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1",
       "-c", 'SELECT "externalItemId", "encryptedToken", "institutionName" FROM public."PlaidItem";',
       connUrl],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    // No PlaidItem table at all (fresh/partial schema) — nothing to tear down.
    console.log("\n  No PlaidItem table present — no Plaid teardown needed.");
    return;
  }

  const items = raw.trim().split("\n").filter(Boolean).map((l) => {
    const [externalItemId, encryptedToken, institutionName] = l.split("\t");
    return { externalItemId, encryptedToken, institutionName: institutionName || "(unknown)" };
  });

  if (items.length === 0) {
    console.log("\n  No Plaid Items in this database — no Plaid teardown needed.");
    return;
  }

  console.log(`\n  ${items.length} Plaid Item(s) found. Removing them from Plaid before the tokens are destroyed …\n`);

  const haveKey   = (process.env.ENCRYPTION_KEY ?? "").length === 64;
  const haveCreds = Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
  if (!haveKey || !haveCreds) {
    if (process.env.ALLOW_STRANDED_PLAID_ITEMS === "true") {
      console.log("  ⚠  ALLOW_STRANDED_PLAID_ITEMS=true — skipping teardown.");
      console.log(`  ⚠  ${items.length} Item(s) will remain live on Plaid and keep billing.\n`);
      return;
    }
    fail([
      `${items.length} Plaid Item(s) exist, but they cannot be removed from Plaid:`,
      !haveKey   ? "  - ENCRYPTION_KEY is missing or not 64 hex chars (cannot decrypt tokens)" : "",
      !haveCreds ? "  - PLAID_CLIENT_ID / PLAID_SECRET are not set" : "",
      "",
      "Wiping now would strand them: they keep billing monthly and the tokens",
      "needed to remove them are about to be destroyed.",
      "",
      "Set the missing values (they must match the ones this database was",
      "written with), or accept the cost explicitly:",
      "  ALLOW_STRANDED_PLAID_ITEMS=true ALLOW_DESTRUCTIVE_DB=true npm run db:wipe",
    ].filter(Boolean));
  }

  const { decryptWithPurpose, EncryptionPurpose } = await import("@/lib/plaid/encryption");
  const { plaidClient } = await import("@/lib/plaid/client");

  const stranded: string[] = [];
  let removed = 0, gone = 0;

  for (const item of items) {
    const label = `${item.externalItemId}  ${item.institutionName}`;
    let accessToken: string;
    try {
      accessToken = decryptWithPurpose(item.encryptedToken, EncryptionPurpose.PLAID_ACCESS_TOKEN);
    } catch {
      console.log(`    DECRYPT✗  ${label}`);
      stranded.push(item.externalItemId);
      continue;
    }
    try {
      await plaidClient.itemRemove({ access_token: accessToken });
      console.log(`    removed   ${label}`);
      removed++;
    } catch (e: unknown) {
      const code = (e as { response?: { data?: { error_code?: string } } })?.response?.data?.error_code;
      if (code === "ITEM_NOT_FOUND" || code === "INVALID_ACCESS_TOKEN") {
        console.log(`    already   ${label}`);
        gone++;
      } else {
        console.log(`    FAILED    ${label} (${code ?? "unknown"})`);
        stranded.push(item.externalItemId);
      }
    }
  }

  console.log(`\n  Plaid teardown: removed ${removed} · already-gone ${gone} · FAILED ${stranded.length}`);

  if (stranded.length > 0) {
    console.log("\n  ⚠  These Items are still live on Plaid and will keep billing:");
    for (const id of stranded) console.log(`       ${id}`);
    console.log("\n     They are recoverable — the backup taken above still contains their");
    console.log("     tokens. After the wipe, retry with:");
    console.log("       npx tsx scripts/remove-orphaned-plaid-items-from-backup.ts backups/<newest>.sql");
    console.log("     (dry run; add --apply once the list looks right)\n");
  }
}

async function main(): Promise<void> {
  console.log(`\n  Target:     ${target}`);
  console.log(`  Connection: ${usingDirect ? "DIRECT_URL (session mode — correct for DDL)" : "DATABASE_URL"}`);
  if (!usingDirect) {
    console.log("  ⚠  DIRECT_URL is not set. If this is a pooled connection, DDL may fail —");
    console.log("     set DIRECT_URL to the session-mode (non-pgbouncer) connection.");
  }

  // ── Layer 4: inventory — see what you are destroying ───────────────────────
  console.log("\n  Reading current contents of schema \"public\" …");
  const inventory = psql(`
    SELECT c.relname, COALESCE(s.n_live_tup, 0)
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY COALESCE(s.n_live_tup, 0) DESC, c.relname;
  `).trim();

  if (!inventory) {
    console.log("  Schema \"public\" already has no tables — nothing to wipe.");
    console.log("  (Run `npx prisma migrate deploy` to build it from migrations.)\n");
    return;
  }

  const rows = inventory.split("\n").map((l) => l.split("|"));
  const total = rows.reduce((s, [, n]) => s + Number(n || 0), 0);
  console.log(`\n  ${rows.length} table(s), ~${total} row(s) — approximate, from planner statistics:\n`);
  for (const [name, n] of rows.slice(0, 15)) {
    console.log(`    ${String(name).padEnd(34)} ${String(n).padStart(9)}`);
  }
  if (rows.length > 15) console.log(`    … and ${rows.length - 15} more table(s)`);

  // ── Layer 2: mandatory backup ─────────────────────────────────────────────
  console.log("\n  Taking a backup first (mandatory — this is the only recovery path) …\n");
  try {
    execFileSync("npm", ["run", "db:backup"], { stdio: ["ignore", "inherit", "inherit"] });
  } catch {
    fail(["The backup FAILED, so the wipe was not attempted.",
          "Never destroy a database whose dump you could not take.",
          "Fix pg_dump (brew install libpq) or connectivity, then re-run."]);
  }

  // ── Layer 3: typed confirmation ───────────────────────────────────────────
  console.log("\n  ────────────────────────────────────────────────────────────────");
  console.log("  This DROPS schema \"public\" and everything in it. IRREVERSIBLE");
  console.log("  except from the backup just taken. Provider-owned schemas");
  console.log("  (auth, storage, extensions, …) are NOT touched.");
  console.log("  ────────────────────────────────────────────────────────────────\n");

  const rl = createInterface({ input: stdin, output: stdout });
  const answer = (await rl.question(`  Type the target to confirm  [${target}]: `)).trim();
  rl.close();

  if (answer !== target) {
    console.error(`\n  ✗ Aborted — you typed "${answer}", which does not match the target.\n`);
    process.exit(1);
  }

  // ── Layer 5: close out Plaid Items BEFORE the tokens are destroyed ────────
  // Dropping `public` destroys PlaidItem.encryptedToken — the only copy of each
  // access_token. The Item itself lives on at Plaid: it keeps emitting webhooks
  // (which land on "[plaid webhook] no PlaidItem for item_id …") and keeps
  // incurring the Transactions monthly subscription fee, forever, with no way
  // to call /item/remove because the token needed to do so was just deleted.
  // On 2026-07-22 three wipes stranded seven live Items exactly this way.
  //
  // So: tear them down here, while the tokens still exist. Ordered AFTER the
  // typed confirmation so an aborted wipe never removes anybody's connections.
  await removePlaidItemsBeforeWipe();

  // ── Execute ───────────────────────────────────────────────────────────────
  // Drop + recreate the schema rather than dropping tables one by one: it clears
  // types, sequences, functions and enums too, which is what Prisma expects of a
  // virgin schema. Grants are restored so a hosted provider's roles still work.
  console.log("\n  Dropping schema \"public\" …");
  psql("DROP SCHEMA public CASCADE;");
  psql("CREATE SCHEMA public;");

  // Best-effort grant restoration. Roles differ by provider, so failures here are
  // reported rather than fatal — the schema is already clean at this point.
  for (const role of ["postgres", "public", "anon", "authenticated", "service_role"]) {
    try {
      execFileSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1",
        "-c", `GRANT ALL ON SCHEMA public TO ${role};`, connUrl],
        { stdio: ["ignore", "ignore", "ignore"] });
    } catch {
      console.log(`  (note: role "${role}" not present — skipped, harmless)`);
    }
  }

  const left = psql(`SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                     WHERE n.nspname = 'public' AND c.relkind = 'r';`).trim();

  console.log(`\n  ✓ Wiped. Schema "public" now has ${left} table(s).\n`);
  console.log("  Next steps:");
  console.log("    1. npx prisma migrate deploy     # rebuild the schema from migrations");
  console.log("    2. npx prisma migrate status     # confirm every migration is applied");
  console.log("    3. Register your account through the app UI (real signup path)");
  console.log("    4. npm run admin:promote -- --email you@example.com");
  console.log("");
  console.log("  Do NOT run `prisma db seed` against production — prisma/seed.ts");
  console.log("  creates DEV-ONLY accounts with a hardcoded password.\n");
}

void main();
