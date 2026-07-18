/**
 * components/auth/index.ts  (UI Convergence Wave 2 — W2-A)
 *
 * The auth presentation kit barrel — the shared "front door" surface. Auth logic
 * (NextAuth, proxy.ts, the API handlers) is untouched by anything here; these are
 * purely the frame, card, and feedback pieces the (auth) pages compose.
 */

export { AuthShell } from "@/components/auth/AuthShell";
export { AuthCard } from "@/components/auth/AuthCard";
export { AuthHeader } from "@/components/auth/AuthHeader";
export { AuthFooter } from "@/components/auth/AuthFooter";
export { AuthButton } from "@/components/auth/AuthButton";
export { AuthCallout, type CalloutTone } from "@/components/auth/AuthCallout";
export { AuthStatus, type StatusTone } from "@/components/auth/AuthStatus";
