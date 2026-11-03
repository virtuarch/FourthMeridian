/**
 * lib/presence/heartbeat-client.test.ts  (PB-10 follow-ups — the client controller)
 *
 *   · first beat is IMMEDIATE on mount when visible (not after an interval)
 *   · hidden tab sends nothing
 *   · F1: a 429 / 5xx / network failure RESTORES the pending interaction, so the
 *     next beat carries it; 401/403 stop the heartbeat
 *   · an interaction only marks the flag; the next interval beat carries it
 *   · F4: becoming visible is presence only (interacted=false) — macOS flips
 *     visibility on occlusion / lock; a pending flag older than 2 × interval is dropped
 *   · the body is only ever {"interacted": boolean}
 *
 *     npx tsx lib/presence/heartbeat-client.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { createHeartbeatController, STALE_INTERACTION_MS, type BeatOutcome } from "./heartbeat-client";
import { PRESENCE_CONFIG } from "./definitions";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function rig(opts: { visible?: boolean } = {}) {
  let clock = 1_000_000;
  let visible = opts.visible ?? true;
  const sent: string[] = [];
  const replies: BeatOutcome[] = [];
  const c = createHeartbeatController({
    now: () => clock,
    isVisible: () => visible,
    send: async (body) => { sent.push(body); return replies.shift() ?? { status: 204 }; },
  });
  return {
    c, sent, replies,
    advance(ms: number) { clock += ms; },
    setVisible(v: boolean) { visible = v; },
    carried: (i: number) => (JSON.parse(sent[i]) as { interacted: boolean }).interacted,
  };
}

async function main() {
  console.log("PB-10 follow-ups — heartbeat client\n\nfirst beat");
  {
    const r = rig();
    await r.c.mount();
    check("first beat is sent IMMEDIATELY on mount (no interval wait)", r.sent.length === 1);
    check("…carrying interacted=false (a page load is not proof of a human)", r.carried(0) === false);
    check("the body is exactly {\"interacted\":boolean}", r.sent[0] === '{"interacted":false}');
    const h = rig({ visible: false });
    await h.c.mount(); h.c.interaction(); await h.c.tick();
    check("a hidden tab sends nothing (mount, interaction or tick)", h.sent.length === 0);
  }

  console.log("\ninteractions ride the interval");
  {
    const r = rig();
    await r.c.mount();
    r.advance(5_000); r.c.interaction(); r.c.interaction();
    check("an interaction never sends a beat by itself", r.sent.length === 1);
    r.advance(PRESENCE_CONFIG.clientBeatIntervalMs); await r.c.tick();
    check("the interval beat carries it", r.sent.length === 2 && r.carried(1) === true);
    r.advance(PRESENCE_CONFIG.clientBeatIntervalMs); await r.c.tick();
    check("no input since ⇒ the next interval beat is idle", r.carried(2) === false);
  }

  console.log("\nF1 — a refused or lost beat keeps its interaction");
  for (const [label, reply] of [
    ["429 (bucket shared by another tab)", { status: 429 }],
    ["503", { status: 503 }],
    ["network failure", { networkError: true }],
  ] as const) {
    const r = rig();
    await r.c.mount();
    r.c.interaction();
    r.advance(PRESENCE_CONFIG.clientBeatIntervalMs);
    r.replies.push(reply as BeatOutcome);
    await r.c.tick();                        // carried=true, refused/lost
    check(`${label}: the interaction is restored after the failed beat`, r.c.state().interacted === true && r.carried(1) === true);
    r.advance(PRESENCE_CONFIG.clientBeatIntervalMs); await r.c.tick();
    check(`${label}: the next beat carries it`, r.carried(2) === true);
    check(`${label}: the heartbeat keeps running`, r.c.state().stopped === false);
  }
  {
    const r = rig();
    r.replies.push({ status: 429 });
    await r.c.mount();                       // idle beat refused
    check("a refused IDLE beat does not invent an interaction", r.c.state().interacted === false);
    const t = rig();
    await t.c.mount(); t.c.interaction();
    t.advance(10_000);
    t.replies.push({ networkError: true });
    await t.c.visible();
    check("a REAL pending input survives a lost visible beat", t.c.state().interacted === true && t.carried(1) === true);
    const th = rig();
    const first = th.c.mount();              // in flight, not awaited
    await th.c.tick();
    await first;
    check("no concurrent beat while one is in flight", th.sent.length === 1);
  }

  console.log("\nF4 — visibility is presence, never an interaction");
  {
    const r = rig();
    await r.c.mount();
    r.setVisible(false);
    r.advance(6 * 60_000);                   // occluded / locked, nobody at the tab
    await r.c.tick();
    check("hidden: no beat", r.sent.length === 1);
    r.setVisible(true);
    await r.c.visible();                     // macOS uncovers the window / unlocks
    check("visible again ⇒ an immediate presence beat", r.sent.length === 2);
    check("…carrying interacted=FALSE (no human input)", r.carried(1) === false);
    r.c.interaction();                       // the human actually clicks
    r.advance(PRESENCE_CONFIG.clientBeatIntervalMs); await r.c.tick();
    check("returning shows Active now only after a real input (next beat carries it)", r.carried(2) === true);
    const src = readFileSync(path.join(process.cwd(), "components/presence/PresenceHeartbeat.tsx"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    check("visibility is not in INTERACTION_EVENTS and the visibility handler only calls visible()",
      !/visibilitychange|focus/.test(/INTERACTION_EVENTS = \[([^\]]*)\]/.exec(src)?.[1] ?? "x")
      && /const onVisibility = \(\) => \{ if \(document\.visibilityState === "visible"\) void controller\.visible\(\); \};/.test(src));
  }
  {
    const r = rig();
    await r.c.mount();
    r.c.interaction();                       // real input …
    r.setVisible(false);                     // … then the tab is hidden before the next beat
    r.advance(STALE_INTERACTION_MS);
    r.setVisible(true); await r.c.visible();
    check("a pending input exactly at the cap is still carried", r.carried(1) === true);
    const q = rig();
    await q.c.mount();
    q.c.interaction();
    q.setVisible(false);
    q.advance(STALE_INTERACTION_MS + 1);
    q.setVisible(true); await q.c.visible();
    check("STALE CAP: a pending input older than 2 × interval (by INPUT time) is dropped", q.carried(1) === false && q.c.state().interacted === false);
    check("the cap is 2 × the client interval", STALE_INTERACTION_MS === 2 * PRESENCE_CONFIG.clientBeatIntervalMs);
    const o = rig();
    await o.c.mount();
    o.advance(30_000); o.c.interaction();    // real input
    for (let i = 0; i < 3; i++) { o.replies.push({ networkError: true }); o.advance(PRESENCE_CONFIG.clientBeatIntervalMs); await o.c.tick(); }
    o.advance(PRESENCE_CONFIG.clientBeatIntervalMs); await o.c.tick();
    check("an outage cannot carry an old input forward: 3 lost beats later it is dropped (age of the input)",
      o.carried(1) === true && o.carried(4) === false, JSON.stringify(o.sent));
    const f = rig();
    await f.c.mount(); f.c.interaction();
    f.advance(PRESENCE_CONFIG.clientBeatIntervalMs);
    f.replies.push({ status: 429 });
    await f.c.tick();
    f.advance(PRESENCE_CONFIG.clientBeatIntervalMs); await f.c.tick();
    check("F1 still holds under the cap: a 429'd input is carried by the next interval beat", f.carried(2) === true);
  }

  {
    // S2 — restore, wait > 2 × interval, the next beat sends interacted:false.
    for (const reply of [{ status: 429 }, { status: 503 }, { networkError: true }] as BeatOutcome[]) {
      const r = rig();
      await r.c.mount();
      r.c.interaction();                     // input at T
      r.replies.push(reply);
      await r.c.visible();                   // carried, refused/lost ⇒ restored with age from T
      check(`${JSON.stringify(reply)}: restored`, r.carried(1) === true && r.c.state().interacted === true);
      r.advance(STALE_INTERACTION_MS + 1);
      await r.c.tick();
      check(`${JSON.stringify(reply)}: > 2 × interval after the INPUT, the next beat sends interacted:false`, r.carried(2) === false, JSON.stringify(r.sent));
    }
    // Age is the input's, not the beat's: last beat long ago, input recent ⇒ carried.
    const a = rig();
    await a.c.mount();
    a.setVisible(false);
    a.advance(10 * 60_000);
    a.c.interaction();                       // input while hidden (e.g. keyboard focus) just before return
    a.advance(5_000);
    a.setVisible(true); await a.c.visible();
    check("a recent input is carried even when the last beat was long ago (age from the input)", a.carried(1) === true);
  }

  console.log("\nstop conditions");
  for (const status of [401, 403]) {
    const r = rig();
    r.replies.push({ status });
    await r.c.mount();
    r.advance(PRESENCE_CONFIG.clientBeatIntervalMs); await r.c.tick(); await r.c.visible();
    check(`${status} stops the heartbeat`, r.c.state().stopped === true && r.sent.length === 1);
  }
  {
    const r = rig();
    await r.c.mount(); r.c.stop();
    r.advance(PRESENCE_CONFIG.clientBeatIntervalMs); await r.c.tick();
    check("unmount (stop) ends beating", r.sent.length === 1);
  }

  console.log("\nprivacy (static)");
  {
    const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const comp = read("components/presence/PresenceHeartbeat.tsx");
    const ctl = read("lib/presence/heartbeat-client.ts");
    check("handlers take no event argument (nothing is read from the event)",
      /const onInteraction = \(\) =>/.test(comp) && !/\.(key|code|clientX|clientY|pageX|target|which)\b/.test(comp + ctl));
    check("no time, URL or page content is sent", !/Date\.now\(\)\s*[,}]|location|href|innerText|textContent/.test(ctl) && /JSON\.stringify\(\{ interacted: carried \}\)/.test(ctl));
  }
}

main().then(() => {
  if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
  console.log("\nAll heartbeat-client checks passed.");
}, (e) => { console.error(e); process.exit(1); });
