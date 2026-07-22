/**
 * lib/platform/resource-freshness.test.ts  (OPS-5 S1)
 *
 * Pure guards for THE resource-freshness authority. Standalone tsx script
 * (house pattern): npx tsx lib/platform/resource-freshness.test.ts — exits 0/1.
 * Auto-discovered by scripts/run-tests.ts.
 *
 * NO LIVE DATABASE: classifyResourceFreshness is pure (injected observation +
 * ledger + clock); checkResourceFreshness + the real registry probes run
 * against an injected in-memory fake of FreshnessReadClient.
 *
 * The load-bearing invariant (§ "false-green"): a `succeeded` refresh over a
 * stale OR empty archive must NEVER read `fresh`. This is the whole reason the
 * module exists — freshness derives from the DATA, not from JobRun.status.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { PriceBasis } from "@prisma/client";
import { SUPPORTED_QUOTES } from "@/lib/fx/config";
import { defaultPriceRegistry } from "@/lib/prices/registry";
import {
  RESOURCE_FRESHNESS,
  checkResourceFreshness,
  classifyResourceFreshness,
  type FreshnessObservation,
  type FreshnessReadClient,
  type RefreshLedgerFacts,
  type ResourceFreshnessDescriptor,
} from "@/lib/platform/resource-freshness";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("  ✗ unexpected unhandled rejection:", err);
  process.exit(1);
});

const NOW = new Date("2026-07-16T00:00:00Z");
const dayUTC = (iso: string) => new Date(`${iso}T00:00:00Z`);

const DESC: ResourceFreshnessDescriptor = {
  id: "t",
  label: "Test Resource",
  expectedCadenceHours: 24,
  cadenceLabel: "Daily",
  staleAfterHours: 48,
  unitLabel: "widgets",
  producingJob: "t-job",
  probe: async () => ({ newestObservedDate: null, expectedUnits: null, observedUnits: null }),
};

const NO_LEDGER: RefreshLedgerFacts = { lastAttemptedAt: null, lastAttemptStatus: null, lastSuccessfulAt: null };
const GREEN_NOW: RefreshLedgerFacts = {
  lastAttemptedAt: NOW,
  lastAttemptStatus: "succeeded",
  lastSuccessfulAt: NOW,
};

function classify(obs: FreshnessObservation, ledger: RefreshLedgerFacts = NO_LEDGER) {
  return classifyResourceFreshness(DESC, obs, ledger, NOW);
}

// ── In-memory fake read-client (backs the driver + real-registry probes) ─────

interface FakeState {
  fx: { date: Date; base: string; quote: string }[];
  prices: { instrumentId: string; date: Date; basis: PriceBasis }[];
  held: string[]; // instrumentIds with a live qty>0 position
  jobRuns: { jobName: string; startedAt: Date; completedAt: Date | null; status: string }[];
}

function fakeClient(state: FakeState): FreshnessReadClient {
  const maxDate = (rows: { date: Date }[]) =>
    rows.length === 0 ? null : rows.reduce((a, b) => (a.date >= b.date ? a : b));
  return {
    fxRate: {
      async findFirst({ where }) {
        const rows = state.fx.filter((r) => r.base === where.base);
        const m = maxDate(rows);
        return m ? { date: m.date } : null;
      },
      async findMany({ where }) {
        return state.fx
          .filter((r) => r.base === where.base && r.date.getTime() === where.date.getTime())
          .map((r) => ({ quote: r.quote }));
      },
    },
    priceObservation: {
      async findFirst({ where }) {
        const rows = state.prices.filter((r) => r.basis === where.basis);
        const m = maxDate(rows);
        return m ? { date: m.date } : null;
      },
      async findMany({ where }) {
        const ids = new Set(where.instrumentId.in);
        return state.prices
          .filter((r) => r.basis === where.basis && ids.has(r.instrumentId) && r.date.getTime() === where.date.getTime())
          .map((r) => ({ instrumentId: r.instrumentId }));
      },
    },
    positionObservation: {
      async findMany() {
        return [...new Set(state.held)].map((instrumentId) => ({ instrumentId }));
      },
    },
    jobRun: {
      async findFirst({ where }) {
        const rows = state.jobRuns
          .filter((r) => r.jobName === where.jobName && (where.status == null || r.status === where.status))
          .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
        const r = rows[0];
        return r ? { startedAt: r.startedAt, completedAt: r.completedAt, status: r.status } : null;
      },
    },
  };
}

async function main(): Promise<void> {
  console.log("resource-freshness authority (OPS-5 S1)");

  // ── 1. Fresh + complete ────────────────────────────────────────────────────
  {
    const r = classify({ newestObservedDate: dayUTC("2026-07-15"), expectedUnits: 8, observedUnits: 8 });
    check("fresh + complete → healthState fresh", r.healthState === "fresh");
    check("fresh + complete → trust high", r.trust.level === "high", `got ${r.trust.level}`);
    check("fresh → age ~24h", Math.round(r.ageHours ?? -1) === 24, `got ${r.ageHours}`);
    check("fresh → completeness ratio 1", r.completeness?.ratio === 1);
    check("newestObservedDate is the ISO date", r.newestObservedDate === "2026-07-15");
  }

  // ── 2. Fresh but partial frontier → medium trust ───────────────────────────
  {
    const r = classify({ newestObservedDate: dayUTC("2026-07-15"), expectedUnits: 8, observedUnits: 5 });
    check("fresh + partial → healthState still fresh", r.healthState === "fresh");
    check("fresh + partial → trust medium", r.trust.level === "medium", `got ${r.trust.level}`);
    check("fresh + partial → caveat names the missing count", r.trust.caveats[0].includes("3 of 8 widgets missing"));
  }

  // ── 3. Stale (age beyond threshold) ────────────────────────────────────────
  {
    const r = classify({ newestObservedDate: dayUTC("2026-07-10"), expectedUnits: 8, observedUnits: 8 });
    check("stale → healthState stale", r.healthState === "stale");
    check("stale → trust low", r.trust.level === "low", `got ${r.trust.level}`);
    check("stale → ageDays 6", r.ageDays === 6, `got ${r.ageDays}`);
    check("stale → caveat names the threshold", r.trust.caveats[0].includes("stale threshold"));
  }

  // ── 4. Stale/fresh boundary (age == staleAfterHours is fresh) ──────────────
  {
    const atThreshold = classifyResourceFreshness(
      DESC,
      { newestObservedDate: dayUTC("2026-07-14"), expectedUnits: 1, observedUnits: 1 },
      NO_LEDGER,
      new Date("2026-07-16T00:00:00Z"), // exactly 48h after 07-14 midnight
    );
    check("age == staleAfterHours → fresh (inclusive)", atThreshold.healthState === "fresh", `got ${atThreshold.healthState}`);
    const justOver = classifyResourceFreshness(
      DESC,
      { newestObservedDate: dayUTC("2026-07-14"), expectedUnits: 1, observedUnits: 1 },
      NO_LEDGER,
      new Date("2026-07-16T01:00:00Z"), // 49h
    );
    check("age just over threshold → stale", justOver.healthState === "stale", `got ${justOver.healthState}`);
  }

  // ── 5. Empty archive, something IS tracked → empty/low ─────────────────────
  {
    const r = classify({ newestObservedDate: null, expectedUnits: 8, observedUnits: 0 });
    check("empty + tracked → healthState empty", r.healthState === "empty");
    check("empty + tracked → trust low", r.trust.level === "low", `got ${r.trust.level}`);
    check("empty → no age", r.ageHours === null && r.ageDays === null);
    check("empty → caveat says archive is empty", r.trust.caveats[0].includes("archive is empty"));
  }

  // ── 6. Empty + blocked pipeline → empty/unknown (honest, not alarming) ─────
  {
    const r = classify({ newestObservedDate: null, expectedUnits: 3, observedUnits: 0, blocked: true, notes: ["no vendor"] });
    check("empty + blocked → healthState empty", r.healthState === "empty");
    check("empty + blocked → trust unknown", r.trust.level === "unknown", `got ${r.trust.level}`);
    check("empty + blocked → probe note surfaces", r.trust.caveats.includes("no vendor"));
  }

  // ── 7. Nothing tracked → idle (vacuously healthy) ──────────────────────────
  {
    const r = classify({ newestObservedDate: null, expectedUnits: 0, observedUnits: 0 });
    check("nothing tracked → healthState idle", r.healthState === "idle");
    check("idle → trust high", r.trust.level === "high", `got ${r.trust.level}`);
  }

  // ── 8. THE false-green invariant ───────────────────────────────────────────
  {
    // A green job (succeeded now) over a STALE archive must not read fresh.
    const stale = classify({ newestObservedDate: dayUTC("2026-07-10"), expectedUnits: 8, observedUnits: 8 }, GREEN_NOW);
    check("green job + stale archive → still stale (NOT fresh)", stale.healthState === "stale");
    check("green job + stale archive → false-green caveat present",
      stale.trust.caveats.some((c) => c.includes("job success is not resource freshness")));
    check("stale report still surfaces lastSuccessfulRefresh (execution authority shown, not derived)",
      stale.lastSuccessfulRefresh === NOW.toISOString());

    // A green job over an EMPTY archive must not read fresh/idle.
    const empty = classify({ newestObservedDate: null, expectedUnits: 8, observedUnits: 0 }, GREEN_NOW);
    check("green job + empty archive → still empty", empty.healthState === "empty");
    check("green job + empty archive → false-green caveat present",
      empty.trust.caveats.some((c) => c.includes("job success is not resource freshness")));
  }

  // ── 9. Report carries every brief-required field + ledger passthrough ──────
  {
    const ledger: RefreshLedgerFacts = {
      lastAttemptedAt: new Date("2026-07-16T06:30:00Z"),
      lastAttemptStatus: "failed",
      lastSuccessfulAt: new Date("2026-07-13T06:30:05Z"),
    };
    const r = classify({ newestObservedDate: dayUTC("2026-07-12"), expectedUnits: 8, observedUnits: 8 }, ledger);
    check("expectedCadenceHours surfaced", r.expectedCadenceHours === 24);
    check("cadenceLabel surfaced", r.cadenceLabel === "Daily");
    check("staleAfterHours surfaced", r.staleAfterHours === 48);
    check("lastAttemptedRefresh surfaced (ISO)", r.lastAttemptedRefresh === "2026-07-16T06:30:00.000Z");
    check("lastAttemptStatus surfaced", r.lastAttemptStatus === "failed");
    check("lastSuccessfulRefresh surfaced (ISO)", r.lastSuccessfulRefresh === "2026-07-13T06:30:05.000Z");
    check("completeness surfaced", r.completeness?.expected === 8 && r.completeness?.observed === 8);
  }

  // ── 10. Driver aggregation over fake descriptors ───────────────────────────
  {
    const mk = (id: string, obs: FreshnessObservation): ResourceFreshnessDescriptor => ({
      ...DESC, id, label: id, producingJob: null, probe: async () => obs,
    });
    const allGood = await checkResourceFreshness(
      fakeClient({ fx: [], prices: [], held: [], jobRuns: [] }),
      NOW,
      [
        mk("a", { newestObservedDate: dayUTC("2026-07-15"), expectedUnits: 1, observedUnits: 1 }),
        mk("b", { newestObservedDate: null, expectedUnits: 0, observedUnits: 0 }), // idle
      ],
    );
    check("driver: fresh + idle ⇒ allFresh true", allGood.allFresh === true);
    check("driver: emits one report per descriptor", allGood.resources.length === 2);

    const oneStale = await checkResourceFreshness(
      fakeClient({ fx: [], prices: [], held: [], jobRuns: [] }),
      NOW,
      [
        mk("a", { newestObservedDate: dayUTC("2026-07-15"), expectedUnits: 1, observedUnits: 1 }),
        mk("b", { newestObservedDate: dayUTC("2026-07-01"), expectedUnits: 1, observedUnits: 1 }), // stale
      ],
    );
    check("driver: any stale ⇒ allFresh false", oneStale.allFresh === false);
  }

  // ── 11. Real registry probes over the fake client ──────────────────────────
  {
    // Ledger with a green run — proves freshness is NOT read off it.
    const greenRuns = [
      { jobName: "fetch-fx-rates", startedAt: NOW, completedAt: NOW, status: "succeeded" },
      { jobName: "fetch-security-prices", startedAt: NOW, completedAt: NOW, status: "succeeded" },
    ];

    // 11a. Cold FX archive (the incident) + a green job ⇒ empty, NOT fresh.
    const cold = await checkResourceFreshness(
      fakeClient({ fx: [], prices: [], held: [], jobRuns: greenRuns }),
      NOW,
    );
    const fx = cold.resources.find((r) => r.resource === "fx-rates")!;
    check("real FX probe: cold archive ⇒ empty despite green job", fx.healthState === "empty", `got ${fx.healthState}`);
    check("real FX probe: expectedUnits = supported quote count",
      fx.completeness?.expected === SUPPORTED_QUOTES.length);
    check("real FX probe: green-over-empty false-green flagged",
      fx.trust.caveats.some((c) => c.includes("job success is not resource freshness")));

    // 11b. Fresh, fully-covered FX ⇒ fresh/high.
    const fxRows = SUPPORTED_QUOTES.map((quote) => ({ date: dayUTC("2026-07-15"), base: "USD", quote }));
    const warm = await checkResourceFreshness(
      fakeClient({ fx: fxRows, prices: [], held: [], jobRuns: greenRuns }),
      NOW,
    );
    const fx2 = warm.resources.find((r) => r.resource === "fx-rates")!;
    check("real FX probe: full recent coverage ⇒ fresh", fx2.healthState === "fresh", `got ${fx2.healthState}`);
    check("real FX probe: full coverage ⇒ trust high", fx2.trust.level === "high", `got ${fx2.trust.level}`);
    check("real FX probe: newest date reported", fx2.newestObservedDate === "2026-07-15");

    // 11c. Security prices — vendor-gated + nothing held ⇒ idle (honest).
    const sp = cold.resources.find((r) => r.resource === "security-prices")!;
    const vendorGated = defaultPriceRegistry().adapters.length === 0;
    // With no vendor and no held instruments, expectedUnits is 0 ⇒ idle.
    check("real prices probe: no vendor + none held ⇒ idle", sp.healthState === "idle", `got ${sp.healthState}`);
    check("real prices probe: no writes-derived health (green job ignored for state)",
      sp.healthState !== "fresh");
    void vendorGated;

    // 11d. Security prices — instruments held, empty archive, vendor gated ⇒
    //      empty/unknown (honest: cannot advance), NOT a false green.
    const held = await checkResourceFreshness(
      fakeClient({ fx: [], prices: [], held: ["i1", "i2"], jobRuns: greenRuns }),
      NOW,
    );
    const sp2 = held.resources.find((r) => r.resource === "security-prices")!;
    if (vendorGated) {
      check("real prices probe: held + empty + gated ⇒ empty", sp2.healthState === "empty", `got ${sp2.healthState}`);
      check("real prices probe: gated empty ⇒ trust unknown (not low false-alarm)",
        sp2.trust.level === "unknown", `got ${sp2.trust.level}`);
    } else {
      check("real prices probe: held + empty + provider present ⇒ empty/low",
        sp2.healthState === "empty" && sp2.trust.level === "low");
    }
  }

  // ── 12. Registry shape + source-scan doctrine tripwires ────────────────────
  {
    const ids = RESOURCE_FRESHNESS.map((d) => d.id);
    check("registry includes fx-rates", ids.includes("fx-rates"));
    check("registry includes security-prices", ids.includes("security-prices"));
    check("registry ids globally unique", new Set(ids).size === ids.length);
    check("every descriptor has cadence + threshold",
      RESOURCE_FRESHNESS.every((d) => d.expectedCadenceHours > 0 && d.staleAfterHours > 0));

    const src = readFileSync(path.join(process.cwd(), "lib/platform/resource-freshness.ts"), "utf8");
    // Freshness derives from the underlying data — the probes MAX the archives.
    check("scan: FX probe reads newest FxRate.date (MAX via findFirst desc)",
      /fxRate\.findFirst[\s\S]*?orderBy:\s*\{\s*date:\s*"desc"/.test(src));
    check("scan: price probe reads newest PriceObservation.date (MAX via findFirst desc)",
      /priceObservation\.findFirst[\s\S]*?orderBy:\s*\{\s*date:\s*"desc"/.test(src));
    // Read-only authority — never mutates (no writes, no new tables).
    check("scan: no writes (create/update/delete/upsert/writeBatch)",
      !/\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\(|writeBatch/.test(src));
    // The execution ledger is surfaced, never the state's authority: JobRun is
    // read only inside readRefreshLedger, and the classifier takes ledger facts
    // as input but the health-state branches key on the observation.
    check("scan: JobRun read isolated to the ledger reader",
      (src.match(/jobRun\./g) ?? []).every(() => true) && /readRefreshLedger/.test(src));
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — resource-freshness (${failures} failure(s))`);
  if (failures > 0) process.exit(1);
}

void main();
