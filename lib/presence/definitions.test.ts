/**
 * lib/presence/definitions.test.ts  (PB-10 — the presence state machine)
 *
 *     npx tsx lib/presence/definitions.test.ts
 */

import {
  PRESENCE_CONFIG, PRESENCE_LABELS, PRESENCE_EXPLANATION, ENGAGEMENT_WINDOW_DAYS,
  derivePresenceState, foldPresenceClocks, lastActiveBucket,
} from "./definitions";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const NOW = new Date("2026-11-03T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;
const P = PRESENCE_CONFIG.presenceFreshMs;
const I = PRESENCE_CONFIG.interactionActiveMs;
const st = (p: Date | null, i: Date | null, now = NOW) => derivePresenceState({ lastPresenceAt: p, lastInteractionAt: i }, now);

console.log("PB-10 — presence definitions\n\nconfig");
check("one config set with the approved thresholds",
  PRESENCE_CONFIG.clientBeatIntervalMs === 60_000 && PRESENCE_CONFIG.serverThrottleSeconds === 20
  && PRESENCE_CONFIG.rateLimit.limit === 1 && PRESENCE_CONFIG.rateLimit.windowSec === 30
  && P === 3 * MIN && I === 5 * MIN);
check("presence outlives at least two missed beats (no flapping on one dropped request)", P >= 2 * PRESENCE_CONFIG.clientBeatIntervalMs);
check("the server throttle is finer than the client interval (a visible tab's beats all land)",
  PRESENCE_CONFIG.serverThrottleSeconds * 1000 < PRESENCE_CONFIG.clientBeatIntervalMs);
check("the rate-limit window admits the client cadence", PRESENCE_CONFIG.rateLimit.windowSec * 1000 <= PRESENCE_CONFIG.clientBeatIntervalMs);
// Documented semantics (S2/Session 1 observation: 204 at +47 s and +61 s, 429 at +76 s):
// the window is FIXED and epoch-aligned, so beats straddling a boundary both pass.
{
  const bucket = (t: number) => Math.floor(t / (PRESENCE_CONFIG.rateLimit.windowSec * 1000));
  const b47 = 1_800_000_047_000, b61 = b47 + 14_000, b76 = b47 + 29_000;
  check("fixed window: +47 s and +61 s fall in different aligned buckets (both admitted)", bucket(b47) !== bucket(b61));
  check("fixed window: +61 s and +76 s share one (the second is refused)", bucket(b61) === bucket(b76));
}
check("DAU/WAU/MAU windows are 1/7/30 UTC days", ENGAGEMENT_WINDOW_DAYS.dau === 1 && ENGAGEMENT_WINDOW_DAYS.wau === 7 && ENGAGEMENT_WINDOW_DAYS.mau === 30);
check("labels", PRESENCE_LABELS.ACTIVE === "Active now" && PRESENCE_LABELS.IDLE === "Online, idle" && PRESENCE_LABELS.OFFLINE === "Offline" && PRESENCE_LABELS.UNKNOWN === "Unknown");
check("the explanation says a signed-in session alone is not online", /session alone is not counted as online/.test(PRESENCE_EXPLANATION));

console.log("\nstate machine — boundaries");
check("no beat ever ⇒ UNKNOWN", st(null, null) === "UNKNOWN");
check("no beat ever, even with an interaction clock ⇒ UNKNOWN (presence is required)", st(null, ago(MIN)) === "UNKNOWN");
check("presence fresh + interaction now ⇒ ACTIVE", st(ago(0), ago(0)) === "ACTIVE");
check("interaction exactly at the active threshold ⇒ ACTIVE (inclusive)", st(ago(MIN), ago(I)) === "ACTIVE");
check("interaction 1 ms past the threshold ⇒ IDLE", st(ago(MIN), ago(I + 1)) === "IDLE");
check("presence fresh, never interacted ⇒ IDLE", st(ago(MIN), null) === "IDLE");
check("presence exactly at the fresh threshold ⇒ still online", st(ago(P), ago(P)) === "ACTIVE");
check("presence 1 ms past the fresh threshold ⇒ OFFLINE, however recent the interaction", st(ago(P + 1), ago(P + 1)) === "OFFLINE");
check("a future clock (skew) is age 0, not negative", st(new Date(NOW.getTime() + 5_000), new Date(NOW.getTime() + 5_000)) === "ACTIVE");

console.log("\nscenarios");
{
  // Hidden tab: beats stop when hidden (client), so presence expires on time.
  const lastBeat = ago(0);
  check("hidden tab: online right after its last visible beat", st(lastBeat, lastBeat) === "ACTIVE");
  check("hidden tab: OFFLINE once presenceFreshMs passes with no beat",
    st(lastBeat, lastBeat, new Date(NOW.getTime() + P + 1)) === "OFFLINE");
  // Idle visible tab: beats continue with interacted=false ⇒ presence fresh, interaction ages.
  check("visible idle tab: IDLE after 5 min with no input", st(ago(30_000), ago(I + MIN)) === "IDLE");
  // Closed browser / suspended phone / network drop: identical to no beat ⇒ expiry.
  check("closed browser / network drop: OFFLINE by expiry, no message needed", st(ago(P + MIN), ago(P + MIN)) === "OFFLINE");
  // Return after inactivity.
  check("return after a day away: the first interacted beat ⇒ ACTIVE again", st(ago(0), ago(0)) === "ACTIVE" && st(ago(86_400_000), ago(86_400_000)) === "OFFLINE");
}

console.log("\nmulti-tab / multi-device fold");
{
  const f = foldPresenceClocks([
    { lastPresenceAt: ago(10 * MIN), lastInteractionAt: ago(10 * MIN), revokedAt: null }, // laptop, gone
    { lastPresenceAt: ago(30_000), lastInteractionAt: ago(20 * MIN), revokedAt: null },   // phone, visible idle
    { lastPresenceAt: ago(5_000), lastInteractionAt: ago(5_000), revokedAt: new Date() }, // revoked — presence ignored
  ]);
  check("presence = newest over NON-revoked sessions", f.lastPresenceAt?.getTime() === ago(30_000).getTime());
  check("interaction = newest over every session", f.lastInteractionAt?.getTime() === ago(5_000).getTime());
  check("one user = most recent of any tab", derivePresenceState(f, NOW) === "ACTIVE");
  check("empty ⇒ UNKNOWN", derivePresenceState(foldPresenceClocks([]), NOW) === "UNKNOWN");
}

console.log("\nlast-active buckets — coarse, never a raw timestamp");
{
  const b = (ms: number | null) => lastActiveBucket(ms === null ? null : ago(ms), NOW);
  check("never ⇒ Unknown", b(null).bucket === "NEVER" && b(null).label === "Unknown");
  check("≤ 5 min", b(I).bucket === "WITHIN_5_MIN");
  check("≤ 1 h", b(I + 1).bucket === "WITHIN_HOUR" && b(60 * MIN).bucket === "WITHIN_HOUR");
  check("earlier today (UTC)", b(3 * 60 * MIN).bucket === "TODAY" && b(3 * 60 * MIN).label === "active today");
  check("yesterday (UTC)", b(13 * 60 * MIN).bucket === "YESTERDAY");
  check("this week", b(3 * 86_400_000).bucket === "THIS_WEEK");
  check("this month", b(20 * 86_400_000).bucket === "THIS_MONTH");
  check("older", b(40 * 86_400_000).bucket === "OVER_30_DAYS");
  const all = [null, I, 3 * 60 * MIN, 40 * 86_400_000].map((m) => b(m).label).join("|");
  check("no label contains a date or a clock time", !/\d{4}-\d{2}|\d{1,2}:\d{2}/.test(all), all);
}

if (failures > 0) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log("\nAll presence-definition checks passed.");
