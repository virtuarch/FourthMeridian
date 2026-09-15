/**
 * scripts/db-guard.ts  (Recovery/Hardening slice)
 *
 * Preflight that MUST pass before any destructive database command runs. The
 * local DB is a personal development environment with real Plaid test data — a
 * `migrate reset` / `migrate dev` reset destroys un-seeded state. This guard
 * makes destruction a deliberate, backed-up, opt-in act instead of an
 * accidental one.
 *
 * Modes (`--mode=<mode>`, default `reset`):
 *   reset        blocks unless ALLOW_DESTRUCTIVE_DB=true (npm run db:reset).
 *   migrate-dev  blocks a NON-INTERACTIVE `prisma migrate dev` against a
 *                populated (or unreachable) database (npm run db:migrate).
 *                2026-09-15: that exact command, run by an agent session with
 *                schema drift pending, reset the database before Prisma's own
 *                interactivity check refused. The decision is made HERE, in
 *                this process, before Prisma is spawned.
 *
 * Every mode refuses the shadow-DB footgun (SHADOW_DATABASE_URL === DATABASE_URL).
 * The decision itself is pure — scripts/lib/db-guard.core.ts — and unit-tested.
 * Raw `npx prisma migrate …` bypasses this file, which is why
 * docs/operations/database-safety.md prohibits raw destructive prisma commands.
 */

import { decideDbGuard, describeTarget, type DbGuardMode } from "./lib/db-guard.core";

function fail(lines: string[]): never {
  console.error("\n╔════════════════════════════════════════════════════════════════╗");
  console.error("║  DESTRUCTIVE DATABASE OPERATION BLOCKED                         ║");
  console.error("╚════════════════════════════════════════════════════════════════╝");
  for (const l of lines) console.error("  " + l);
  console.error("");
  process.exit(1);
}

function parseMode(argv: string[]): DbGuardMode {
  const raw = argv.find((a) => a.startsWith("--mode="))?.slice("--mode=".length) ?? "reset";
  if (raw === "reset" || raw === "migrate-dev") return raw;
  fail([`Unknown --mode=${raw}. Expected reset | migrate-dev.`]);
}

/**
 * Does the target database hold rows? Asked ONLY for migrate-dev, and only
 * through three tables that every populated deployment has. A missing table
 * (fresh database) is "empty"; an unreachable database is `null`, which the
 * decision treats as populated — an unknown database is never safe to reset.
 */
async function isPopulated(): Promise<boolean | null> {
  try {
    const { PrismaClient } = await import("@prisma/client");
    const client = new PrismaClient({ log: [] });
    try {
      const count = async (table: string): Promise<number> => {
        try {
          const rows = await client.$queryRawUnsafe<{ n: bigint | number }[]>(`SELECT count(*)::int AS n FROM "${table}"`);
          return Number(rows[0]?.n ?? 0);
        } catch (e) {
          // 42P01 undefined_table ⇒ the table does not exist ⇒ nothing to lose there.
          if (e instanceof Error && /42P01|does not exist/.test(e.message)) return 0;
          throw e;
        }
      };
      const total = (await count("_prisma_migrations")) + (await count("User")) + (await count("FinancialAccount"));
      return total > 0;
    } finally {
      await client.$disconnect();
    }
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2));
  const dbUrl = process.env.DATABASE_URL;
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const populated = mode === "migrate-dev" ? await isPopulated() : null;

  const decision = decideDbGuard({
    mode,
    dbUrl,
    shadowUrl: process.env.SHADOW_DATABASE_URL,
    allowDestructive: process.env.ALLOW_DESTRUCTIVE_DB,
    interactive,
    populated,
  });
  if (!decision.ok) fail([...decision.reasons, "", ...decision.hint]);

  const target = describeTarget(dbUrl);
  if (mode === "migrate-dev") {
    console.log(`⚠  db-guard: interactive \`prisma migrate dev\` against ${target} (populated=${populated}). A backup is taken next; answer Prisma's prompt yourself.`);
  } else {
    console.log(`⚠  ALLOW_DESTRUCTIVE_DB=true — proceeding with a destructive op against ${target}.`);
    console.log("   (A backup should have been taken by the safe script before this point.)");
  }
}

main().catch((e) => fail([`db-guard crashed: ${e instanceof Error ? e.message : String(e)}`]));
