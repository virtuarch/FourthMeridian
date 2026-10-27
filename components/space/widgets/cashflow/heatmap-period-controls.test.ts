/**
 * components/space/widgets/cashflow/heatmap-period-controls.test.ts
 * (v2.7 final follow-ups — Workstream A: stable heatmap period controls)
 *
 * The owner's binding spec for the Activity heatmap's period controls on Cash Flow
 * AND Spending (standalone tsx, exits 0/1):
 *
 *   1. DEFAULT — row 1 = Month · Quarter · Year + the measure select, no unit
 *      active, the rolling 1M range painted, NO second row;
 *   2. SELECTED — row 2 appears (◀ · label · ▶ · Reset) with October 2026 / Q4 2026
 *      / 2026 labels, and row 1's markup is identical before vs after (only the
 *      active segment's colour + aria-checked differ — nothing displaced);
 *   3. ARROWS — step one unit, bounded (never past today, never before the first
 *      transaction) by the SAME predicate as the picker;
 *   4. PICKER — options limited to the supported range; the current unit marked;
 *      dialog semantics, ≥40 px cells, phone-safe geometry, Escape / click-outside
 *      / focus wiring;
 *   5. RESET + URL — through the REAL hooks (the space-history.test.ts recipe):
 *      a picker choice pins ?fperiod (PUSH), Reset clears it and restores the
 *      rolling 1M flow default (PUSH — the same intent as the pick it undoes),
 *      keeps Net Worth's position params, survives Back / Forward / reload; a
 *      pinned unit stays pinned across midnight; both Cash Flow and Spending;
 *   6. the measure is kept by Reset, and no "Cards" anywhere.
 *
 *   node_modules/.bin/tsx --require ./scripts/lib/server-only-preload.cjs components/space/widgets/cashflow/heatmap-period-controls.test.ts
 */

import { createElement, act, useEffect, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CashFlowHistoryWidget } from "@/components/space/widgets/CashFlowHistoryWidget";
import { HeatmapPeriodRow, HeatmapPeriodPicker } from "./HeatmapPeriodControls";
import {
  calendarNavigation, defaultGroupedShellTime, hydrateGroupedShellTime, isSelectablePeriod, periodPickerOptions,
  resetGroupTime, selectablePickerYears, serializeGroupedShellTime, setGroupExplicit, explicitPeriodKey,
} from "@/lib/space/perspective-time-groups";
import { periodLabel, type ExplicitCashFlowPeriod } from "@/lib/transactions/cash-flow";
import { getPerspectivesForCategory } from "@/lib/perspectives";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const TODAY = "2026-10-27";
const EARLIEST = "2025-03-02";
const RANGE = { earliest: EARLIEST, today: TODAY };

let n = 0;
const tx = (over: Record<string, unknown>) => ({
  id: `t${n++}`, accountId: "chk", financialAccountId: "chk", merchant: "m", category: "Shopping",
  pending: false, currency: "USD", flowType: "SPENDING", counterpartyAccountId: null, transferDisposition: null,
  date: "2026-10-05", amount: -10, ...over,
});
const ROWS = [
  tx({ amount: -40, date: EARLIEST }),
  tx({ amount: 2500, date: "2026-09-01", flowType: "INCOME", category: "Payroll" }),
  tx({ amount: -200, date: "2026-10-04", category: "Groceries" }),
  tx({ amount: -60, date: "2026-10-20", accountId: "card", financialAccountId: "card" }),
];
const ACCOUNTS = [{ id: "chk", type: "checking" }, { id: "card", type: "debt" }];
const OCT: ExplicitCashFlowPeriod = { kind: "month", year: 2026, month: 10 };
const Q4: ExplicitCashFlowPeriod = { kind: "quarter", year: 2026, quarter: 4 };
const Y26: ExplicitCashFlowPeriod = { kind: "year", year: 2026 };

const widget = (over: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(CashFlowHistoryWidget as unknown as ComponentType<Record<string, unknown>>, {
  transactions: ROWS, period: "PAST_MONTH", now: () => new Date(`${TODAY}T00:00:00`), asOf: TODAY, today: TODAY,
  accounts: ACCOUNTS, onSelectPeriod: () => {}, onResetPeriod: () => {}, ...over,
}));

/** The element carrying `marker`, balanced by its own tag name. */
function elementWith(html: string, marker: string): string {
  const i = html.indexOf(marker);
  if (i < 0) return "";
  const start = html.lastIndexOf("<", i);
  const tag = /^<([a-z]+)/.exec(html.slice(start))![1];
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "g");
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  return html.slice(start);
}
/** Row 1 with ONLY the active-state paint removed (aria-checked, colour token, inline style). */
const geometry = (row: string) => row
  .replace(/aria-checked="(true|false)"/g, "aria-checked")
  .replace(/ style="[^"]*"/g, "")
  .replace(/ ?(hover:)?text-\[var\(--(meridian-400|text-muted|text-secondary)\)\]/g, "");

for (const page of ["cashFlow", "spending"] as const) {
  const P = page === "cashFlow" ? "Cash Flow" : "Spending";

  // ── 1. default ──────────────────────────────────────────────────────────────
  console.log(`\n1. ${P} — default state`);
  const def = widget({ page });
  const row1 = elementWith(def, 'data-heatmap-row="primary"');
  check("row 1 holds Month · Quarter · Year and the measure select", /role="radiogroup" aria-label="Heatmap period"/.test(row1)
    && ["month", "quarter", "year"].every((k) => row1.includes(`data-scale="${k}"`)) && /aria-label="Heatmap measure"/.test(row1));
  check("no unit is active", !/aria-checked="true"/.test(def));
  check("NO secondary period row (no arrows, no label, no Reset)",
    !/data-heatmap-row="period"|data-heatmap-stepper|Previous period|data-heatmap-reset/.test(def));
  check("the rolling 1M window is painted (the calendar renders the window's month)", /October|Oct/.test(def.slice(def.indexOf("</select>"))));
  check(page === "cashFlow" ? "Cash Flow measure: Cash in & out" : "Spending measure: spending set",
    page === "cashFlow" ? /<option value="liq-net" selected="">Cash in &amp; out/.test(def) : /Credit-card spending/.test(def) && !/Cash in &amp; out/.test(def));

  // ── 2. selected ─────────────────────────────────────────────────────────────
  console.log(`2. ${P} — Month / Quarter / Year selected`);
  for (const [p, label] of [[OCT, "October 2026"], [Q4, "Q4 2026"], [Y26, "2026"]] as const) {
    const html = widget({ page, period: p });
    const r1 = elementWith(html, 'data-heatmap-row="primary"');
    const r2 = elementWith(html, 'data-heatmap-row="period"');
    check(`${p.kind}: row 2 appears with the label "${label}"`, r2 !== "" && periodLabel(p) === label
      && new RegExp(`<span aria-live="polite">${label}</span>`).test(r2));
    check(`${p.kind}: row 2 = ◀ · label · ▶ · Reset, in that order`,
      ["Previous period", "data-heatmap-period-label", "Next period", "data-heatmap-reset"].map((k) => r2.indexOf(k)).every((v, i, a) => v > -1 && (i === 0 || v > a[i - 1])));
    check(`${p.kind}: row 2 sits BELOW row 1 (separate element, after it)`, html.indexOf(r2) > html.indexOf(r1) + r1.length - 1 && !r1.includes("data-heatmap-stepper"));
    check(`${p.kind}: exactly that segment is active`, (r1.match(/aria-checked="true"/g) ?? []).length === 1 && r1.includes(`aria-checked="true" data-scale="${p.kind}"`));
    check(`${p.kind}: row 1 markup identical to the default (only active paint differs — nothing displaced)`, geometry(r1) === geometry(row1),
      `${geometry(r1).length} vs ${geometry(row1).length}`);
  }
  const r1Classes = (elementWith(def, 'data-heatmap-row="primary"').match(/data-scale="[a-z]+" aria-label="[A-Za-z]+" class="([^"]*)"/g) ?? []);
  check("segments are fixed-width (w-10 phones, sm:w-[4.25rem]) — stable width whatever is active",
    r1Classes.length === 3 && r1Classes.every((c) => /\bw-10\b/.test(c) && c.includes("sm:w-[4.25rem]") && /max-lg:min-h-10/.test(c)));
  check("below sm the visible text is M / Q / Y; the accessible name stays the word",
    ["Month", "Quarter", "Year"].every((w) => def.includes(`aria-label="${w}"`)) && /<span aria-hidden="true" class="sm:hidden">M<\/span>/.test(def));
}

// ── 3. arrows (one bound shared with the picker) ──────────────────────────────
console.log("\n3. arrows step one unit, bounded");
{
  const oct = calendarNavigation({ period: OCT, windowEnd: TODAY, today: TODAY, earliest: EARLIEST });
  check("Oct 2026: ◀ Sep 2026, ▶ none (Nov starts after today)", same(oct.prev, { kind: "month", year: 2026, month: 9 }) && oct.next === null);
  const mar = calendarNavigation({ period: { kind: "month", year: 2025, month: 3 }, windowEnd: TODAY, today: TODAY, earliest: EARLIEST });
  check("Mar 2025 (first transaction month): ◀ none, ▶ Apr 2025", mar.prev === null && same(mar.next, { kind: "month", year: 2025, month: 4 }));
  const q = calendarNavigation({ period: { kind: "quarter", year: 2025, quarter: 1 }, windowEnd: TODAY, today: TODAY, earliest: EARLIEST });
  check("Q1 2025: ◀ none (Q4 2024 ends before the data), ▶ Q2 2025", q.prev === null && same(q.next, { kind: "quarter", year: 2025, quarter: 2 }));
  const y = calendarNavigation({ period: { kind: "year", year: 2025 }, windowEnd: TODAY, today: TODAY, earliest: EARLIEST });
  check("2025: ◀ none, ▶ 2026", y.prev === null && same(y.next, Y26));
  const html = widget({ period: OCT });
  check("rendered: Next disabled at today's month, Previous enabled", /aria-label="Next period" disabled=""/.test(html) && !/aria-label="Previous period" disabled=""/.test(html));
  check("arrows are ≥40px below lg", /aria-label="Previous period"[^>]*max-lg:h-10 max-lg:w-10/.test(html));
  check("the arrows read the SAME predicate as the picker (isSelectablePeriod)",
    /prev: isSelectablePeriod\(older, range\)/.test(code("lib/space/perspective-time-groups.ts")) && /next: isSelectablePeriod\(newer, range\)/.test(code("lib/space/perspective-time-groups.ts")));
}

// ── 4. the direct picker ──────────────────────────────────────────────────────
console.log("\n4. the direct period picker");
{
  const years = selectablePickerYears({ ...RANGE, current: OCT });
  check("years: first transaction's year → today's year", same(years, [2025, 2026]));
  check("…a pinned unit older than the data is still listed (never hidden)", selectablePickerYears({ ...RANGE, current: { kind: "year", year: 2023 } })[0] === 2023);
  const m26 = periodPickerOptions("month", 2026, RANGE, years);
  check("months 2026: Jan–Oct selectable, Nov/Dec not (after today)",
    m26.length === 12 && m26.slice(0, 10).every((o) => o.selectable) && !m26[10].selectable && !m26[11].selectable && m26[9].short === "Oct");
  const m25 = periodPickerOptions("month", 2025, RANGE, years);
  check("months 2025: Jan/Feb not selectable (before the first transaction), Mar on", !m25[0].selectable && !m25[1].selectable && m25[2].selectable);
  const q26 = periodPickerOptions("quarter", 2026, RANGE, years);
  check("quarters 2026: Q1–Q4 listed, all reachable (Q4 has started)", q26.map((o) => o.short).join() === "Q1,Q2,Q3,Q4" && q26.every((o) => o.selectable));
  check("quarters 2025: Q1 reachable (contains Mar 2)", periodPickerOptions("quarter", 2025, RANGE, years)[0].selectable);
  check("years: 2025 · 2026 only", periodPickerOptions("year", 2026, RANGE, years).map((o) => o.short).join() === "2025,2026");
  check("predicate: Nov 2026 / Feb 2025 / 2024 out; Oct 2026 / Mar 2025 in",
    !isSelectablePeriod({ kind: "month", year: 2026, month: 11 }, RANGE) && !isSelectablePeriod({ kind: "month", year: 2025, month: 2 }, RANGE)
      && !isSelectablePeriod({ kind: "year", year: 2024 }, RANGE) && isSelectablePeriod(OCT, RANGE) && isSelectablePeriod({ kind: "month", year: 2025, month: 3 }, RANGE));

  const open = renderToStaticMarkup(createElement(HeatmapPeriodRow, {
    period: OCT, label: "October 2026", prev: null, next: null, earliest: EARLIEST, today: TODAY, onSelect: () => {}, onReset: () => {}, defaultOpen: true,
  }));
  const dlg = elementWith(open, 'role="dialog"');
  check("the label is a dialog trigger (aria-haspopup, aria-expanded, aria-controls → the dialog id)",
    /data-heatmap-period-label="true" aria-haspopup="dialog" aria-expanded="true" aria-controls="([^"]+)"/.test(open)
      && dlg.includes(`id="${/aria-controls="([^"]+)"/.exec(open)![1]}"`));
  check("dialog is named for its unit", /aria-label="Choose a month"/.test(dlg));
  check("12 month cells; Oct is aria-current; Nov/Dec disabled", (dlg.match(/data-period-option=/g) ?? []).length === 12
    && /data-period-option="month:2026-10"[^>]*aria-current="true"/.test(dlg)
    && /data-period-option="month:2026-11" disabled=""/.test(dlg) && /data-period-option="month:2026-12" disabled=""/.test(dlg));
  check("cells carry full accessible names (October 2026)", /aria-label="October 2026"/.test(dlg));
  check("every cell is ≥40px tall; the year arrows 40px", (dlg.match(/class="min-h-10 /g) ?? []).length === 12 && /aria-label="Previous year"[^>]*h-10 w-10/.test(dlg));
  check("year header: ◀ 2025 enabled, ▶ disabled (2026 is the last year)", !/aria-label="Previous year" disabled=""/.test(dlg) && /aria-label="Next year" disabled=""/.test(dlg));
  check("phone-safe geometry: anchored inside the row (left-0 right-0), 18rem only from sm, no fixed px width",
    /class="absolute left-0 right-0 top-full[^"]*sm:right-auto sm:w-72"/.test(dlg) && !/w-\[\d+px\]|min-w-\[\d+px\]/.test(dlg));
  const qOpen = renderToStaticMarkup(createElement(HeatmapPeriodPicker, { period: Q4, earliest: EARLIEST, today: TODAY, onChoose: () => {}, onDismiss: () => {} }));
  check("quarter picker: 4 cells in one row + year header", (qOpen.match(/data-period-option=/g) ?? []).length === 4 && /grid-cols-4/.test(qOpen) && /data-heatmap-picker-year/.test(qOpen));
  const yOpen = renderToStaticMarkup(createElement(HeatmapPeriodPicker, { period: Y26, earliest: EARLIEST, today: TODAY, onChoose: () => {}, onDismiss: () => {} }));
  check("year picker: the available years, no year header", (yOpen.match(/data-period-option=/g) ?? []).length === 2 && !/data-heatmap-picker-year/.test(yOpen) && /aria-label="Choose a year"/.test(yOpen));
  const closed = widget({ period: OCT });
  check("closed by default (aria-expanded=false, no dialog)", /aria-expanded="false"/.test(closed) && !/role="dialog"/.test(closed));

  const src = code("components/space/widgets/cashflow/HeatmapPeriodControls.tsx");
  check("Escape closes and returns focus to the label", /e\.key === "Escape"\) \{ e\.stopPropagation\(\); onDismiss\(\); \}/.test(src)
    && /onDismiss=\{\(\) => close\(true\)\}/.test(src) && /if \(refocus\) triggerRef\.current\?\.focus\(\)/.test(src));
  check("a click outside closes (document pointerdown, contained check, cleaned up)",
    /document\.addEventListener\("pointerdown", onDown\)/.test(src) && /!wrapRef\.current\.contains\(e\.target as Node\)\) setOpen\(false\)/.test(src)
      && /removeEventListener\("pointerdown", onDown\)/.test(src));
  check("opening focuses the selected (or first selectable) cell", /useEffect\(\(\) => \{ focusRef\.current\?\.focus\(\); \}, \[\]\)/.test(src)
    && /ref=\{o\.key === focusKey \? focusRef : undefined\}/.test(src));
  check("choosing a cell closes the picker and pins that unit through onSelect (no write when unchanged)",
    /onClick=\{\(\) => onChoose\(o\.period\)\}/.test(src) && /onChoose=\{\(p\) => \{ close\(true\); if \(explicitPeriodKey\(p\) !== explicitPeriodKey\(period\)\) onSelect\(p\); \}\}/.test(src));
  check("disabled (out-of-range) cells cannot fire", /disabled=\{!o\.selectable\}/.test(src));
}

// ── 5. Reset + URL contract (pure) ─────────────────────────────────────────────
console.log("\n5a. Reset — pure group contract");
{
  const ctx = { today: TODAY, coverageFrom: "2025-01-01" };
  const d = defaultGroupedShellTime(TODAY);
  const pinned = { ...d, position: { ...d.position, time: { ...d.position.time, preset: "YTD" as const } }, flow: setGroupExplicit(d.flow, OCT) };
  const reset = { ...pinned, flow: resetGroupTime(ctx) };
  check("reset: no explicit unit, 1M at a rolling As Of", reset.flow.explicit === null && reset.flow.time.preset === "PAST_MONTH" && reset.flow.time.asOf === TODAY);
  const q = new URLSearchParams(serializeGroupedShellTime(reset, TODAY) as Record<string, string>);
  const ser = serializeGroupedShellTime(reset, TODAY);
  check("reset URL: fperiod cleared, fasof / fcompareto omitted (rolling), fpreset = the 1M default", ser.fperiod === null && ser.fasof === null && ser.fcompareto === null && ser.fpreset === "PAST_MONTH");
  check("reset leaves the position slice untouched", reset.position === pinned.position && ser.preset === "YTD" && q.get("preset") === "YTD");
  check("hydrating a pinned unit the next day keeps it pinned (never reinterpreted as rolling)",
    same(hydrateGroupedShellTime("perspective=cash-flow&fpreset=PAST_MONTH&fperiod=month:2026-08", { today: "2026-10-28", coverageFrom: null }).flow.explicit, { kind: "month", year: 2026, month: 8 }));
}

// ── 5b. the real hooks (space-history.test.ts recipe) ─────────────────────────
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
const writes: string[] = [];
const cur = () => new URL(entries[index].url, BASE);
Object.defineProperty(g, "location", { configurable: true, get: () => { const u = cur(); return { pathname: u.pathname, search: u.search, href: u.href }; } });
const rel = (u: string) => { const x = new URL(u, BASE); return x.pathname + x.search; };
const history = {
  get length() { return entries.length; },
  get state() { return entries[index].state; },
  pushState(data: Entry["state"], _t: string, url: string) {
    writes.push(`push ${rel(url)}`);
    entries = entries.slice(0, index + 1); entries.push({ url: rel(url), state: { ...(data ?? {}), __NA: true } }); index = entries.length - 1;
  },
  replaceState(data: Entry["state"], _t: string, url: string) {
    writes.push(`replace ${rel(url)}`);
    entries[index] = { url: rel(url), state: { ...(data ?? {}), __NA: true } };
  },
  back() { go(-1); },
  forward() { go(1); },
};
g.history = history;
function go(delta: number) {
  index += delta;
  for (const fn of listeners.get("popstate") ?? []) fn({ state: entries[index].state });
}

async function hooks(): Promise<void> {
  console.log("\n5b. Reset + picker through the real hooks — push/replace, Back/Forward, reload");
  const { createRoot } = await import("react-dom/client");
  const { useSpaceNavigation } = await import("@/lib/space/use-space-navigation");
  const { usePerspectiveShellState } = await import("@/components/space/shell/usePerspectiveShellState");
  const { timeGroupFor } = await import("@/lib/space/perspective-time-groups");
  type Nav = ReturnType<typeof useSpaceNavigation>;
  type Shell = ReturnType<typeof usePerspectiveShellState>;
  let nav!: Nav; let shell!: Shell;
  let today = TODAY;
  const PERSONAL = getPerspectivesForCategory("PERSONAL").map((p) => p.id);
  function Harness() {
    nav = useSpaceNavigation({ category: "PERSONAL", availablePerspectives: PERSONAL });
    shell = usePerspectiveShellState({ spaceId: "space-1", today, earliestDefensibleDate: "2025-01-01", group: timeGroupFor(nav.activeTab, nav.activePerspectiveId) });
    const { applyInitialTab } = nav;
    useEffect(() => { applyInitialTab([]); }, [applyInitialTab]);
    return null;
  }
  let root: ReturnType<typeof createRoot> | null = null;
  async function load(url: string) {
    if (root) await act(async () => root!.unmount());
    entries = [{ url: "/dashboard/spaces", state: { __NA: true } }, { url, state: { __NA: true } }];
    index = 1; writes.length = 0;
    const container = { nodeType: 1, nodeName: "DIV", tagName: "DIV", ownerDocument: doc, addEventListener() {}, removeEventListener() {}, childNodes: [], firstChild: null, appendChild() {}, removeChild() {} };
    root = createRoot(container as never);
    await act(async () => root!.render(createElement(Harness)));
    writes.length = 0;
  }
  const step = async (fn: () => void) => { await act(async () => fn()); };
  const q = () => cur().searchParams;
  const pushes = () => writes.filter((w) => w.startsWith("push")).length;
  /** What the heatmap's row 2 would show (label) — null ⇒ no row 2. */
  const row2 = () => (shell.explicitPeriod ? periodLabel(shell.explicitPeriod) : null);

  for (const [slug, lens] of [["cash-flow", "cashFlow"], ["spending", "spending"]] as const) {
    const P = lens === "cashFlow" ? "Cash Flow" : "Spending";
    // Net Worth pinned to a past date + YTD; the flow group at its default.
    await load(`/dashboard?tab=overview&perspective=${slug}&asof=2026-06-30&preset=YTD&fpreset=PAST_MONTH`);
    check(`${P}: opens on the flow default — no unit, rolling 1M, no row 2`, shell.group === "flow" && shell.period === "PAST_MONTH" && row2() === null && !q().has("fasof"));
    const posBefore = ["asof", "compareto", "preset"].map((k) => `${k}=${q().get(k)}`).join("&");

    await step(() => shell.setExplicitPeriod(calendarNavigation({ period: shell.period, windowEnd: TODAY, today: TODAY, earliest: EARLIEST }).choose.quarter));
    check(`${P}: Quarter pick ⇒ ?fperiod=quarter:2026-Q4 (PUSH), row 2 "Q4 2026"`, q().get("fperiod") === "quarter:2026-Q4" && pushes() === 1 && row2() === "Q4 2026");

    // The picker's choice: any listed, selectable option pins it.
    const opt = periodPickerOptions("quarter", 2025, RANGE, selectablePickerYears({ ...RANGE, current: shell.explicitPeriod })).find((o) => o.key === "quarter:2025-Q2")!;
    await step(() => shell.setExplicitPeriod(opt.period));
    check(`${P}: picker choice pins it (?fperiod=quarter:2025-Q2, PUSH), label updates`, opt.selectable && q().get("fperiod") === "quarter:2025-Q2" && pushes() === 2 && row2() === "Q2 2025");

    // A header As Of pin on the flow group too, then a unit again — Reset must clear both.
    await step(() => shell.actions.setAsOf("2026-08-15"));
    await step(() => shell.setExplicitPeriod({ kind: "month", year: 2026, month: 3 }));
    check(`${P}: (setup) flow As Of pinned + March 2026 unit`, q().get("fasof") === "2026-08-15" && q().get("fperiod") === "month:2026-03");
    writes.length = 0;
    await step(() => shell.resetPeriod());
    check(`${P}: Reset clears ?fperiod and ?fasof/?fcompareto, fpreset back to 1M`, !q().has("fperiod") && !q().has("fasof") && !q().has("fcompareto") && q().get("fpreset") === "PAST_MONTH", cur().search);
    check(`${P}: …the period is the rolling 1M default again (no row 2)`, shell.period === "PAST_MONTH" && shell.state.asOf === TODAY && shell.explicitPeriod === null && row2() === null);
    check(`${P}: …it PUSHES (same intent as the pick it undoes) — one entry`, pushes() === 1 && writes.length === 1, writes.join(" | "));
    check(`${P}: …Net Worth's position params are untouched`, ["asof", "compareto", "preset"].map((k) => `${k}=${q().get(k)}`).join("&") === posBefore, cur().search);
    check(`${P}: …the navigation params are untouched`, q().get("tab") === "overview" && q().get("perspective") === slug);
    writes.length = 0;
    await step(() => shell.resetPeriod());
    check(`${P}: Reset at the default writes nothing`, writes.length === 0);

    await step(() => history.back());
    check(`${P}: Back ⇒ the pinned March 2026 unit is back (pinned in its entry)`, q().get("fperiod") === "month:2026-03" && row2() === "March 2026" && shell.state.asOf === "2026-08-15");
    await step(() => history.forward());
    check(`${P}: Forward ⇒ the reset default again`, !q().has("fperiod") && shell.period === "PAST_MONTH" && row2() === null);

    const resetUrl = cur().pathname + cur().search;
    await load(resetUrl);
    check(`${P}: reload of the reset URL ⇒ default, no write`, shell.period === "PAST_MONTH" && shell.explicitPeriod === null && writes.length === 0);
    await step(() => shell.setExplicitPeriod(OCT));
    const pinnedUrl = cur().pathname + cur().search;
    today = "2026-11-02";
    await load(pinnedUrl);
    check(`${P}: reload a week later keeps the pinned October 2026 (not rolled to November)`, same(shell.explicitPeriod, OCT) && row2() === "October 2026");
    today = TODAY;
    check(`${P}: the reload also restores Net Worth's own params`, q().get("asof") === "2026-06-30" && q().get("preset") === "YTD");
  }
  if (root) await act(async () => root!.unmount());
}

// ── 6. measure kept; no Cards ─────────────────────────────────────────────────
function staticTail() {
  console.log("\n6. measure kept by Reset; no Cards");
  const hist = code("components/space/widgets/CashFlowHistoryWidget.tsx");
  const ctl = code("components/space/widgets/cashflow/HeatmapPeriodControls.tsx");
  check("the measure is widget-local state, outside the URL-backed period (Reset cannot reach it)",
    /useState<string>\(defaultFilterFor/.test(hist) && !/setFilterId/.test(ctl) && !/filterId|fmeasure/.test(code("lib/space/perspective-time-groups.ts")));
  check("Reset calls ONLY the reset handler", /onClick=\{\(\) => \{ setOpen\(false\); onReset\(\); \}\}/.test(ctl));
  check("the widget is not re-keyed by the period (its measure survives a period change)",
    !/<CashFlowHistoryWidget[^>]*\bkey=/.test(code("components/space/widgets/cashflow/CashFlowWorkspace.tsx")));
  check("Reset is wired host → renderer (both pages) → workspace → widget",
    /onResetCashFlowPeriod: shell\.resetPeriod/.test(code("components/dashboard/SpaceDashboard.tsx"))
      && (code("components/space/workspaces/workspaceRenderers.tsx").match(/onResetPeriod=\{ctx\.onResetCashFlowPeriod\}/g) ?? []).length === 2
      && /onResetPeriod=\{onResetPeriod\}/.test(code("components/space/widgets/cashflow/CashFlowWorkspace.tsx")));
  for (const page of ["cashFlow", "spending"] as const) {
    const html = widget({ page, period: OCT });
    check(`${page}: no Cards view / Calendar⇄Cards switch`, !/>Cards</.test(html) && !/CardsView|aria-label="Cash flow history view"/.test(hist + html));
  }
  const standalone = widget({ period: OCT, onResetPeriod: undefined });
  check("no reset handler ⇒ no Reset button (standalone heatmap)", !/data-heatmap-reset/.test(standalone) && /data-heatmap-stepper/.test(standalone));
  check("keys round-trip for every picker option", periodPickerOptions("month", 2026, RANGE, [2025, 2026]).every((o) => o.key === explicitPeriodKey(o.period)));
}

hooks().then(() => {
  staticTail();
  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}).catch((e) => { console.error(e); process.exit(1); });
