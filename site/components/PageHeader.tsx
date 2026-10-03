import type { ReactNode } from "react";
import { Container } from "./Container";
import ui from "./ui.module.css";

/** Optional eyebrow + heading + intro for inner pages. */
export function PageHeader({ eyebrow, heading, intro }: { eyebrow?: string; heading: string; intro?: ReactNode }) {
  return (
    <Container className={ui.pageTop}>
      {eyebrow && <p className={ui.eyebrow}>{eyebrow}</p>}
      <h1 className={ui.heading}>{heading}</h1>
      {intro && <p className={ui.intro}>{intro}</p>}
    </Container>
  );
}
