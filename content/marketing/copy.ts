/**
 * content/marketing/copy.ts
 *
 * Structured marketing copy for the public (unauthenticated) landing pages.
 * Kept as data, separate from the presentational components in
 * components/marketing/* — copy edits happen here, layout edits happen there.
 *
 * Long-form legal text (terms / privacy / AI) lives as Markdown alongside this
 * file (terms.md, privacy.md, legal-ai.md) and is rendered via react-markdown;
 * this module carries only the short, structured page copy.
 *
 * Voice follows fourth-meridian-product-language.md: "Fourth Meridian" is the
 * platform (full name on first reference), a "Space" is the container a user
 * lives inside, "FinTracker" is the default Space Template — never the product.
 */

export const SITE = {
  name: "Fourth Meridian",
  tagline: "Your whole financial life, in one clear view.",
} as const;

// ── Home / hero ───────────────────────────────────────────────────────────────

export const HOME = {
  eyebrow: "Personal finance, held to a higher standard",
  heading: "Every account, every asset, one true north.",
  subheading:
    "Fourth Meridian brings your balances, investments, crypto, and debt " +
    "together into a single, honest picture — organized into Spaces you " +
    "actually live inside, with an ambient daily briefing that tells you " +
    "what changed and why it matters.",
  primaryCta: { label: "Request beta access", href: "/request-access" },
  secondaryCta: { label: "How we protect your data", href: "/security" },
} as const;

export type Feature = { title: string; body: string };

export const FEATURES: Feature[] = [
  {
    title: "One picture, every account",
    body:
      "Link banks and brokerages or add manual assets and debts. Net worth, " +
      "holdings, and cash flow reconcile into a single view that stays honest — " +
      "no fake jumps, no double-counting.",
  },
  {
    title: "Spaces, not spreadsheets",
    body:
      "Organize your finances into Spaces — personal, a household, an entity — " +
      "each shaped by a template like FinTracker. The structure follows how you " +
      "actually think about money.",
  },
  {
    title: "A daily briefing that reads for you",
    body:
      "An ambient briefing surfaces what moved overnight and what deserves your " +
      "attention — grounded in your own data, never a chat window you have to " +
      "prompt.",
  },
  {
    title: "Investments and crypto, honestly valued",
    body:
      "Historical holdings and on-chain balances are valued against real market " +
      "prices over time, so the history you see is the history that happened.",
  },
  {
    title: "Security you can inspect",
    body:
      "Two-factor authentication, encrypted credentials, and an audited access " +
      "model — described plainly on our security page, not buried in a policy.",
  },
  {
    title: "Built to give back control",
    body:
      "Export your data whenever you want, and close your account on your terms. " +
      "Your financial picture belongs to you.",
  },
];

// ── Security page ─────────────────────────────────────────────────────────────

export const SECURITY = {
  heading: "Security is the product, not a footnote.",
  intro:
    "Fourth Meridian holds the most sensitive record most people own — the " +
    "full shape of their money. We treat protecting it as a first-order feature. " +
    "Here is what that means in practice.",
  pillars: [
    {
      title: "Your credentials are encrypted",
      body:
        "Account passwords are hashed with bcrypt and never stored in plaintext. " +
        "Provider access tokens are encrypted at rest, and read-only wherever the " +
        "provider supports it.",
    },
    {
      title: "Two-factor authentication",
      body:
        "Protect your account with an authenticator-app second factor and " +
        "single-use recovery codes. We nudge you toward enabling it and never " +
        "get in your way once you have.",
    },
    {
      title: "Least-privilege access to your money",
      body:
        "Bank and brokerage connections are read-only by design — Fourth Meridian " +
        "can see balances and holdings to show them back to you, and cannot move " +
        "funds.",
    },
    {
      title: "Every sensitive action is audited",
      body:
        "Sign-ins, connection changes, exports, and account changes are recorded " +
        "so there is always an honest trail of what happened to your account.",
    },
    {
      title: "Rate-limited and abuse-resistant",
      body:
        "Login, verification, and other sensitive endpoints are rate-limited to " +
        "resist brute-force and automated abuse.",
    },
    {
      title: "Your data, on your terms",
      body:
        "Export a full copy of your data at any time, and delete your account " +
        "when you choose. We keep no more than we need to run the service.",
    },
  ],
  footnote:
    "Found something that looks wrong? Responsible disclosure is welcome — " +
    "reach us through the request-access form and mark it as a security report.",
} as const;

// ── About page ────────────────────────────────────────────────────────────────

export const ABOUT = {
  heading: "Why Fourth Meridian exists.",
  paragraphs: [
    "Most money tools optimize for engagement — streaks, nudges, and dashboards " +
      "that reward you for opening the app, not for understanding your finances. " +
      "Fourth Meridian is built for the opposite: to be looked at less, and " +
      "trusted more.",
    "A meridian is a line you navigate by — a fixed reference that tells you " +
      "where you actually are. That is the job: give you one true reading of your " +
      "financial position, honest enough that you can make decisions from it and " +
      "then get on with your life.",
    "We organize that picture into Spaces — a personal Space, a household, an " +
      "entity you manage — each shaped by a template for what it needs to track. " +
      "An ambient daily briefing does the reading for you and surfaces only what " +
      "changed.",
    "Fourth Meridian is in a closed beta. If that sounds like the tool you have " +
      "been wanting, request access — we are letting people in deliberately.",
  ],
  cta: { label: "Request beta access", href: "/request-access" },
} as const;

// ── Request access page ───────────────────────────────────────────────────────

export const REQUEST_ACCESS = {
  heading: "Request beta access.",
  intro:
    "Fourth Meridian is invite-only while we are in beta. Leave your email and " +
    "we will reach out when a spot opens. No spam, and nothing shared.",
  successTitle: "You're on the list.",
  successBody:
    "Thanks — we've noted your request and will be in touch when a beta spot " +
    "opens up.",
} as const;

// ── Legal page metadata (bodies live in the .md files) ────────────────────────

export const LEGAL = {
  terms: {
    title: "Terms of Service",
    updated: "July 2026",
  },
  privacy: {
    title: "Privacy Policy",
    updated: "July 2026",
  },
  ai: {
    title: "AI Disclosures",
    updated: "July 2026",
  },
} as const;
