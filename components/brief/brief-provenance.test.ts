/**
 * components/brief/brief-provenance.test.ts — a prior day's Brief says it is one
 *
 * On 2026-10-04 the page showed a Brief written the night before ("$15,925 … recent expenses of about
 * $7,013", on the method in force then) beneath a LIVE "Net worth … as of Oct 4", marked only
 * "From Saturday, Oct 3 · Couldn't update". The fallback stays; the boundary is now unmistakable:
 *   1. a prior-day Brief opens with a dated "Last successful Brief" note saying its figures reflect the
 *      time it was written, its sections are dated, and the live figures follow under "Live now";
 *   2. a current Brief renders exactly as before (no note, no "Live now", "Brief updated" kept);
 *   3. a missing balance anchor drops its clause — never "Invalid Date";
 *   4. the Brief's own words are rendered verbatim either way.
 *
 * Standalone tsx + renderToStaticMarkup (house pattern), exits 0/1.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BriefBody } from "./DailyBriefClient";
import type { BriefArtifactView, BriefMetricsView } from "@/lib/brief-types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const BODY = "You have about $15,925 in liquid cash, covering roughly 2.3 months of recent expenses of about $7,013.";
const brief = (over: Partial<BriefArtifactView> = {}): BriefArtifactView => ({
  briefDay: "2026-10-03", fromPriorDay: true, generatedAt: "2026-10-03T21:44:11.985Z",
  balancesAsOf: "2026-10-03T12:00:00.000Z", balancesMayBeStale: false,
  headline: "A steady day with a thin cash buffer.", quiet: false,
  observations: [
    { kind: "LIQUIDITY", importance: "NOTABLE", title: "Cash buffer", body: BODY, evidence: [] } as never,
    { kind: "CONTEXT", importance: "CONTEXT", title: "Spending", body: "Spending was steady.", evidence: [] } as never,
  ],
  ...over,
});
const metrics: BriefMetricsView = { currency: "USD", netWorth: 123_456, asOf: "2026-10-04", estimated: false, monthChange: null } as BriefMetricsView;
const render = (b: BriefArtifactView, phase = "COULD_NOT_UPDATE") =>
  renderToStaticMarkup(createElement(BriefBody, { brief: b, metrics, dataHealth: null, phase: phase as never }));

console.log("1. a prior-day Brief is dated, and today's figures are labelled live");
{
  const html = render(brief());
  check("exactly one Last-successful-Brief note", (html.match(/role="note" aria-label="Last successful Brief"/g) ?? []).length === 1);
  check("…naming it, with the failure as today's", /Last successful Brief · /.test(html) && /Couldn’t update today’s Brief/.test(html));
  check("…and saying its figures reflect the time it was written, with the balance anchor",
    /reflect your accounts and assumptions when it was written/.test(html) && /with balances as of /.test(html));
  check("the observation sections are dated", /aria-label="Worth your attention · from /.test(html) && /aria-label="Worth knowing · from /.test(html));
  check("today's figures sit under Live now, labelled live", /<section aria-label="Live now">/.test(html) && /Live · Net worth/.test(html));
  const iNote = html.indexOf("Last successful Brief"), iHead = html.indexOf("A steady day"), iObs = html.indexOf("Cash buffer"),
    iLive = html.indexOf('aria-label="Live now"');
  check("order: note → headline → observations → Live now", iNote < iHead && iHead < iObs && iObs < iLive, `${iNote} ${iHead} ${iObs} ${iLive}`);
  check("the Brief's own words are rendered verbatim", html.includes("$15,925") && html.includes("$7,013"));
  check("no bare 'From …' prefix competing with the note", !/From \w+day, /.test(html));
}

console.log("\n2. a current Brief is unchanged");
{
  const html = render(brief({ fromPriorDay: false, briefDay: "2026-10-04" }), "IDLE");
  check("no note, no Live now, no dated sections",
    !/Last successful Brief/.test(html) && !/Live now/.test(html) && /aria-label="Worth your attention"/.test(html));
  check("'Brief updated' and the plain Net worth label kept", /Brief updated/.test(html) && />Net worth</.test(html) && !/Live · Net worth/.test(html));
  check("…metrics still above the observations", html.indexOf("Net worth") < html.indexOf("Cash buffer"));
  const failedToday = render(brief({ fromPriorDay: false, briefDay: "2026-10-04" }), "COULD_NOT_UPDATE");
  check("a same-day failure says Couldn't update, without the prior-day note", /Couldn’t update/.test(failedToday) && !/Last successful Brief/.test(failedToday));
}

console.log("\n3. no balance anchor");
{
  const html = render(brief({ balancesAsOf: null }));
  check("the clause is dropped, never Invalid Date", !/with balances as of/.test(html) && !/Invalid Date/.test(html));
}

console.log(failures === 0 ? "\nall brief provenance checks passed" : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
