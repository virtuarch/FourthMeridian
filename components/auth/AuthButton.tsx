/**
 * components/auth/AuthButton.tsx  (UI Convergence Wave 2 — W2-A)
 *
 * The primary auth call-to-action — a filled, meridian-gradient CTA with the Atlas
 * specular top edge and hover/active motion. This is the "front door" signature
 * action (Sign in, Create account, Verify), deliberately stronger than the tinted
 * GlassButton so it reads as the one primary action on the card. Renders a
 * <button> (submit / onClick) or, with `href`, a next/link — mirroring the
 * AtlasLiquidCta dual-mode pattern.
 *
 * `loading` shows an inline spinner and disables the control; the caller supplies
 * the label text (so the "Checking…" / "Verifying…" copy stays with the page).
 * `tone` keeps the old blue-vs-amber semantic split (primary vs warning actions).
 */

import Link from "next/link";
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";

type AuthButtonTone = "primary" | "warning";

const TONE: Record<AuthButtonTone, { backgroundImage: string; boxShadow: string }> = {
  primary: {
    backgroundImage: "linear-gradient(180deg, var(--meridian-500), var(--meridian-600))",
    boxShadow: "0 10px 28px -12px rgba(59,130,246,0.60)",
  },
  warning: {
    backgroundImage: "linear-gradient(180deg, #F59E0B, #D97706)",
    boxShadow: "0 10px 28px -12px rgba(217,119,6,0.55)",
  },
};

const BASE =
  "relative inline-flex items-center justify-center gap-2 overflow-hidden " +
  "rounded-[var(--radius-md)] px-4 py-3 text-sm font-semibold text-white no-underline " +
  "transition-[transform,filter,box-shadow] duration-[var(--dur-base)] ease-[var(--ease-standard)] " +
  "motion-safe:hover:-translate-y-[1px] hover:brightness-[1.06] active:translate-y-0 active:brightness-100 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-300)] " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-base)] " +
  "disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:brightness-100 disabled:cursor-not-allowed";

/** The Atlas specular top-edge highlight — same signature as GlassPanel/Button. */
function Specular() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute left-2 right-2 top-0 h-px"
      style={{
        background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.5), transparent)",
      }}
    />
  );
}

export function AuthButton({
  href,
  type = "button",
  onClick,
  disabled,
  loading,
  tone = "primary",
  fullWidth = true,
  ariaLabel,
  className = "",
  children,
}: {
  href?: string;
  type?: "button" | "submit";
  onClick?: () => void;
  disabled?: boolean;
  loading?: boolean;
  tone?: AuthButtonTone;
  fullWidth?: boolean;
  ariaLabel?: string;
  className?: string;
  children: ReactNode;
}) {
  const cls = [BASE, fullWidth ? "w-full" : "", className].filter(Boolean).join(" ");
  const style = TONE[tone];

  const inner = (
    <>
      <Specular />
      {loading && <Loader2 size={15} className="animate-spin" />}
      {children}
    </>
  );

  if (href) {
    return (
      <Link href={href} aria-label={ariaLabel} className={cls} style={style}>
        {inner}
      </Link>
    );
  }

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      aria-label={ariaLabel}
      className={cls}
      style={style}
    >
      {inner}
    </button>
  );
}
