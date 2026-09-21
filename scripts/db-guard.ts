/**
 * scripts/db-guard.ts  (Recovery/Hardening slice; FM-AUDIT-002/032)
 *
 * Preflight that MUST pass before any destructive or schema-mutating database
 * command runs. The local DB is a personal development environment with real
 * Plaid test data — a `migrate reset` / `migrate dev` reset destroys un-seeded
 * state. This guard makes destruction a deliberate, backed-up, opt-in act
 * instead of an accidental one.
 *
 * Modes (`--mode=<mode>`, default `reset`):
 *   reset           ALLOW_DESTRUCTIVE_DB=true, plus — when the target is not a
 *                   recognised clone — a typed `host/database` at a real TTY
 *                   (npm run db:reset).
 *   migrate-dev     blocks a NON-INTERACTIVE `prisma migrate dev` against a
 *                   populated (or unreachable) database (npm run db:migrate).
 *                   2026-09-15: that exact command, run by an agent session with
 *                   schema drift pending, reset the database before Prisma's own
 *                   interactivity check refused.
 *   migrate-deploy  additive; the target-identity check only (npm run db:migrate:safe).
 *
 * EVERY mode first resolves the database Prisma Migrate will actually mutate —
 * DIRECT_URL when schema.prisma routes Migrate through it — and refuses unless
 * DATABASE_URL and DIRECT_URL are provably the same logical database and any
 * SHADOW_DATABASE_URL is provably a different one (lib/db/target-identity.ts).
 * The population probe and the backup that follows read that SAME target.
 *
 * The decision itself is pure — scripts/lib/db-guard.core.ts — and unit-tested.
 * Raw `npx prisma migrate …` bypasses this file, which is why
 * docs/operations/database-safety.md prohibits raw destructive prisma commands.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { decideDbGuard, resetNeedsTypedConfirmation, type DbGuardMode } from "./lib/db-guard.core";
import { mutationAuthority, schemaRequiresDirectUrl } from "@/lib/db/target-identity";
import { dbGuardArmed } from "@/lib/db/live-guard";

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
  if (raw === "reset" || raw === "migrate-dev" || raw === "migrate-deploy") return raw;
  fail([`Unknown --mode=${raw}. Expected reset | migrate-dev | migrate-deploy.`]);
}

/**
 * Does the mutation target hold rows? Asked ONLY for migrate-dev, and only
 * through three tables that every populated deployment has. A missing table
 * (fresh database) is "empty"; an unreachable database is `null`, which the
 * decision treats as populated — an unknown database is never safe to reset.
 * The client is pointed at the TARGET url explicitly, never at a default.
 */
async function isPopulated(targetUrl: string): Promise<boolean | null> {
  try {
    const { PrismaClient } = await import("@prisma/client");
    const client = new PrismaClient({ log: [], datasourceUrl: targetUrl });
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
  const requireDirect = schemaRequiresDirectUrl(readFileSync(path.join(process.cwd(), "prisma", "schema.prisma"), "utf8"));
  const armed = dbGuardArmed();
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const env = { DATABASE_URL: process.env.DATABASE_URL, DIRECT_URL: process.env.DIRECT_URL, SHADOW_DATABASE_URL: process.env.SHADOW_DATABASE_URL };

  // Identity first: nothing — not even a population probe — touches a database
  // whose relationship to the mutation target is not proven.
  const authority = mutationAuthority(env, { requireDirect, armed });
  if (!authority.ok) fail([...authority.reasons, "", ...authority.hint]);
  const target = authority.target;

  const populated = mode === "migrate-dev" ? await isPopulated(target.url) : null;

  let typedConfirmation: string | null = null;
  if (mode === "reset" && process.env.ALLOW_DESTRUCTIVE_DB === "true" && resetNeedsTypedConfirmation(target) && interactive) {
    console.log(`\n  RESET target: ${target.identity.display}  (${target.verdict} — not a recognised clone)`);
    console.log("  Every table will be dropped, migrations re-applied and the seed re-run.");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    typedConfirmation = (await rl.question(`  Type the target exactly to continue (${target.identity.display}): `)).trim();
    rl.close();
  }

  const decision = decideDbGuard({
    mode,
    dbUrl: env.DATABASE_URL,
    directUrl: env.DIRECT_URL,
    shadowUrl: env.SHADOW_DATABASE_URL,
    requireDirect,
    armed,
    allowDestructive: process.env.ALLOW_DESTRUCTIVE_DB,
    interactive,
    populated,
    typedConfirmation,
  });
  if (!decision.ok) fail([...decision.reasons, "", ...decision.hint]);

  const where = `${target.identity.display} via ${target.source}`;
  if (mode === "migrate-dev") {
    console.log(`⚠  db-guard: interactive \`prisma migrate dev\` against ${where} (populated=${populated}). A backup of this same database is taken next; answer Prisma's prompt yourself.`);
  } else if (mode === "migrate-deploy") {
    console.log(`db-guard: \`prisma migrate deploy\` target ${where} (${target.verdict}). A backup of this same database is taken next.`);
  } else {
    console.log(`⚠  ALLOW_DESTRUCTIVE_DB=true — proceeding with a RESET of ${where} (${target.verdict}).`);
  }
}

main().catch((e) => fail([`db-guard crashed: ${e instanceof Error ? e.message : String(e)}`]));
