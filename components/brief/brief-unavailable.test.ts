/**
 * components/brief/brief-unavailable.test.ts  (AI RELIABILITY — F4)
 *
 * When the allowance or pacing store COULD NOT BE CHECKED (2026-10-25 Preview:
 * 503 `AI_ALLOWANCE` / `retryable: true`), the Brief says "briefly unavailable"
 * neutrally — not "Couldn't update", not "paused for maintenance":
 *   1. only 503 + a retryable gate code + retryable:true is UNAVAILABLE; a pause
 *      stays PAUSED; allowance used up (429), unpriced, other 5xx stay ordinary;
 *   2. no server text is carried or shown;
 *   3. the Brief on screen is kept; nothing re-asks during the hold (≥ 1 min,
 *      ≤ 5 min); after the hold one retry is one POST;
 *   4. rendered in the neutral tone with its own sentence.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/brief/brief-unavailable.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BriefArtifactView, BriefMetricsView, BriefResponse, BriefState } from "@/lib/brief-types";
import {
  BRIEF_RECHECK_THROTTLE_MS, BRIEF_UNAVAILABLE_MAX_HOLD_MS, BRIEF_UNAVAILABLE_MESSAGE, BRIEF_UNAVAILABLE_MIN_HOLD_MS,
  BriefUnavailableError, RETRYABLE_GATE_CODES, classifyBriefRefusal, createBriefController, httpBriefTransport, unavailableHoldMs,
  type BriefClock, type BriefTransport, type BriefView,
} from "./brief-flow";
import { BriefBody } from "./DailyBriefClient";
import { ALLOWANCE_CODE, RESERVATION_RETRY_AFTER_SECONDS, allowanceRefusalBody, type AllowanceVerdict } from "@/lib/ai/allowance-core";
import { PACING_UNAVAILABLE_CODE, pacingResponse } from "@/lib/ai/pacing";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const refused = (reason: string) =>
  ({ allowed: false, reason, unpricedInvocations: 0, spentUsd: 1, allowanceUsd: 5, enforced: true, reservation: "NONE", inFlight: 0 }) as unknown as Extract<AllowanceVerdict, { allowed: false }>;

function fakeClock(start = Date.parse("2026-10-25T21:28:00.000Z")) {
  let t = start;
  const timers: unknown[] = [];
  return {
    now: () => t, setTimeout: (_fn: () => void, _ms: number) => { const h = {}; timers.push(h); return h; },
    clearTimeout: (h: unknown) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    advance(ms: number) { t += ms; }, pending: () => timers.length,
  } satisfies BriefClock & Record<string, unknown>;
}
const SPACE = "space_A";
const brief = (over: Partial<BriefArtifactView> = {}): BriefArtifactView => ({
  briefDay: "2026-10-25", fromPriorDay: false, generatedAt: "2026-10-25T19:52:00.000Z", balancesAsOf: null,
  balancesMayBeStale: false, headline: "Spending ran close to your usual pace.", quiet: true, observations: [], ...over,
});
const res = (state: BriefState, over: Partial<BriefResponse> = {}): BriefResponse => ({
  spaceId: SPACE, state, brief: null, checkedAt: "2026-10-25T21:28:00.000Z",
  needsGeneration: state === "CHECK_REQUIRED" || state === "STALE" || state === "ABSENT", ...over,
});
function harness(get: BriefResponse, generate: () => Promise<BriefResponse>) {
  const clock = fakeClock(); const calls = { get: 0, generate: 0 };
  const transport: BriefTransport = { get: async () => { calls.get++; return get; }, generate: () => { calls.generate++; return generate(); } };
  const views: BriefView[] = [];
  const controller = createBriefController({ spaceId: SPACE, initial: null, transport, clock, onView: (v) => views.push(v) });
  return { clock, calls, views, controller };
}

async function main() {
  console.log("1. classification, from the producers' real bodies");
  {
    const unavailable = allowanceRefusalBody(refused("RESERVATION_UNAVAILABLE"), "The Daily Brief");
    check("503 allowance couldn't be checked ⇒ UNAVAILABLE", (await classifyBriefRefusal(json(503, unavailable)))?.kind === "UNAVAILABLE");
    const ledger = allowanceRefusalBody(refused("LEDGER_UNTRUSTED"), "The Daily Brief");
    check("503 ledger untrusted (retryable) ⇒ UNAVAILABLE", (await classifyBriefRefusal(json(503, ledger)))?.kind === "UNAVAILABLE");
    const pacingBody = await pacingResponse({ status: "unavailable" }, "The Daily Brief")!.json();
    check("503 pacing couldn't be checked ⇒ UNAVAILABLE", (await classifyBriefRefusal(json(503, pacingBody)))?.kind === "UNAVAILABLE");
    check("503 AI_PAUSED ⇒ PAUSED (unchanged)", (await classifyBriefRefusal(json(503, { error: "x", code: "AI_PAUSED" })))?.kind === "PAUSED");
    const exhausted = allowanceRefusalBody(refused("ALLOWANCE_EXHAUSTED"), "The Daily Brief");
    check("429 allowance used up ⇒ ordinary (not unavailable)", (await classifyBriefRefusal(json(429, exhausted))) === null);
    const unpriced = allowanceRefusalBody(refused("UNPRICED_MODEL"), "The Daily Brief");
    check("503 unpriced (not retryable) ⇒ ordinary", (await classifyBriefRefusal(json(503, unpriced))) === null);
    check("503 AI_ALLOWANCE without retryable:true ⇒ ordinary", (await classifyBriefRefusal(json(503, { code: "AI_ALLOWANCE" }))) === null);
    check("500 claiming a retryable code ⇒ ordinary", (await classifyBriefRefusal(json(500, { code: "AI_ALLOWANCE", retryable: true }))) === null);
    check("503 HTML ⇒ ordinary", (await classifyBriefRefusal(new Response("<html/>", { status: 503 }))) === null);
    check("the client's gate codes are the server's", RETRYABLE_GATE_CODES.join() === [ALLOWANCE_CODE, PACING_UNAVAILABLE_CODE].join());
  }

  console.log("\n2. the hold is bounded and carries no server text");
  {
    check("the server's 15 s hint is raised to the 1-minute floor", unavailableHoldMs(RESERVATION_RETRY_AFTER_SECONDS) === BRIEF_UNAVAILABLE_MIN_HOLD_MS);
    check("a huge hint is capped at 5 minutes", unavailableHoldMs(86_400) === BRIEF_UNAVAILABLE_MAX_HOLD_MS);
    check("a missing or junk hint gets the floor", unavailableHoldMs(undefined) === BRIEF_UNAVAILABLE_MIN_HOLD_MS && unavailableHoldMs("9") === BRIEF_UNAVAILABLE_MIN_HOLD_MS);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => json(503, { error: "internal: rateLimit.upsert 25006", code: "AI_ALLOWANCE", retryable: true, retryAfterSeconds: 15 })) as typeof fetch;
    let err: unknown = null;
    try { await httpBriefTransport.generate(SPACE, new AbortController().signal); } catch (e) { err = e; }
    globalThis.fetch = realFetch;
    check("the transport throws BriefUnavailableError", err instanceof BriefUnavailableError);
    check("…carrying none of the server's text", err instanceof Error && !/25006|upsert|internal/.test(err.message));
  }

  console.log("\n3. the Brief is kept and nothing re-asks during the hold");
  {
    const h = harness(res("STALE", { brief: brief() }), () => Promise.reject(new BriefUnavailableError(BRIEF_UNAVAILABLE_MIN_HOLD_MS)));
    h.controller.start(); await flush();
    const v = h.controller.view();
    check("STALE ⇒ one POST ⇒ UNAVAILABLE, Brief kept", v.phase === "UNAVAILABLE" && v.brief !== null && h.calls.generate === 1, v.phase);
    check("never shown as Couldn't update or paused", !h.views.some((x) => x.phase === "COULD_NOT_UPDATE" || x.phase === "PAUSED"));
    check("no timer left to retry on its own", h.clock.pending() === 0);
    h.clock.advance(BRIEF_RECHECK_THROTTLE_MS - 1); h.controller.onVisible(); await flush();
    h.controller.retry(); await flush();
    check("a visibility event and a retry click during the hold send nothing", h.calls.get === 1 && h.calls.generate === 1);
    h.clock.advance(BRIEF_UNAVAILABLE_MIN_HOLD_MS); h.controller.retry(); await flush();
    check("after the hold, one retry ⇒ exactly one POST", h.calls.generate === 2);
    const empty = harness(res("ABSENT"), () => Promise.reject(new BriefUnavailableError(BRIEF_UNAVAILABLE_MIN_HOLD_MS)));
    empty.controller.start(); await flush();
    check("nothing to show ⇒ UNAVAILABLE without a Brief (the empty panel)", empty.controller.view().phase === "UNAVAILABLE" && empty.controller.view().brief === null);
  }

  console.log("\n4. rendered neutrally, with its own sentence");
  {
    const metrics = { currency: "USD", netWorth: 1000, asOf: "2026-10-25", estimated: false, monthChange: null } as BriefMetricsView;
    const render = (b: BriefArtifactView) => renderToStaticMarkup(createElement(BriefBody, { brief: b, metrics, dataHealth: null, phase: "UNAVAILABLE" }));
    const html = render(brief());
    check("says Briefly unavailable in the polite status region", /role="status" aria-live="polite"[^>]*>[\s\S]*?Briefly unavailable/.test(html));
    check("…in the neutral tone", !/accent-warning[^"]*">Briefly/.test(html));
    check("shows its sentence and keeps the Brief's words", html.includes(BRIEF_UNAVAILABLE_MESSAGE) && html.includes("Spending ran close to your usual pace."));
    check("never says Couldn't update or paused for maintenance", !/Couldn’t update/.test(html) && !/paused for maintenance/i.test(html));
    const prior = render(brief({ fromPriorDay: true, briefDay: "2026-10-24" }));
    check("a prior-day Brief's note says briefly unavailable", /Today’s Brief is briefly unavailable/.test(prior) && !/Couldn’t update/.test(prior));
    check("the sentence names no internal detail", !/allowance|budget|database|provider|rate/i.test(BRIEF_UNAVAILABLE_MESSAGE));
  }

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
