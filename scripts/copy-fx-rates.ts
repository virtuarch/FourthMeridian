/**
 * scripts/copy-fx-rates.ts
 *
 * Copy existing FxRate archive rows from one database to another WITHOUT
 * calling the FX provider/API. Point it at a well-populated source (e.g. prod)
 * and a target (e.g. a fresh staging/preview DB) to seed the target's rate
 * archive from rows that were already fetched, paid for, and closed.
 *
 * House pattern (scripts/backfill-fx-rates.ts): dry-run by default, --apply to
 * write, idempotent, re-runnable, summary output. This is a DB→DB transfer, so
 * unlike the sibling backfill it opens TWO Prisma clients (one per URL) and
 * never touches the app's default `@/lib/db` connection.
 *
 * Contract (append-only, idempotent):
 *   - Reads FxRate rows from SOURCE_DATABASE_URL only.
 *   - Writes to TARGET_DATABASE_URL only, and only with --apply.
 *   - All writes go through createMany({ data, skipDuplicates: true }) — insert-
 *     only. Never updates, never deletes, never overwrites a target row.
 *     Re-running is safe: existing rows are skipped via the unique key.
 *   - No FX provider/API is contacted. No schema changes. No app runtime code.
 *
 * Refuses to run if SOURCE_DATABASE_URL === TARGET_DATABASE_URL, or if either
 * env var is missing — cross-DB copy into the same place is never intended.
 *
 * Env / flags:
 *   SOURCE_DATABASE_URL   (required)  read-from connection string
 *   TARGET_DATABASE_URL   (required)  write-to connection string
 *   START_DATE            (optional)  YYYY-MM-DD inclusive lower bound
 *   END_DATE              (optional)  YYYY-MM-DD inclusive upper bound
 *   QUOTES               (optional)  comma list, e.g. "EUR,GBP,SAR" (case-insensitive)
 *   --apply                          perform writes (omit = dry-run)
 *
 * Run:
 *   # dry-run (default): reads source, previews, writes nothing
 *   SOURCE_DATABASE_URL=... TARGET_DATABASE_URL=... npx tsx scripts/copy-fx-rates.ts
 *
 *   # scoped dry-run
 *   SOURCE_DATABASE_URL=... TARGET_DATABASE_URL=... \
 *     START_DATE=2026-01-01 END_DATE=2026-06-30 QUOTES=EUR,GBP \
 *     npx tsx scripts/copy-fx-rates.ts
 *
 *   # apply
 *   SOURCE_DATABASE_URL=... TARGET_DATABASE_URL=... \
 *     npx tsx scripts/copy-fx-rates.ts --apply
 */

import { PrismaClient, Prisma } from "@prisma/client";
import { pathToFileURL } from "node:url";

// ── pure, side-effect-free helpers (exported for scripts/copy-fx-rates.test.ts) ──

/** A single copyable FxRate row. `id` is carried across so identity is stable. */
export interface FxRateRow {
  id: string;
  date: Date;
  base: string;
  quote: string;
  rate: number;
  source: string;
  fetchedAt: Date;
}

export interface CopyConfig {
  sourceUrl: string;
  targetUrl: string;
  startDate: string | null;
  endDate: string | null;
  quotes: string[] | null;
  apply: boolean;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True iff `s` is a YYYY-MM-DD string denoting a real calendar date. */
export function isISODate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Midnight-UTC Date for a YYYY-MM-DD string (matches Prisma @db.Date storage). */
export function isoToUTCDate(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}

/**
 * Parse a comma-separated QUOTES list into a normalized, de-duplicated,
 * upper-cased array. Returns null for undefined/empty (= "all quotes").
 */
export function parseQuotes(raw: string | undefined | null): string[] | null {
  if (raw == null) return null;
  const list = raw
    .split(",")
    .map((q) => q.trim().toUpperCase())
    .filter((q) => q.length > 0);
  return list.length > 0 ? Array.from(new Set(list)) : null;
}

/**
 * Validate env/flags into a CopyConfig or throw a clear Error. Enforces: both
 * URLs present, URLs distinct, dates (if given) well-formed and ordered.
 */
export function buildConfig(env: NodeJS.ProcessEnv, argv: string[]): CopyConfig {
  const sourceUrl = (env.SOURCE_DATABASE_URL ?? "").trim();
  const targetUrl = (env.TARGET_DATABASE_URL ?? "").trim();

  if (!sourceUrl || !targetUrl) {
    throw new Error(
      "Both SOURCE_DATABASE_URL and TARGET_DATABASE_URL must be set. Refusing to run.",
    );
  }
  if (sourceUrl === targetUrl) {
    throw new Error(
      "SOURCE_DATABASE_URL === TARGET_DATABASE_URL. Refusing to copy a database onto itself.",
    );
  }

  const startDate = env.START_DATE?.trim() || null;
  const endDate = env.END_DATE?.trim() || null;
  if (startDate && !isISODate(startDate)) {
    throw new Error(`START_DATE is not a valid YYYY-MM-DD date: "${startDate}"`);
  }
  if (endDate && !isISODate(endDate)) {
    throw new Error(`END_DATE is not a valid YYYY-MM-DD date: "${endDate}"`);
  }
  if (startDate && endDate && startDate > endDate) {
    throw new Error(`START_DATE ${startDate} is after END_DATE ${endDate}.`);
  }

  return {
    sourceUrl,
    targetUrl,
    startDate,
    endDate,
    quotes: parseQuotes(env.QUOTES),
    apply: argv.includes("--apply"),
  };
}

/** Build the Prisma `where` filter for the source read from a config. */
export function buildReadWhere(cfg: CopyConfig): Prisma.FxRateWhereInput {
  const where: Prisma.FxRateWhereInput = {};
  if (cfg.startDate || cfg.endDate) {
    where.date = {
      ...(cfg.startDate ? { gte: isoToUTCDate(cfg.startDate) } : {}),
      ...(cfg.endDate ? { lte: isoToUTCDate(cfg.endDate) } : {}),
    };
  }
  if (cfg.quotes) where.quote = { in: cfg.quotes };
  return where;
}

/** Insert-count → {found, inserted, duplicates}. duplicates are skipped rows. */
export function computeCounts(found: number, inserted: number): {
  found: number;
  inserted: number;
  duplicates: number;
} {
  return { found, inserted, duplicates: Math.max(0, found - inserted) };
}

/** Min/max valuation date across rows, as ISO strings (null when no rows). */
export function dateRangeOf(rows: FxRateRow[]): { min: string; max: string } | null {
  if (rows.length === 0) return null;
  let min = rows[0].date.getTime();
  let max = min;
  for (const r of rows) {
    const t = r.date.getTime();
    if (t < min) min = t;
    if (t > max) max = t;
  }
  return {
    min: new Date(min).toISOString().slice(0, 10),
    max: new Date(max).toISOString().slice(0, 10),
  };
}

/** Sorted distinct quotes present in the rows. */
export function quotesOf(rows: FxRateRow[]): string[] {
  return Array.from(new Set(rows.map((r) => r.quote))).sort();
}

/** Split an array into chunks of at most `size` (size > 0). */
export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error("chunk size must be > 0");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Redact credentials before printing a connection string.
function redactUrl(url: string): string {
  return url.replace(/\/\/[^@/]*@/, "//***:***@");
}

// ── runtime (DB I/O) ─────────────────────────────────────────────────────────

const CHUNK_SIZE = 1000; // rows per createMany call — keeps bind-param count sane

function clientFor(url: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url } }, log: ["error"] });
}

export async function main(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const cfg = buildConfig(env, argv);
  const where = buildReadWhere(cfg);

  const mode = cfg.apply
    ? "[APPLY] copying rows (append-only, skipDuplicates)"
    : "[DRY RUN] no writes — reading source and previewing only";

  console.log(`\ncopy-fx-rates — ${mode}`);
  console.log(`  source: ${redactUrl(cfg.sourceUrl)}`);
  console.log(`  target: ${redactUrl(cfg.targetUrl)}`);
  console.log(
    `  filters: start=${cfg.startDate ?? "—"} end=${cfg.endDate ?? "—"} ` +
      `quotes=${cfg.quotes ? cfg.quotes.join(",") : "ALL"}\n`,
  );

  const source = clientFor(cfg.sourceUrl);
  const target = clientFor(cfg.targetUrl);

  try {
    const rows: FxRateRow[] = await source.fxRate.findMany({
      where,
      select: {
        id: true,
        date: true,
        base: true,
        quote: true,
        rate: true,
        source: true,
        fetchedAt: true,
      },
      orderBy: [{ date: "asc" }, { quote: "asc" }],
    });

    const range = dateRangeOf(rows);
    const quotes = quotesOf(rows);

    console.log(`Source rows found:   ${rows.length}`);
    console.log(`Date range:          ${range ? `${range.min} → ${range.max}` : "—"}`);
    console.log(`Quotes copied:       ${quotes.length ? quotes.join(", ") : "—"}`);

    if (rows.length === 0) {
      console.log("\nNothing to copy for the given filters.");
      return;
    }

    if (!cfg.apply) {
      // Knowable in dry-run: how many of these keys already exist in target.
      const existing = await target.fxRate.count({ where });
      console.log(`Already in target:   ${existing} (would be skipped)`);
      console.log(
        `\nDry run only — no writes. Re-run with --apply to copy ${rows.length} row(s).`,
      );
      return;
    }

    let inserted = 0;
    const batches = chunk(rows, CHUNK_SIZE);
    for (let i = 0; i < batches.length; i++) {
      const res = await target.fxRate.createMany({
        data: batches[i],
        skipDuplicates: true,
      });
      inserted += res.count;
      console.log(
        `  batch ${i + 1}/${batches.length}: ${res.count}/${batches[i].length} inserted`,
      );
    }

    const counts = computeCounts(rows.length, inserted);
    console.log(`\nTarget rows inserted: ${counts.inserted}`);
    console.log(`Duplicates skipped:   ${counts.duplicates}`);
    console.log(
      `\nDone (append-only, idempotent). Re-running copies only rows still missing from target.`,
    );
  } finally {
    await Promise.all([source.$disconnect(), target.$disconnect()]);
  }
}

// Only run when invoked directly (`tsx scripts/copy-fx-rates.ts`), so the test
// can import the pure helpers without kicking off a DB connection.
const invokedDirectly =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error("copy-fx-rates failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
