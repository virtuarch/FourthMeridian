/**
 * components/space/shell/asof-rolling.test.ts  (v2.7 — rolling "today" + Debt as-of cache)
 *
 * Owner report (Preview, 04:20 Kuwait = 01:20 UTC): Debt said "Updating…" on
 * every toggle. Root cause: the shell wrote the rolling As Of (= today) into the
 * URL (?asof=2026-10-27); after UTC midnight a reload hydrated that as a PAST
 * date, so Debt (the only workspace with its own per-mount as-of fetch, whose
 * result died with the workspace) refetched on every return.
 *
 *   1. serialize: a rolling As Of is omitted (and a derivable preset's derived
 *      boundary); explicit past dates + CUSTOM Compare To are kept (shared links);
 *   2. the Kuwait rollover: a URL written at 23:00 Kuwait hydrates to the NEW
 *      UTC day at 04:20 Kuwait — not a historical view; a fixed link still pins;
 *   3. an open page rolls a rolling state at UTC midnight; explicit dates stay;
 *      identity when nothing rolls (no state/URL loop);
 *   4. the midnight timer;
 *   5. the Debt as-of cache: keyed by Space · date · currency · data revision,
 *      bounded, success-only, cleared on data-change events, cached ⇒ no
 *      "Updating…", uncached ⇒ the loading state remains;
 *   6. no financial / snapshot code touched.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/space/shell/asof-rolling.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  serializeShellTimeState, hydrateShellTimeState, rollShellTimeStateToToday,
  resolvePerspectiveTimeRange, type PerspectiveTimeState,
} from "@/lib/perspectives/time-range";
import { todayUTCISO } from "@/lib/time/clock";
import { msUntilNextUtcMidnight } from "./useUtcToday";
import { __debtAsOfLensCache as C, __resetDebtAsOfLensCache } from "@/components/space/widgets/debt/useDebtSpaceData";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const code = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const COVER = "2025-01-01";
const month = (asOf: string): PerspectiveTimeState => resolvePerspectiveTimeRange({ preset: "PAST_MONTH", asOf, coverageFrom: COVER });

console.log("1. serialize — rolling vs explicit");
{
  const t = "2026-10-27";
  const rolling = serializeShellTimeState(month(t), t);
  check("rolling 1M: no asof, no derived compareto, preset kept", rolling.asOf === null && rolling.compareTo === null && rolling.preset === "PAST_MONTH", JSON.stringify(rolling));
  const past = serializeShellTimeState(month("2026-09-30"), t);
  check("explicit past date: asof + compareto written verbatim", past.asOf === "2026-09-30" && past.compareTo === month("2026-09-30").compareTo);
  const custom = serializeShellTimeState({ preset: "CUSTOM", asOf: t, compareTo: "2026-06-30" }, t);
  check("CUSTOM ending today: asof omitted, the chosen Compare To kept", custom.asOf === null && custom.compareTo === "2026-06-30" && custom.preset === "custom");
  check("no today given ⇒ legacy behaviour (asof written)", serializeShellTimeState(month(t)).asOf === t);
  const ctx = { today: t, coverageFrom: COVER };
  const cases = [month(t), month("2026-09-30"), { preset: "CUSTOM", asOf: t, compareTo: "2026-06-30" } as PerspectiveTimeState, { preset: "CUSTOM", asOf: "2026-08-01", compareTo: null } as PerspectiveTimeState];
  check("serialize(today) → hydrate is identity for rolling AND explicit states",
    cases.every((s) => JSON.stringify(hydrateShellTimeState(serializeShellTimeState(s, t), ctx)) === JSON.stringify(s)));
}

console.log("\n2. the Kuwait (UTC+3) rollover");
{
  const opened = new Date("2026-10-27T20:00:00Z");   // 23:00 Kuwait, Oct 27
  const later  = new Date("2026-10-28T01:20:00Z");   // 04:20 Kuwait, Oct 28
  const tOpen = todayUTCISO(opened), tLater = todayUTCISO(later);
  check("UTC days: 2026-10-27 then 2026-10-28", tOpen === "2026-10-27" && tLater === "2026-10-28");
  const url = serializeShellTimeState(month(tOpen), tOpen);
  const reloaded = hydrateShellTimeState(url, { today: tLater, coverageFrom: COVER });
  check("reload at 04:20 Kuwait follows the NEW day (asOf = today ⇒ not historical)", reloaded.asOf === tLater && reloaded.asOf >= tLater, JSON.stringify(reloaded));
  check("…with the 1M boundary re-derived from the new day", reloaded.compareTo === month(tLater).compareTo);
  const shared = hydrateShellTimeState({ asOf: "2026-10-27", preset: "PAST_MONTH", compareTo: null }, { today: tLater, coverageFrom: COVER });
  check("a link with an EXPLICIT asof still pins that date (shared links preserved)", shared.asOf === "2026-10-27");
}

console.log("\n3. an open page rolls at UTC midnight");
{
  const ctx = { today: "2026-10-28", coverageFrom: COVER };
  const s = month("2026-10-27");
  const rolled = rollShellTimeStateToToday(s, "2026-10-27", ctx);
  check("rolling derivable preset → new anchor + re-derived boundary", JSON.stringify(rolled) === JSON.stringify(month("2026-10-28")), JSON.stringify(rolled));
  const explicit = month("2026-09-30");
  check("explicit past date is never moved (same object)", rollShellTimeStateToToday(explicit, "2026-10-27", ctx) === explicit);
  const custom: PerspectiveTimeState = { preset: "CUSTOM", asOf: "2026-10-27", compareTo: "2026-06-30" };
  const rc = rollShellTimeStateToToday(custom, "2026-10-27", ctx);
  check("CUSTOM rolling end moves; its chosen Compare To stays", rc.asOf === "2026-10-28" && rc.compareTo === "2026-06-30");
  check("same day ⇒ identity (setState no-op ⇒ no state/URL loop)", rollShellTimeStateToToday(s, "2026-10-28", { ...ctx, today: "2026-10-28" }) === s
    && rollShellTimeStateToToday(s, "2026-10-27", { ...ctx, today: "2026-10-27" }) === s);
  const hook = code("components/space/shell/usePerspectiveShellState.ts");
  check("the shell rolls on a today change with REPLACE intent", /rollShellTimeStateToToday\(s, prev,/.test(hook) && /historyIntent\.current = "replace";\s*setState\(\(s\) => rollShellTimeStateToToday/.test(hook));
  check("the shell serializes with today (rolling As Of never hits the URL)", /serializeShellTimeState\(state, ctxRef\.current\.today\)/.test(hook));
  check("SpaceDashboard uses the LIVE UTC today (no once-per-mount memo)", /const shellToday = useUtcToday\(\);/.test(code("components/dashboard/SpaceDashboard.tsx")));
  const ut = code("components/space/shell/useUtcToday.ts");
  check("useUtcToday re-arms at each midnight and re-checks on focus/visibility", /arm\(\);/.test(ut) && /visibilitychange/.test(ut) && /"focus"/.test(ut) && /t === prev \? prev : t/.test(ut));
}

console.log("\n4. the midnight timer");
check("21:00Z (00:00 Kuwait) → 3h + 250ms to the UTC boundary", msUntilNextUtcMidnight(new Date("2026-10-27T21:00:00Z")) === 3 * 3600_000 + 250);
check("23:59:59.900Z → 350ms", msUntilNextUtcMidnight(new Date("2026-10-27T23:59:59.900Z")) === 350);
check("exactly midnight → a full day + 250ms (never 0 ⇒ no tight loop)", msUntilNextUtcMidnight(new Date("2026-10-28T00:00:00Z")) === 86_400_000 + 250);

console.log("\n5. the Debt as-of cache");
{
  __resetDebtAsOfLensCache();
  const k = C.key("sp1", "2026-10-27", "EUR", "2026-10-28T01:00:00Z");
  check("key carries Space · date · currency · data revision", k === "sp1|2026-10-27|EUR|2026-10-28T01:00:00Z");
  check("a new data revision is a different key (stale lens never reused)", C.key("sp1", "2026-10-27", "EUR", "rev2") !== k);
  C.remember(k, { lensId: "debt" } as never);
  check("remember → peek", (C.peek(k) as { lensId: string } | undefined)?.lensId === "debt");
  for (let i = 0; i < C.max + 5; i++) C.remember(C.key("sp", `d${i}`, undefined, ""), null);
  check(`bounded to ${C.max} entries (LRU)`, C.size() === C.max && C.peek(k) === undefined);
  const hook = code("components/space/widgets/debt/useDebtSpaceData.ts");
  check("errors are never cached (only the success path remembers)", /rememberLens\(key, d\.lens \?\? null\);/.test(hook) && !/catch\([^)]*\)\s*=>\s*\{[^}]*rememberLens/.test(hook));
  check("the cache empties on account change / data refresh / currency change",
    /addEventListener\(SPACE_ACCOUNTS_CHANGED_EVENT, clear\)/.test(hook) && /addEventListener\(SPACE_DATA_REFRESHED_EVENT, clear\)/.test(hook) && /addEventListener\(SPACE_CURRENCY_CHANGED_EVENT, clear\)/.test(hook));
  check("cached ⇒ shown at once (state seeded from the cache)", /useState<LensResult \| null>\(\(\) => AS_OF_LENS_CACHE\.get\(key\) \?\? null\)/.test(hook));
  check("uncached ⇒ the loading state remains (Updating… only while no lens)", /loading: loading && historical && asOfLens === null/.test(hook));
  check("a cached lens is still revalidated on mount (fetch effect keyed on the key)", /\[spaceId, asOf, historical, targetCurrency, nonce, key\]/.test(hook));
  check("a date/currency change adopts that key's entry during render (no previous-date flash)", /if \(key !== prevKey\) \{\s*setPrevKey\(key\);\s*setAsOfLens\(AS_OF_LENS_CACHE\.get\(key\) \?\? null\);/.test(hook));
}

console.log("\n6. presentation / URL only — no financial or snapshot code");
{
  const files = ["lib/perspectives/time-range.ts", "components/space/shell/usePerspectiveShellState.ts", "components/space/shell/useUtcToday.ts", "components/space/widgets/debt/useDebtSpaceData.ts"];
  check("none of the patched files import lib/balances, lib/snapshots, lib/debt or the engines",
    files.every((f) => !/from "@\/lib\/(balances|snapshots|debt\/|perspective-engine\/lenses)/.test(code(f))));
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
