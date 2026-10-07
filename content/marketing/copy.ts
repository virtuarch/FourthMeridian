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
 *
 * FACTUAL PASS (OPERATIONALIZATION P0, 2026-10-07). Every capability named here
 * is one the shipped product has, in the words the code uses for it. The
 * canonical positioning is "Fourth Meridian is an AI-native wealth management
 * platform" (lib/ai/conversation/product.ts PRODUCT_IDENTITY says the same to
 * the model). Not "financial operating system", not "intelligent financial
 * ecosystem". Roadmap concepts (Business/Property/Vehicle/Trip Spaces are
 * `comingSoon` in lib/space-templates/registry.ts; Markets is an empty
 * skeleton) are not described as shipped. Limits that shape the promise —
 * three exports a day, a seven-day deletion window — are stated.
 */

export const SITE = {
  name: "Fourth Meridian",
  tagline: "Your whole financial life, in one clear view.",
  /** The canonical positioning sentence. Verbatim, everywhere it is quoted. */
  positioning: "Fourth Meridian is an AI-native wealth management platform.",
} as const;

/**
 * The published support destination. `support@fourthmeridian.com` is the
 * operational catch-all identity every account-lifecycle email is sent FROM
 * (lib/email/senders.ts), on the Google Workspace domain. Publishing it gives
 * the beta a reachable defect-report path; the owner confirms the inbox is
 * monitored (OPERATIONALIZATION P0, 2026-10-07).
 */
export const SUPPORT_EMAIL = "support@fourthmeridian.com";


// ── Security page ─────────────────────────────────────────────────────────────

export const SECURITY = {
  heading: "Security is the product, not a footnote.",
  intro:
    "Fourth Meridian holds the most sensitive record most people own — the " +
    "full shape of their money. We treat protecting it as a first-order feature. " +
    "Here is what that means in practice, as the product is built today.",
  pillars: [
    {
      title: "Your credentials are encrypted",
      body:
        "Account passwords are hashed with bcrypt and never stored in plaintext. " +
        "Bank connection tokens are encrypted at rest with AES-256-GCM, and the " +
        "access they grant is read-only wherever the provider supports it.",
    },
    {
      title: "Two-factor authentication",
      body:
        "Protect your account with an authenticator-app second factor and " +
        "single-use recovery codes. We nudge you toward enabling it and stay out " +
        "of your way once you have.",
    },
    {
      title: "Least-privilege access to your money",
      body:
        "Bank and brokerage connections are read-only by design — Fourth Meridian " +
        "can see balances, holdings and transactions to show them back to you. It " +
        "cannot move funds, pay bills, trade, or change anything at your bank.",
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
        "Login, verification, password reset, and other sensitive endpoints are " +
        "rate-limited to resist brute-force and automated abuse.",
    },
    {
      title: "Your data, on your terms",
      body:
        "Export a copy of your data from Settings whenever you like (up to three " +
        "exports a day). Delete your account when you choose: deletion is " +
        "scheduled with a seven-day window in which signing back in cancels it, " +
        "and then your personal data is purged. We keep no more than we need to " +
        "run the service.",
    },
  ],
  footnote:
    "Found something that looks wrong? Responsible disclosure is welcome — " +
    "email us and mark it as a security report.",
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
      "where you actually are. That is the job: one true reading of your " +
      "financial position — cash, spending, income, debt and investments — " +
      "honest enough that you can make decisions from it and then get on with " +
      "your life.",
    "Fourth Meridian is an AI-native wealth management platform. Your connected " +
      "accounts become one continuously updated picture. A Daily Brief reads it " +
      "for you and says what changed. Conversations answer questions and model " +
      "what-ifs from your own numbers, and show the figures behind each answer. " +
      "It never moves money or acts on your accounts.",
    "That picture is organized into Spaces — your personal Space, a shared " +
      "family Space, or a custom one — each bringing the right people and " +
      "accounts into focus without losing the whole.",
    "Fourth Meridian is in a closed beta. If that sounds like the tool you have " +
      "been wanting, request access — we review requests by hand and let people " +
      "in deliberately.",
  ],
  cta: { label: "Request beta access", href: "/request-access" },
} as const;

// ── Request access page ───────────────────────────────────────────────────────

export const REQUEST_ACCESS = {
  heading: "Request beta access.",
  intro:
    "Fourth Meridian is invite-only while we are in beta. Leave your email and " +
    "we will review your request; if it is approved, your invitation arrives by " +
    "email. No spam, and nothing shared.",
  successTitle: "You're on the list.",
  successBody:
    "Thanks — we've recorded your request. We review requests by hand and will " +
    "email you an invitation when a spot opens up.",
} as const;

// ── Legal page metadata (bodies live in the .md files) ────────────────────────

export const LEGAL = {
  terms: {
    title: "Terms of Service",
    updated: "October 2026",
  },
  privacy: {
    title: "Privacy Policy",
    updated: "October 2026",
  },
  ai: {
    title: "AI Disclosures",
    updated: "October 2026",
  },
} as const;
