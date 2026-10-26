/**
 * components/ai/talk-about-this.ts  (v2.7 R6 — contextual AI entry, option A / D-8)
 *
 * The pure half of "Talk with Fourth Meridian about this": the link a dashboard
 * view emits, the strict parser the Analyze page reads it back with, and the ONE
 * templated question that parse produces.
 *
 * ⚠️ THE URL CARRIES A TOPIC, NEVER A FIGURE. Two closed vocabularies cross the
 * boundary — which view (`about`) and which relative window (`period`) — and
 * nothing else: no amount, no account or merchant name, no date of a figure, no
 * free text. The Analyze page rebuilds the question from those two ids alone,
 * so whatever a crafted link carries, the only prose that can ever reach the
 * composer is one of the fixed templates below.
 *
 * ⚠️ A SUGGESTION, NOT A TURN. The question becomes the first starter chip; it is
 * sent only when the user clicks it, through the same path as every other chip,
 * as ordinary user prose. The chat request is unchanged ({spaceId, messages}) —
 * no context, instruction or view state travels to the server beside it.
 */

/** The views that offer the entry. */
export const TALK_SECTIONS = ["net-worth", "assets", "cash", "investments", "debt", "cash-flow"] as const;
export type TalkSection = (typeof TALK_SECTIONS)[number];

/**
 * The shell presets the AI's own relative vocabulary also understands
 * (lib/ai/measures/period.ts RELATIVE_PRESETS — parity is pinned by test).
 * WTD, ALL, CUSTOM and explicit calendar periods are deliberately absent: the
 * link then simply omits `period`.
 */
export const TALK_PERIODS = [
  "MTD", "QTD", "YTD", "PAST_WEEK", "PAST_MONTH", "PAST_QUARTER", "PAST_6_MONTHS", "PAST_YEAR",
] as const;
export type TalkPeriod = (typeof TALK_PERIODS)[number];

export const ANALYZE_PATH = "/dashboard/analyze";

function isTalkSection(v: unknown): v is TalkSection {
  return typeof v === "string" && (TALK_SECTIONS as readonly string[]).includes(v);
}
function isTalkPeriod(v: unknown): v is TalkPeriod {
  return typeof v === "string" && (TALK_PERIODS as readonly string[]).includes(v);
}

/**
 * The entry link. `period` accepts anything the shell might hold (a preset id,
 * "CUSTOM", an explicit-period object, null) and keeps it only when it is in
 * the allowlist — so a caller can pass its time state straight through.
 */
export function talkAboutHref(section: TalkSection, period?: unknown): string {
  const params = new URLSearchParams({ about: section });
  if (isTalkPeriod(period)) params.set("period", period);
  return `${ANALYZE_PATH}?${params.toString()}`;
}

/** The validated topic of an Analyze visit, or null. */
export interface TalkTopic {
  about: TalkSection;
  period: TalkPeriod | null;
}

/**
 * Read `about` / `period` back from the Analyze page's searchParams.
 * Exact allowlist matches only: a repeated, decorated or unknown value is
 * ignored silently (an unknown `about` ⇒ no suggestion; an unknown `period` ⇒
 * a suggestion without a window).
 */
export function parseTalkTopic(
  searchParams: Record<string, string | string[] | undefined> | null | undefined,
): TalkTopic | null {
  const about = searchParams?.about;
  if (!isTalkSection(about)) return null;
  const period = searchParams?.period;
  return { about, period: isTalkPeriod(period) ? period : null };
}

const PERIOD_PHRASE: Record<TalkPeriod, string> = {
  MTD:           "this month",
  QTD:           "this quarter",
  YTD:           "this year",
  PAST_WEEK:     "over the past week",
  PAST_MONTH:    "over the past month",
  PAST_QUARTER:  "over the past quarter",
  PAST_6_MONTHS: "over the past six months",
  PAST_YEAR:     "over the past year",
};

const TEMPLATE: Record<TalkSection, (when: string) => string> = {
  "net-worth":   (w) => `What drove my net worth ${w}?`,
  assets:        (w) => `What changed in my assets ${w}?`,
  cash:          (w) => `Walk me through my cash ${w}.`,
  investments:   (w) => `How did my investments do ${w}?`,
  debt:          (w) => `Explain how my debt changed ${w}.`,
  "cash-flow":   (w) => `Walk me through my cash flow ${w}.`,
};

/** The one figure-free question for a topic. */
export function talkQuestion(topic: TalkTopic): string {
  return TEMPLATE[topic.about](topic.period ? PERIOD_PHRASE[topic.period] : "recently");
}

/** The suggested starter chip for a visit, or null when the visit names no topic. */
export function suggestedStarter(
  searchParams: Record<string, string | string[] | undefined> | null | undefined,
): { label: string; prompt: string } | null {
  const topic = parseTalkTopic(searchParams);
  if (!topic) return null;
  const q = talkQuestion(topic);
  return { label: q, prompt: q };
}
