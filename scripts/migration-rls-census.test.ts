/**
 * scripts/migration-rls-census.test.ts  (Comms Center A-2a review)
 *
 * THE STATIC RLS CENSUS. The RLS acceptance suites (scripts/rls-acceptance.ts)
 * run only in CI, against a live throwaway database, and their census (cases
 * 35–37) looks only at tables GRANTED to fm_app — a new operator-only table
 * that silently lost its `ENABLE ROW LEVEL SECURITY` would pass them. This
 * test closes that hole without a database, in every `npm test`:
 *
 *   replay every prisma/migrations/<name>/migration.sql IN ORDER, tracking
 *     · tables: CREATE TABLE adds, DROP TABLE removes, ALTER TABLE … RENAME TO renames;
 *     · RLS:    ALTER TABLE "X" ENABLE / FORCE ROW LEVEL SECURITY (and DISABLE / NO FORCE),
 *               including the house loop form
 *                 FOREACH t IN ARRAY ARRAY['A', 'B'] LOOP … format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t) … END LOOP;
 *   then assert EVERY table that exists at the end is ENABLED and FORCED,
 *   except the closed EXCEPTIONS list below (which must stay exact).
 *
 * A table created after the RLS baseline whose migration forgets RLS — or a
 * later migration that DISABLEs it — fails here, naming the table.
 *
 *   npx tsx scripts/migration-rls-census.test.ts
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

/**
 * Tables that legitimately have no RLS. Each entry is a decision with a reason;
 * the list must be EXACT (an entry that now has RLS, or no longer exists, fails).
 */
export const RLS_EXCEPTIONS: Readonly<Record<string, string>> = {
  // The global REFERENCE data shared by every tenant by design — the same closed
  // set as REFERENCE_TABLES_WITHOUT_POLICY in scripts/rls-acceptance.ts (cases 35–37):
  // instruments, prices, corporate-action terms, FX and merchants carry no tenant.
  CorporateActionTerms: "global reference data (rls-acceptance REFERENCE_TABLES_WITHOUT_POLICY)",
  FxRate: "global reference data (rls-acceptance REFERENCE_TABLES_WITHOUT_POLICY)",
  Instrument: "global reference data (rls-acceptance REFERENCE_TABLES_WITHOUT_POLICY)",
  InstrumentAlias: "global reference data (rls-acceptance REFERENCE_TABLES_WITHOUT_POLICY)",
  Merchant: "global reference data (rls-acceptance REFERENCE_TABLES_WITHOUT_POLICY)",
  MerchantAlias: "global reference data (rls-acceptance REFERENCE_TABLES_WITHOUT_POLICY)",
  PriceObservation: "global reference data (rls-acceptance REFERENCE_TABLES_WITHOUT_POLICY)",
};

const strip = (sql: string) => sql.replace(/--[^\n]*/g, "");
const ident = /(?:public\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?/.source;

export interface RlsState { tables: Set<string>; enabled: Set<string>; forced: Set<string> }

/** Replay one migration's statements onto the state. Pure. */
export function applyMigration(state: RlsState, raw: string): void {
  const sql = strip(raw);
  // Loop form: the array names the tables the format() statements in its body touch.
  const loops: Array<{ start: number; end: number; tables: string[]; body: string }> = [];
  for (const m of sql.matchAll(/FOREACH\s+\w+\s+IN\s+ARRAY\s+ARRAY\s*\[([\s\S]*?)\]\s*LOOP([\s\S]*?)END\s+LOOP/gi)) {
    loops.push({ start: m.index!, end: m.index! + m[0].length, tables: [...m[1].matchAll(/'([A-Za-z_][A-Za-z0-9_]*)'/g)].map((x) => x[1]), body: m[2] });
  }
  type Ev = { at: number; apply: () => void };
  const events: Ev[] = [];
  const on = (re: RegExp, fn: (m: RegExpMatchArray) => void) => { for (const m of sql.matchAll(re)) events.push({ at: m.index!, apply: () => fn(m) }); };

  on(new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${ident}\\s*\\(`, "gi"), (m) => state.tables.add(m[1]));
  on(new RegExp(`DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${ident}`, "gi"), (m) => { state.tables.delete(m[1]); state.enabled.delete(m[1]); state.forced.delete(m[1]); });
  on(new RegExp(`ALTER\\s+TABLE\\s+(?:ONLY\\s+)?${ident}\\s+RENAME\\s+TO\\s+${ident}`, "gi"), (m) => {
    for (const s of [state.tables, state.enabled, state.forced]) if (s.delete(m[1])) s.add(m[2]);
  });
  on(new RegExp(`ALTER\\s+TABLE\\s+(?:ONLY\\s+)?${ident}\\s+(ENABLE|DISABLE|FORCE|NO\\s+FORCE)\\s+ROW\\s+LEVEL\\s+SECURITY`, "gi"), (m) => {
    const t = m[1]; const verb = m[2].toUpperCase().replace(/\s+/g, " ");
    if (verb === "ENABLE") state.enabled.add(t);
    else if (verb === "DISABLE") state.enabled.delete(t);
    else if (verb === "FORCE") state.forced.add(t);
    else state.forced.delete(t);
  });
  for (const loop of loops) {
    const verbs = [...loop.body.matchAll(/ALTER\s+TABLE\s+(?:public\.)?%I\s+(ENABLE|DISABLE|FORCE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY/gi)].map((m) => m[1].toUpperCase().replace(/\s+/g, " "));
    events.push({ at: loop.start, apply: () => {
      for (const t of loop.tables) for (const v of verbs) {
        if (v === "ENABLE") state.enabled.add(t);
        else if (v === "DISABLE") state.enabled.delete(t);
        else if (v === "FORCE") state.forced.add(t);
        else state.forced.delete(t);
      }
    } });
  }
  for (const e of events.sort((a, b) => a.at - b.at)) e.apply();
}

export function census(migrations: ReadonlyArray<string>): RlsState {
  const state: RlsState = { tables: new Set(), enabled: new Set(), forced: new Set() };
  for (const sql of migrations) applyMigration(state, sql);
  return state;
}

function main(): void {
  const dir = join(process.cwd(), "prisma", "migrations");
  const names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const files = names.map((n) => { try { return readFileSync(join(dir, n, "migration.sql"), "utf8"); } catch { return ""; } });
  const state = census(files);

  console.log("migration RLS census (static)");
  check(`the replay found a realistic number of tables (${state.tables.size})`, state.tables.size >= 70);
  const missing = [...state.tables].filter((t) => !(t in RLS_EXCEPTIONS) && !(state.enabled.has(t) && state.forced.has(t))).sort();
  check("every table the migrations leave behind has ROW LEVEL SECURITY ENABLED and FORCED",
    missing.length === 0, missing.map((t) => `${t}(enable=${state.enabled.has(t)},force=${state.forced.has(t)})`).join(", "));
  const stale = Object.keys(RLS_EXCEPTIONS).filter((t) => !state.tables.has(t) || (state.enabled.has(t) && state.forced.has(t)));
  check("the exception list is exact (no entry that has RLS or no longer exists)", stale.length === 0, stale.join(", "));
  const acceptance = readFileSync(join(process.cwd(), "scripts", "rls-acceptance.ts"), "utf8");
  const refList = /REFERENCE_TABLES_WITHOUT_POLICY = \[([\s\S]*?)\]/.exec(acceptance)?.[1] ?? "";
  check("the exceptions are exactly the acceptance suite's reference tables",
    [...refList.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]).sort().join() === Object.keys(RLS_EXCEPTIONS).sort().join());
  const models = [...readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf8").matchAll(/^model (\w+) \{/gm)].map((m) => m[1]);
  const unreplayed = models.filter((m) => !state.tables.has(m));
  check("every schema model is a table the replay knows (the parser misses nothing)", unreplayed.length === 0, unreplayed.join(", "));
  for (const t of ["CommsDelivery", "CommsDeliveryDaily", "BetaAccessRequestReview", "RateLimit"]) {
    check(`${t}: enabled + forced`, state.enabled.has(t) && state.forced.has(t));
  }

  console.log("the replay itself (self-test)");
  const s1 = census([`CREATE TABLE "A" (id text); CREATE TABLE "B" (id text);
    ALTER TABLE public."A" ENABLE ROW LEVEL SECURITY; ALTER TABLE public."A" FORCE ROW LEVEL SECURITY;`]);
  check("explicit form: A enabled+forced, B neither", s1.enabled.has("A") && s1.forced.has("A") && !s1.enabled.has("B"));
  const s2 = census([`CREATE TABLE "A" (id text);`, `DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['A'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t); END LOOP; END $$;`]);
  check("loop form counts", s2.enabled.has("A") && s2.forced.has("A"));
  const s3 = census([...files, `ALTER TABLE public."CommsDelivery" DISABLE ROW LEVEL SECURITY;`]);
  check("a later DISABLE on CommsDelivery is caught", !s3.enabled.has("CommsDelivery"));
  const commsMig = files[names.indexOf("20261031200000_comms_delivery_ledger")] ?? "";
  const withoutRls = files.map((f) => (f === commsMig ? f.replace(/ALTER TABLE public\."CommsDelivery" ENABLE ROW LEVEL SECURITY;/, "") : f));
  check("dropping CommsDelivery's ENABLE from its migration is caught", commsMig !== "" && !census(withoutRls).enabled.has("CommsDelivery"));
  check("a renamed table keeps its RLS; a dropped one leaves the census",
    (() => { const s = census([`CREATE TABLE "Old" (x int); ALTER TABLE "Old" ENABLE ROW LEVEL SECURITY; ALTER TABLE "Old" RENAME TO "New"; CREATE TABLE "Gone" (x int); DROP TABLE "Gone";`]); return s.enabled.has("New") && !s.tables.has("Gone") && s.tables.has("New"); })());
  check("comments are ignored (a commented-out ENABLE does not count)",
    !census([`CREATE TABLE "C" (x int); -- ALTER TABLE "C" ENABLE ROW LEVEL SECURITY;`]).enabled.has("C"));

  if (failures > 0) { console.error(`\n❌ migration RLS census: ${failures} check(s) failed`); process.exit(1); }
  console.log("\n✅ migration RLS census: all checks passed");
}

main();
