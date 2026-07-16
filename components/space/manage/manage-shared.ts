/**
 * components/space/manage/manage-shared.ts  (MSM decomposition)
 *
 * Cross-panel primitives shared by the extracted Manage-Space panels — the
 * small surface that genuinely spans more than one panel. Everything single-
 * panel stays co-located with its panel; this file is deliberately minimal so
 * the decomposition does NOT create a lifted "everything" module.
 *
 *   - SpaceDetail / Member          — the GET /api/spaces/[id] payload shape
 *     (roster is a side-payload of that route; there is no members loader).
 *   - SharedAccount / UserAccount   — the account-sharing view shapes.
 *   - ROLE_LABELS                    — role display labels (shell subtitle + members).
 *   - formatBalance                  — currency label formatter (finances + share panel).
 *
 * Behavior-preserving extraction: these are the exact types/helpers the former
 * single-file ManageSpaceModal declared inline.
 */

import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";

// ─── Types ─────────────────────────────────────────────────────────────────────

export type Member = {
  id: string;
  role: string;
  joinedAt: string;
  user: { id: string; name: string | null; username: string | null; email: string | null };
};

export type SpaceDetail = {
  id:          string;
  name:        string;
  description: string | null;
  type:        string;
  category:    string;
  isPublic:    boolean;
  /** MC1 Phase 4 Slice 2 — authoritative reporting currency (present on the GET include). */
  reportingCurrency?: string;
  createdAt:   string;
  members:     Member[];
  myRole:      string | null;
};

export type SharedAccount = {
  id:          string;
  name:        string;
  type:        string;
  institution: string;
  balance:     number;
  currency:    string;
  lastUpdated: string;
};

export type UserAccount = SharedAccount & { mask?: string | null };

// ─── Role display ───────────────────────────────────────────────────────────────

export const ROLE_LABELS: Record<string, string> = {
  OWNER: "Owner", ADMIN: "Admin", MEMBER: "Member", VIEWER: "Viewer",
};

// ─── Format ────────────────────────────────────────────────────────────────────

export function formatBalance(amount: number, currency = DEFAULT_DISPLAY_CURRENCY) {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency, maximumFractionDigits: 0,
  }).format(amount);
}
