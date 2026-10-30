"use client";

/**
 * site/components/ProductShowcase.tsx — a framed product capture, or a short
 * loop of them.
 *
 * Every frame is a screenshot of the REAL application's components rendered
 * over a synthetic demo household (scripts/marketing-showcase/ at the repo
 * root reproduces them byte-for-byte; site/public/showcase/). Nothing here is
 * live data and the badge says so.
 *
 * Motion is a cross-fade between still frames — no video, no animation library.
 * It advances only while the figure is on screen and the tab is visible; it
 * stops while the pointer or keyboard focus is inside it; the visitor can pause
 * it; and under prefers-reduced-motion it never advances on its own (the steps
 * stay clickable). Frames of one loop share an aspect ratio and are stacked in
 * one box, so changing frame never moves the page.
 */
import { useEffect, useRef, useState } from "react";
import styles from "./ProductShowcase.module.css";

export interface ShowcaseImage { src: string; width: number; height: number }
export interface ShowcaseFrame {
  /** Short step label under the frame ("Last 12 months"). */
  caption: string;
  /** What the frame shows, for screen readers. */
  alt: string;
  desktop: ShowcaseImage;
  /** Narrow-viewport capture (the app's compact layout). */
  mobile: ShowcaseImage;
}

const MOBILE_QUERY = "(max-width: 600px)";

export function ProductShowcase({ label, frames, interval = 4200, note }: {
  /** Accessible name of the figure ("Personal Space — Net Worth"). */
  label: string;
  frames: ShowcaseFrame[];
  interval?: number;
  /** Optional line under the frame (e.g. what is illustrative). */
  note?: string;
}) {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const [held, setHeld] = useState(false);          // pointer / focus inside
  const [visible, setVisible] = useState(false);
  const [reduced, setReduced] = useState(true);     // assume reduced until known
  const ref = useRef<HTMLElement | null>(null);
  const loop = frames.length > 1;

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || !loop) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.35 });
    io.observe(el);
    const onVis = () => { if (document.hidden) setVisible(false); };
    document.addEventListener("visibilitychange", onVis);
    return () => { io.disconnect(); document.removeEventListener("visibilitychange", onVis); };
  }, [loop]);

  const running = loop && visible && !paused && !held && !reduced;
  useEffect(() => {
    if (!running) return;
    const t = window.setTimeout(() => setActive((i) => (i + 1) % frames.length), interval);
    return () => window.clearTimeout(t);
  }, [running, active, frames.length, interval]);

  const d = frames[0].desktop;
  const m = frames[0].mobile;
  return (
    <figure
      ref={ref}
      className={styles.showcase}
      aria-label={label}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHeld(false); }}
    >
      <div className={styles.window}>
        <span className={styles.badge}>Product UI · demo data</span>
        <div
          className={styles.stage}
          style={{ ["--ar-d" as string]: `${d.width} / ${d.height}`, ["--ar-m" as string]: `${m.width} / ${m.height}` }}
        >
          {frames.map((f, i) => (
            <picture key={f.desktop.src} className={styles.frame} data-active={i === active ? "" : undefined}>
              <source media={MOBILE_QUERY} srcSet={f.mobile.src} width={f.mobile.width} height={f.mobile.height} />
              <img src={f.desktop.src} width={f.desktop.width} height={f.desktop.height} alt={i === active ? f.alt : ""} loading="lazy" decoding="async" />
            </picture>
          ))}
        </div>
      </div>
      {loop && (
        <div className={styles.controls}>
          <div className={styles.steps} role="group" aria-label={`${label} — views`}>
            {frames.map((f, i) => (
              <button key={f.caption} type="button" className={styles.step} aria-pressed={i === active} onClick={() => setActive(i)}>
                <span className={styles.track} aria-hidden>
                  <span className={styles.fill} data-running={running && i === active ? "" : undefined}
                    style={{ animationDuration: `${interval}ms` }} key={`${active}-${running}`} />
                </span>
                {f.caption}
              </button>
            ))}
          </div>
          {!reduced && (
            <button type="button" className={styles.pause} onClick={() => setPaused((p) => !p)} aria-pressed={paused}>
              {paused ? "Play" : "Pause"}<span className={styles.srOnly}> {label} loop</span>
            </button>
          )}
        </div>
      )}
      {note && <figcaption className={styles.note}>{note}</figcaption>}
    </figure>
  );
}
