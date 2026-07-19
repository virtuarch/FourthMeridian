/**
 * scripts/db-guard.ts  (Recovery/Hardening slice)
 *
 * Preflight that MUST pass before any destructive database command runs. The
 * local DB is a personal development environment with real Plaid test data — a
 * `migrate reset` / `migrate dev` reset destroys un-seeded state (the exact
 * incident that motivated this slice). This guard makes destruction a deliberate,
 * backed-up, opt-in act instead of an accidental one.
 *
 * Blocks unless BOTH hold:
 *   1. ALLOW_DESTRUCTIVE_DB=true is set explicitly (no default, no config file).
 *   2. The command is not the shadow-DB footgun: SHADOW_DATABASE_URL must not
 *      equal DATABASE_URL (using the live DB as a migrate-diff shadow RESETS it —
 *      this is precisely what wiped the DB).
 *
 * Invoked by the safe npm scripts (db:reset). Raw `prisma migrate reset` bypasses
 * it — which is why DATABASE_SAFETY_PROTOCOL.md prohibits raw destructive prisma
 * commands and the safe scripts are the sanctioned path.
 */

function fail(lines: string[]): never {
  console.error("\n╔════════════════════════════════════════════════════════════════╗");
  console.error("║  DESTRUCTIVE DATABASE OPERATION BLOCKED                         ║");
  console.error("╚════════════════════════════════════════════════════════════════╝");
  for (const l of lines) console.error("  " + l);
  console.error("");
  process.exit(1);
}

function hostDb(url: string | undefined): string {
  if (!url) return "(unset)";
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return "(unparseable)";
  }
}

const dbUrl = process.env.DATABASE_URL;
const target = hostDb(dbUrl);

// 2. Shadow-DB footgun — never allow the live DB to be used as a migrate shadow.
const shadow = process.env.SHADOW_DATABASE_URL;
if (shadow && dbUrl && shadow.split("?")[0] === dbUrl.split("?")[0]) {
  fail([
    "SHADOW_DATABASE_URL is the SAME as DATABASE_URL.",
    "`prisma migrate diff/dev --shadow-database-url <live-db>` RESETS that DB.",
    "Point SHADOW_DATABASE_URL at a throwaway database (or unset it).",
    `Target: ${target}`,
  ]);
}

// 1. Explicit opt-in required.
if (process.env.ALLOW_DESTRUCTIVE_DB !== "true") {
  fail([
    `This would run a destructive command against:  ${target}`,
    "That database may contain REAL personal test data (Plaid connections,",
    "sync history, manually created Spaces) — none of which is in the seed.",
    "",
    "If you truly intend this:",
    "  1. Back up first:            npm run db:backup",
    "  2. Then re-run with opt-in:  ALLOW_DESTRUCTIVE_DB=true npm run <script>",
  ]);
}

console.log(`⚠  ALLOW_DESTRUCTIVE_DB=true — proceeding with a destructive op against ${target}.`);
console.log("   (A backup should have been taken by the safe script before this point.)");
