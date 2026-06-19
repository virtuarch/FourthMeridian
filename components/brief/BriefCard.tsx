"use client";

/**
 * BriefCard
 *
 * Atlas Glass card for a single BriefSection. Renders through the shared
 * GlassPanel primitive so it matches every other glass surface on the brief
 * (same blur, saturation, border, specular edge, elevation).
 */

import Link from "next/link";
import {
  TrendingUp,
  AlertTriangle,
  Lightbulb,
  CheckCircle,
  Circle,
  ArrowRight,
} from "lucide-react";
import { GlassPanel } from "@/components/atlas/GlassPanel";
import { TONE_TEXT, TONE_VALUE, TONE_BORDER_L } from "@/components/atlas/tones";
import type { BriefSection, BriefItem, BriefTone } from "@/lib/brief-types";

// ── Section icon ──────────────────────────────────────────────────────────────

function SectionIcon({ type, tone }: { type: BriefSection["type"]; tone?: BriefTone }) {
  const cls = `w-3.5 h-3.5 ${TONE_TEXT[tone ?? "neutral"]} shrink-0`;
  switch (type) {
    case "since_last_visit": return <TrendingUp    className={cls} />;
    case "insight":          return <Lightbulb     className={cls} />;
    case "attention":        return <AlertTriangle className={cls} />;
    case "onboarding":       return <CheckCircle   className={cls} />;
    default:                 return <TrendingUp    className={cls} />;
  }
}

// ── Item rows ─────────────────────────────────────────────────────────────────

function ItemRow({ item }: { item: BriefItem }) {
  const tone = item.tone ?? "neutral";
  const inner = (
    <div
      className="flex items-center justify-between gap-3 py-2 last:border-0"
      style={{ borderBottom: "1px solid var(--border-hairline)" }}
    >
      <div className="flex items-start gap-2 min-w-0">
        <Circle className="w-1.5 h-1.5 mt-1.5 text-[var(--text-muted)]/50 shrink-0" />
        <div className="min-w-0">
          <span className={`text-sm leading-snug ${TONE_TEXT[tone]}`}>{item.label}</span>
          {item.detail && (
            <p className="text-xs text-[var(--text-muted)] mt-0.5 leading-tight">{item.detail}</p>
          )}
        </div>
      </div>
      {item.value && (
        <span className={`text-sm shrink-0 tabular-nums ${TONE_VALUE[tone]}`}>{item.value}</span>
      )}
      {item.href && <ArrowRight className="w-3 h-3 text-[var(--text-muted)]/60 shrink-0" />}
    </div>
  );

  return item.href
    ? <Link href={item.href} className="block hover:bg-[var(--surface-hover)] -mx-4 px-4 rounded-[var(--radius-sm)] transition-colors">{inner}</Link>
    : inner;
}

function OnboardingRow({ item }: { item: BriefItem }) {
  const inner = (
    <div
      className="flex items-center gap-3 py-2.5 last:border-0"
      style={{ borderBottom: "1px solid var(--border-hairline)" }}
    >
      <div className="w-4 h-4 rounded-full border border-[var(--border-hairline-strong)] flex items-center justify-center shrink-0">
        <div className="w-1.5 h-1.5 rounded-full bg-[var(--text-muted)]/60" />
      </div>
      <span className="text-sm text-[var(--text-secondary)] leading-snug">{item.label}</span>
      {item.href && <ArrowRight className="w-3 h-3 text-[var(--text-muted)]/70 ml-auto shrink-0" />}
    </div>
  );

  return item.href
    ? <Link href={item.href} className="block hover:bg-[var(--surface-hover)] -mx-4 px-4 rounded-[var(--radius-sm)] transition-colors">{inner}</Link>
    : inner;
}

// ── Main card ─────────────────────────────────────────────────────────────────

interface BriefCardProps {
  section: BriefSection;
}

export function BriefCard({ section }: BriefCardProps) {
  const tone      = section.tone ?? "neutral";
  const isOnboard = section.type === "onboarding";
  const accentCls = TONE_BORDER_L[tone];

  return (
    <GlassPanel
      depth="thin"
      elevation="e2"
      radius="lg"
      interactive
      className={[
        tone !== "neutral" ? `border-l-2 ${accentCls}` : "",
        "p-4 md:p-5",
      ].join(" ")}
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <SectionIcon type={section.type} tone={section.tone} />
        <h2 className="text-xs font-semibold tracking-wide uppercase text-[var(--text-muted)]">
          {section.title}
        </h2>
      </div>

      {/* Body text */}
      {section.body && (
        <p className="text-sm text-[var(--text-secondary)] leading-relaxed mb-3">{section.body}</p>
      )}

      {/* Items */}
      {section.items && section.items.length > 0 && (
        <div className="mt-1">
          {isOnboard
            ? section.items.map(item => <OnboardingRow key={item.id} item={item} />)
            : section.items.map(item => <ItemRow       key={item.id} item={item} />)
          }
        </div>
      )}

      {/* Footer action link */}
      {section.actionLabel && section.actionHref && (
        <div className="mt-4 pt-3" style={{ borderTop: "1px solid var(--border-hairline)" }}>
          <Link
            href={section.actionHref}
            className="flex items-center gap-1.5 text-xs text-[var(--meridian-400)] hover:text-[var(--meridian-300)] transition-colors"
          >
            {section.actionLabel}
            <ArrowRight className="w-3 h-3" />
          </Link>
        </div>
      )}
    </GlassPanel>
  );
}
