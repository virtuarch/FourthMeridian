/**
 * components/platform/widgets/overview/status-board.test.ts  (UX-P1 · Agent 2)
 *
 * RENDER-PATH proof for the Overview status board (standalone tsx +
 * renderToStaticMarkup, DB-free):
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/widgets/overview/status-board.test.ts
 *
 * Pinned:
 *   1. the self-fetching block's FIRST FRAME is loading inside ONE SectionSurface
 *   2. six tiles, in cockpit order, each word + figure + qualifier + doorway
 *   3. UNKNOWN is muted — never the ok tone
 *   4. four posture chips, from the server; Unavailable is muted and worded
 *   5. basis strings and provenance live ONLY inside the Technical details disclosure
 *   6. the footnote is one sentence; no KeyRow list on the board
 *   7. doorways are the registry's labels; the policy strip has a Policies doorway
 *   8. the block derives nothing (no filter/reduce/sort; no fetch other than the one literal)
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { StatusBoard, StatusBoardSurface } from "./StatusBoard";
import { buildOverview, derivePosture, type OverviewInputs } from "@/lib/platform/ops/overview-core";
import type { OperationsOverview } from "@/lib/platform/ops/overview";
import type { PipelineStatus } from "@/lib/platform/refresh/types";
import { defaultRefreshPolicies } from "@/lib/platform/refresh-policy.core";
import { getPlatformWorkspace } from "@/lib/platform/workspaces";
import { OVERVIEW_FOOTNOTE, STATE_TONE } from "../ops-overview-view";
import { TONE_COLOR } from "../../platform-surface";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const strip = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const now = new Date("2026-10-14T12:00:00.000Z");

function pipeline(over: Partial<PipelineStatus>): PipelineStatus {
  return {
    window: { from: "2026-10-13", to: "2026-10-14" }, deterministic: true, indeterminacyReason: null, checkedAt: now.toISOString(),
    executions: 0, byStatus: {}, kinds: [], networks: [], openExecutions: 0, latestFailures: [], tier: "observed" as PipelineStatus["tier"],
    ...over,
  };
}

const inputs: OverviewInputs = {
  pipeline: pipeline({ executions: 1, byStatus: { SUCCEEDED: 1 } }), pipelineWindowLabel: "window since yesterday (UTC)",
  sources: { total: 4, counts: { HEALTHY: 2, STALE: 2, DEGRADED: 0, NEEDS_REAUTH: 0, ERROR: 0, REVOKED: 0 }, unhealthy: [], retired: { revoked: 0, ownerInactive: 0 } },
  jobs: { healthy: 0, running: 0, overdue: 0, failing: 1, dead: 0, neverRan: 10 },
  ai: { invocations: 3, usd: 0.02, unpricedTokens: 0, cacheShare: 0.5, windowLabel: "last 24 h", failures: { failed: 0, timeouts: 0, rateLimited: 0, quota: 0 } },
  brief: { windowLabel: "last 24 h", generated: 1, failed: 0, inProgress: 0, versionStale: 0, usd: 0.003, uncorrelatedGenerations: 0 },
  plaid: { billableItems: 12, byStatus: { ACTIVE: 12 }, currentCycle: { transactions: 12, investments: 0, usd: 3.6, agree: true, label: "current" }, priceConfigured: true },
  policies: defaultRefreshPolicies(),
};

function overview(over: Partial<OperationsOverview> = {}, inp: OverviewInputs = inputs): OperationsOverview {
  const core = buildOverview(inp, null, now);
  return {
    ...core,
    checkedAt: now.toISOString(),
    windows: { pipeline: "2026-10-13 .. 2026-10-14 (UTC)", ai: "24h", brief: "24h" },
    latestFailures: [],
    nextSlotAt: null,
    posture: derivePosture({
      alerts: { latest: { evaluatedAtISO: now.toISOString(), deliveryStatus: "none", counts: { evaluated: 1, live: 1, enabled: 1, firing: 0, delivered: 0, suppressed: 0 }, rules: [{ id: "job-failing", kind: "job-failing", enabled: true, live: true, firing: false, breaches: 0, severity: null }] }, rulesRegistered: 1 },
      providers: null,
      freshness: { checkedAt: now, allFresh: true, resources: [] },
      configuration: { nodeEnv: "test", deploymentEnv: "development", ok: true, counts: { pass: 2, warn: 0, fail: 0 }, keys: [] },
    }),
    ...over,
  };
}

const render = (data: OperationsOverview, wired = true) => {
  const html = renderToStaticMarkup(createElement(StatusBoardSurface, { title: "Operations overview", data, checkedAgo: "12s", onOpenWorkspace: wired ? () => {} : undefined, onSelectExecution: () => {} }));
  return { html, text: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() };
};
const badgeWords = (html: string) => [...html.matchAll(/<span class="text-xs font-medium">([^<]*)<\/span>/g)].map((m) => m[1]);
const outsideDetails = (html: string) => html.slice(0, html.indexOf("<details"));

function main() {
  console.log("1. first frame of the self-fetching block");
  {
    const html = renderToStaticMarkup(createElement(StatusBoard, { title: "Operations overview" }));
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    check("ONE section surface carries the DB label", (html.match(/<section/g) ?? []).length === 1 && text.includes("Operations overview"));
    check("renders a loading status, no verdict, no figure", /role="status"/.test(html) && badgeWords(html).length === 0 && !/\d/.test(text.replace("Operations overview", "")), text);
  }

  console.log("2. six tiles in cockpit order, word + figure + qualifier + doorway");
  {
    const { html, text } = render(overview());
    const words = badgeWords(html);
    check("six domain verdict words before the posture", words.slice(0, 6).join(",") === "Healthy,Stale,Failed,Healthy,Healthy,Healthy", words.join(","));
    check("figures are the server's", ["0 of 1 failed", "2 stale", "1 failing", "1 generated", "0 failed", "12 billable Items"].every((f) => text.includes(f)), text);
    check("qualifiers render", text.includes("10 never ran") && text.includes("of 4 sources"));
    const openLabels = [...html.matchAll(/aria-label="Open ([^"]+)"/g)].map((m) => m[1]);
    check("six doorways labelled from the workspace registry",
      openLabels.join(",") === ["platform-refresh", "platform-providers", "platform-jobs", "platform-ai", "platform-ai", "platform-costs"].map((id) => getPlatformWorkspace(id)!.label).join(","), openLabels.join(","));
    check("no KeyRow list on the board", !/items-baseline justify-between gap-4/.test(html));
  }

  console.log("3. UNKNOWN is muted, never ok");
  {
    const unknown = overview({}, { ...inputs, pipeline: pipeline({}), sources: { total: 0, counts: { HEALTHY: 0, STALE: 0, DEGRADED: 0, NEEDS_REAUTH: 0, ERROR: 0, REVOKED: 0 }, unhealthy: [], retired: { revoked: 0, ownerInactive: 0 } } });
    const { html, text } = render(unknown);
    check("STATE_TONE maps UNKNOWN to muted", STATE_TONE.UNKNOWN === "muted" && STATE_TONE.HEALTHY === "ok");
    const unknownBadge = html.match(/<span class="inline-flex shrink-0 items-center gap-1.5" style="color:([^"]+)"><span aria-hidden="true" class="rounded-full" style="[^"]*"><\/span><span class="text-xs font-medium">Unknown<\/span>/);
    check("an Unknown tile is painted with the muted token", unknownBadge?.[1] === TONE_COLOR.muted, unknownBadge?.[1]);
    check("unknown figures say none recorded / none connected, never 0 of 0", text.includes("none recorded") && text.includes("none connected") && !/0 of 0/.test(text));
  }

  console.log("4. posture: four chips, Unavailable is muted and worded");
  {
    const { html, text } = render(overview());
    const words = badgeWords(html).slice(6);
    check("four posture words follow the six tiles", words.length === 4, words.join(","));
    check("Alerts quiet from the LATEST run, Providers unavailable, Freshness unknown, Configuration set", words.join(",") === "Quiet,Unavailable,Unknown,Set", words.join(","));
    check("unavailable is worded 'could not be asked', never zero", text.includes("could not be asked") && !/0 of 0/.test(text));
    const unavailableBadge = html.match(/style="color:([^"]+)"><span aria-hidden="true" class="rounded-full" style="[^"]*"><\/span><span class="text-xs font-medium">Unavailable<\/span>/);
    check("Unavailable carries the muted token", unavailableBadge?.[1] === TONE_COLOR.muted);
    const postureDoorways = [...html.matchAll(/aria-label="([^"]+) — open the workspace behind (Alerts|Providers|Freshness|Configuration)"/g)].map((m) => `${m[2]}→${m[1]}`);
    check("each chip has a doorway labelled from the registry", postureDoorways.join(",") === "Alerts→Policies,Providers→Providers,Freshness→Providers,Configuration→Policies", postureDoorways.join(","));
  }

  console.log("5. basis strings and provenance live only inside Technical details");
  {
    const { html, text } = render(overview());
    const before = outsideDetails(html);
    check("a Technical details disclosure exists", /<details[^>]*>\s*<summary[^>]*>Technical details/.test(html));
    for (const basis of ["RefreshExecution ledger", "JobRun ledger", "AiInvocation ledger", "DailyBrief rows", "PlaidItem census", "latest evaluate-alerts run"]) {
      check(`"${basis}" is in the disclosure and not on the board`, html.includes(basis) && !before.includes(basis));
    }
    check("the disclosure names the windows and the next due slot", text.includes("2026-10-13 .. 2026-10-14") && text.includes("not derivable"));
    check("no module path outside the disclosure", !/lib\/|\.ts\b/.test(before.replace(/<[^>]+>/g, " ")));
  }

  console.log("6. footnote is one sentence; header carries the worst word, the clock and the policy strip");
  {
    const { html, text } = render(overview());
    check("footnote is OVERVIEW_FOOTNOTE", text.includes(OVERVIEW_FOOTNOTE));
    check("…and it is one sentence", (OVERVIEW_FOOTNOTE.match(/\.\s/g) ?? []).length === 0 && OVERVIEW_FOOTNOTE.endsWith("."));
    check("the worst word leads the header", /Failed Something has failed checked 12s ago/.test(text), text.slice(0, 200));
    check("policy strip with a Policies doorway", text.includes("Banks every 24h (default)") && /aria-label="Policies — open the workspace behind the refresh policy"/.test(html));
    const unwired = render(overview(), false);
    check("no doorway renders when the host wired no handler", !unwired.html.includes("aria-label=\"Open ") && !unwired.html.includes("behind the refresh policy"));
  }

  console.log("7. the block derives nothing and fetches once");
  {
    const src = strip("components/platform/widgets/overview/StatusBoard.tsx");
    check("exactly one fetch, a string literal", (src.match(/useWidgetFetch</g) ?? []).length === 1 && src.includes('useWidgetFetch<OperationsOverview>("/api/platform/platform-ops/overview")'));
    check("no filter/reduce/sort in the block", !/\.filter\(|\.reduce\(|\.sort\(/.test(src));
    check("no raw hex, no palette class, no deep coral", !/#[0-9a-fA-F]{3,8}\b/.test(src) && !/\b(?:bg|text|border)-(?:gray|blue|red|emerald|green)-\d{2,3}\b/.test(src) && !/--coral-(5|6)00/.test(src));
    check("imports no reader or server module", !/@\/lib\/platform\/ops\/overview"|@\/lib\/db|server-only|customer-core/.test(src.replace(/import type[^;]+;/g, "")));
  }

  if (failures > 0) { console.error(`\nstatus-board.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\nstatus-board.test: all passed.");
}

main();
