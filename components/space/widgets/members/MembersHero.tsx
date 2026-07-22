"use client";

/**
 * components/space/widgets/members/MembersHero.tsx
 *
 * Surface ① of the Members workspace — the editorial lede, in the same bare
 * (no-card) idiom as LiquidityHero / DebtHero, but with NO money, NO trust chip,
 * NO delta: Members is envelope "none". It answers one question — "who has access
 * to this Space?" — with the people count as the headline, a plain supporting
 * sentence, and a quiet "your role" bridge. Presentation only; every value passed in.
 */

import { Figure } from "@/components/atlas/Surface";
import { GlassButton } from "@/components/atlas/GlassButton";
import { Settings } from "lucide-react";
import { ROLE_LABELS } from "@/components/space/manage/manage-shared";
import { ROLE_ICONS } from "./members-ui";

export function MembersHero({
  count,
  myRole,
  isPersonal,
  onManage,
}: {
  /** Active member count (the headline). */
  count: number;
  /** The caller's role, for the "your role" bridge line. */
  myRole: string;
  /** Personal Space — strictly single-user, so the copy says so. */
  isPersonal: boolean;
  /** Opens the host-owned Manage Space modal (General / Add Accounts / Delete). */
  onManage?: () => void;
}) {
  return (
    <section>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">People</p>
        {onManage && (
          <GlassButton size="sm" onClick={onManage}>
            <Settings size={12} /> Manage Space
          </GlassButton>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Figure value={count} size="hero" className="sm:text-5xl leading-none" />
        <span className="text-lg text-[var(--text-secondary)]">
          {count === 1 ? "person" : "people"}
        </span>
      </div>

      <p className="mt-2.5 max-w-prose text-sm text-[var(--text-secondary)]">
        {isPersonal
          ? "This is a personal Space — only you can see it."
          : "Everyone here can see this Space. What each person can do depends on their role."}
        <span className="text-[var(--text-muted)]">
          {" · "}your role is {ROLE_LABELS[myRole] ?? myRole}
        </span>
      </p>

      <p className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-[var(--text-faint)]">
        {ROLE_ICONS[myRole] ?? null}
        You&rsquo;re signed in as {ROLE_LABELS[myRole] ?? myRole}
      </p>
    </section>
  );
}
