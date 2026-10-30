/**
 * site/app/page.tsx — fourthmeridian.com.
 *
 * Carried over from the app's app/(public)/page.tsx. The only changes: the
 * hero and mark are the site's own optimised assets, and the two calls to
 * action are plain absolute links into the application (lib/public-config.ts)
 * instead of same-origin paths — the request-access one through AppLink, which
 * forwards acquisition context (lib/acquisition.ts).
 *
 * FACTUAL PASS (2026-10-07): every capability named here is shipped.
 * POSITIONING (2026-10-30): "AI-powered financial understanding" — financial
 * context, read-only, decisions stay the user's (content/copy.ts SITE).
 * Spaces named are the ones a user can have today (Personal is
 * created for everyone; Family and Custom are selectable — lib/space-templates);
 * Business/Property/Vehicle/Trip are planned, so they are not listed. The
 * "Brief" card is an illustrative example and is labelled as one.
 *
 * PRODUCT SHOWCASE PASS (2026-10-30): the Personal Space, Cash Flow,
 * Connections and Conversations sections show screenshots of the application's
 * real components over a synthetic demo household (content/showcase.ts; the
 * captures are reproducible from scripts/marketing-showcase/ at the repo root).
 * Every frame carries a "demo data" badge; the conversation's wording is an
 * example and says so.
 */
import Image from "next/image";
import Link from "next/link";
import { Reveal } from "@site/components/Reveal";
import { AppLink } from "@site/components/AppLink";
import { APP_LINKS } from "@site/lib/public-config";
import { ProductShowcase } from "@site/components/ProductShowcase";
import { CASH_FLOW_FRAMES, CONNECTIONS_FRAMES, CONVERSATION_FRAMES, NET_WORTH_FRAMES } from "@site/content/showcase";
import styles from "./landing.module.css";
import motion from "./motion.module.css";

const spaces = [
  ["Personal", "Your complete financial position, organized around the life you live. Everyone starts here."],
  ["Family", "A shared Space for the accounts, decisions and plans you hold together, with the people you choose."],
  ["Custom", "A Space you shape yourself — its own accounts, its own view, still part of the whole."],
];

export default function HomePage() {
  return (
    <div className={styles.page}>
      <section className={styles.hero} aria-labelledby="hero-title">
        <Image src="/hero/earth-mena.jpg" alt="" fill priority sizes="100vw" className={`${styles.earth} ${motion.earth}`} />
        <div className={styles.heroShade} aria-hidden />
        <div className={`${styles.heroInner} ${motion.heroInner}`}>
          <p className={styles.eyebrow}>Fourth Meridian</p>
          <h1 id="hero-title">Your whole financial life.<br /><span>Finally in context.</span></h1>
          <p className={styles.heroCopy}>Fourth Meridian brings your accounts, spending, debt and investments into one connected picture—with AI conversations grounded in your own financial data.</p>
          <Link className={styles.primaryCta} href="#personal-space">Explore Fourth Meridian <span aria-hidden>↓</span></Link>
        </div>
        <div className={`${styles.heroSignal} ${motion.heroSignal}`} aria-label="Fourth Meridian overview">
          <span>Financial context</span><strong>One picture across every Space</strong>
          <div><i /> Connected accounts <em>Refreshed daily</em></div>
        </div>
      </section>

      <Reveal as="section" className={`${styles.section} ${styles.showcase} ${styles.firstShowcase}`} id="personal-space" aria-labelledby="personal-space-title">
        <div className={styles.sectionLead}><p className={styles.eyebrow}>Your Personal Space</p><h2 id="personal-space-title">Everything you own and owe, on one timeline.</h2><p>Net worth, assets and liabilities in one place, with the history behind them. Pick a period—the last 90 days, the year so far, the last twelve months—and every change and chart on the page follows it.</p></div>
        <ProductShowcase label="Personal Space — Net worth" frames={NET_WORTH_FRAMES} eager />
      </Reveal>

      <Reveal as="section" className={`${styles.section} ${styles.philosophy}`} id="philosophy">
        <div className={styles.sectionLead}><p className={styles.eyebrow}>Fourth Meridian · Philosophy</p><h2>Financial information should become something you can use.</h2></div>
        <div className={styles.philosophyGrid}>
          <div className={styles.missionCopy}>
            <p>Fourth Meridian is AI-powered financial understanding, built to help people and families see their money in context and think through decisions with the whole picture in view. The decisions stay theirs.</p>
            <p>The name is inspired by the Fourth Meridian—the Spleen Meridian—in Traditional Chinese Medicine. The Spleen transforms nourishment into usable energy and distributes it throughout the body.</p>
            <p>Likewise, Fourth Meridian transforms fragmented financial data into one understanding you can reason from—and refreshes it as your accounts update.</p>
          </div>
          <Reveal className={styles.transformation} aria-label="Fragmented data becomes understanding, then your decision" stagger>
            <div><span>01</span><strong>Fragmented data</strong></div><b aria-hidden>↓</b><div><span>02</span><strong>Understanding</strong></div><b aria-hidden>↓</b><div className={styles.activeStep}><span>03</span><strong>Your decision</strong></div>
          </Reveal>
        </div>
        <p className={styles.missionLine}>Understand more. <span>Decide for yourself.</span></p>
      </Reveal>

      <Reveal as="section" className={`${styles.section} ${styles.showcase}`} id="product" aria-labelledby="product-title">
        <div className={styles.sectionLead}><p className={styles.eyebrow}>How Fourth Meridian works</p><h2 id="product-title">One view of the full shape of your financial life.</h2><p>Not another budgeting app. Fourth Meridian connects the parts of your finances that usually live apart—bank, card, loan and investment accounts through Plaid, self-custody crypto wallets you add by public address (watch-only: nothing can be moved), and real assets like a home that you value yourself—and keeps their context together, refreshed on a regular cadence.</p></div>
        <ProductShowcase label="Connections" frames={CONNECTIONS_FRAMES} />
      </Reveal>

      <Reveal as="section" className={`${styles.section} ${styles.showcase}`} id="cash-flow" aria-labelledby="cash-flow-title">
        <div className={styles.sectionLead}><p className={styles.eyebrow}>Cash Flow</p><h2 id="cash-flow-title">See money move, day by day.</h2><p>Cash in and cash out across your bank accounts, a calendar that shades each day by what moved, and spending by category. In Spending, a card purchase counts once—when you buy it—never again when you pay the card.</p></div>
        <ProductShowcase label="Cash Flow" frames={CASH_FLOW_FRAMES} />
      </Reveal>

      <Reveal as="section" className={`${styles.section} ${styles.intelligence}`}>
        <div className={styles.sectionLead}><p className={styles.eyebrow}>The Daily Brief</p><h2>A clearer reading of where you stand—and what changed.</h2><p>Connected accounts, holdings, debts and transactions become one financial context. Each day the Brief reads it for you and says, in plain language, what moved and what may deserve attention. The figures are computed by Fourth Meridian; the words describe them.</p></div>
        <div className={styles.briefing}><span>Example · Daily Brief</span><h3>Liquidity is higher for a reason.</h3><p>Near-term obligations account for most of the change. Your longer-horizon position remains consistent.</p><div><span>Cash flow</span><span>Obligations</span><span>Investments</span></div></div>
      </Reveal>

      <Reveal as="section" className={`${styles.section} ${styles.spaces}`}>
        <div className={styles.sectionLead}><p className={styles.eyebrow}>Spaces</p><h2>Organize money around meaning.</h2><p>Spaces reflect the real structures in your life. Each brings the right people, accounts, history, and decisions into focus—without losing the whole.</p></div>
        <Reveal className={styles.spaceGrid} stagger>{spaces.map(([title, body], i) => <article key={title}><span>0{i + 1}</span><h3>{title}</h3><p>{body}</p></article>)}</Reveal>
      </Reveal>

      <Reveal as="section" className={`${styles.section} ${styles.ai}`} id="vision">
        <div className={styles.sectionLead}><p className={styles.eyebrow}>Conversations</p><h2>Answers grounded in your financial reality.</h2><p>Not generic answers. Conversations in Fourth Meridian work from your own numbers—what you own, owe, earn and spend—and show the figures behind each answer. They explain and model; you decide. Fourth Meridian never moves money or acts on your accounts.</p><ul><li>Understand the full picture, on any date</li><li>Explain what changed, and why</li><li>Model what-ifs: spending, income, contributions, debt payoff, a goal by a date</li><li>Say plainly what it does not know</li></ul></div>
        <ProductShowcase label="Conversations" frames={CONVERSATION_FRAMES}
          note="An example conversation over the demo household. In the app, answers are written by the AI from your own figures, and wording varies." />
      </Reveal>

      <Reveal as="section" className={`${styles.section} ${styles.about}`} id="about">
        <p className={styles.eyebrow}>About Fourth Meridian</p><div><h2>Built for a longer horizon.</h2><div><p>Fourth Meridian exists because financial lives are complex, connected, and always changing—while the tools built to understand them remain fragmented.</p><p>We are building it to grow with a person or a family over years, not sessions: one record of where you stand that stays honest as your accounts, goals and circumstances change.</p><p>The direction is a private, contextual layer for financial understanding—designed to make complexity useful. Today that means connected accounts, a Daily Brief, Conversations and Spaces, in a closed beta.</p></div></div>
      </Reveal>

      <Reveal as="section" className={`${styles.section} ${styles.cta}`}><Image src="/brand/fm-mark-dark-128.png" alt="" width={52} height={52} /><p className={styles.eyebrow}>Fourth Meridian</p><h2>See your financial life as one connected picture.</h2><p>Fourth Meridian is in closed beta. Request access and we will review it by hand.</p><AppLink className={styles.primaryCta} href={APP_LINKS.requestAccess()}>Request access <span aria-hidden>↗</span></AppLink><a className={styles.signIn} href={APP_LINKS.open()}>Already have access? Open Fourth Meridian</a></Reveal>
    </div>
  );
}
