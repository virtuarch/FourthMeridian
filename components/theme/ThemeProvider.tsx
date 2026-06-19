"use client";

/**
 * components/theme/ThemeProvider.tsx
 *
 * Fourth Meridian global appearance system — Midnight Glass (dark,
 * default) / Light Glass / System. This is the only theme axis in the
 * app: there are no separate navy/gold/purple themes, just dark/light
 * glass. The shared semantic accent palette (Meridian, Brass, Emerald,
 * Coral, Violet) is defined once in :root in app/globals.css and is
 * identical in both modes — this provider only ever toggles which of the
 * two `html[data-theme="..."]` token blocks is active.
 *
 * Persistence: localStorage only (key below). No cookie, no database, no
 * backend call — a pure client-side preference, per spec.
 *
 * Hydration safety: server-rendered HTML never carries a `data-theme`
 * attribute. app/globals.css's bare `html` selector (no [data-theme]
 * qualifier) already resolves to the dark token block, so the server
 * render and the client's first paint are both dark with zero JS — there
 * is nothing to flash on the very first frame. This provider only reads
 * localStorage / matchMedia and applies `data-theme` *after* mount, in an
 * effect; if the stored/system preference turns out to be light, there is
 * one expected swap from the dark default to light shortly after mount,
 * never a hydration mismatch warning. (app/layout.tsx's <html> already
 * carries suppressHydrationWarning for unrelated reasons, but this
 * provider doesn't rely on it — the attribute is simply absent during SSR
 * and the first client render, by construction.)
 *
 * Every setState call below that originates synchronously inside an
 * effect body is deferred one frame via requestAnimationFrame, matching
 * the project's established pattern (BriefModal's entrance trigger,
 * BriefHero's region detection) — this satisfies the
 * react-hooks/set-state-in-effect lint rule. setState calls inside event
 * listener callbacks (matchMedia's "change" handler) are not in that
 * category and are called directly, same as the outside-click handler in
 * UserMenu and InlineFilter's mobile dropdown.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export type ThemeMode = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

const STORAGE_KEY = "fm-theme-mode";

function isThemeMode(value: string | null): value is ThemeMode {
  return value === "dark" || value === "light" || value === "system";
}

interface ThemeContextValue {
  /** The user's stored preference — may be "system". */
  mode: ThemeMode;
  /** What's actually applied to <html data-theme>. Never "system". */
  resolvedTheme: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
  /** False until the post-mount localStorage read has completed. */
  mounted: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>("dark");
  const [systemPrefersDark, setSystemPrefersDark] = useState(true);
  const [mounted, setMounted] = useState(false);

  // Read the persisted preference once, after mount.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      let stored: string | null = null;
      try {
        stored = window.localStorage.getItem(STORAGE_KEY);
      } catch {
        // localStorage unavailable (private browsing, blocked storage,
        // etc.) — fall back to the dark default below.
      }
      setModeState(isThemeMode(stored) ? stored : "dark");
      setMounted(true);
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  // Track the OS-level preference, only while "system" mode is active.
  useEffect(() => {
    if (!mounted || mode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const raf = requestAnimationFrame(() => setSystemPrefersDark(mq.matches));
    const handleChange = (e: MediaQueryListEvent) => setSystemPrefersDark(e.matches);
    mq.addEventListener("change", handleChange);
    return () => {
      cancelAnimationFrame(raf);
      mq.removeEventListener("change", handleChange);
    };
  }, [mounted, mode]);

  const resolvedTheme: ResolvedTheme =
    mode === "system" ? (systemPrefersDark ? "dark" : "light") : mode;

  // Apply to <html data-theme="...">. Skipped before mount so the
  // server-rendered markup (no attribute) keeps matching the client's
  // first paint — see the hydration-safety note above.
  useEffect(() => {
    if (!mounted) return;
    document.documentElement.setAttribute("data-theme", resolvedTheme);
  }, [mounted, resolvedTheme]);

  // Persist the mode itself (not the resolved theme), so "system" stays
  // "system" across reloads rather than freezing at whatever it last
  // resolved to.
  useEffect(() => {
    if (!mounted) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // Best-effort only — never block the UI on a storage failure.
    }
  }, [mounted, mode]);

  const setMode = useCallback((next: ThemeMode) => setModeState(next), []);

  return (
    <ThemeContext.Provider value={{ mode, resolvedTheme, setMode, mounted }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
