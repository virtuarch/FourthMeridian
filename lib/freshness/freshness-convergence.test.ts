/**
 * lib/freshness/freshness-convergence.test.ts   (V27-L1)
 *
 * STANDING source-scan probes. These are the guards the brief asks for, and
 * probe 1 is the one that would have caught the original defect: the Space header
 * reduced with a MAX under a comment stating the opposite intent, and nothing in
 * the suite disagreed.
 *
 * Repo-wide where it matters, not pinned to the file that happens to be wrong
 * today — a pinned probe only proves the file it names.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const src  = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
/** Comments stripped — a probe must assert on CODE, never on prose about code. */
const code = (rel: string) =>
  src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
}

/** Every tracked .ts/.tsx under the product directories. */
function walk(dir: string, out: string[] = []): string[] {
  const abs = path.join(ROOT, dir);
  let entries: string[];
  try { entries = readdirSync(abs); } catch { return out; }
  for (const e of entries) {
    if (e === "node_modules" || e === ".next" || e.startsWith(".")) continue;
    const rel = path.join(dir, e);
    const st = statSync(path.join(ROOT, rel));
    if (st.isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(rel);
  }
  return out;
}

// `prototype/` is an untracked local design harness — never a product invariant.
const FILES = [...walk("lib"), ...walk("components"), ...walk("app"), ...walk("jobs")]
  .filter((f) => !f.startsWith("prototype/") && !f.startsWith(path.join("app", "prototype")));

console.log(`Scanning ${FILES.length} source files\n`);

// ── 1. Freshness is never represented by the newest account ───────────────────

console.log("PROBE 1 — freshness is never a MAX across accounts");
{
  // A reducer that keeps the LATER of two freshness timestamps. This is the exact
  // shape of the defect (`a.lastUpdated > best ? a.lastUpdated : best`) and of the
  // BALANCE_ONLY aggregation bug found alongside it
  // (`if (a.lastUpdated > existing.lastUpdated)`).
  const MAX_SHAPES = [
    // ternary keep-the-newer, either operand order
    /(\w+)\.(lastUpdated|balanceLastUpdatedAt|observedAt)\s*>\s*[\w.]+\s*\?\s*\1\.\2\b/,
    // if-guard keep-the-newer
    /if\s*\(\s*(\w+)\.(lastUpdated|balanceLastUpdatedAt|observedAt)\s*>\s*([\w.]+)\s*\)\s*\3\s*=\s*\1\.\2/,
    // Math.max over a freshness field
    /Math\.max\([^)]*\.(lastUpdated|balanceLastUpdatedAt|observedAt)/,
    // sort ascending then take the LAST element
    /\.map\(\([^)]*\)\s*=>\s*[\w.]*\.(lastUpdated|balanceLastUpdatedAt)\)\.sort\(\)\.at\(-1\)/,
  ];
  const offenders: string[] = [];
  for (const f of FILES) {
    const c = code(f);
    for (const re of MAX_SHAPES) {
      if (re.test(c)) { offenders.push(`${f}  [${re.source.slice(0, 44)}…]`); break; }
    }
  }
  check("no MAX-over-accounts freshness reducer anywhere in the product tree",
    offenders.length === 0, offenders.join("\n      "));

  // …and the two known sites now keep the OLDER value.
  const privacy = code("lib/account-privacy.ts");
  check("normalizeSharedAccounts keeps the OLDEST member freshness",
    /if\s*\(\s*a\.lastUpdated\s*<\s*existing\.lastUpdated\s*\)/.test(privacy));
  const host = code("components/dashboard/SpaceDashboard.tsx");
  check("the Space header no longer reduces over lastUpdated at all",
    !/accounts\.reduce\([^)]*lastUpdated/.test(host));
  check("the Space header delegates to the freshness authority",
    host.includes("resolveSpaceFreshness("));
}

// ── 2. No Space-level claim hides stale material value ────────────────────────

console.log("\nPROBE 2 — the Space claim anchors on the oldest, and discloses the rest");
{
  const spaceFresh = code("lib/freshness/space-freshness.ts");
  check("the anchor is selected by an OLDEST comparison",
    /observedAt\s*<\s*oldest\.balance\.observedAt/.test(spaceFresh));
  check("stale VALUE (not just count) is computed", spaceFresh.includes("staleValue"));
  check("the value share reaches the rendered qualifier",
    spaceFresh.includes("% of value unverified"));
  // The header must publish the qualifier, not silently drop it.
  const host = code("components/dashboard/SpaceDashboard.tsx");
  check("the header publishes the qualifier alongside the age",
    host.includes("freshness?.qualifier") && host.includes("freshnessNote:"));
  const navbar = code("components/ui/ContextualNavbar.tsx");
  check("the chrome actually renders the qualifier", navbar.includes("identity.freshnessNote"));
}

// ── 3. Unknown provider freshness stays unknown ───────────────────────────────

console.log("\nPROBE 3 — unknown stays unknown");
{
  const obs = code("lib/freshness/observation.ts");
  check("an unobserved balance yields a null age, never a number",
    /observed === null \? null : ageInDays/.test(obs));
  check("UNKNOWN is not counted as a stale band",
    /band === "STALE" \|\| band === "VERY_STALE"/.test(obs));
  // The killer: nobody may substitute our write clock for the provider's.
  const substitution = FILES.filter((f) =>
    /balanceLastUpdatedAt\s*[:?]{0,2}\s*\?\?\s*[\w.]*lastUpdated/.test(code(f)) ||
    /balanceLastUpdatedAt\s*\|\|\s*[\w.]*lastUpdated/.test(code(f)),
  );
  check("no file falls back from balanceLastUpdatedAt to lastUpdated",
    substitution.length === 0, substitution.join(", "));
}

// ── 4. Provider timestamp and ingestion timestamp are never conflated ─────────

console.log("\nPROBE 4 — the two clocks are never conflated");
{
  const obs = code("lib/freshness/observation.ts");
  check("both instants are carried separately on every observation",
    obs.includes("ingestedAt:") && obs.includes("providerAttestedAt:"));
  check("the basis names which clock produced the reported instant",
    obs.includes('"PROVIDER_ATTESTED"') && obs.includes('"INGESTION"'));
  check("provider-after-ingestion is reported as contradictory, not silently taken",
    obs.includes("contradictory"));
  // Wording: "as of" (the institution's clock) is reserved for attested rows.
  check("'as of' wording is gated on PROVIDER_ATTESTED",
    /case "PROVIDER_ATTESTED":\s*return "Balances as of"/.test(obs) &&
    /case "INGESTION":\s*return "Last checked"/.test(obs));
  // The lens envelope no longer claims live balances "as of" a date.
  const envelope = code("lib/perspectives/envelope.ts");
  check("the lens envelope stopped claiming 'Live account balances, as of'",
    !envelope.includes("Live account balances"));
  // V27-L2 — the wording is now BASIS-GATED: "as of" only when every contributor
  // carries an institution timestamp, otherwise "checked".
  check("...and says what dataAsOf actually is",
    envelope.includes("Oldest balance checked") && envelope.includes("Oldest balance as of"));
  check("...gated on the resolved basis, not assumed",
    /dataAsOfBasis === "PROVIDER_ATTESTED"/.test(envelope));
}

// ── 5. Every current balance claim can expose account-level freshness ─────────

console.log("\nPROBE 5 — a balance and its freshness travel together");
{
  const detailRoute = code("app/api/spaces/[id]/accounts/detail/route.ts");
  check("the account detail read carries per-account freshness",
    /freshness:\s+AccountFreshness/.test(src("app/api/spaces/[id]/accounts/detail/route.ts")));
  check("...resolved through the authority, not hand-rolled",
    detailRoute.includes("resolveAccountFreshness("));
  check("...with ONE clock for the whole response",
    (detailRoute.match(/const now = new Date\(\)/g) ?? []).length === 1);

  const detailPanel = code("components/space/widgets/accounts/AccountDetail.tsx");
  check("the account panel renders the basis-aware label",
    detailPanel.includes("accountBalanceClaimLabel("));
  check("the account panel renders the caveat when our clock is all we have",
    detailPanel.includes("balanceBasisCaveat("));
  check("the panel no longer asserts 'Balance is current'",
    !detailPanel.includes("Balance is current"));

  // The shared Space account shape must carry the provider clock, or no surface
  // downstream can ever distinguish the two.
  const dashTypes = code("lib/space/dashboard-types.ts");
  check("SpaceAccount carries balanceLastUpdatedAt", dashTypes.includes("balanceLastUpdatedAt"));
  const mount = code("lib/space/mount-composition.ts");
  check("the accounts loader selects it", mount.includes("balanceLastUpdatedAt: true"));

  // The AI payload states a resolved basis rather than leaving a model to guess.
  const aiAssembler = code("lib/ai/assemblers/accounts.ts");
  check("the AI accounts payload carries a resolved freshness claim",
    aiAssembler.includes("balanceFreshness:"));
  check("...at BOTH visibility tiers",
    (aiAssembler.match(/balanceFreshness:\s*freshnessFact\(/g) ?? []).length === 2);
}

// ── 6. The clock is always explicit ──────────────────────────────────────────

console.log("\nPROBE 6 — no ambient clock inside the authority");
{
  const obs = code("lib/freshness/observation.ts");
  const spaceFresh = code("lib/freshness/space-freshness.ts");
  check("observation.ts never reads the wall clock", !/new Date\(\)/.test(obs));
  check("space-freshness.ts never reads the wall clock", !/new Date\(\)/.test(spaceFresh));
  // Required, not optional-with-a-default: an injected clock production never
  // passes is the defect, not the safeguard.
  check("resolveAccountFreshness takes a REQUIRED now",
    /export function resolveAccountFreshness\(\s*input: AccountFreshnessInput,\s*now: Date,\s*\)/.test(obs));
  check("resolveSpaceFreshness takes a REQUIRED now",
    /export function resolveSpaceFreshness\(\s*inputs: AccountFreshnessInput\[\],\s*now: Date,\s*\)/.test(spaceFresh));
  // summarizeSpaceFreshness deliberately takes NO clock — it consumes ages that
  // were already resolved, and a second clock would let the summary disagree with
  // its own members.
  check("summarizeSpaceFreshness accepts no second clock",
    /export function summarizeSpaceFreshness\(\s*accounts: AccountFreshness\[\],\s*\)/.test(spaceFresh));
}

// ── 7. No financial arithmetic moved into React ──────────────────────────────

console.log("\nPROBE 7 — surfaces format, they do not derive");
{
  const host = code("components/dashboard/SpaceDashboard.tsx");
  check("the header does no age arithmetic of its own",
    !/86_?400_?000/.test(host) && !/getTime\(\)/.test(host));
  const detailPanel = code("components/space/widgets/accounts/AccountDetail.tsx");
  check("the account panel does no age arithmetic of its own",
    !/86_?400_?000/.test(detailPanel) && !/getTime\(\)/.test(detailPanel));
}

// ── 8. Read-only slice: no schema, no writes ─────────────────────────────────

console.log("\nPROBE 8 — the freshness authority writes nothing");
{
  for (const f of ["lib/freshness/observation.ts", "lib/freshness/space-freshness.ts"]) {
    const c = code(f);
    check(`${path.basename(f)} touches no database`,
      !c.includes("@/lib/db") && !/prisma|\.update\(|\.create\(|\.upsert\(/.test(c));
  }
}

if (failures > 0) { console.error(`\nfreshness-convergence: ${failures} failure(s).`); process.exit(1); }
console.log("\nfreshness-convergence: all passed.");
