/**
 * lib/presence/heartbeat-client.test.ts  (PB-10 follow-ups — the client controller)
 *
 *   · first beat is IMMEDIATE on mount when visible (not after an interval)
 *   · hidden tab sends nothing
 *   · F1: a 429 / 5xx / network failure RESTORES the pending interaction, so the
 *     next beat carries it; 401/403 stop the heartbeat
 *   · an interaction only marks the flag; the next interval beat carries it
 *   · the body is only ever {"interacted": boolean}
 *
 *     npx tsx lib/presence/heartbeat-client.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { createHeartbeatController, type BeatOutcome } from "./heartbeat-client";
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
    t.replies.push({ networkError: true });
    await t.c.visible();
    check("the tab-became-visible interaction survives a lost beat", t.c.state().interacted === true);
    const th = rig();
    const first = th.c.mount();              // in flight, not awaited
    await th.c.tick();
    await first;
    check("no concurrent beat while one is in flight", th.sent.length === 1);
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
