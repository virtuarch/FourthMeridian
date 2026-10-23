/**
 * lib/investments/corporate-actions.ts
 *
 * V26-S1-CA — the DB binding for the corporate-action terms authority.
 *
 * Two jobs, and nothing else:
 *   1. RECORD terms a source stated (`recordCorporateActionTerms`), called
 *      wherever a price fetch lands, because that is where the vendor states
 *      them.
 *   2. RESOLVE the terms that apply to a set of instruments
 *      (`loadCorporateActionTerms`), so the reconstruction runner can hand a
 *      known ratio to a walk that would otherwise stop.
 *
 * All grading, selection and refusal live in the pure core
 * (corporate-actions.core.ts). This file reads and writes; it decides nothing.
 *
 * Deployment-global, exactly like Instrument and PriceObservation: one Tiingo
 * answer about TQQQ serves every user who holds it, and no user's data is
 * visible in a corporate action.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import type { ProviderCorporateAction } from "@/lib/prices/types";
import {
  assertPersistableTerms,
  resolveTerms,
  actionKey,
  type CorporateActionTermsInput,
  type ResolvedTerms,
} from "./corporate-actions.core";

type Client = PrismaClient | Prisma.TransactionClient;

/** Grade for terms a PRICE VENDOR stated. See the core's header for why not STATED. */
export const VENDOR_GRADE = "CORROBORATED";

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function fromYmd(s: string): Date {
  return new Date(`${s.slice(0, 10)}T00:00:00.000Z`);
}

/**
 * Record corporate actions a provider stated. Idempotent per
 * (instrument, date, kind, source): re-running a fetch re-states the same term
 * and updates nothing material.
 *
 * Best-effort by contract — the caller wraps it non-fatal. A corporate action we
 * failed to record leaves the walk exactly where it already was (stopped, with
 * UNSUPPORTED_CORPORATE_ACTION), which is a refusal, not a wrong number. Losing
 * a price run over it would be the worse trade.
 *
 * Returns the number of actions accepted. A malformed action THROWS through
 * `assertPersistableTerms` rather than being coerced: a bad ratio silently
 * written here would license a wrong historical quantity, which is precisely the
 * failure the whole authority exists to prevent.
 */
export async function recordCorporateActionTerms(
  source: string,
  actions: readonly ProviderCorporateAction[],
  client: Client = db,
): Promise<number> {
  if (actions.length === 0) return 0;
  let written = 0;
  for (const a of actions) {
    const terms: CorporateActionTermsInput = {
      instrumentId:  a.instrumentId,
      effectiveDate: a.effectiveDate,
      kind:          a.kind,
      ratio:         a.ratio,
      grade:         VENDOR_GRADE,
      source,
    };
    assertPersistableTerms(terms);
    const data = {
      ratio:        a.ratio,
      grade:        VENDOR_GRADE,
      evidenceRefs: (a.evidence ?? {}) as Prisma.InputJsonValue,
    };
    await client.corporateActionTerms.upsert({
      where: {
        instrumentId_effectiveDate_kind_source: {
          instrumentId:  a.instrumentId,
          effectiveDate: fromYmd(a.effectiveDate),
          kind:          a.kind,
          source,
        },
      },
      create: {
        instrument:    { connect: { id: a.instrumentId } },
        effectiveDate: fromYmd(a.effectiveDate),
        kind:          a.kind,
        source,
        ...data,
      },
      update: data,
    });
    written++;
  }
  return written;
}

/**
 * The terms that apply for a set of instruments, keyed by
 * `actionKey(instrumentId, effectiveDate, kind)`.
 *
 * Selection (grade precedence, deterministic tie-break, dispute detection) is
 * the pure core's; this only supplies the rows.
 */
export async function loadCorporateActionTerms(
  instrumentIds: readonly string[],
  client: Client = db,
): Promise<Map<string, ResolvedTerms>> {
  if (instrumentIds.length === 0) return new Map();
  const rows = await client.corporateActionTerms.findMany({
    where:  { instrumentId: { in: [...new Set(instrumentIds)] } },
    select: { instrumentId: true, effectiveDate: true, kind: true, ratio: true, grade: true, source: true },
  });
  return resolveTerms(
    rows.map((r) => ({
      instrumentId:  r.instrumentId,
      effectiveDate: ymd(r.effectiveDate),
      kind:          r.kind,
      ratio:         r.ratio,
      grade:         r.grade,
      source:        r.source,
    })),
  );
}

export { actionKey };
export type { ResolvedTerms };
