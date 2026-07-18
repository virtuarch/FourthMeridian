"use client";

import { useEffect, useRef, type CSSProperties, type HTMLAttributes, type ReactNode, type RefObject } from "react";
import styles from "./Reveal.module.css";

type RevealProps = HTMLAttributes<HTMLElement> & { as?: "section" | "div"; children: ReactNode; delay?: number; stagger?: boolean };

/** Shared, non-blocking Atlas entrance motion for public marketing surfaces. */
export function Reveal({ as = "div", children, className = "", delay = 0, stagger = false, style, ...props }: RevealProps) {
  const elementRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const element = elementRef.current;
    if (!element || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      if (element) element.dataset.revealState = "visible";
      return;
    }
    element.dataset.revealState = "pending";
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      element.dataset.revealState = "visible";
      observer.disconnect();
    }, { rootMargin: "0px 0px -10%", threshold: 0.08 });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const elementProps = {
    ...props,
    className: `${styles.reveal} ${className}`,
    "data-reveal-state": "idle",
    "data-reveal-group": stagger ? "stagger" : undefined,
    style: { ...style, "--reveal-delay": `${delay}ms` } as CSSProperties,
  };

  if (as === "section") return <section ref={elementRef} {...elementProps}>{children}</section>;
  return <div ref={elementRef as RefObject<HTMLDivElement | null>} {...elementProps}>{children}</div>;
}
