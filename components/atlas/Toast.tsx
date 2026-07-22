"use client";

/**
 * components/atlas/Toast.tsx  (UI Convergence Wave 1 — W1-D)
 *
 * The one transient save-status primitive. `ToastProvider` mounts a single portal
 * viewport (fixed, `--z-toast`); `useToast().toast(message, {tone})` pushes a
 * self-dismissing message. This replaces the scattered per-form "Saved ✓" flashes
 * and success banners with one shared success/error signal.
 *
 * Domain-neutral platform primitive (Settings today; Admin and other surfaces
 * next). `useToast()` is tolerant of a missing provider — it no-ops — so a
 * component that opts into toasts never crashes a tree that hasn't mounted one.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, AlertCircle, Info } from "lucide-react";

// SSR-safe "are we on the client?" without setState-in-effect: false on the server
// and during hydration, true thereafter — so the body-portal only mounts client-side.
const SUBSCRIBE = () => () => {};
function useMounted(): boolean {
  return useSyncExternalStore(SUBSCRIBE, () => true, () => false);
}

export type ToastTone = "success" | "error" | "neutral";
interface ToastItem { id: number; message: string; tone: ToastTone; }
interface ToastApi { toast: (message: string, opts?: { tone?: ToastTone; durationMs?: number }) => void; }

const ToastContext = createContext<ToastApi | null>(null);

/** Push toasts from anywhere under a ToastProvider. No-ops without a provider. */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? NOOP;
}
const NOOP: ToastApi = { toast: () => {} };

const TONE: Record<ToastTone, { color: string; Icon: typeof Check }> = {
  success: { color: "var(--accent-positive)", Icon: Check },
  error:   { color: "var(--accent-negative)", Icon: AlertCircle },
  neutral: { color: "var(--text-secondary)",  Icon: Info },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const mounted = useMounted();
  const seq = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const t = timers.current;
    return () => { t.forEach(clearTimeout); };
  }, []);

  const toast = useCallback<ToastApi["toast"]>((message, opts) => {
    const id = ++seq.current;
    setItems((prev) => [...prev, { id, message, tone: opts?.tone ?? "success" }]);
    const handle = setTimeout(() => {
      setItems((prev) => prev.filter((t) => t.id !== id));
    }, opts?.durationMs ?? 2600);
    timers.current.push(handle);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {mounted && createPortal(
        <div
          className="fixed bottom-4 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 pointer-events-none"
          style={{ zIndex: "var(--z-toast)" }}
          aria-live="polite"
          role="status"
        >
          {items.map(({ id, message, tone }) => {
            const { color, Icon } = TONE[tone];
            return (
              <div
                key={id}
                className="pointer-events-auto flex items-center gap-2 rounded-[var(--radius-lg)] border px-3.5 py-2.5 text-sm shadow-[var(--shadow-e3)]"
                style={{ background: "var(--glass-thick)", borderColor: "var(--border-hairline)", color: "var(--text-primary)", backdropFilter: "blur(12px)" }}
              >
                <Icon size={15} style={{ color }} aria-hidden />
                <span>{message}</span>
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}
