/**
 * site/app/page.tsx — fourthmeridian.com.
 *
 * Carried over from the app's app/(public)/page.tsx. The only changes: the
 * hero and mark are the site's own optimised assets, and the two calls to
 * action are plain absolute links into the application (lib/public-config.ts)
 * instead of same-origin paths — the request-access one through AppLink, which
 * forwards acquisition context (lib/acquisition.ts).
 *
 * FACTUAL PASS (2026-10-07): every capability named here is shipped. The
 * canonical positioning is "Fourth Meridian is an AI-native wealth management
 * platform". Spaces named are the ones a user can have today (Personal is
 * created for everyone; Family and Custom are selectable — lib/space-templates);
 * Business/Property/Vehicle/Trip are planned, so they are not listed. The
 * "Brief" card is an illustrative example and is labelled as one.
 */
import Image from "next/image";
import Link from "next/link";
import { Reveal } from "@site/components/Reveal";
import { AppLink } from "@site/components/AppLink";
import { APP_LINKS } from "@site/lib/public-config";
import styles from "./landing.module.css";
import motion from "./motion.module.css";

const ecosystem = ["Banks & cards", "Investments & crypto", "Debt", "Cash flow", "Daily Brief", "Conversations"];
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
          <h1 id="hero-title">Transform data into clarity.<br /><span>Decide with the whole picture.</span></h1>
          <p className={styles.heroCopy}>Fourth Meridian is an AI-native wealth management platform: one continuously updated understanding of your cash, spending, income, debt and investments — and a conversation grounded in it.</p>
          <Link className={styles.primaryCta} href="#philosophy">Explore Fourth Meridian <span aria-hidden>↓</span></Link>
        </div>
        <div className={`${styles.heroSignal} ${motion.heroSignal}`} aria-label="Fourth Meridian overview">
          <span>One financial context</span><strong>Clarity across every Space</strong>
          <div><i /> Connected accounts <em>Refreshed daily</em></div>
        </div>
      </section>

      <Reveal as="section" className={`${styles.section} ${styles.philosophy}`} id="philosophy">
        <div className={styles.sectionLead}><p className={styles.eyebrow}>Fourth Meridian · Philosophy</p><h2>Financial information should become something you can use.</h2></div>
        <div className={styles.philosophyGrid}>
          <div className={styles.missionCopy}>
            <p>Fourth Meridian is an AI-native wealth management platform, built to help people and families understand their money and think through decisions with the whole picture in view.</p>
            <p>The name is inspired by the Fourth Meridian—the Spleen Meridian—in Traditional Chinese Medicine. The Spleen transforms nourishment into usable energy and distributes it throughout the body.</p>
            <p>Likewise, Fourth Meridian transforms fragmented financial data into one understanding you can reason from—and keeps it current as your accounts change.</p>
          </div>
          <Reveal className={styles.transformation} aria-label="Fragmented data becomes understanding, then your decision" stagger>
            <div><span>01</span><strong>Fragmented data</strong></div><b aria-hidden>↓</b><div><span>02</span><strong>Understanding</strong></div><b aria-hidden>↓</b><div className={styles.activeStep}><span>03</span><strong>Your decision</strong></div>
          </Reveal>
        </div>
        <p className={styles.missionLine}>Transform data into clarity. <span>Then decide with it.</span></p>
      </Reveal>

      <Reveal as="section" className={`${styles.section} ${styles.works}`} id="product">
        <div className={styles.sectionLead}><p className={styles.eyebrow}>How Fourth Meridian works</p><h2>One view of the full shape of your financial life.</h2><p>Not another budgeting app. Fourth Meridian connects the parts of your finances that usually live apart—bank and card accounts, investments, crypto wallets, debt, cash flow—and keeps their context together, refreshed on a daily cadence.</p></div>
        <div className={styles.ecosystem}>
          <div className={styles.orbit} aria-hidden><span>4M</span></div>
          <Reveal className={styles.ecosystemItems} stagger>{ecosystem.map((item, i) => <div key={item}><span>0{i + 1}</span>{item}</div>)}</Reveal>
        </div>
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
        <div className={`${styles.aiVisual} ${motion.aiVisual}`} aria-hidden><div className={styles.aiCore}>Context</div><span className={styles.ringOne} /><span className={styles.ringTwo} /></div>
        <div className={styles.sectionLead}><p className={styles.eyebrow}>Conversations</p><h2>Answers grounded in your financial reality.</h2><p>Not generic advice. Conversations in Fourth Meridian answer from your own numbers—what you own, owe, earn and spend—and show the figures behind each answer. It never moves money or acts on your accounts.</p><ul><li>Understand the full picture, on any date</li><li>Explain what changed, and why</li><li>Model what-ifs: spending, income, contributions, debt payoff, a goal by a date</li><li>Say plainly what it does not know</li></ul></div>
      </Reveal>

      <Reveal as="section" className={`${styles.section} ${styles.about}`} id="about">
        <p className={styles.eyebrow}>About Fourth Meridian</p><div><h2>Built for a longer horizon.</h2><div><p>Fourth Meridian exists because financial lives are complex, connected, and always changing—while the tools built to understand them remain fragmented.</p><p>We are building it to grow with a person or a family over years, not sessions: one record of where you stand that stays honest as your accounts, goals and circumstances change.</p><p>The direction is a private, contextual layer for financial understanding—designed to make complexity useful. Today that means connected accounts, a Daily Brief, Conversations and Spaces, in a closed beta.</p></div></div>
      </Reveal>

      <Reveal as="section" className={`${styles.section} ${styles.cta}`}><Image src="/brand/fm-mark-dark-128.png" alt="" width={52} height={52} /><p className={styles.eyebrow}>Fourth Meridian</p><h2>See your financial life as one connected picture.</h2><p>Fourth Meridian is in closed beta. Request access and we will review it by hand.</p><AppLink className={styles.primaryCta} href={APP_LINKS.requestAccess()}>Request access <span aria-hidden>↗</span></AppLink><a className={styles.signIn} href={APP_LINKS.open()}>Already have access? Open Fourth Meridian</a></Reveal>
    </div>
  );
}
