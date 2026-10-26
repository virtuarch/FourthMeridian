/**
 * components/space/shell/compact-time.ts  (v2.7 P0)
 *
 * The compact (<1024px) header slot the time control is portalled into. Shared
 * by SpaceShell (renders the slot beside Manage) and PerspectiveShell (owns the
 * time intents and portals the SAME TimelineLens into it).
 */
export const COMPACT_TIME_SLOT_ID = "fm-compact-time-slot";

/**
 * The header copy shows only the period trigger: the range and comparison
 * readouts are hidden (still referenced by the trigger's aria-describedby, so
 * screen readers keep the resolved range). Every utility applies <lg only.
 */
export const COMPACT_TIME_WRAPPER = "lg:hidden [&_[data-timeline-period]~span]:hidden";
