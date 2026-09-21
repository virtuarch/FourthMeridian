/**
 * components/space/shell/space-history.test.ts
 *
 * Standalone tsx, exits 0/1.   npx tsx components/space/shell/space-history.test.ts
 *
 * THE SPACE'S BROWSER-HISTORY CONTRACT, run against the REAL hooks — the
 * navigation authority (useSpaceNavigation) and the time shell
 * (usePerspectiveShellState), both writing through the real useSpaceUrl — on a
 * faithful model of window.history / location / popstate AND of Next 16's
 * app-router patch (node_modules/next/dist/client/components/app-router.js):
 *
 *   • a write whose state carries `__NA` is treated as Next's own — raw write,
 *     router NOT synced;
 *   • any other write gets Next's `__NA` copied in and SYNCS the router's
 *     canonical URL (ACTION_RESTORE);
 *   • on its next commit Next's HistoryUpdater replaceState()s the entry to the
 *     router's canonical URL (`nextCommit()` below).
 *
 * The contract (declared intent, never inferred):
 *   workspace / rail-tab NAVIGATION by the user → PUSH
 *   a workspace's own VIEW (Net Worth mode + slice, Markets view) → REPLACE
 *   parent click = open that workspace on its DEFAULT view: PUSH if a different
 *     workspace, REPLACE if it is already open
 *   user TIME change → PUSH (SD-0A, unchanged); SYSTEM writes (hydration,
 *     canonicalization, popstate) → REPLACE / no write
 *
 * The React root runs on a stub container (the repo has no DOM environment):
 * the harness renders null, so only hooks + effects execute — exactly the code
 * under test.
 */

import { createElement, act, useEffect } from "react";
import { getPerspectivesForCategory } from "@/lib/perspectives";

// ── a faithful History + Location model ─────────────────────────────────────
type Entry = { url: string; state: Record<string, unknown> | null };
const listeners = new Map<string, Set<(e: unknown) => void>>();
const g = globalThis as unknown as Record<string, unknown>;
const doc = { nodeType: 9, activeElement: null, addEventListener() {}, removeEventListener() {}, documentElement: {} };
g.document = doc;
g.window = globalThis;
g.HTMLIFrameElement = class {};
g.IS_REACT_ACT_ENVIRONMENT = true;
g.addEventListener = (t: string, fn: (e: unknown) => void) => { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t)!.add(fn); };
g.removeEventListener = (t: string, fn: (e: unknown) => void) => listeners.get(t)?.delete(fn);

const BASE = "http://localhost";
let entries: Entry[] = [];
let index = 0;
let canonicalUrl = "";            // Next's router canonical URL
const writes: string[] = [];      // every write, for the pollution assertions
const cur = () => new URL(entries[index].url, BASE);
Object.defineProperty(g, "location", {
  configurable: true,
  get: () => { const u = cur(); return { pathname: u.pathname, search: u.search, href: u.href }; },
});
const rawPush = (state: Entry["state"], url: string) => { entries = entries.slice(0, index + 1); entries.push({ url, state }); index = entries.length - 1; };
const rawReplace = (state: Entry["state"], url: string) => { entries[index] = { url, state }; };
const rel = (u: string) => { const x = new URL(u, BASE); return x.pathname + x.search; };
// Next 16's patched functions (the shape of app-router.js's useEffect patch).
const history = {
  get length() { return entries.length; },
  get state() { return entries[index].state; },
  pushState(data: Entry["state"], _t: string, url: string) {
    writes.push(`push ${rel(url)}`);
    if (data?.__NA) return rawPush(data, rel(url));          // "Next's own" — no router sync
    const copied = { ...(data ?? {}), __NA: true };
    canonicalUrl = rel(url);                                  // ACTION_RESTORE
    rawPush(copied, rel(url));
  },
  replaceState(data: Entry["state"], _t: string, url: string) {
    writes.push(`replace ${rel(url)}`);
    if (data?.__NA) return rawReplace(data, rel(url));
    const copied = { ...(data ?? {}), __NA: true };
    canonicalUrl = rel(url);
    rawReplace(copied, rel(url));
  },
  back() { go(-1); },
  forward() { go(1); },
};
g.history = history;
/** Next's HistoryUpdater: on any router commit, the entry is rewritten to the router's canonical URL. */
function nextCommit() { entries[index] = { url: canonicalUrl, state: { __NA: true } }; }
function go(delta: number) {
  const target = index + delta;
  if (target < 0 || target >= entries.length) throw new Error(`history.go(${delta}) leaves the document (index ${index}, length ${entries.length})`);
  index = target;
  canonicalUrl = entries[index].url;                         // Next's traverse restores the router to this URL
  for (const fn of listeners.get("popstate") ?? []) fn({ state: entries[index].state });
}

async function main(): Promise<void> {
// ── the harness: the host's composition of the two URL writers ───────────────
const { createRoot } = await import("react-dom/client");
const { useSpaceNavigation, openWorkspaceId, openChildId, lensHref, marketsModeHref, wealthModeHref, NET_WORTH_LENS_ID } =
  await import("@/lib/space/use-space-navigation");
const { usePerspectiveShellState } = await import("@/components/space/shell/usePerspectiveShellState");

type Nav = ReturnType<typeof useSpaceNavigation>;
type Shell = ReturnType<typeof usePerspectiveShellState>;
let nav!: Nav; let shell!: Shell;
const PERSONAL = getPerspectivesForCategory("PERSONAL").map((p) => p.id);
function Harness() {
  nav = useSpaceNavigation({ category: "PERSONAL", availablePerspectives: PERSONAL });
  shell = usePerspectiveShellState({ spaceId: "space-1", today: "2026-09-21", earliestDefensibleDate: "2024-01-01" });
  const { applyInitialTab } = nav;
  useEffect(() => { applyInitialTab([]); }, [applyInitialTab]); // the host calls this when data lands
  return null;
}

let root: ReturnType<typeof createRoot> | null = null;
/** A fresh document load at `url`, preceded by one foreign entry (where Back must NOT go). */
async function load(url: string) {
  if (root) await act(async () => root!.unmount());
  entries = [{ url: "/dashboard/spaces", state: { __NA: true } }, { url, state: { __NA: true } }];
  index = 1; canonicalUrl = url; writes.length = 0;
  const container = { nodeType: 1, nodeName: "DIV", tagName: "DIV", ownerDocument: doc, addEventListener() {}, removeEventListener() {}, childNodes: [], firstChild: null, appendChild() {}, removeChild() {} };
  root = createRoot(container as never);
  await act(async () => root!.render(createElement(Harness)));
  writes.length = 0; // hydration/canonicalization writes are asserted separately
}
const step = async (fn: () => void) => { await act(async () => fn()); };
const back = () => step(() => history.back());
const forward = () => step(() => history.forward());

/** The UI as the page renders it — sidebar parent + child, derived from state. */
function where(): string {
  const ws = openWorkspaceId(nav.activeTab, nav.activePerspectiveId);
  const child = openChildId(ws, { wealthMode: nav.wealthMode, marketsMode: nav.marketsMode });
  const name = ws === NET_WORTH_LENS_ID ? "Net Worth" : ws === "cashFlow" ? "Cash Flow" : ws === "markets" ? "Markets" : String(ws);
  return child ? `${name}/${child}` : name;
}
/** The URL, reduced to the navigation params (time params asserted separately). */
function url(): string {
  const p = cur().searchParams;
  return ["tab", "perspective", "metric", "slice", "view"].filter((k) => p.has(k)).map((k) => `${k}=${p.get(k)}`).join("&");
}
// user actions, wired exactly as the host wires them
const parent = (id: string) => step(() => nav.openWorkspaceDefault(id));                   // sidebar parent click
const netWorthMode = (m: "total" | "assets" | "debt") => step(() => nav.setWealthMode(m));  // sidebar child / content row
const marketsView = (m: "portfolio" | "research" | "fundamentals" | "technicals" | "watchlist") => step(() => nav.setMarketsMode(m));
const lensChip = (id: string) => step(() => nav.selectLens(id));                           // mobile lens row
const railTab = (id: string) => step(() => { if (id === "OVERVIEW") nav.setSelectedPerspectiveId(null); nav.setActiveTab(id); });

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const pushes = () => writes.filter((w) => w.startsWith("push")).length;

// ─────────────────────────────────────────────────────────────────────────────
console.log("0. Next integration — Space writes SYNC Next's router (no __NA pass-through)");
{
  await load("/dashboard?tab=overview");
  check("load: the page's own entry plus the foreign one before it", history.length === 2 && where() === "Net Worth/total");
  await parent("cashFlow");
  check("after a Space write, Next's canonical URL IS the Space URL", canonicalUrl === rel(cur().href), `${canonicalUrl} vs ${rel(cur().href)}`);
  const before = cur().href;
  nextCommit(); // Next re-commits its router state (a transition, a prefetch, HMR…)
  check("…so Next's HistoryUpdater rewrite is a no-op — the Cash Flow URL survives", cur().href === before && url() === "tab=overview&perspective=cash-flow", url());
  check("entries carry Next's __NA (copied in by its patch), so Next can traverse them", entries.slice(1).every((e) => e.state?.__NA === true));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("1–3. Workspace navigation PUSHES — including the FIRST action after a load");
{
  await load("/dashboard?tab=overview");
  await parent("cashFlow");
  check("1. Net Worth → Cash Flow: a new entry (first action after a fresh load)", history.length === 3 && pushes() === 1, `len ${history.length} ${writes.join(" | ")}`);
  await back();
  check("…Back returns to Net Worth (not out of the app)", where() === "Net Worth/total" && url() === "tab=overview", `${where()} ${url()}`);

  await load("/dashboard?tab=overview");
  await parent("markets");
  check("2. Net Worth → Markets: a new entry", history.length === 3 && where() === "Markets/portfolio");
  await back();
  check("…Back → Net Worth", where() === "Net Worth/total");

  await load("/dashboard?tab=overview");
  await parent("cashFlow"); await parent("markets");
  await back();  check("3. N→C→M, Back → Cash Flow", where() === "Cash Flow", where());
  await back();  check("   Back → Net Worth", where() === "Net Worth/total", where());
  await forward(); check("   Forward → Cash Flow", where() === "Cash Flow", where());
  await forward(); check("   Forward → Markets", where() === "Markets/portfolio", where());
  check("   exactly two navigation entries were created", history.length === 4);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("4–6. Net Worth modes REPLACE (refine the entry)");
{
  await load("/dashboard?tab=overview");
  await netWorthMode("assets");
  check("4. Total → Assets: no new entry, URL metric=assets", history.length === 2 && pushes() === 0 && url() === "tab=overview&metric=assets", url());
  await netWorthMode("debt");
  check("5. Assets → Debt: no new entry, metric=debt", history.length === 2 && pushes() === 0 && url() === "tab=overview&metric=debt", url());
  await netWorthMode("assets");
  await parent("cashFlow");
  await back();
  check("6. Net Worth/Assets → Cash Flow → Back ⇒ Net Worth/Assets", where() === "Net Worth/assets" && url() === "tab=overview&metric=assets", `${where()} ${url()}`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("7–9. Markets views REPLACE");
{
  await load("/dashboard?tab=overview&perspective=markets");
  check("load Markets ⇒ Portfolio, no view param", where() === "Markets/portfolio" && url() === "tab=overview&perspective=markets");
  await marketsView("fundamentals");
  check("7. Portfolio → Fundamentals: no new entry", history.length === 2 && pushes() === 0 && url().endsWith("view=fundamentals"), url());
  await marketsView("technicals");
  check("8. Fundamentals → Technicals: no new entry", history.length === 2 && pushes() === 0 && url().endsWith("view=technicals"));
  await marketsView("fundamentals");
  await parent("cashFlow");
  await back();
  check("9. Markets/Fundamentals → Cash Flow → Back ⇒ Markets/Fundamentals", where() === "Markets/fundamentals", where());
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("10. Composed — views refine, workspaces navigate");
{
  await load("/dashboard?tab=overview");
  await netWorthMode("assets");
  await parent("cashFlow");
  await parent("markets");
  await marketsView("fundamentals");
  await marketsView("technicals");
  check("NW/Assets → CF → Markets → Fundamentals → Technicals = exactly TWO new entries", history.length === 4 && pushes() === 2, `${history.length} ${writes.join(" | ")}`);
  await back();    check("Back → Cash Flow", where() === "Cash Flow", where());
  await back();    check("Back → Net Worth/Assets", where() === "Net Worth/assets", where());
  await forward(); check("Forward → Cash Flow", where() === "Cash Flow", where());
  await forward(); check("Forward → Markets/Technicals (the entry holds the LATEST view)", where() === "Markets/technicals" && url().endsWith("view=technicals"), `${where()} ${url()}`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("11–12. Direct loads");
{
  await load("/dashboard?tab=overview&perspective=markets&view=technicals");
  check("direct load Markets/Technicals restores it", where() === "Markets/technicals");
  await parent("cashFlow"); await back();
  check("11. → Cash Flow → Back ⇒ Markets/Technicals", where() === "Markets/technicals" && url() === "tab=overview&perspective=markets&view=technicals", url());

  await load("/dashboard?tab=overview&metric=debt");
  check("direct load Net Worth/Debt restores it", where() === "Net Worth/debt");
  await parent("markets"); await back();
  check("12. → Markets → Back ⇒ Net Worth/Debt", where() === "Net Worth/debt" && url() === "tab=overview&metric=debt", url());
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("13–14. Default parents — the destination actually selected");
{
  await load("/dashboard?tab=overview&metric=debt");
  await parent("cashFlow");
  await parent(NET_WORTH_LENS_ID);
  check("13. NW/Debt → CF → Net Worth parent ⇒ Net Worth/Total (not the old Debt)", where() === "Net Worth/total" && !cur().searchParams.has("metric"), `${where()} ${url()}`);
  check("    one push per navigation, and the source entry was never rewritten", pushes() === 2 && !writes.some((w) => w.startsWith("replace")), writes.join(" | "));
  await back();
  check("    Back → Cash Flow", where() === "Cash Flow", where());

  await load("/dashboard?tab=overview&perspective=markets&view=watchlist");
  await parent("cashFlow");
  await parent("markets");
  check("14. Markets/Watchlist → CF → Markets parent ⇒ Markets/Portfolio", where() === "Markets/portfolio" && !cur().searchParams.has("view"), `${where()} ${url()}`);
  await back();
  check("    Back → Cash Flow", where() === "Cash Flow");

  await load("/dashboard?tab=overview&metric=debt");
  await parent(NET_WORTH_LENS_ID);
  check("re-clicking the OPEN workspace's parent resets its view IN PLACE (replace, no entry)",
    where() === "Net Worth/total" && history.length === 2 && pushes() === 0, `${where()} ${writes.join(" | ")}`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("15. Popstate — the URL is the authority; traversal never writes");
{
  await load("/dashboard?tab=overview");
  await netWorthMode("assets"); await parent("cashFlow"); await parent("markets"); await marketsView("research");
  writes.length = 0;
  await back(); await back(); await forward(); await forward();
  check("Back/Forward create or rewrite NO entry", writes.length === 0 && history.length === 4, writes.join(" | "));
  check("…and land on the entry's state (Markets/Research)", where() === "Markets/research");
  await back(); await back();
  check("state rebuilt from the URL: workspace + mode + lens chip (mobile) agree",
    where() === "Net Worth/assets" && nav.activeLensId === NET_WORTH_LENS_ID && nav.activePerspectiveId === "wealth");
  await forward();
  check("…Cash Flow: lens chip = cashFlow, no child", where() === "Cash Flow" && nav.activeLensId === "cashFlow");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("Other user navigation — mobile lens chips and rail tabs follow the same contract");
{
  await load("/dashboard?tab=overview");
  await lensChip("cashFlow");
  check("mobile lens chip Net Worth → Cash Flow PUSHES", history.length === 3 && where() === "Cash Flow");
  await railTab("ACCOUNTS");
  check("rail tab → Accounts PUSHES", history.length === 4 && nav.activeTab === "ACCOUNTS");
  await back();
  check("Back → Cash Flow", nav.activeTab === "OVERVIEW" && where() === "Cash Flow");
  await lensChip("cashFlow");
  check("selecting what is already open writes nothing", pushes() === 2 && history.length === 4);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("System writes REPLACE — canonicalization is not navigation");
{
  // load() clears writes AFTER mount, so look at the entry count instead.
  await load("/dashboard?tab=overview&perspective=markets&view=garbage&metric=netWorth");
  check("an invalid view canonicalizes in place (no entry): view dropped", history.length === 2 && where() === "Markets/portfolio" && !cur().searchParams.has("view"), url());
  await load("/dashboard?tab=overview&perspective=investments");
  check("a legacy peer-lens link canonicalizes in place to Net Worth/Assets", history.length === 2 && where() === "Net Worth/assets" && url() === "tab=overview&metric=assets&slice=investments", url());
  await load("/dashboard");
  check("a bare /dashboard gains ?tab=overview by REPLACE, not a duplicate entry", history.length === 2 && url() === "tab=overview");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("Time (SD-0A, unchanged): a user time change pushes, a system re-derivation does not");
{
  await load("/dashboard?tab=overview&asof=2026-09-21&compareto=2026-08-21&preset=PAST_MONTH");
  await step(() => shell.actions.selectPreset("YTD"));
  check("the FIRST user time change after a canonical load pushes (the old first-write rule replaced it)", history.length === 3 && pushes() === 1, writes.join(" | "));
  await back();
  check("…Back restores the previous slice", cur().searchParams.get("preset") === "PAST_MONTH" && shell.state.preset === "PAST_MONTH");
  writes.length = 0;
  await step(() => shell.actions.selectPreset("PAST_MONTH"));
  check("re-selecting the current slice writes nothing", writes.length === 0);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("16–17. Links — canonical hrefs for new-tab / modified clicks");
{
  check("16. parent hrefs = the default views", lensHref(NET_WORTH_LENS_ID) === "/dashboard?tab=overview" && lensHref("markets") === "/dashboard?tab=overview&perspective=markets" && lensHref("cashFlow") === "/dashboard?tab=overview&perspective=cash-flow");
  check("    child hrefs = the canonical view URLs", wealthModeHref("assets") === "/dashboard?tab=overview&metric=assets" && marketsModeHref("fundamentals") === "/dashboard?tab=overview&perspective=markets&view=fundamentals");
  for (const href of [lensHref("cashFlow"), wealthModeHref("debt"), marketsModeHref("technicals")]) {
    await load(href);
    const expect = href.includes("cash-flow") ? "Cash Flow" : href.includes("metric=debt") ? "Net Worth/debt" : "Markets/technicals";
    check(`    ${href} opened in a new tab lands on ${expect}`, where() === expect, where());
  }
}

if (root) await act(async () => root!.unmount());
if (failures > 0) { console.error(`\nspace-history: ${failures} failure(s).`); process.exit(1); }
console.log("\nspace-history: all passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
