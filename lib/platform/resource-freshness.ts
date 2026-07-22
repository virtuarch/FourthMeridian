/**
 * lib/platform/resource-freshness.ts  (OPS-5 S1)
 *
 * THE canonical Resource Freshness authority — the answer to the one question
 * the FX incident proved the platform could not answer:
 *
 *     "Is the underlying resource actually FRESH?"
 *
 * ── The separation of authorities (the whole point) ──────────────────────────
 * OPS-4 shipped the JobRun ledger and lib/jobs/health.ts (the dead-job
 * detector). That detector answers a DIFFERENT question — "did the job EXECUTE
 * and return?" — and it is deliberately left untouched here. A `succeeded`
 * JobRun is NOT proof a resource is healthy:
 *   - fetch-fx-rates returns source:"none" WITHOUT throwing when every provider
 *     fails → a `succeeded` run over an archive that gained zero rows.
 *   - fetch-security-prices returns `no-provider` (a successful no-op) forever
 *     while it is vendor-gated → `succeeded` while nothing is ever priced.
 * Job execution and resource freshness are two authorities. This module is the
 * SECOND one, and it derives freshness ONLY from the underlying data
 * (MAX(FxRate.date), the newest PriceObservation, …) — NEVER from JobRun.status.
 * The ledger is read here for one purpose only: to surface `lastAttempted` /
 * `lastSuccessful` ALONGSIDE the content truth, so the divergence between them
 * (a green job over a stale archive) becomes visible instead of invisible.
 *
 * ── One reusable authority, N resources ──────────────────────────────────────
 * The freshness SEMANTICS live once, in the pure classifier
 * classifyResourceFreshness(). Each refreshable resource contributes a thin
 * `ResourceFreshnessDescriptor` to RESOURCE_FRESHNESS — its cadence, its stale
 * threshold, its producing job, and a `probe()` that reads its OWN newest
 * observed date + frontier completeness from the underlying data. Adding a
 * resource (snapshots, valuation archives, PositionObservations, provider
 * caches, historical series) = adding one descriptor. No freshness rule is ever
 * duplicated — probes read data; the classifier decides health. This mirrors
 * the SCHEDULED_JOBS registry + classifyJobHealth split exactly (OPS-4 S5).
 *
 * ── Health states (content-derived) ──────────────────────────────────────────
 *   fresh   newest observation is within the stale threshold.
 *   stale   data exists but the newest observation is older than the threshold
 *           (this is what catches a source:"none" succeeded FX run).
 *   empty   the resource SHOULD have data (something is being tracked) but the
 *           archive holds none (the incident's cold-archive shape).
 *   idle    nothing is being tracked yet (no held instruments, etc.) — the
 *           archive is legitimately empty; not a problem, vacuously healthy.
 *
 * PURE + INJECTABLE: classifyResourceFreshness is a pure function of
 * (descriptor, observation, ledger facts, clock). checkResourceFreshness runs
 * the real probes against an injected read-client (the `db` in production, a
 * fake in tests), so the whole surface unit-tests with no live database — the
 * house pattern (lib/jobs/health.ts, lib/money/fx-freshness.ts).
 *
 * READ-ONLY: zero writes, zero new tables. Freshness is COMPUTED read-time from
 * facts that already exist, exactly like lib/jobs/health.ts over the ledger.
 */

import { db } from "@/lib/db";
import { PriceBasis } from "@prisma/client";
import { FX_BASE, SUPPORTED_QUOTES } from "@/lib/fx/config";
import { defaultPriceRegistry } from "@/lib/prices/registry";

const HOUR_MS = 60 * 60 * 1000;

// ── Public shapes ─────────────────────────────────────────────────────────────

export type FreshnessHealthState = "fresh" | "stale" | "empty" | "idle";
export type FreshnessTrustLevel = "high" | "medium" | "low" | "unknown";

/** Frontier completeness: of the units expected on the newest observed date,
 *  how many are actually present (e.g. quotes stored, held instruments priced). */
export interface FreshnessCompleteness {
  expected: number;
  observed: number;
  /** observed / expected in [0,1]; 1 when expected is 0 (vacuously complete). */
  ratio: number;
}

export interface FreshnessTrust {
  level: FreshnessTrustLevel;
  /** Ordered, human-readable reasons — worst/most-load-bearing first. */
  caveats: string[];
}

/** The canonical freshness report for ONE resource. Every field the OPS-5 S1
 *  brief enumerates is present; dates are ISO strings at the API boundary. */
export interface ResourceFreshnessReport {
  resource: string;
  label: string;
  /** newest observed date — the content check (MAX(date)); null = empty. ISO date. */
  newestObservedDate: string | null;
  /** freshness: age of the newest observation. null when empty/idle. */
  ageHours: number | null;
  ageDays: number | null;
  /** expected cadence — how often the resource should advance. */
  expectedCadenceHours: number;
  cadenceLabel: string;
  /** stale threshold — age beyond which the resource is `stale`. */
  staleAfterHours: number;
  healthState: FreshnessHealthState;
  completeness: FreshnessCompleteness | null;
  /** last SUCCESSFUL refresh of the producing job — execution authority, shown
   *  beside the content truth, never used to derive it. ISO datetime | null. */
  lastSuccessfulRefresh: string | null;
  /** last ATTEMPTED refresh (any status) + its status. ISO datetime | null. */
  lastAttemptedRefresh: string | null;
  lastAttemptStatus: string | null;
  trust: FreshnessTrust;
}

export interface ResourceFreshnessResult {
  checkedAt: Date;
  /** True only when every resource is `fresh` or `idle` (nothing wrong). */
  allFresh: boolean;
  resources: ResourceFreshnessReport[];
}

// ── Probe / descriptor contract ───────────────────────────────────────────────

/** The raw content facts a probe reads from a resource's underlying data. This
 *  is DATA, not judgement — the classifier turns it into a health state. */
export interface FreshnessObservation {
  /** MAX(date) over the underlying data; null when the archive is empty. */
  newestObservedDate: Date | null;
  /** Units expected on the newest date (e.g. #supported quotes, #held
   *  instruments). 0 means "nothing is being tracked" → `idle`. null = unknown. */
  expectedUnits: number | null;
  /** Units actually present on the newest observed date. null = unknown. */
  observedUnits: number | null;
  /** The producing pipeline cannot populate the archive right now (e.g. no price
   *  vendor configured). An empty archive under `blocked` is honest, not alarming. */
  blocked?: boolean;
  /** Extra probe-supplied caveats (always surfaced in trust). */
  notes?: string[];
}

/** Facts read from the JobRun ledger for the resource's producing job. This is
 *  the EXECUTION authority — surfaced, never used to derive the health state. */
export interface RefreshLedgerFacts {
  lastAttemptedAt: Date | null;
  lastAttemptStatus: string | null;
  lastSuccessfulAt: Date | null;
}

const NO_LEDGER: RefreshLedgerFacts = {
  lastAttemptedAt: null,
  lastAttemptStatus: null,
  lastSuccessfulAt: null,
};

/** One registered refreshable resource. */
export interface ResourceFreshnessDescriptor {
  id: string;
  label: string;
  /** Expected cadence — how often the newest observation should advance. */
  expectedCadenceHours: number;
  cadenceLabel: string;
  /** Age (of the newest observation) beyond which the resource is `stale`.
   *  Defaults to cadence + a day of grace when a descriptor omits it. */
  staleAfterHours: number;
  /** Human label for a completeness unit ("currency pairs", "held instruments"). */
  unitLabel: string;
  /** JobRun.jobName of the producing job, or null when no job produces it. */
  producingJob: string | null;
  /** Reads the underlying data — THE content check. No freshness judgement here. */
  probe(client: FreshnessReadClient, now: Date): Promise<FreshnessObservation>;
}

// ── Narrow read-client (injection seam; `db` in prod, a fake in tests) ────────

interface DateRow { date: Date }
interface QuoteRow { quote: string }
interface InstrumentIdRow { instrumentId: string }
interface LedgerRow { startedAt: Date; completedAt: Date | null; status: string }

export interface FreshnessReadClient {
  fxRate: {
    findFirst(args: {
      where: { base: string };
      orderBy: { date: "desc" };
      select: { date: true };
    }): Promise<DateRow | null>;
    findMany(args: {
      where: { base: string; date: Date };
      select: { quote: true };
    }): Promise<QuoteRow[]>;
  };
  priceObservation: {
    findFirst(args: {
      where: { basis: PriceBasis };
      orderBy: { date: "desc" };
      select: { date: true };
    }): Promise<DateRow | null>;
    findMany(args: {
      where: { instrumentId: { in: string[] }; basis: PriceBasis; date: Date };
      select: { instrumentId: true };
    }): Promise<InstrumentIdRow[]>;
  };
  positionObservation: {
    findMany(args: {
      where: { supersededById: null; deletedAt: null; quantity: { gt: number } };
      select: { instrumentId: true };
      distinct: ["instrumentId"];
    }): Promise<InstrumentIdRow[]>;
  };
  jobRun: {
    findFirst(args: {
      where: { jobName: string; status?: string };
      orderBy: { startedAt: "desc" };
      select: { startedAt: true; completedAt: true; status: true };
    }): Promise<LedgerRow | null>;
  };
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/** Date (@db.Date is UTC-midnight) → "YYYY-MM-DD". */
function toISODateUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Default stale threshold: one cadence plus a full day of grace. */
function defaultStaleAfterHours(cadenceHours: number): number {
  return cadenceHours + 24;
}

// ── The one classifier (pure, deterministic) ─────────────────────────────────

/**
 * Turn one resource's content observation + ledger facts into a freshness
 * report. THE single place freshness semantics live. Deterministic given a
 * fixed clock. The health state is a function of the OBSERVATION only — the
 * ledger contributes caveats (and the false-green flag) but never the state.
 */
export function classifyResourceFreshness(
  d: ResourceFreshnessDescriptor,
  obs: FreshnessObservation,
  ledger: RefreshLedgerFacts,
  now: Date,
): ResourceFreshnessReport {
  const staleAfterHours = d.staleAfterHours;
  const caveats: string[] = [];
  for (const n of obs.notes ?? []) caveats.push(n);

  const completeness: FreshnessCompleteness | null =
    obs.expectedUnits != null && obs.observedUnits != null
      ? {
          expected: obs.expectedUnits,
          observed: obs.observedUnits,
          ratio: obs.expectedUnits === 0 ? 1 : obs.observedUnits / obs.expectedUnits,
        }
      : null;

  const base = {
    resource: d.id,
    label: d.label,
    expectedCadenceHours: d.expectedCadenceHours,
    cadenceLabel: d.cadenceLabel,
    staleAfterHours,
    completeness,
    lastSuccessfulRefresh: ledger.lastSuccessfulAt ? ledger.lastSuccessfulAt.toISOString() : null,
    lastAttemptedRefresh: ledger.lastAttemptedAt ? ledger.lastAttemptedAt.toISOString() : null,
    lastAttemptStatus: ledger.lastAttemptStatus,
  };

  const newest = obs.newestObservedDate;

  // ── Empty archive ──────────────────────────────────────────────────────────
  if (newest == null) {
    const trackingNothing = (obs.expectedUnits ?? 0) === 0;
    if (trackingNothing) {
      // Nothing is being tracked — the empty archive is legitimate.
      return {
        ...base,
        newestObservedDate: null,
        ageHours: null,
        ageDays: null,
        healthState: "idle",
        trust: { level: "high", caveats: ["nothing to observe yet", ...caveats] },
      };
    }
    // Something IS tracked but the archive is empty — the incident's shape.
    const level: FreshnessTrustLevel = obs.blocked ? "unknown" : "low";
    const lead = obs.blocked
      ? `${d.label} archive is empty and its refresh pipeline is not configured`
      : `${d.label} archive is empty — no observations stored`;
    const flags: string[] = [];
    if (ledger.lastSuccessfulAt) {
      // The false-green: a green job over an empty archive.
      flags.push(
        "a refresh reported success but the archive is empty — job success is not resource freshness",
      );
    }
    return {
      ...base,
      newestObservedDate: null,
      ageHours: null,
      ageDays: null,
      healthState: "empty",
      trust: { level, caveats: [lead, ...caveats, ...flags] },
    };
  }

  // ── Populated archive ──────────────────────────────────────────────────────
  const ageHours = (now.getTime() - newest.getTime()) / HOUR_MS;
  const ageDays = Math.floor(ageHours / 24);
  const newestISO = toISODateUTC(newest);
  const fresh = ageHours <= staleAfterHours;

  if (!fresh) {
    const flags: string[] = [];
    // The false-green: a recent successful job while the archive is stale.
    if (ledger.lastSuccessfulAt && now.getTime() - ledger.lastSuccessfulAt.getTime() <= staleAfterHours * HOUR_MS) {
      flags.push(
        "a refresh recently reported success but the archive is stale — job success is not resource freshness",
      );
    }
    return {
      ...base,
      newestObservedDate: newestISO,
      ageHours,
      ageDays,
      healthState: "stale",
      trust: {
        level: "low",
        caveats: [
          `newest observation is ${ageDays}d old (${newestISO}), beyond the ${staleAfterHours}h stale threshold`,
          ...caveats,
          ...flags,
        ],
      },
    };
  }

  // Fresh — but a partial frontier drops trust to medium (data arrived, not all).
  if (completeness && completeness.ratio < 1) {
    const missing = completeness.expected - completeness.observed;
    return {
      ...base,
      newestObservedDate: newestISO,
      ageHours,
      ageDays,
      healthState: "fresh",
      trust: {
        level: "medium",
        caveats: [
          `${missing} of ${completeness.expected} ${d.unitLabel} missing on ${newestISO}`,
          ...caveats,
        ],
      },
    };
  }

  return {
    ...base,
    newestObservedDate: newestISO,
    ageHours,
    ageDays,
    healthState: "fresh",
    trust: { level: "high", caveats },
  };
}

// ── Ledger read (execution authority, surfaced not derived) ──────────────────

async function readRefreshLedger(
  client: FreshnessReadClient,
  jobName: string,
): Promise<RefreshLedgerFacts> {
  const [lastAttempt, lastSuccess] = await Promise.all([
    client.jobRun.findFirst({
      where: { jobName },
      orderBy: { startedAt: "desc" },
      select: { startedAt: true, completedAt: true, status: true },
    }),
    client.jobRun.findFirst({
      where: { jobName, status: "succeeded" },
      orderBy: { startedAt: "desc" },
      select: { startedAt: true, completedAt: true, status: true },
    }),
  ]);
  return {
    lastAttemptedAt: lastAttempt?.startedAt ?? null,
    lastAttemptStatus: lastAttempt?.status ?? null,
    // completedAt is the moment the success was recorded; fall back to start.
    lastSuccessfulAt: lastSuccess ? lastSuccess.completedAt ?? lastSuccess.startedAt : null,
  };
}

// ── Probes — one per resource, thin data reads (NO freshness judgement) ───────

/** FX Rates: newest FxRate.date (base USD) + how many supported quotes it has. */
async function probeFxRates(client: FreshnessReadClient): Promise<FreshnessObservation> {
  const newestRow = await client.fxRate.findFirst({
    where: { base: FX_BASE },
    orderBy: { date: "desc" },
    select: { date: true },
  });
  const expectedUnits = SUPPORTED_QUOTES.length;
  if (!newestRow) {
    return { newestObservedDate: null, expectedUnits, observedUnits: 0 };
  }
  const onNewest = await client.fxRate.findMany({
    where: { base: FX_BASE, date: newestRow.date },
    select: { quote: true },
  });
  const supported = new Set<string>(SUPPORTED_QUOTES);
  const observedUnits = new Set(onNewest.map((r) => r.quote).filter((q) => supported.has(q))).size;
  return { newestObservedDate: newestRow.date, expectedUnits, observedUnits };
}

/** Security Prices: newest RAW_CLOSE PriceObservation + how many currently-held
 *  instruments are priced on that date. Vendor-gated: no price adapter ⇒ the
 *  pipeline is `blocked`, so an empty archive is honest, not a failure. */
async function probeSecurityPrices(client: FreshnessReadClient): Promise<FreshnessObservation> {
  const blocked = defaultPriceRegistry().adapters.length === 0;
  const notes = blocked
    ? ["no price vendor configured — the price archive cannot advance (A8-3B, externally blocked)"]
    : [];

  // Held instruments = the universe that SHOULD be priced (fetch-security-prices
  // scope). Zero held ⇒ nothing to track ⇒ `idle`, not `empty`.
  const held = await client.positionObservation.findMany({
    where: { supersededById: null, deletedAt: null, quantity: { gt: 0 } },
    select: { instrumentId: true },
    distinct: ["instrumentId"],
  });
  const instrumentIds = [...new Set(held.map((h) => h.instrumentId))];
  const expectedUnits = instrumentIds.length;

  const newestRow = await client.priceObservation.findFirst({
    where: { basis: PriceBasis.RAW_CLOSE },
    orderBy: { date: "desc" },
    select: { date: true },
  });

  if (!newestRow) {
    return { newestObservedDate: null, expectedUnits, observedUnits: 0, blocked, notes };
  }

  const onNewest = expectedUnits === 0
    ? []
    : await client.priceObservation.findMany({
        where: { instrumentId: { in: instrumentIds }, basis: PriceBasis.RAW_CLOSE, date: newestRow.date },
        select: { instrumentId: true },
      });
  const observedUnits = new Set(onNewest.map((r) => r.instrumentId)).size;
  return { newestObservedDate: newestRow.date, expectedUnits, observedUnits, blocked, notes };
}

// ── The registry — add a resource = add a descriptor ─────────────────────────

export const RESOURCE_FRESHNESS: readonly ResourceFreshnessDescriptor[] = [
  {
    id: "fx-rates",
    label: "FX Rates",
    expectedCadenceHours: 24,
    cadenceLabel: "Daily",
    staleAfterHours: defaultStaleAfterHours(24),
    unitLabel: "currency pairs",
    producingJob: "fetch-fx-rates",
    probe: (client) => probeFxRates(client),
  },
  {
    id: "security-prices",
    label: "Security Prices",
    expectedCadenceHours: 24,
    cadenceLabel: "Daily",
    staleAfterHours: defaultStaleAfterHours(24),
    unitLabel: "held instruments",
    producingJob: "fetch-security-prices",
    probe: (client) => probeSecurityPrices(client),
  },
];

// ── The driver ────────────────────────────────────────────────────────────────

/**
 * Evaluate freshness for every registered resource. Read-only; deterministic
 * given a fixed clock and a fixed archive/ledger. The probe reads content; the
 * ledger read surfaces execution facts; the pure classifier decides health.
 */
export async function checkResourceFreshness(
  client: FreshnessReadClient = db as unknown as FreshnessReadClient,
  now: Date = new Date(),
  descriptors: readonly ResourceFreshnessDescriptor[] = RESOURCE_FRESHNESS,
): Promise<ResourceFreshnessResult> {
  const resources: ResourceFreshnessReport[] = [];
  for (const d of descriptors) {
    const obs = await d.probe(client, now);
    const ledger = d.producingJob ? await readRefreshLedger(client, d.producingJob) : NO_LEDGER;
    resources.push(classifyResourceFreshness(d, obs, ledger, now));
  }
  return {
    checkedAt: now,
    allFresh: resources.every((r) => r.healthState === "fresh" || r.healthState === "idle"),
    resources,
  };
}
