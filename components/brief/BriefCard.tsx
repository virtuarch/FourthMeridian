"use client";

/**
 * BriefCard
 *
 * Glassmorphism card for a single BriefSection.
 * Designed to float over the earth background.
 *
 * Glass treatment:
 *   - backdrop-blur-md
 *   - bg-white/[0.06]  (very translucent)
 *   - border border-white/[0.10]
 *   - subtle inner top-edge highlight
 *   - hover: lift with deeper shadow
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
import type { BriefSection, BriefItem, BriefTone } from "@/lib/brief-types";

// ── Tone colour maps ──────────────────────────────────────────────────────────

const TONE_TEXT: Record<BriefTone, string> = {
  positive: "text-emerald-400",
  warning:  "text-amber-400",
  danger:   "text-red-400",
  info:     "text-blue-400",
  neutral:  "text-gray-300",
};

const TONE_VALUE: Record<BriefTone, string> = {
  positive: "text-emerald-400 font-semibold",
  warning:  "text-amber-400  font-semibold",
  danger:   "text-red-400    font-semibold",
  info:     "text-blue-400   font-semibold",
  neutral:  "text-white      font-semibold",
};

const TONE_ACCENT: Record<BriefTone, string> = {
  positive: "border-l-emerald-500/50",
  warning:  "border-l-amber-500/50",
  danger:   "border-l-red-500/50",
  info:     "border-l-blue-500/50",
  neutral:  "border-l-white/10",
};

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
    <div className="flex items-center justify-between gap-3 py-2 border-b border-white/[0.06] last:border-0">
      <div className="flex items-start gap-2 min-w-0">
        <Circle className="w-1.5 h-1.5 mt-1.5 text-white/20 shrink-0" />
        <div className="min-w-0">
          <span className={`text-sm leading-snug ${TONE_TEXT[tone]}`}>{item.label}</span>
          {item.detail && (
            <p className="text-xs text-gray-500 mt-0.5 leading-tight">{item.detail}</p>
          )}
        </div>
      </div>
      {item.value && (
        <span className={`text-sm shrink-0 tabular-nums ${TONE_VALUE[tone]}`}>{item.value}</span>
      )}
      {item.href && <ArrowRight className="w-3 h-3 text-white/20 shrink-0" />}
    </div>
  );

  return item.href
    ? <Link href={item.href} className="block hover:bg-white/[0.03] -mx-4 px-4 rounded-lg transition-colors">{inner}</Link>
    : inner;
}

function OnboardingRow({ item }: { item: BriefItem }) {
  const inner = (
    <div className="flex items-center gap-3 py-2.5 border-b border-white/[0.06] last:border-0">
      <div className="w-4 h-4 rounded-full border border-white/20 flex items-center justify-center shrink-0">
        <div className="w-1.5 h-1.5 rounded-full bg-white/20" />
      </div>
      <span className="text-sm text-gray-300 leading-snug">{item.label}</span>
      {item.href && <ArrowRight className="w-3 h-3 text-white/25 ml-auto shrink-0" />}
    </div>
  );

  return item.href
    ? <Link href={item.href} className="block hover:bg-white/[0.03] -mx-4 px-4 rounded-lg transition-colors">{inner}</Link>
    : inner;
}

// ── Main card ─────────────────────────────────────────────────────────────────

interface BriefCardProps {
  section: BriefSection;
}

export function BriefCard({ section }: BriefCardProps) {
  const tone      = section.tone ?? "neutral";
  const isOnboard = section.type === "onboarding";
  const accentCls = TONE_ACCENT[tone];

  return (
    <div
      className={[
        // Glass surface
        "relative rounded-2xl overflow-hidden",
        "backdrop-blur-md",
        "bg-white/[0.06]",
        "border border-white/[0.09]",
        // Left accent bar for non-neutral sections
        tone !== "neutral" ? `border-l-2 ${accentCls}` : "",
        // Hover depth
        "transition-all duration-200 hover:bg-white/[0.09] hover:shadow-xl hover:shadow-black/30 hover:-translate-y-0.5",
        "p-4 md:p-5",
      ].join(" ")}
    >
      {/* Inner top-edge highlight — the "glass" effect */}
      <div
        className="absolute top-0 left-0 right-0 h-px"
        style={{ background: "linear-gradient(to right, transparent, rgba(255,255,255,0.12), transparent)" }}
      />

      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <SectionIcon type={section.type} tone={section.tone} />
        <h2 className="text-xs font-semibold tracking-wide uppercase text-gray-400">
          {section.title}
        </h2>
      </div>

      {/* Body text */}
      {section.body && (
        <p className="text-sm text-gray-300 leading-relaxed mb-3">{section.body}</p>
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
        <div className="mt-4 pt-3 border-t border-white/[0.06]">
          <Link
            href={section.actionHref}
            className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors"
          >
            {section.actionLabel}
            <ArrowRight className="w-3 h-3" />
          </Link>
        </div>
      )}
    </div>
  );
}
