import Image from "next/image";
import Link from "next/link";
import { Reveal } from "@/components/marketing/Reveal";
import styles from "./landing.module.css";
import motion from "./motion.module.css";

const ecosystem = ["Banking", "Investments", "Liabilities", "Cash flow", "Financial activity", "Intelligence"];
const spaces = [
  ["Personal", "Your complete financial position, organized around the life you live."],
  ["Family", "Shared context for the decisions, responsibilities, and plans you hold together."],
  ["Business", "A distinct view of operating capital, obligations, and financial activity."],
  ["Goals", "A focused place for the milestones that connect today’s choices to tomorrow."],
];

export default function HomePage() {
  return (
    <div className={styles.page}>
      <section className={styles.hero} aria-labelledby="hero-title">
        <Image src="/hero/earth-mena.png" alt="" fill priority sizes="100vw" className={`${styles.earth} ${motion.earth}`} />
        <div className={styles.heroShade} aria-hidden />
        <div className={`${styles.heroInner} ${motion.heroInner}`}>
          <p className={styles.eyebrow}>Fourth Meridian</p>
          <h1 id="hero-title">Transform data into clarity.<br /><span>Transform clarity into action.</span></h1>
          <p className={styles.heroCopy}>An intelligent financial ecosystem that helps individuals, families, and businesses understand, organize, and improve their financial lives.</p>
          <Link className={styles.primaryCta} href="#philosophy">Explore Fourth Meridian <span aria-hidden>↓</span></Link>
        </div>
        <div className={`${styles.heroSignal} ${motion.heroSignal}`} aria-label="Fourth Meridian ecosystem overview">
          <span>One financial context</span><strong>Clarity across every Space</strong>
          <div><i /> Connected intelligence <em>Context current</em></div>
        </div>
      </section>

      <Reveal as="section" className={`${styles.section} ${styles.philosophy}`} id="philosophy">
        <div className={styles.sectionLead}><p className={styles.eyebrow}>Fourth Meridian · Philosophy</p><h2>Financial information should become something you can use.</h2></div>
        <div className={styles.philosophyGrid}>
          <div className={styles.missionCopy}>
            <p>Fourth Meridian is an intelligent financial ecosystem designed to help individuals, families, and businesses make better financial decisions throughout every stage of life.</p>
            <p>The name is inspired by the Fourth Meridian—the Spleen Meridian—in Traditional Chinese Medicine. The Spleen transforms nourishment into usable energy and distributes it throughout the body.</p>
            <p>Likewise, Fourth Meridian transforms fragmented financial data into meaningful intelligence, then distributes that insight across every aspect of a person’s financial life.</p>
          </div>
          <Reveal className={styles.transformation} aria-label="Fragmented data becomes intelligence, then action" stagger>
            <div><span>01</span><strong>Fragmented data</strong></div><b aria-hidden>↓</b><div><span>02</span><strong>Intelligence</strong></div><b aria-hidden>↓</b><div className={styles.activeStep}><span>03</span><strong>Action</strong></div>
          </Reveal>
        </div>
        <p className={styles.missionLine}>Transform data into clarity. <span>Transform clarity into action.</span></p>
      </Reveal>

      <Reveal as="section" className={`${styles.section} ${styles.works}`} id="product">
        <div className={styles.sectionLead}><p className={styles.eyebrow}>How Fourth Meridian works</p><h2>One system for the full shape of your financial life.</h2><p>Not another budgeting app. Fourth Meridian connects the parts of your finances that usually live apart, preserving their context as one coherent system.</p></div>
        <div className={styles.ecosystem}>
          <div className={styles.orbit} aria-hidden><span>4M</span></div>
          <Reveal className={styles.ecosystemItems} stagger>{ecosystem.map((item, i) => <div key={item}><span>0{i + 1}</span>{item}</div>)}</Reveal>
        </div>
      </Reveal>

      <Reveal as="section" className={`${styles.section} ${styles.intelligence}`}>
        <div className={styles.sectionLead}><p className={styles.eyebrow}>Financial intelligence</p><h2>A clearer reading of where you stand—and why.</h2><p>Accounts, holdings, obligations, and movement become a living financial context. Fourth Meridian turns that context into explanations that are calm, specific, and useful.</p></div>
        <div className={styles.briefing}><span>Fourth Meridian Intelligence</span><h3>Liquidity is higher for a reason.</h3><p>Near-term obligations account for most of the change. Your longer-horizon position remains consistent.</p><div><span>Cash flow</span><span>Obligations</span><span>Investments</span></div></div>
      </Reveal>

      <Reveal as="section" className={`${styles.section} ${styles.spaces}`}>
        <div className={styles.sectionLead}><p className={styles.eyebrow}>Spaces · Ecosystem</p><h2>Organize money around meaning.</h2><p>Financial Spaces reflect the real structures in your life. Each brings the right people, accounts, history, and decisions into focus—without losing the whole.</p></div>
        <Reveal className={styles.spaceGrid} stagger>{spaces.map(([title, body], i) => <article key={title}><span>0{i + 1}</span><h3>{title}</h3><p>{body}</p></article>)}</Reveal>
      </Reveal>

      <Reveal as="section" className={`${styles.section} ${styles.ai}`} id="vision">
        <div className={`${styles.aiVisual} ${motion.aiVisual}`} aria-hidden><div className={styles.aiCore}>Context</div><span className={styles.ringOne} /><span className={styles.ringTwo} /></div>
        <div className={styles.sectionLead}><p className={styles.eyebrow}>AI vision</p><h2>Intelligence grounded in your financial reality.</h2><p>Not generic advice. AI in Fourth Meridian is built on financial context: what you own, owe, earn, spend, value, and intend.</p><ul><li>Understand the full picture</li><li>Explain what changed</li><li>Support better decisions</li><li>Help turn decisions into action</li></ul></div>
      </Reveal>

      <Reveal as="section" className={`${styles.section} ${styles.about}`} id="about">
        <p className={styles.eyebrow}>About Fourth Meridian</p><div><h2>Built for a longer horizon.</h2><div><p>Fourth Meridian exists because financial lives are complex, connected, and always changing—while the tools built to understand them remain fragmented.</p><p>We are building durable financial infrastructure: a system that can grow with an individual, a family, or a business through every stage of life.</p><p>The long-term vision is an intelligent layer for financial understanding—private, contextual, and designed to make complexity useful.</p></div></div>
      </Reveal>

      <Reveal as="section" className={`${styles.section} ${styles.cta}`}><Image src="/fm-mark-dark.png" alt="" width={52} height={52} /><p className={styles.eyebrow}>Fourth Meridian</p><h2>See your financial life as one connected system.</h2><p>Transform data into clarity. Transform clarity into action.</p><Link className={styles.primaryCta} href="/request-access">Get Started <span aria-hidden>↗</span></Link><Link className={styles.signIn} href="/login">Already have access? Sign in</Link></Reveal>
    </div>
  );
}
