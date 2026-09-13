/**
 * components/brief/brief-flow.test.ts
 *
 * THE BRIEF PAGE'S FLOW — skeleton, stale-while-refresh, bounded polling, failure,
 * rechecks, and abort — driven with a fake clock and a scripted transport.
 * No React, no DOM: the controller is the flow; the component only wires it.
 *
 *   npx tsx components/brief/brief-flow.test.ts
 */

import type { BriefArtifactView, BriefResponse, BriefState } from "@/lib/brief-types";
import {
  BRIEF_POLL_INTERVAL_MS, BRIEF_POLL_MAX_MS, BRIEF_RECHECK_THROTTLE_MS,
  createBriefController, type BriefClock, type BriefTransport, type BriefView,
} from "./brief-flow";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

function fakeClock(start = Date.parse("2026-09-13T12:00:00.000Z")) {
  let t = start;
  const timers: { at: number; fn: () => void }[] = [];
  const clock: BriefClock & { advance(ms: number): Promise<void>; pending(): number } = {
    now: () => t,
    setTimeout: (fn, ms) => { const h = { at: t + ms, fn }; timers.push(h); return h; },
    clearTimeout: (h) => { const i = timers.indexOf(h as never); if (i >= 0) timers.splice(i, 1); },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = next.at;
        next.fn();
        await flush();
      }
      t = end;
      await flush();
    },
    pending: () => timers.length,
  };
  return clock;
}

const SPACE = "space_A";
const brief = (headline: string, over: Partial<BriefArtifactView> = {}): BriefArtifactView => ({
  briefDay: "2026-09-13", fromPriorDay: false, generatedAt: "2026-09-13T08:00:00.000Z", balancesAsOf: null,
  balancesMayBeStale: false, headline, quiet: true, observations: [], ...over,
});
const res = (state: BriefState, over: Partial<BriefResponse> = {}): BriefResponse => ({
  spaceId: SPACE, state, brief: null, checkedAt: "2026-09-13T12:00:00.000Z",
  needsGeneration: state === "CHECK_REQUIRED" || state === "STALE" || state === "ABSENT", ...over,
});

type Step = BriefResponse | Error | Promise<BriefResponse>;
function script(get: Step[], generate: Step[] = []) {
  const calls = { get: 0, generate: 0, signals: [] as AbortSignal[] };
  const take = (queue: Step[], kind: string, signal: AbortSignal) => {
    calls.signals.push(signal);
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (!next) throw new Error(`no scripted ${kind}`);
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  };
  const transport: BriefTransport = {
    get: (_s, signal) => { calls.get++; return take(get, "get", signal); },
    generate: (_s, signal) => { calls.generate++; return take(generate, "generate", signal); },
  };
  return { transport, calls };
}

function run(get: Step[], generate: Step[] = [], initial: BriefResponse | null = null) {
  const clock = fakeClock();
  const s = script(get, generate);
  const views: BriefView[] = [];
  const controller = createBriefController({ spaceId: SPACE, initial, transport: s.transport, clock, onView: (v) => views.push(v) });
  return { clock, calls: s.calls, views, controller, phases: () => views.map((v) => v.phase) };
}

async function main() {
  console.log("1. a current Brief");
  {
    const r = run([res("FRESH", { brief: brief("Quiet day.") })]);
    r.controller.start(); await flush();
    check("GET → SHOWING, no POST", r.controller.view().phase === "SHOWING" && r.calls.generate === 0 && r.controller.view().brief?.headline === "Quiet day.");

    const ssr = run([res("FRESH", { brief: brief("from GET") })], [], res("FRESH", { brief: brief("from the server render"), checkedAt: new Date(Date.parse("2026-09-13T12:00:00.000Z") - 1000).toISOString() }));
    ssr.controller.start(); await flush();
    check("a just-rendered server state is used as is — no extra GET", ssr.calls.get === 0 && ssr.controller.view().brief?.headline === "from the server render");
    const restored = run([res("FRESH", { brief: brief("re-read") })], [], res("FRESH", { brief: brief("old render"), checkedAt: "2026-09-13T11:00:00.000Z" }));
    restored.controller.start(); await flush();
    check("an old server state (history restore) is re-read", restored.calls.get === 1 && restored.controller.view().brief?.headline === "re-read");
  }

  console.log("\n2. first ever: skeleton, generate, swap in");
  {
    const r = run([res("ABSENT")], [res("FRESH", { brief: brief("Your first brief.") })]);
    r.controller.start(); await flush();
    check("ABSENT → GENERATING with nothing on screen → SHOWING", r.phases().join() === "GENERATING,SHOWING"
      && r.views[0].brief === null && r.controller.view().brief?.headline === "Your first brief.");
    check("…one POST", r.calls.generate === 1);
  }

  console.log("\n3. stale while refresh");
  {
    const r = run([res("STALE", { brief: brief("Yesterday.", { fromPriorDay: true, briefDay: "2026-09-12" }) })], [res("FRESH", { brief: brief("Today.") })]);
    r.controller.start(); await flush();
    check("the old Brief stays on screen while updating", r.views[0].phase === "UPDATING" && r.views[0].brief?.headline === "Yesterday.");
    check("…and is replaced when the new one arrives", r.controller.view().phase === "SHOWING" && r.controller.view().brief?.headline === "Today.");
    const same = run([res("CHECK_REQUIRED", { brief: brief("Still true.") })], [res("FRESH", { brief: brief("Still true.") })]);
    same.controller.start(); await flush();
    check("a digest-equal check settles quietly on the same Brief", same.phases().join() === "UPDATING,SHOWING" && same.controller.view().brief?.headline === "Still true.");
  }

  console.log("\n4. someone else is generating: bounded polling");
  {
    const r = run(
      [res("ABSENT"), res("IN_PROGRESS"), res("IN_PROGRESS"), res("FRESH", { brief: brief("Done elsewhere.") })],
      [res("IN_PROGRESS")],
    );
    r.controller.start(); await flush();
    check("POST lost the claim → WAITING", r.controller.view().phase === "WAITING" && r.calls.generate === 1);
    await r.clock.advance(BRIEF_POLL_INTERVAL_MS); await r.clock.advance(BRIEF_POLL_INTERVAL_MS); await r.clock.advance(BRIEF_POLL_INTERVAL_MS);
    check("…polls GET every 2 s until the Brief appears", r.controller.view().phase === "SHOWING" && r.calls.get === 4
      && r.controller.view().brief?.headline === "Done elsewhere.");
    check("…never a second POST while it waited", r.calls.generate === 1);

    const forever = run([res("IN_PROGRESS", { brief: brief("Shown meanwhile.") })]);
    forever.controller.start(); await flush();
    await forever.clock.advance(BRIEF_POLL_MAX_MS + BRIEF_POLL_INTERVAL_MS * 2);
    check("…and stops at the cap, keeping the Brief, with nothing left scheduled",
      forever.controller.view().phase === "COULD_NOT_UPDATE" && forever.controller.view().brief?.headline === "Shown meanwhile."
        && forever.clock.pending() === 0 && forever.calls.get <= 1 + BRIEF_POLL_MAX_MS / BRIEF_POLL_INTERVAL_MS + 1, `${forever.calls.get} GETs`);
    const getsAtCap = forever.calls.get;
    await forever.clock.advance(60_000);
    check("…and does not poll after stopping", forever.calls.get === getsAtCap);

    const expired = run([res("ABSENT"), res("ABSENT")], [res("IN_PROGRESS"), res("FRESH", { brief: brief("Took over.") })]);
    expired.controller.start(); await flush(); await expired.clock.advance(BRIEF_POLL_INTERVAL_MS);
    check("if the other claim expired without a Brief, one more POST — no more", expired.controller.view().brief?.headline === "Took over." && expired.calls.generate === 2);
    const loop = run([res("STALE", { brief: brief("Old.") })], [res("STALE", { brief: brief("Old.") })]);
    loop.controller.start(); await flush();
    check("a server that keeps asking is not obeyed forever (two POSTs, then stop)", loop.calls.generate === 2 && loop.controller.view().phase === "COULD_NOT_UPDATE");
  }

  console.log("\n5. failure");
  {
    const r = run([res("STALE", { brief: brief("Keep me.") })], [res("FAILED", { brief: brief("Keep me."), retryAfterMs: 180_000 })]);
    r.controller.start(); await flush();
    const v = r.controller.view();
    check("with a Brief → COULD_NOT_UPDATE, the Brief kept", v.phase === "COULD_NOT_UPDATE" && v.brief?.headline === "Keep me.");
    check("…and a retry time from the server's cooldown", v.retryAt === r.clock.now() + 180_000);
    r.controller.retry(); await flush();
    check("…retry is withheld during the cooldown", r.calls.generate === 1);
    await r.clock.advance(180_000);
    r.controller.retry(); await flush();
    check("…and allowed after it", r.calls.generate === 2);

    const empty = run([res("ABSENT")], [res("FAILED", { retryAfterMs: 180_000 })]);
    empty.controller.start(); await flush();
    check("with nothing → FAILED_EMPTY", empty.controller.view().phase === "FAILED_EMPTY" && empty.controller.view().brief === null);
    empty.controller.onVisible(); empty.controller.retry(); await flush();
    check("…and neither a return to the tab nor a retry hammers the model", empty.calls.generate === 1);

    const cooling = run([res("FAILED", { retryAfterMs: 60_000 })]);
    cooling.controller.start(); await flush();
    check("a GET that reports a cooldown starts no POST", cooling.calls.generate === 0 && cooling.controller.view().phase === "FAILED_EMPTY");

    const down = run([new Error("503")]);
    down.controller.start(); await flush();
    check("a failed read with nothing to show → LOAD_ERROR", down.controller.view().phase === "LOAD_ERROR");
  }

  console.log("\n6. returning to the tab");
  {
    const r = run([res("FRESH", { brief: brief("Morning.") }), res("STALE", { brief: brief("Morning.") })], [res("FRESH", { brief: brief("Afternoon.") })]);
    r.controller.start(); await flush();
    r.controller.onVisible(); await flush();
    check("a visibility event within a minute is ignored", r.calls.get === 1);
    await r.clock.advance(BRIEF_RECHECK_THROTTLE_MS);
    r.controller.onVisible(); await flush();
    check("after a minute it re-reads — and follows the answer", r.calls.get === 2 && r.calls.generate === 1 && r.controller.view().brief?.headline === "Afternoon.");
    await r.clock.advance(BRIEF_RECHECK_THROTTLE_MS);
    const fresh = run([res("FRESH", { brief: brief("Same.") })]);
    fresh.controller.start(); await flush(); await fresh.clock.advance(BRIEF_RECHECK_THROTTLE_MS);
    fresh.controller.onVisible(); await flush();
    check("a recheck that finds the Brief current does nothing more", fresh.calls.get === 2 && fresh.calls.generate === 0 && fresh.controller.view().phase === "SHOWING");

    let release!: (r: BriefResponse) => void;
    const held = new Promise<BriefResponse>((resolve) => { release = resolve; });
    const busy = run([res("ABSENT")], [held]);
    busy.controller.start(); await flush(); await busy.clock.advance(BRIEF_RECHECK_THROTTLE_MS * 2);
    busy.controller.onVisible(); await flush();
    check("a visibility event during a generation starts nothing", busy.calls.get === 1 && busy.calls.generate === 1);
    release(res("FRESH", { brief: brief("ok") })); await flush();
  }

  console.log("\n7. abort and Space safety");
  {
    let release!: (r: BriefResponse) => void;
    const held = new Promise<BriefResponse>((resolve) => { release = resolve; });
    const r = run([res("ABSENT")], [held]);
    r.controller.start(); await flush();
    const seen = r.views.length;
    r.controller.dispose();
    check("dispose aborts the in-flight request", r.calls.signals.every((s) => s.aborted));
    release(res("FRESH", { brief: brief("too late") })); await flush();
    check("…and a late answer never reaches the page", r.views.length === seen && r.views.every((v) => v.brief?.headline !== "too late"));

    const polling = run([res("IN_PROGRESS")]);
    polling.controller.start(); await flush();
    polling.controller.dispose();
    await polling.clock.advance(BRIEF_POLL_INTERVAL_MS * 5);
    check("dispose during polling clears the timer and stops the GETs", polling.clock.pending() === 0 && polling.calls.get === 1);

    const foreign = run([{ ...res("FRESH", { brief: brief("Other Space's Brief") }), spaceId: "space_B" }]);
    foreign.controller.start(); await flush();
    check("a response naming another Space is never shown", foreign.views.every((v) => v.brief?.headline !== "Other Space's Brief")
      && foreign.calls.generate === 0);
  }

  console.log("\n7b. the second clock survives a generation response");
  {
    const health = { sources: [], groups: [], attention: 0 } as NonNullable<BriefResponse["dataHealth"]>;
    const r = run([res("CHECK_REQUIRED", { brief: brief("Old."), dataHealth: health, metrics: null })], [res("FRESH", { brief: brief("New.") })]);
    r.controller.start(); await flush();
    const last = r.views[r.views.length - 1];
    check("data health read by GET is kept after the POST that carries none", last.brief?.headline === "New." && last.dataHealth === health);
  }

  console.log("\n8. no data");
  {
    const r = run([res("NO_DATA")]);
    r.controller.start(); await flush();
    check("NO_DATA → onboarding, no POST", r.controller.view().phase === "NO_DATA" && r.calls.generate === 0);
  }

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
