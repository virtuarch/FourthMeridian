import type { ReactNode } from "react";
import ui from "./ui.module.css";

/** Centered max-width content column. */
export function Container({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`${ui.container} ${className}`}>{children}</div>;
}
