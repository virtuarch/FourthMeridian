/**
 * lib/presence/definitions.ts  (PB-10 — THE ONE PLACE THE ACTIVITY WORDS ARE DEFINED)
 *
 * Owner-reported defect: Customer Success showed an idle open tab as "active",
 * because "last active" was UserSession.lastActiveAt — a clock bumped by ANY
 * authenticated request (focus refetch of the session, ConnectionsList polling,
 * prefetches). Six different facts were being read off one clock. They are now
 * defined here, once, and consumed by Customer Operations and Growth (and,
 * later, Platform Intelligence). Nothing below may be restated elsewhere.
 *
 * ── THE SIX FACTS (never conflated) ──────────────────────────────────────────
 *   1. LAST LOGIN — the newest successful sign-in: AuditLog action LOGIN
 *      (written by lib/auth.ts authorize()). Server fact, high trust.
 *   2. AUTHENTICATED SESSION — a UserSession row that is not revoked and inside
 *      its SEC-010 idle (30 d) / absolute (90 d) lifetime. Proves a credential
 *      is valid. It is NOT proof that any browser is open, so a valid session
 *      alone is NEVER shown as "online".
 *      `UserSession.lastActiveAt` = SESSION LAST USED (any authenticated
 *      request, 60 s granularity, lib/auth/session-activity.ts). It feeds the
 *      SEC-010 idle cut-off and the user's own sessions list ONLY. Customer
 *      Operations and Growth must not read it as activity.
 *      PB-10 F3 (S2 ruling): BACKGROUND reads do NOT touch it — the presence
 *      heartbeat, the bell's unread-count poll, the notice rail's focus re-read
 *      and the SessionProvider's GET /api/auth/session refetch run the full
 *      guard with the touch off (lib/auth/presence-scope.ts allowlist). So a tab
 *      left open but unused for 30 days signs out (the intended SEC-010 policy);
 *      the 90-day absolute cut-off is unchanged. Navigations, RSC renders,
 *      server actions and mutations still touch.
 *      SESSION_ACTIVE_DAY (written by that same touch) is therefore "a UTC day
 *      with a HUMAN-INITIATED authenticated request" — presence, not engagement.
 *   3. ONLINE PRESENCE — `UserSession.lastPresenceAt`: a VISIBLE browser tab
 *      holding the session sent a heartbeat (POST /api/user/presence) within
 *      PRESENCE_CONFIG.presenceFreshMs. Server-stamped (database clock). A
 *      hidden tab, a closed browser, a suspended phone or a dropped network
 *      sends nothing, so presence simply EXPIRES — no "offline" message is
 *      needed or trusted.
 *   4. ACTIVE NOW — presence is fresh AND the newest beat that reported an
 *      interaction is within PRESENCE_CONFIG.interactionActiveMs.
 *   5. LAST ACTIVE — `UserSession.lastInteractionAt`: the server time of the
 *      newest beat whose body said "interacted since the last beat" (coarse
 *      local pointer/key/scroll/visibility events — never keystroke contents,
 *      coordinates or page content; NOT visibility — F4: macOS flips it on
 *      window occlusion / screen lock with nobody at the tab). ⚠️ LOW TRUST: the boolean is
 *      CLIENT-ASSERTED. It may drive ONLY the presence buckets (Active now /
 *      Online, idle / Offline) and the coarse Customer Success "last active ~"
 *      display. It must NEVER feed engagement (DAU/WAU/MAU, "Returned",
 *      Growth returning), SEC-010, or any security decision.
 *      KNOWN LIMITATION (accepted): the server stamps the interaction at beat
 *      ARRIVAL, so a real input just before the tab is hidden is credited when
 *      the next beat lands — up to one interval later, or on return. Capped: a
 *      pending flag is dropped once the INPUT is more than 2 × clientBeatIntervalMs
 *      old — including a flag restored after a refused / lost beat
 *      (lib/presence/heartbeat-client.ts STALE_INTERACTION_MS).
 *   6. MEANINGFUL ENGAGEMENT — actual product use, from SERVER-SIDE events only:
 *      the frozen engagement predicate in
 *      lib/platform/growth/product-analytics-core.ts — ENGAGEMENT_AUDIT_ACTIONS
 *      (the interactive PRODUCT_EVENT_ACTIONS: SPACE_VIEWED, BRIEF_VIEWED,
 *      TRANSACTIONS_VIEWED, MANUAL_ASSET_VALUE_UPDATED, plus connection adds)
 *      ∪ AiInvocation on ENGAGEMENT_AI_SURFACES with a userId. NEVER background
 *      sync, cron, webhooks, token refresh, polling, prefetch, focus refetch,
 *      heartbeats, or SESSION_ACTIVE_DAY (which is PRESENCE — see below).
 *
 * ── WINDOWS, TIMEZONE, INCLUSION ─────────────────────────────────────────────
 *   · Every clock is the DATABASE clock (UTC). Client timestamps are never read.
 *   · Presence/interaction windows are rolling, measured from the reader's
 *     `now` (PRESENCE_CONFIG below).
 *   · DAU / WAU / MAU = distinct users with ≥1 MEANINGFUL ENGAGEMENT fact in
 *     the trailing 1 / 7 / 30 UTC days (ENGAGEMENT_WINDOW_DAYS). Day = UTC
 *     calendar day. Operator actions on a customer, harness AI runs, jobs and
 *     webhooks are excluded by the predicate (they carry no customer surface /
 *     are not engagement actions).
 *   · Growth "returning" = users created before the window start who have an
 *     engagement fact inside it (lib/platform/growth/growth.ts).
 *   · Multiple tabs/devices: one user = the NEWEST value across their sessions
 *     (presence only over non-revoked sessions).
 *
 * Pure: no I/O, no server-only import — the client heartbeat reads the interval.
 */

/** ONE configurable threshold set. Changing a number here changes it everywhere. */
export const PRESENCE_CONFIG = {
  /** Client: one beat per this interval while the tab is VISIBLE (none while hidden). */
  clientBeatIntervalMs: 60_000,
  /** Server/DB: a session row is not rewritten more often than this. */
  serverThrottleSeconds: 20,
  /**
   * Endpoint rate limit — its OWN per-session bucket (shared by every tab of
   * that session). It is lib/rate-limit.ts's FIXED window, aligned to the
   * epoch: the bucket is floor(now / 30 s), not a sliding 30 s. So two beats a
   * few seconds apart that straddle a boundary are BOTH admitted (e.g. :59 and
   * :01), while two inside one window get a 429 — "at most 1 per aligned 30 s
   * window", i.e. at most 2 within any 30 s span. That is acceptable here
   * because the database throttle (serverThrottleSeconds) still bounds row
   * WRITES, and a refused beat's interaction is carried to the next beat
   * (lib/presence/heartbeat-client.ts).
   */
  rateLimit: { limit: 1, windowSec: 30 },
  /** Presence is fresh while the newest beat is at most this old (3 missed-ish beats ⇒ offline). */
  presenceFreshMs: 3 * 60_000,
  /** "Active now" needs a reported interaction at most this old (and fresh presence). */
  interactionActiveMs: 5 * 60_000,
} as const;

/** DAU / WAU / MAU windows, in UTC days, over MEANINGFUL ENGAGEMENT only. */
export const ENGAGEMENT_WINDOW_DAYS = { dau: 1, wau: 7, mau: 30 } as const;

export type PresenceState = "ACTIVE" | "IDLE" | "OFFLINE" | "UNKNOWN";

export const PRESENCE_LABELS: Readonly<Record<PresenceState, string>> = {
  ACTIVE: "Active now",
  IDLE: "Online, idle",
  OFFLINE: "Offline",
  UNKNOWN: "Unknown",
};

/** The short explanation operators see beside the labels. */
export const PRESENCE_EXPLANATION =
  "Active now = an open, visible tab reported a click, key, scroll or focus in the last 5 min. " +
  "Online, idle = a visible tab is open but nothing was interacted with for 5 min. " +
  "Offline = no visible tab has checked in for 3 min. Unknown = never recorded. " +
  "A signed-in session alone is not counted as online, and background refreshes never count as activity.";

export interface PresenceClocks {
  /** Newest heartbeat over the user's NON-REVOKED sessions. */
  lastPresenceAt: Date | null;
  /** Newest beat that reported an interaction, over all of the user's sessions. */
  lastInteractionAt: Date | null;
}

function ms(d: Date | null): number | null {
  if (!d) return null;
  const t = d.getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * The presence state machine. Boundaries are INCLUSIVE (age === threshold is
 * still fresh / still active). A clock in the future (reader/DB skew) is
 * treated as age 0 — it is server-stamped, so never client-chosen.
 */
export function derivePresenceState(c: PresenceClocks, now: Date): PresenceState {
  const nowMs = now.getTime();
  const presence = ms(c.lastPresenceAt);
  if (presence === null) return "UNKNOWN";
  const presenceAge = Math.max(0, nowMs - presence);
  if (presenceAge > PRESENCE_CONFIG.presenceFreshMs) return "OFFLINE";
  const interaction = ms(c.lastInteractionAt);
  if (interaction !== null && Math.max(0, nowMs - interaction) <= PRESENCE_CONFIG.interactionActiveMs) return "ACTIVE";
  return "IDLE";
}

/** Fold many sessions (tabs / devices) into one user: newest of each clock. */
export function foldPresenceClocks(rows: readonly { lastPresenceAt: Date | null; lastInteractionAt: Date | null; revokedAt?: Date | null }[]): PresenceClocks {
  let p: Date | null = null; let i: Date | null = null;
  for (const r of rows) {
    if (r.lastPresenceAt && !r.revokedAt && (!p || r.lastPresenceAt > p)) p = r.lastPresenceAt;
    if (r.lastInteractionAt && (!i || r.lastInteractionAt > i)) i = r.lastInteractionAt;
  }
  return { lastPresenceAt: p, lastInteractionAt: i };
}

export type LastActiveBucket =
  | "WITHIN_5_MIN" | "WITHIN_HOUR" | "TODAY" | "YESTERDAY" | "THIS_WEEK" | "THIS_MONTH" | "OVER_30_DAYS" | "NEVER";

/**
 * The COARSE "last active" an operator sees — a bucket, never the raw beat
 * timestamp. "Today"/"yesterday" are UTC calendar days.
 */
export function lastActiveBucket(lastInteractionAt: Date | null, now: Date): { bucket: LastActiveBucket; label: string } {
  const t = ms(lastInteractionAt);
  if (t === null) return { bucket: "NEVER", label: "Unknown" };
  const age = Math.max(0, now.getTime() - t);
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (age <= PRESENCE_CONFIG.interactionActiveMs) return { bucket: "WITHIN_5_MIN", label: "within 5 min" };
  if (age <= 60 * 60_000) return { bucket: "WITHIN_HOUR", label: "within the hour" };
  if (t >= dayStart) return { bucket: "TODAY", label: "active today" };
  if (t >= dayStart - 86_400_000) return { bucket: "YESTERDAY", label: "yesterday" };
  if (age <= 7 * 86_400_000) return { bucket: "THIS_WEEK", label: "this week" };
  if (age <= 30 * 86_400_000) return { bucket: "THIS_MONTH", label: "this month" };
  return { bucket: "OVER_30_DAYS", label: "over 30 days ago" };
}
