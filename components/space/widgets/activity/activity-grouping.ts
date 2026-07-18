/**
 * components/space/widgets/activity/activity-grouping.ts
 *
 * Pure date-bucketing for the Activity workspace's editorial timeline.
 *
 * The activity feed answers "what happened in this Space?" — so it reads best as
 * a narrative broken into human date bands (Today · Yesterday · Earlier this week
 * · then by month) rather than one flat, paginated list. This is the presentation
 * layer's ONLY structural transform over the canonical TimelineEvent[]: it groups,
 * it never invents, reorders within a group, or drops an event.
 *
 * Deterministic by construction — `now` is passed in (never read from the clock
 * here), so the grouping is a pure function of its inputs and unit-testable.
 * Input order is preserved inside every group (the API already sorts newest-first),
 * and groups come out in reading order: Today, Yesterday, Earlier this week, then
 * calendar months descending.
 */

import type { TimelineEvent } from "@/lib/timeline-types";

export interface ActivityGroup {
  /** Stable key for React lists (e.g. "today", "2026-06"). */
  key: string;
  /** Member-facing band label (e.g. "Today", "June 2026"). */
  label: string;
  /** Scroll-anchor id for the shell sidebar (e.g. "activity-today"). */
  anchor: string;
  /** The band's events, in the input's newest-first order. */
  events: TimelineEvent[];
}

const MS_DAY = 86_400_000;

// Fixed month names so the label is timezone/locale-stable (important for tests
// and for a consistent read across members in different locales).
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Local midnight of the given date — the day boundary the bands are cut on. */
function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Group a newest-first TimelineEvent[] into ordered date bands relative to `now`.
 *
 * Bands:
 *   - Today            — on or after local midnight today
 *   - Yesterday        — the prior calendar day
 *   - Earlier this week — within the trailing 7-day window, before yesterday
 *   - {Month Year}     — everything older, one band per calendar month (desc)
 *
 * Empty bands are omitted, so the timeline never shows a header with nothing
 * under it. Events with an unparseable date sort to the oldest month band they
 * resolve to; the API only ever emits valid ISO strings, so this is defensive.
 */
export function groupActivityEvents(events: TimelineEvent[], now: Date): ActivityGroup[] {
  const todayStart     = startOfDay(now);
  const yesterdayStart = todayStart - MS_DAY;
  // Trailing 7-day window (today + the 6 days before it). Anything at or after
  // this floor but before yesterday is "Earlier this week".
  const weekFloor      = todayStart - 6 * MS_DAY;

  const today:      TimelineEvent[] = [];
  const yesterday:  TimelineEvent[] = [];
  const earlierWk:  TimelineEvent[] = [];
  // Month bands, keyed "YYYY-MM", insertion order preserved (input is desc, so
  // months naturally arrive newest-first).
  const months = new Map<string, ActivityGroup>();

  for (const e of events) {
    const t = new Date(e.date).getTime();

    if (Number.isFinite(t) && t >= todayStart) {
      today.push(e);
    } else if (Number.isFinite(t) && t >= yesterdayStart) {
      yesterday.push(e);
    } else if (Number.isFinite(t) && t >= weekFloor) {
      earlierWk.push(e);
    } else {
      const d   = new Date(Number.isFinite(t) ? t : 0);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      let band  = months.get(key);
      if (!band) {
        band = {
          key,
          label:  `${MONTHS[d.getMonth()]} ${d.getFullYear()}`,
          anchor: `activity-${key}`,
          events: [],
        };
        months.set(key, band);
      }
      band.events.push(e);
    }
  }

  const groups: ActivityGroup[] = [];
  if (today.length)     groups.push({ key: "today",       label: "Today",             anchor: "activity-today",       events: today });
  if (yesterday.length) groups.push({ key: "yesterday",   label: "Yesterday",         anchor: "activity-yesterday",   events: yesterday });
  if (earlierWk.length) groups.push({ key: "earlier-week", label: "Earlier this week", anchor: "activity-earlier-week", events: earlierWk });
  for (const band of months.values()) groups.push(band);

  return groups;
}
