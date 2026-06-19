"use client";

/**
 * DailyBriefClient
 *
 * Full cinematic Daily Brief orchestrator.
 *
 * Layout (top → bottom):
 *   BriefHero          — full-bleed earth + typography
 *   ── content area (max-w-[1400px], px-6 md:px-10 xl:px-16) ──
 *   BriefSinceLastVisit  — 4-column glass panel
 *   BriefInsight         — wide insight card
 *   BriefAttention       — always present; healthy or alert state
 *   BriefActions         — CTA buttons
 *   timestamp footer
 *
 * Section routing:
 *   since_last_visit  → BriefSinceLastVisit
 *   insight           → BriefInsight
 *   attention         → BriefAttention
 *   onboarding        → BriefCard
 *   map               → filtered out (earth IS the map)
 *   anything else     → BriefCard fallback
 *
 * New-user state: BriefNewUser shown when !hasData && new_user;
 * onboarding section still rendered after it as a checklist.
 *
 * Stagger: each section fades in with a sequential CSS delay.
 */

import { useEffect, useState } from "react";
import { BriefHero }           from "./BriefHero";
import { BriefCard }           from "./BriefCard";
import { BriefNewUser }        from "./BriefNewUser";
import { BriefSinceLastVisit } from "./BriefSinceLastVisit";
import { BriefInsight }        from "./BriefInsight";
import { BriefAttention }      from "./BriefAttention";
import type { BriefPayload, BriefSection } from "@/lib/brief-types";

// ── Skeleton ──────────────────────────────────────────────────────────────────

function BriefSkeleton() {
  return (
    <div className="animate-pulse">
      {/* Hero — height scales with BriefHero's own clamp() (currently
          480px/72vh/820px) so the skeleton doesn't visibly "pop" taller
          once the real hero mounts. */}
      <div
        className="w-full"
        style={{ minHeight: "clamp(440px, 65vh, 740px)", background: "var(--ink-800)" }}
      />
      {/* Cards */}
      <div className="px-6 md:px-10 xl:px-16 max-w-[1400px] mx-auto mt-8 space-y-4">
        <div className="h-36" style={{ borderRadius: "var(--radius-lg)", background: "var(--glass-thin)" }} />
        <div className="h-32" style={{ borderRadius: "var(--radius-lg)", background: "var(--glass-ultrathin)" }} />
        <div className="h-20" style={{ borderRadius: "var(--radius-lg)", background: "var(--glass-ultrathin)" }} />
      </div>
    </div>
  );
}

// ── Error state ───────────────────────────────────────────────────────────────

function BriefError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center px-4">
      <p className="text-sm text-[var(--text-muted)]">Couldn&apos;t load your brief.</p>
      <button
        onClick={onRetry}
        className="text-xs text-[var(--meridian-400)] hover:text-[var(--meridian-300)] underline transition-colors"
      >
        Try again
      </button>
    </div>
  );
}

// ── Stagger wrapper ───────────────────────────────────────────────────────────
// Each section gets an incrementing CSS transition-delay so they cascade in.

function StaggerSection({
  index,
  children,
}: {
  index: number;
  children: React.ReactNode;
}) {
  return (
    <div
      className="briefSection"
      style={{
        transitionDelay: `${index * 80}ms`,
      }}
    >
      {children}
    </div>
  );
}

// ── Section router ────────────────────────────────────────────────────────────

function SectionRenderer({
  section,
  index,
}: {
  section: BriefSection;
  index: number;
}) {
  switch (section.type) {
    case "since_last_visit":
      return (
        <StaggerSection index={index}>
          <BriefSinceLastVisit section={section} />
        </StaggerSection>
      );
    case "insight":
      return (
        <StaggerSection index={index}>
          <BriefInsight section={section} />
        </StaggerSection>
      );
    case "attention":
      // BriefAttention rendered separately — skip here
      return null;
    case "map":
      // Earth IS the map — skip
      return null;
    default:
      // onboarding, unknown types → glass card
      return (
        <StaggerSection index={index}>
          <BriefCard section={section} />
        </StaggerSection>
      );
  }
}

// ── Main component ────────────────────────────────────────────────────────────

export function DailyBriefClient() {
  const [payload, setPayload] = useState<BriefPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(false);
  const [visible, setVisible] = useState(false);

  // Retry — called from error button only (no synchronous setState in effect)
  function retryBrief() {
    setLoading(true);
    setError(false);
    setVisible(false);
    fetch("/api/brief")
      .then(res => {
        if (!res.ok) throw new Error("Failed");
        return res.json() as Promise<BriefPayload>;
      })
      .then(data => { setPayload(data); setLoading(false); })
      .catch(() => { setError(true); setLoading(false); });
  }

  // Initial load
  useEffect(() => {
    fetch("/api/brief")
      .then(res => {
        if (!res.ok) throw new Error("Failed");
        return res.json() as Promise<BriefPayload>;
      })
      .then(data => { setPayload(data); setLoading(false); })
      .catch(() => { setError(true); setLoading(false); });
  }, []);

  // Trigger stagger fade-in once data arrives
  useEffect(() => {
    if (!payload) return;
    const t = setTimeout(() => setVisible(true), 50);
    return () => clearTimeout(t);
  }, [payload]);

  // Mark viewed — best effort, non-blocking
  useEffect(() => {
    if (!payload) return;
    fetch("/api/brief/viewed", { method: "POST" }).catch(() => {});
  }, [payload]);

  if (loading) return <BriefSkeleton />;
  if (error || !payload) return <BriefError onRetry={retryBrief} />;

  const { visitState, contextLine, hasData, sections, generatedAt } = payload;

  const isNewUser      = visitState === "new_user" && !hasData;
  const attentionSec   = sections.find(s => s.type === "attention");
  const renderedSections = sections.filter(s => s.type !== "map" && s.type !== "attention");

  return (
    <>
      {/* CSS for stagger fade-in */}
      <style>{`
        .briefVisible .briefSection {
          opacity: 1;
          transform: translateY(0);
        }
        .briefSection {
          opacity: 0;
          transform: translateY(12px);
          transition: opacity var(--dur-slow) var(--ease-standard), transform var(--dur-slow) var(--ease-standard);
        }
      `}</style>

      <div className={isVisible(visible) ? "briefVisible" : ""}>
        {/* ── Hero — full bleed ─────────────────────────────────────────────── */}
        <BriefHero
          visitState={visitState}
          contextLine={contextLine}
          generatedAt={generatedAt}
        />

        {/* ── Content below hero ────────────────────────────────────────────── */}
        <div className="px-6 md:px-10 xl:px-16 max-w-[1400px] mx-auto pb-16">

          {/* New user card */}
          {isNewUser && (
            <StaggerSection index={0}>
              <div className="mt-8">
                <BriefNewUser />
              </div>
            </StaggerSection>
          )}

          {/* Ordered sections */}
          <div className={isNewUser ? "mt-6 space-y-4" : "mt-8 space-y-4"}>
            {renderedSections.map((section, i) => (
              <SectionRenderer
                key={section.id}
                section={section}
                index={isNewUser ? i + 1 : i}
              />
            ))}

            {/* Needs Attention — always rendered */}
            <StaggerSection index={renderedSections.length + (isNewUser ? 1 : 0)}>
              <BriefAttention section={attentionSec} />
            </StaggerSection>
          </div>

          {/* Spacer footer — CTAs are now in the hero */}
          <div className="pt-8" />
        </div>
      </div>
    </>
  );
}

function isVisible(v: boolean) { return v ? "briefVisible" : ""; }
