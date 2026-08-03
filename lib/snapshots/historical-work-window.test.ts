/**
 * lib/snapshots/historical-work-window.test.ts
 *
 * V26-ORCH-1 — the canonical historical-work planner, and the static guarantee
 * that the three migrated triggers no longer invent their own window.
 * Standalone tsx, pure (no DB).
 */

import { planHistoricalWorkWindow, type HistoricalWorkWindowInput } from "./historical-work-window.core";
import { readFileSync } from "node:fs";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** The shape of the wallet that motivated this slice. */
const WALLET: HistoricalWorkWindowInput = {
  evidenceFloorISO:      "2023-03-24", // earliest wallet transaction
  blockingPriceFloorISO: "2025-08-03", // provider price floor
  writableToISO:         "2026-08-02",
  recentFromISO:         "2026-07-03",
  initialBuild:          true,
  changeDetection:       "unavailable",
  impactedFromISO:       null,
};
const plan = (over: Partial<HistoricalWorkWindowInput> = {}) =>
  planHistoricalWorkWindow({ ...WALLET, ...over });

function main(): void {
  console.log("V26-ORCH-1 — historical work window planner\n");

  // 1 — a NEW wallet gets the full provider-supported window, not 30 days.
  {
    const p = plan();
    check("1. new wallet → full provider-supported interval",
      p.fromDate === "2025-08-03" && p.toDate === "2026-08-02", `${p.fromDate}..${p.toDate}`);
    check("1. …mode is initial-full", p.mode === "initial-full");
    check("1. …NOT the 30-day recent window", p.fromDate !== "2026-07-03");
    check("1. …and the binding constraint is named",
      p.reasons.some((r) => r.includes("provider prices reach only 2025-08-03")));
  }

  // 2 — a quiet refresh does NOT rebuild the year.
  {
    const p = plan({ initialBuild: false, changeDetection: "measured", impactedFromISO: null });
    check("2. measured, nothing changed → recent interval only",
      p.fromDate === "2026-07-03", p.fromDate);
    check("2. …and it says so rather than rebuilding",
      p.historicalWorkRequired === false && p.mode === "incremental");
  }

  // 3 — a newly discovered OLD transaction moves impactedFrom backward.
  {
    const p = plan({ initialBuild: false, changeDetection: "measured", impactedFromISO: "2026-02-01" });
    check("3. newly discovered old movement → rebuild from that date",
      p.fromDate === "2026-02-01" && p.mode === "incremental", p.fromDate);
    check("3. …and work IS required", p.historicalWorkRequired === true);
  }

  // 4 — a newly acquired price starts regeneration no later than that date.
  {
    const p = plan({ initialBuild: false, changeDetection: "measured", impactedFromISO: "2025-09-15" });
    check("4. newly acquired price → regeneration begins no later than it",
      p.fromDate <= "2025-09-15" && p.fromDate === "2025-09-15", p.fromDate);
  }

  // 5 — no change metadata falls back safely to the whole supportable interval.
  {
    const p = plan({ initialBuild: false, changeDetection: "unavailable" });
    check("5. unmeasurable change → fallback-full over the supportable interval",
      p.mode === "fallback-full" && p.fromDate === "2025-08-03", `${p.mode} ${p.fromDate}`);
    check("5. …impactedFrom is reported null, never invented",
      p.impactedFrom === null);
  }

  // 8 — nothing is ever planned before capability, evidence, or the ceiling.
  {
    check("8. never before the provider price floor",
      plan({ initialBuild: false, changeDetection: "measured", impactedFromISO: "2020-01-01" }).fromDate === "2025-08-03");
    const laterEvidence = plan({ evidenceFloorISO: "2026-01-01", blockingPriceFloorISO: "2025-08-03" });
    check("8. never before the evidence floor when evidence is the binding term",
      laterEvidence.fromDate === "2026-01-01", laterEvidence.fromDate);
    check("8. the floor is the MAX of the terms, never the MIN",
      plan({ evidenceFloorISO: "2024-01-01", blockingPriceFloorISO: "2025-08-03" }).fromDate === "2025-08-03");
  }

  // 12 — a provider-limited history is a BOUNDED interval, never an error.
  {
    const p = plan({ blockingPriceFloorISO: "2026-08-01" });
    check("12. tightly-limited provider → bounded window, no throw",
      p.fromDate === "2026-08-01" && p.toDate === "2026-08-02");
    const past = plan({ blockingPriceFloorISO: "2027-01-01" });
    check("12. floor after the ceiling → nothing to build, still no throw",
      past.fromDate === past.toDate && past.historicalWorkRequired === false);
  }

  // Unconstrained (cash-only / equity-only) sets are not bounded by prices.
  {
    const p = plan({ blockingPriceFloorISO: null });
    check("no blocking holding → evidence floor governs",
      p.fromDate === "2023-03-24", p.fromDate);
    check("…and the reason says prices do not bound it",
      p.reasons.some((r) => r.includes("no price-blocking holding")));
  }

  // No evidence at all → nothing deeper than the recent window exists.
  {
    const p = plan({ evidenceFloorISO: null, blockingPriceFloorISO: null });
    check("no evidence floor → recent window", p.fromDate === "2026-07-03");
  }

  // 10 — determinism: identical inputs ⇒ identical output (idempotent planning).
  check("10. identical inputs → identical plan",
    JSON.stringify(plan()) === JSON.stringify(plan()));

  // Reasons are always populated — a window is never unexplained.
  check("every mode explains itself",
    [plan(), plan({ initialBuild: false, changeDetection: "measured", impactedFromISO: "2026-01-01" }),
     plan({ initialBuild: false, changeDetection: "unavailable" })].every((p) => p.reasons.length > 0));

  // C — the API already accepts a widened capability without redesign.
  {
    const widened = plan({ blockingPriceFloorISO: "2023-08-03", initialBuild: false,
      changeDetection: "measured", impactedFromISO: "2023-08-03" });
    check("C. a widened capability floor needs no new parameter",
      widened.fromDate === "2023-08-03" && widened.providerFloor === "2023-08-03");
  }

  // ── 7 / PART 7 — STATIC GUARDS ────────────────────────────────────────────
  {
    console.log("\nstatic guards");
    const stripComments = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const wallet = stripComments(readFileSync("app/api/accounts/wallet/route.ts", "utf8"));
    const cron   = stripComments(readFileSync("jobs/sync-crypto.ts", "utf8"));
    const manual = stripComments(readFileSync("app/api/accounts/[id]/sync/route.ts", "utf8"));
    const plaid  = stripComments(readFileSync("lib/plaid/backgroundHistorySync.ts", "utf8"));

    for (const [name, src] of [["wallet connect", wallet], ["crypto cron", cron], ["manual sync", manual]] as const) {
      check(`${name} no longer builds history from recentWealthWindow`, !/recentWealthWindow/.test(src));
      check(`${name} routes through the canonical planner`, /resolveHistoricalWorkWindow/.test(src));
      check(`${name} hardcodes no 30-day rebuild`, !/\b30\b\s*\)?\s*;?\s*$/m.test(src) || !/setUTCDate/.test(src));
    }
    // 7 — Plaid is deliberately untouched by this slice.
    check("7. Plaid background-history path is unchanged (still maxAvailableWealthWindow)",
      /maxAvailableWealthWindow/.test(plaid) && !/resolveHistoricalWorkWindow/.test(plaid));

    // The planner must stay generic.
    const core = stripComments(readFileSync("lib/snapshots/historical-work-window.core.ts", "utf8"));
    check("planner names no asset, provider, ticker or user",
      !/BTC|bitcoin|coingecko|plaid|schwab|tiingo/i.test(core));
    const binding = stripComments(readFileSync("lib/snapshots/historical-work-window.ts", "utf8"));
    check("binding selects by ASSET CLASS, never by ticker or provider",
      /AssetClass\.CRYPTO/.test(binding) && !/tickerSymbol|"BTC"|coingecko/i.test(binding));
  }

  console.log(failures === 0 ? "\nAll historical-work-window guards passed." : `\n${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
