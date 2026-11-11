/**
 * components/space/widgets/charts/TrendChart.test.ts  (v2.7 owner chart cleanup)
 *
 *   1. no title / subtitle ("Balance history" is the accessible name only);
 *      a header row renders only when headerRight is passed;
 *   2. y-axis: 3–4 nice ticks, labelled in the PASSED currency (EUR and USD), with
 *      gridlines and a left gutter that fits the longest label;
 *   3. no evidence-basis seam rule and no "Evidence changes" legend item; adjacent
 *      observed↔reconstructed runs are JOINED (no stroke gap), each keeping its style;
 *   4. NO provenance legend (v2.7 final UX pass); gaps stay hatched + "no data", runs stay dashed;
 *   5. B12 P3 — identical x-axis labels collapse (a one-date chart shows its date
 *      once, centred); multi-date axes unchanged; `pending` holds a placeholder.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/space/widgets/charts/TrendChart.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TrendChart, niceTicks, xAxisLabels, type TrendPoint } from "./TrendChart";
import { formatCompactCurrency } from "@/lib/currency";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const day = (i: number) => new Date(Date.UTC(2026, 6, 1 + i)).toISOString().slice(0, 10);
const series = (n: number, f: (i: number) => Partial<TrendPoint> = () => ({})): TrendPoint[] =>
  Array.from({ length: n }, (_, i) => ({ date: day(i), value: 20_000 + i * 1_000, estimated: false, ...f(i) }));
const render = (props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(TrendChart as never, { currency: "USD", ...props } as never));
const legendText = (h: string) => {
  const at = h.lastIndexOf('<div class="mt-3 flex flex-wrap');
  return at < 0 ? "" : h.slice(at).replace(/<[^>]+>/g, "|").split("|").map((s) => s.trim()).filter(Boolean);
};
const yLabels = (h: string) => {
  const g = /<g data-trend-y-axis="">([\s\S]*?)<\/g><line/.exec(h)?.[1] ?? "";
  return [...g.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1].replace(/&#x27;/g, "'"));
};

console.log("1. no title / subtitle");
{
  const html = render({ points: series(10), ariaLabel: "Net worth over time" });
  check("no 'Balance history' heading text", !html.includes(">Balance history<") && !/<h2/.test(html));
  check("no subtitle paragraph above the plot", !/text-\[11px\] text-\[var\(--text-muted\)\]">As of/.test(html) && html.startsWith('<section><div class="relative">'));
  check("ariaLabel remains the chart's accessible name", html.includes('role="img" aria-label="Net worth over time"'));
  check("default accessible name without ariaLabel", render({ points: series(3) }).includes('aria-label="Balance history"'));
  const withRight = render({ points: series(3), headerRight: createElement("span", { "data-chips": "" }, "chips") });
  check("headerRight still renders, in a header row", /<section><div class="mb-4[^"]*"><span data-chips="">chips<\/span><\/div>/.test(withRight));
  const empty = render({ points: [], emptyMessage: "nothing yet" });
  check("empty state has no title either", !/<h2/.test(empty) && empty.includes("nothing yet"));
}

console.log("\n2. y-axis ticks in the passed currency");
{
  for (const cur of ["USD", "EUR"]) {
    const html = render({ points: series(10), currency: cur });
    const labels = yLabels(html);
    check(`${cur}: 3–4 tick labels`, labels.length >= 3 && labels.length <= 4, labels.join(", "));
    const sym = cur === "USD" ? "$" : "€";
    check(`${cur}: every label is compact currency in ${cur}`, labels.every((l) => l.includes(sym) && /k$/i.test(l)), labels.join(", "));
    check(`${cur}: labels match formatCompactCurrency(value, "${cur}")`, labels.some((l) => l === formatCompactCurrency(20_000, cur) || l === formatCompactCurrency(25_000, cur) || l === formatCompactCurrency(30_000, cur)), labels.join(", "));
    check(`${cur}: one gridline per tick`, (/<g data-trend-y-axis="">([\s\S]*?)<\/g><line/.exec(html)?.[1].match(/<line /g) ?? []).length === labels.length);
  }
  check("EUR chart never renders a $ tick", !yLabels(render({ points: series(10), currency: "EUR" })).some((l) => l.includes("$")));
  const t = niceTicks(18_000, 31_500);
  check("niceTicks: 3–4 evenly stepped values inside the range", t.length >= 3 && t.length <= 4 && t.every((v) => v >= 18_000 && v <= 31_500)
    && t.slice(1).every((v, i) => Math.abs(v - t[i] - (t[1] - t[0])) < 1e-6), t.join(","));
  check("niceTicks: degenerate range ⇒ one value", niceTicks(5, 5).length === 1);
  const flat = yLabels(render({ points: series(5, () => ({ value: 1_000 })) }));
  check("flat series: identical labels collapse (no repeated tick text)", new Set(flat).size === flat.length, flat.join(","));
  const html = render({ points: series(10) });
  const x0 = Number(/<line x1="([\d.]+)" y1="238" x2="640" y2="238"/.exec(html)?.[1] ?? NaN);
  check("plot is inset by a left gutter that fits the labels (baseline starts > 0)", x0 > 20, String(x0));
  check("x-axis labels kept, aligned to the plot", /<div class="mt-1 flex justify-between[^"]*" style="padding-left:\d+px">/.test(html));
}

console.log("\n3. no seam, runs joined across a basis change");
{
  // 0–4 reconstructed, 5–9 observed: one adjacent basis change, no date hole.
  const pts = series(10, (i) => ({ estimated: i < 5 }));
  const html = render({ points: pts });
  check("no 'Evidence changes' legend item", !html.includes("Evidence changes"));
  check("no seam rule (no full-height dashed 2 3 rule without a gap)", !html.includes('stroke-dasharray="2 3"'));
  const paths = [...html.matchAll(/<path d="(M[^"]+)" fill="none"[^>]*>/g)]
    .map((m) => [m[0], m[1], /stroke-dasharray="([^"]+)"/.exec(m[0])?.[1]] as const);
  check("two line paths (reconstructed, observed)", paths.length === 2, String(paths.length));
  const endOfFirst = paths[0]?.[1].split(" ").pop()?.replace(/^[ML]/, "");
  const startOfSecond = paths[1]?.[1].split(" ")[0].replace(/^M/, "");
  check("the observed run starts exactly where the reconstructed run ends (joined)", !!endOfFirst && endOfFirst === startOfSecond, `${endOfFirst} vs ${startOfSecond}`);
  check("each run keeps its style (reconstructed dashed 4 3, observed solid)", paths[0]?.[2] === "4 3" && paths[1]?.[2] === undefined);
  // A TRUE gap still breaks and still draws the hatched band.
  const holed = [...series(5), ...series(5).map((p, i) => ({ ...p, date: day(60 + i) }))];
  const hh = render({ points: holed });
  const hp = [...hh.matchAll(/<path d="(M[^"]+)" fill="none"/g)].map((m) => m[1]);
  check("a true date gap is NOT joined (two disjoint paths) and draws 'no data'",
    hp.length === 2 && hp[0].split(" ").pop()!.slice(1) !== hp[1].split(" ")[0].slice(1) && hh.includes(">no data<"));
}

console.log("\n4. no provenance legend (v2.7 final UX pass) — the gap stays drawn and labelled");
{
  const holed = [...series(5, (i) => ({ estimated: i < 2 })), ...series(5).map((p, i) => ({ ...p, date: day(60 + i) }))];
  const cases = [
    render({ points: series(6) }),
    render({ points: series(6, () => ({ estimated: true })) }),
    render({ points: holed }),
    render({ points: series(6, (i) => ({ basis: i === 0 || i === 5 ? "recorded" : "modeled" })) }),
    render({ points: series(6, (i) => ({ basis: i < 3 ? "unreliable" : "observed" })) }),
  ];
  check("no legend row is rendered for any basis mix", cases.every((h) => legendText(h) === ""));
  check("no 'Observed' / 'Reconstructed' / 'Never observed' key text",
    cases.every((h) => !/>\s*(Observed|Reconstructed|Never observed)\s*</.test(h)));
  const hh = render({ points: holed });
  check("a true gap is still hatched and labelled 'no data' (honest, never fabricated)",
    hh.includes('fill="url(#tc-hatch)"') && hh.includes(">no data<"));
  check("reconstructed runs are still drawn dashed (the series itself is unchanged)", /stroke-dasharray="4 3"/.test(hh));
}

console.log("\n5. x-axis labels (B12 P3) + pending hold");
{
  const xLabels = (h: string) => {
    const m = /<div class="mt-1 flex (justify-[a-z]+)[^"]*" style="padding-left:\d+px">([\s\S]*?)<\/div>/.exec(h);
    return { justify: m?.[1] ?? "", labels: [...(m?.[2] ?? "").matchAll(/<span>([^<]*)<\/span>/g)].map((x) => x[1]) };
  };
  const one = xLabels(render({ points: series(1) }));
  check("single-date chart: the date appears once, centred", one.labels.length === 1 && one.labels[0] === "Jul 1, 2026" && one.justify === "justify-center", JSON.stringify(one));
  const many = xLabels(render({ points: series(10) }));
  check("multi-date chart: first · middle · last, unchanged", JSON.stringify(many.labels) === JSON.stringify(["Jul 1, 2026", "Jul 6, 2026", "Jul 10, 2026"]) && many.justify === "justify-between", JSON.stringify(many));
  const two = xLabels(render({ points: series(2) }));
  check("two dates: each once, at the ends (the repeated middle collapses)", JSON.stringify(two.labels) === JSON.stringify(["Jul 1, 2026", "Jul 2, 2026"]) && two.justify === "justify-between", JSON.stringify(two));
  const month = (iso: string) => iso.slice(0, 7);
  check("dedupe is by rendered label (coarse formatter: [a, a, b] ⇒ [a, b])",
    JSON.stringify(xAxisLabels(["2026-07-01", "2026-07-15", "2026-08-01"], month)) === JSON.stringify(["2026-07", "2026-08"]));
  check("all-identical labels ⇒ one", xAxisLabels(["2026-07-01", "2026-07-02", "2026-07-03"], month).length === 1);
  check("no dates ⇒ no labels", xAxisLabels([], month).length === 0);

  const held = render({ points: [], pending: true, ariaLabel: "Net worth over time", emptyMessage: "nothing yet" });
  check("pending: a busy placeholder, no plot, no points, no empty message",
    held.includes("data-trend-pending") && held.includes('aria-busy="true"') && !/<svg/.test(held) && !/<circle/.test(held) && !held.includes("nothing yet"));
  check("pending: the placeholder keeps the plot height (no layout jump)", held.includes("height:264px"));
  check("pending: headerRight still renders", render({ points: [], pending: true, headerRight: createElement("span", { "data-chips": "" }, "chips") }).includes("data-chips"));
  check("pending omitted ⇒ chart unchanged (plots)", /<svg/.test(render({ points: series(3) })) && !render({ points: series(3) }).includes("data-trend-pending"));
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
