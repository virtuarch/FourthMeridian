"use client";

/**
 * components/space/widgets/activity/event-visuals.tsx
 *
 * The small shared vocabulary the editorial Activity surfaces (timeline + detail)
 * render a TimelineEvent through: its Lucide icon, its tone colour, and the
 * relative/absolute time strings. Kept together so the marker in the feed and the
 * glyph in the detail panel can never drift apart.
 *
 * Tone → colour follows the same restraint as the rest of the product (Design
 * Language Law 7): colour on a marker is a signal, so only genuine positive /
 * negative severity carries it; info / warning / neutral resolve to ink. The icon
 * name → component map mirrors the TimelineWidget's set (the widget still powers
 * the embeddable `recent_activity` section); this module is the editorial tab's.
 */

import {
  Activity, AlertTriangle, Archive, CheckCircle2, Clock, FileDown, Landmark,
  LayoutDashboard, Link2, LogOut, PackageCheck, PackageMinus, PackagePlus,
  RefreshCw, RotateCcw, Settings, Shield, Target, Undo2, Unlink, UserCheck,
  UserMinus, UserPlus, Flame,
} from "lucide-react";
import type { TimelineTone } from "@/lib/timeline-types";

const ICON_MAP: Record<string, React.ElementType> = {
  Activity,
  AlertTriangle,
  Archive,
  CheckCircle2,
  Clock,
  FileDown,
  Flame,
  Landmark,
  LayoutDashboard,
  Link2,
  LogOut,
  PackageCheck,
  PackageMinus,
  PackagePlus,
  RefreshCw,
  RotateCcw,
  Settings,
  Shield,
  Target,
  Undo2,
  Unlink,
  UserCheck,
  UserMinus,
  UserPlus,
};

export function EventIcon({ name, size = 14 }: { name?: string; size?: number }) {
  const Icon = (name && ICON_MAP[name]) || Activity;
  return <Icon size={size} />;
}

/** Marker/glyph colour — only real positive/negative severity is coloured. */
export function toneColor(tone: TimelineTone | undefined): string {
  switch (tone) {
    case "positive": return "var(--accent-positive)";
    case "danger":   return "var(--accent-negative)";
    default:         return "var(--text-secondary)";
  }
}

/** Whether the marker is filled (a coloured event) or hollow (a neutral one). */
export function isColoredTone(tone: TimelineTone | undefined): boolean {
  return tone === "positive" || tone === "danger";
}

/** "just now" · "12m ago" · "3h ago" · "2d ago" · "Jun 4" — the compact stamp. */
export function timeAgo(iso: string, now: Date): string {
  const diffMs  = now.getTime() - new Date(iso).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1)  return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24)   return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 7)    return `${diffD}d ago`;
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short", day: "numeric",
    year:  new Date(iso).getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}
