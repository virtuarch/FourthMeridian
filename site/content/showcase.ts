/**
 * site/content/showcase.ts — the product captures on the home page.
 *
 * Each file in public/showcase/ is a screenshot of the application's real
 * components over a SYNTHETIC demo household, produced by
 * scripts/marketing-showcase/ at the repository root (build.mts, then
 * capture.mts). Sizes are the capture's CSS pixels (frames are stored at 2×);
 * frames of one loop share a size so they stack without layout shift.
 */
import type { ShowcaseFrame } from "@site/components/ProductShowcase";

const img = (name: string, width: number, height: number) => ({ src: `/showcase/${name}.webp`, width, height });

export const NET_WORTH_FRAMES: ShowcaseFrame[] = [
  {
    caption: "Last 12 months",
    alt: "A Personal Space showing net worth of $454,639, up $72,806 over the last 12 months, with assets, liabilities and liquid net worth beneath it and a rising balance-history chart.",
    desktop: img("net-worth-1y", 1088, 720),
    mobile: img("net-worth-1y-m", 390, 760),
  },
  {
    caption: "Last 90 days",
    alt: "The same Personal Space switched to the last 90 days: net worth up $21,440 since July 15, with the chart redrawn for that period.",
    desktop: img("net-worth-3m", 1088, 720),
    mobile: img("net-worth-3m-m", 390, 760),
  },
];

export const CASH_FLOW_FRAMES: ShowcaseFrame[] = [
  {
    caption: "Cash in & out",
    alt: "Cash Flow for one month: net cash flow of +$3,848, cash in and cash out, and a calendar that shades each day green or red by its net.",
    desktop: img("cash-flow-month", 1088, 900),
    mobile: img("cash-flow-month-m", 390, 900),
  },
  {
    caption: "Spending",
    alt: "Spending for the last 90 days: $8,448 in total, split into credit-card and direct spending, with a calendar heat map shading each day by how much was spent.",
    desktop: img("spending-quarter", 1088, 900),
    mobile: img("spending-quarter-m", 390, 900),
  },
];

export const CONVERSATION_FRAMES: ShowcaseFrame[] = [
  {
    caption: "Ask",
    alt: "The Fourth Meridian AI conversation view. The question: “What moved my net worth over the last year?”",
    desktop: img("conversation-question", 1088, 648),
    mobile: img("conversation-question-m", 390, 940),
  },
  {
    caption: "Answer from your numbers",
    alt: "The answer: net worth rose $72,806 (19.1%) to $454,639, broken down into investments +$38,096, home value +$16,000, cash +$11,017, debt down $8,266 and crypto −$572, noting that the home figure is the owner's own estimate.",
    desktop: img("conversation-answer", 1088, 648),
    mobile: img("conversation-answer-m", 390, 940),
  },
];

export const CONNECTIONS_FRAMES: ShowcaseFrame[] = [
  {
    caption: "Connections",
    alt: "The Connections page: a bank, an investment account and a credit card connected through Plaid and up to date, a self-custody Bitcoin wallet with current holdings, and a home valued by its owner at $561,000.",
    desktop: img("connections", 1088, 505),
    mobile: img("connections-m", 390, 595),
  },
];
