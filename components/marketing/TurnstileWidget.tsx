"use client";

/**
 * components/marketing/TurnstileWidget.tsx  (Wave 2 ⑥)
 *
 * The landing page's own copy of the Cloudflare Turnstile widget, used by the
 * beta access-request form. It is a DELIBERATE duplicate of
 * components/ui/TurnstileWidget.tsx: the marketing tree must stay importable
 * with no dependency on the authenticated app's component library, so that it
 * can split into its own repo/deploy carrying only static pages + one fetch URL
 * (investigation §3; enforced by lib/marketing-boundary.test.ts). A generic
 * CAPTCHA widget is exactly the kind of primitive the marketing repo owns its
 * own copy of — keep the two files in sync. This is the second (and only other)
 * "use client" island the marketing boundary test permits.
 *
 * No SDK, no app imports — just react + one <script> tag. The server
 * (/api/access-request → lib/captcha.ts) is the authoritative verifier; on a
 * client script-load failure we signal a null token and let the server decide.
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
  }, [siteKey, theme, action, resetNonce]);

  return <div ref={containerRef} className={className} />;
}
