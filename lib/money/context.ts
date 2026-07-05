/**
 * lib/money/context.ts
 *
 * MC1 Phase 2 Slice 2 — the async bridge from the immutable FxRate archive
 * to the SYNCHRONOUS ConversionContext seam (plan D-2, §3.1). Server-side
 * only in practice: the archive reader it consumes is Prisma-backed.
 *
 * Shape: one async prefetch pass resolves every (currency × date) pair the
 * caller will need through the Phase 1 fx service (identity fast path,
 * USD cross-rate, ≤7-day walk-back, RateMiss as value), stores the
 * Resolution VALUES in a private frozen table, and returns a context whose
 * `resolve()` is a pure synchronous lookup — exactly what the sync
 * aggregation families (classifyAccounts, flow rollups) can consume.
 *
 * Dependency injection, not imports: the FxArchiveReader is a REQUIRED
 * parameter. This module never imports lib/fx/archive (whose lib/db import
 * instantiates PrismaClient at load), so it stays importable in pure test
 * environments; production callers (Slice 3+) pass `fxArchive`.
 *
 * Doctrine carried through:
 *   - Read-only: nothing here writes anything, ever.
 *   - Never throw on data (plan D-3): a currency outside the supported set is
 *     a DATA value here (it arrives from stored rows, not from programmer
 *     constants), so the fx service's unsupported-currency throw is caught
 *     per pair and recorded as a RateMiss — downstream convertMoney passes
 *     the native amount through with `estimated: true`.
 *   - Unprefetched pairs resolve to RateMiss (deterministic, never a throw):
 *     callers must prefetch what they intend to convert.
 *   - Determinism: the archive is append-only for closed dates, so a table
 *     built from the same archive state is byte-identical every time.
 */

import { createFxService } from "@/lib/fx/service";
import type { FxArchiveReader, Resolution } from "@/lib/fx/types";
import type { ConversionContext } from "./types";

export interface BuildConversionContextOptions {
  /** The currency every conversion resolves into (Phase 2: always DEFAULT_DISPLAY_CURRENCY). */
  target:     string;
  /** Native currencies that will be converted. Nulls and the target itself are skipped (identity/null-residue never hit resolve()). */
  currencies: readonly (string | null)[];
  /** Valuation dates that will be used (live = yesterday UTC; rollups = per-row transaction dates; plan D-6). */
  dates:      readonly string[];
}

const key = (from: string, dateISO: string): string => `${from}|${dateISO}`;

/**
 * Prefetch all needed rates and return a frozen, synchronous ConversionContext.
 *
 * @param reader — the Phase 1 archive read seam. Production: `fxArchive`
 *                 (lib/fx/archive). Tests: an in-memory fake.
 */
export async function buildConversionContext(
  opts: BuildConversionContextOptions,
  reader: FxArchiveReader,
): Promise<ConversionContext> {
  const { target } = opts;
  const service = createFxService(reader);

  const currencies = [...new Set(opts.currencies.filter((c): c is string => c != null && c !== target))];
  const dates      = [...new Set(opts.dates)];

  const table = new Map<string, Resolution>();
  for (const from of currencies) {
    for (const dateISO of dates) {
      let res: Resolution;
      try {
        res = await service.getRateForDate(from, target, dateISO);
      } catch {
        // Unsupported currency (or malformed stored date) — data condition at
        // this layer, not a programmer error: degrade to a miss (plan D-3).
        res = { kind: "miss", quote: from, requestedDateISO: dateISO };
      }
      table.set(key(from, dateISO), Object.freeze(res) as Resolution);
    }
  }

  return Object.freeze({
    target,
    resolve(from: string, dateISO: string): Resolution {
      return (
        table.get(key(from, dateISO)) ??
        // Unprefetched pair: deterministic miss — never a throw, never a
        // surprise async fetch on a sync read path.
        { kind: "miss", quote: from, requestedDateISO: dateISO }
      );
    },
  });
}
