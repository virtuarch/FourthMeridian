/**
 * components/brief/brief-paused.test.ts — the Brief says "paused for maintenance", not "Couldn't update"
 *
 * On 2026-10-24 (Preview maintenance validation) POST /api/brief/generate correctly refused with
 * 503 `{ error, code: "AI_PAUSED" }` before any model work, but the page showed only "Couldn't
 * update": the transport threw `brief generation request failed: 503` and dropped the code.
 *   1. only 503 + code AI_PAUSED is a pause — network, 401/403, 429, the allowance and other 5xx are not;
 *   2. the pause carries no server text; the page shows its own sentence (Conversations' words);
 *   3. the Brief on screen stays, and nothing re-asks during the hold — no timer, no visibility
 *      event, no retry click; after the hold, one retry is one POST;
 *   4. an ordinary failure still says "Couldn't update";
 *   5. rendered: neutral polite status, the sentence, the Brief's own words, no "Couldn't update".
 *
 *   npx tsx components/brief/brief-paused.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BriefArtifactView, BriefMetricsView, BriefResponse, BriefState } from "@/lib/brief-types";
import {
  AI_PAUSED_CODE, BRIEF_PAUSED_HOLD_MS, BRIEF_PAUSED_MESSAGE, BRIEF_RECHECK_THROTTLE_MS, BriefPausedError,
  createBriefController, httpBriefTransport, isPaidAiPaused, type BriefClock, type BriefTransport, type BriefView,
} from "./brief-flow";
import { BriefBody } from "./DailyBriefClient";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

function fakeClock(start = Date.parse("2026-10-24T20:57:00.000Z")) {
  let t = start;
  const timers: { at: number; fn: () => void }[] = [];
  return {
    now: () => t,
    setTimeout: (fn: () => void, ms: number) => { const h = { at: t + ms, fn }; timers.push(h); return h; },
    clearTimeout: (h: unknown) => { const i = timers.indexOf(h as never); if (i >= 0) timers.splice(i, 1); },
    advance(ms: number) { t += ms; },
    pending: () => timers.length,
  } satisfies BriefClock & Record<string, unknown>;
}

const SPACE = "space_A";
const brief = (over: Partial<BriefArtifactView> = {}): BriefArtifactView => ({
  briefDay: "2026-10-24", fromPriorDay: false, generatedAt: "2026-10-24T19:52:00.000Z", balancesAsOf: null,
  balancesMayBeStale: false, headline: "Spending ran close to your usual pace.", quiet: true, observations: [], ...over,
});
const res = (state: BriefState, over: Partial<BriefResponse> = {}): BriefResponse => ({
  spaceId: SPACE, state, brief: null, checkedAt: "2026-10-24T20:57:00.000Z",
  needsGeneration: state === "CHECK_REQUIRED" || state === "STALE" || state === "ABSENT", ...over,
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function harness(get: BriefResponse, generate: () => Promise<BriefResponse>) {
  const clock = fakeClock();
  const calls = { get: 0, generate: 0 };
  const transport: BriefTransport = {
    get: async () => { calls.get++; return get; },
    generate: () => { calls.generate++; return generate(); },
  };
  const views: BriefView[] = [];
  const controller = createBriefController({ spaceId: SPACE, initial: null, transport, clock, onView: (v) => views.push(v) });
  return { clock, calls, views, controller };
}

async function main() {
  console.log("1. only 503 + AI_PAUSED is a pause");
  const cases: [string, Response, boolean][] = [
    ["503 AI_PAUSED", json(503, { error: "AI features are paused for maintenance.", code: "AI_PAUSED" }), true],
    ["503 unpriced model", json(503, { error: "x", code: "UNPRICED_MODEL" }), false],
    ["503 no code", json(503, { error: "The brief could not be prepared right now." }), false],
    ["503 HTML", new Response("<html>Service Unavailable</html>", { status: 503 }), false],
    ["429 allowance", json(429, { error: "x", code: "AI_ALLOWANCE" }), false],
    ["429 pacing", json(429, { error: "Too many requests" }), false],
    ["401", json(401, { error: "Unauthorized" }), false],
    ["403", json(403, { error: "Forbidden" }), false],
    ["500 claiming AI_PAUSED", json(500, { code: "AI_PAUSED" }), false],
  ];
  for (const [name, r, want] of cases) check(`${name} ⇒ ${want ? "paused" : "not paused"}`, (await isPaidAiPaused(r)) === want);

  console.log("\n2. the transport: a typed pause, no server text; everything else unchanged");
  {
    const realFetch = globalThis.fetch;
    const stub = (r: () => Response) => { globalThis.fetch = (async () => r()) as typeof fetch; };
    const attempt = async () => { try { await httpBriefTransport.generate(SPACE, new AbortController().signal); return null; } catch (e) { return e; } };
    stub(() => json(503, { error: "internal detail: kill switch row 42", code: "AI_PAUSED" }));
    const paused = await attempt();
    check("503 AI_PAUSED ⇒ BriefPausedError", paused instanceof BriefPausedError);
    check("…carrying none of the server's text", paused instanceof Error && !/internal detail|row 42/.test(paused.message));
    stub(() => json(500, { error: "boom" }));
    const failed = await attempt();
    check("500 ⇒ the ordinary failure, not a pause", failed instanceof Error && !(failed instanceof BriefPausedError) && /failed: 500/.test(failed.message));
    stub(() => json(429, { error: "x", code: "AI_ALLOWANCE" }));
    check("429 allowance ⇒ the ordinary failure", !((await attempt()) instanceof BriefPausedError));
    globalThis.fetch = (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch;
    const net = await attempt();
    check("a network error ⇒ the ordinary failure", net instanceof TypeError);
    globalThis.fetch = realFetch;
  }

  console.log("\n3. paused keeps the Brief and does not re-ask during the hold");
  {
    const h = harness(res("STALE", { brief: brief() }), () => Promise.reject(new BriefPausedError()));
    h.controller.start(); await flush();
    const v = h.controller.view();
    check("STALE ⇒ one POST ⇒ PAUSED", v.phase === "PAUSED" && h.calls.generate === 1, `${v.phase} ${h.calls.generate}`);
    check("the Brief on screen is kept", v.brief?.headline === "Spending ran close to your usual pace.");
    check("the hold is set", v.retryAt === h.clock.now() + BRIEF_PAUSED_HOLD_MS);
    check("no timer is left to retry on its own", h.clock.pending() === 0);
    check("never passes through Couldn't update", !h.views.some((x) => x.phase === "COULD_NOT_UPDATE"));

    h.clock.advance(BRIEF_RECHECK_THROTTLE_MS + 1);
    h.controller.onVisible(); await flush();
    check("a visibility event during the hold sends nothing (no GET, no POST)", h.calls.get === 1 && h.calls.generate === 1);
    h.controller.retry(); await flush();
    check("the retry control during the hold sends nothing", h.calls.generate === 1 && h.controller.view().phase === "PAUSED");

    h.clock.advance(BRIEF_PAUSED_HOLD_MS);
    h.controller.retry(); await flush();
    check("after the hold, one retry ⇒ exactly one POST, still paused, Brief kept",
      h.calls.generate === 2 && h.controller.view().phase === "PAUSED" && h.controller.view().brief !== null);
  }
  {
    const h = harness(res("ABSENT"), () => Promise.reject(new BriefPausedError()));
    h.controller.start(); await flush();
    check("nothing to show ⇒ PAUSED without a Brief (the empty paused panel), one POST",
      h.controller.view().phase === "PAUSED" && h.controller.view().brief === null && h.calls.generate === 1);
  }

  console.log("\n4. an ordinary failure is unchanged");
  {
    const h = harness(res("STALE", { brief: brief() }), () => Promise.reject(new Error("brief generation request failed: 500")));
    h.controller.start(); await flush();
    check("500 ⇒ COULD_NOT_UPDATE, Brief kept", h.controller.view().phase === "COULD_NOT_UPDATE" && h.controller.view().brief !== null);
    const e = harness(res("ABSENT"), () => Promise.reject(new TypeError("Failed to fetch")));
    e.controller.start(); await flush();
    check("network error with nothing shown ⇒ LOAD_ERROR, not PAUSED", e.controller.view().phase === "LOAD_ERROR");
  }

  console.log("\n5. rendered");
  {
    const metrics = { currency: "USD", netWorth: 1000, asOf: "2026-10-24", estimated: false, monthChange: null } as BriefMetricsView;
    const render = (b: BriefArtifactView, phase: BriefView["phase"]) =>
      renderToStaticMarkup(createElement(BriefBody, { brief: b, metrics, dataHealth: null, phase }));
    const html = render(brief(), "PAUSED");
    check("says Paused for maintenance in the polite status region", /role="status" aria-live="polite"[^>]*>[\s\S]*?Paused for maintenance/.test(html));
    check("…in the neutral tone, not the warning tone", !/accent-warning[^"]*">Paused/.test(html));
    check("shows Conversations' sentence", html.includes(BRIEF_PAUSED_MESSAGE));
    check("keeps the Brief's own words", html.includes("Spending ran close to your usual pace."));
    check("does not say Couldn't update", !/Couldn’t update/.test(html));
    const prior = render(brief({ fromPriorDay: true, briefDay: "2026-10-23" }), "PAUSED");
    check("a prior-day Brief: the dated note says paused, not couldn't update",
      /Today’s Brief is paused for maintenance/.test(prior) && !/Couldn’t update/.test(prior) && /Last successful Brief/.test(prior));
    check("COULD_NOT_UPDATE still says Couldn't update", /Couldn’t update/.test(render(brief(), "COULD_NOT_UPDATE")));
  }

  console.log("\n6. the client's words and code match the server's");
  {
    const src = readFileSync(path.join(process.cwd(), "lib/platform/ai/paid-requests-admission.ts"), "utf8");
    check("AI_PAUSED_CODE", src.includes(`AI_PAUSED_CODE = "${AI_PAUSED_CODE}"`));
    check("the customer sentence", src.includes(`"${BRIEF_PAUSED_MESSAGE}"`));
    const client = readFileSync(path.join(process.cwd(), "components/brief/DailyBriefClient.tsx"), "utf8");
    check("the empty paused panel is a status, not an alert", /phase === "PAUSED" \? \(\s*<BriefError message=\{BRIEF_PAUSED_MESSAGE\}[^>]*role="status"/.test(client));
  }

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
