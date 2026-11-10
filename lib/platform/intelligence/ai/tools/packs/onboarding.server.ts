/**
 * lib/platform/intelligence/ai/tools/packs/onboarding.server.ts  (Platform AI P6 — the onboarding pack's Production readers)
 *
 * The EXISTING readers, unchanged, behind tools/packs/onboarding.ts:
 *   newConnectionImports   lib/platform/ops/new-connection-imports.ts getNewConnectionImports (identity-free counts)
 *   attention              lib/platform/customer/attention.ts loadAttention (the CS token from THIS call's fresh guard)
 *   timeline               lib/platform/customer/customer-detail.ts getCustomerDetail → onboarding + rollup.funnelStage
 *   ridOf / resolveRid     the customers pack's keyed CUSTOMER rid (customers.server.ts — PRIV-ref, no new key)
 * This file mints nothing (token TYPES only) and never logs.
 */

import "server-only";

import { systemDb } from "@/lib/db";
import { loadAttention } from "@/lib/platform/customer/attention";
import { getCustomerDetail } from "@/lib/platform/customer/customer-detail";
import { getNewConnectionImports } from "@/lib/platform/ops/new-connection-imports";
import { customerRid, resolveCustomerRid } from "./customers.server";
import { onboardingPackTools, type OnboardingPackReaders, type OnboardingToolContext } from "./onboarding";

export const ONBOARDING_PACK_READERS: OnboardingPackReaders = {
  newConnectionImports: (now) => getNewConnectionImports(now),
  attention: async (token, now) => {
    const r = await loadAttention(token, now, systemDb);
    return { facts: r.facts, fold: r.fold };
  },
  timeline: async (userId, token, now) => {
    const d = await getCustomerDetail(userId, token, systemDb, now);
    return d ? { onboarding: d.onboarding, rollup: { funnelStage: d.rollup.funnelStage } } : null;
  },
  ridOf: customerRid,
  resolveRid: (rid) => resolveCustomerRid(rid),
  now: () => new Date(),
};

/** The Production onboarding-pack tools (tools/registry.ts). */
export const ONBOARDING_PACK_TOOLS = onboardingPackTools<OnboardingToolContext>(ONBOARDING_PACK_READERS);
