"use client";

/**
 * components/ui/TurnstileWidget.tsx  (Wave 2 ⑥)
 *
 * Cloudflare Turnstile widget for the authenticated app's public entry forms
 * (login, register). No SDK — the Turnstile script is one <script> tag loaded
 * once, then the widget is rendered explicitly into a ref'd div. Callers pass
 * the site key (client-inlined NEXT_PUBLIC_TURNSTILE_SITE_KEY) and an onToken
 * callback; the parent posts the token to the server, which is the authoritative
 * verifier (lib/captcha.ts). When the site key is absent, render the widget only
 * behind a caller-side `if (siteKey)` guard — this component assumes it's set.
 *
 * NOTE: the landing page (components/marketing/*) intentionally carries its OWN
 * copy of this widget (components/marketing/TurnstileWidget.tsx) so the marketing
 * tree stays importable without any app-component dependency — the repo-split
 * seam enforced by lib/marketing-boundary.test.ts. Keep the two in sync.
 *
 * CLIENT FAIL-OPEN: if the script fails to load, we signal a null token and move
 * on — the server still verifies (and itself fails open on a Cloudflare outage),
 * so a script-load blip never hard-blocks a legitimate user in the browser.
 */

import { useEffect, useRef } from "react";

interface TurnstileRenderOptions {
  sitekey: string;
  theme?: "auto" | "light" | "dark";
  action?: string;
  callback: (token: string) => void;
  "expired-callback"?: () => void;
  "error-callback"?: () => void;
}

interface TurnstileApi {
  render: (el: HTMLElement, opts: TurnstileRenderOptions) => string;
  remove: (widgetId: string) => void;
  reset: (widgetId?: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_ID  = "cf-turnstile-script";
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/** Load the Turnstile script exactly once per page; shared across every widget. */
let scriptPromise: Promise<void> | null = null;
function loadTurnstileScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("turnstile script failed to load")));
      return;
    }
    const s = document.createElement("script");
    s.id = SCRIPT_ID;
    s.src = SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("turnstile script failed to load"));
    document.head.appendChild(s);
  });
  return scriptPromise;
}

interface TurnstileWidgetProps {
  siteKey: string;
  /** Called with the solved token, or null on expiry/error/load-failure. */
  onToken: (token: string | null) => void;
  theme?: "auto" | "light" | "dark";
  action?: string;
  /** Bump to force a fresh challenge (Turnstile tokens are single-use). */
  resetNonce?: number;
  className?: string;
}

export function TurnstileWidget({
  siteKey,
  onToken,
  theme = "auto",
  action,
  resetNonce,
  className,
}: TurnstileWidgetProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef  = useRef<string | null>(null);
  // Keep the latest onToken without re-rendering the widget on every keystroke.
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useEffect(() => {
    let cancelled = false;

    loadTurnstileScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return;
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          theme,
          action,
          callback: (token: string) => onTokenRef.current(token),
          "expired-callback": () => onTokenRef.current(null),
          "error-callback": () => onTokenRef.current(null),
        });
      })
      .catch(() => {
        if (!cancelled) onTokenRef.current(null); // client fail-open; server verifies
      });

    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) {
        try { window.turnstile.remove(widgetIdRef.current); } catch { /* already gone */ }
        widgetIdRef.current = null;
      }
    };
    // resetNonce in deps: bumping it tears down and re-renders a fresh widget.
  }, [siteKey, theme, action, resetNonce]);

  return <div ref={containerRef} className={className} />;
}
