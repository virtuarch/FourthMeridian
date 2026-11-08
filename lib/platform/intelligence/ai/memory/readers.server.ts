/**
 * lib/platform/intelligence/ai/memory/readers.server.ts  (Platform AI operational memory — the authorized readers)
 *
 * Design v2 §2 "Revalidate": every ref is re-read through the CURRENT binding
 * or an authorized reader — never from stored text. Built by the route from the
 * operator's FRESH guard result on ONE area (`auth`, `binding`); nothing here
 * re-decides authority:
 *
 *   METRIC    binding.readMetric (the area's metric token; null ⇒ not visible)
 *   PAGE      binding.listPages + binding.resolvePage (the area's navigation token)
 *   INCIDENT  incidentAccessors.investigate with incidentAudienceFor(auth) — the
 *             verdict's operator wording, never a customer identity (the label
 *             is the same identity-free `label` at every tier)
 *   JOB       the scheduled-job health report (Platform Ops only)
 *   PROVIDER  provider health (Platform Ops only)
 *
 * Reports are read at most once per readers instance (one surface). A reader
 * that is not allowed for the area answers null (GONE / not visible).
 */

import "server-only";

import type { PlatformArea } from "@prisma/client";
import type { PlatformAuth } from "@/lib/platform/authorize";
import { incidentAudienceFor } from "@/lib/platform/incidents/intelligence/audience";
import { incidentAccessors } from "@/lib/platform/incidents/intelligence";
import type { PlatformAiBinding } from "../core";
import { incidentRead, jobRead, metricRead, providerRead, type MemoryReaders, type RecordRead } from "./revalidate";

export function buildMemoryReaders(auth: PlatformAuth, area: PlatformArea, binding: PlatformAiBinding): MemoryReaders {
  let jobs: Promise<Array<{ job: string; lastRunStatus: string | null; lastStartedAt: Date | null }>> | null = null;
  let providers: Promise<Array<{ key: string; label: string; trust: string }>> | null = null;
  const ops = area === "PLATFORM_OPS";
  return {
    async metric(id, window) {
      const def = binding.describeMetric(id);
      if (!def) return null;
      return metricRead(await binding.readMetric(id, window ? { window } : {}), def.label);
    },
    async page(id): Promise<RecordRead | null> {
      const t = binding.listPages({}).find((x) => x.id === id);
      if (!t || !binding.resolvePage(id)) return null;
      return { state: "OK", label: t.label, updatedAt: null };
    },
    async incident(id) {
      const token = incidentAudienceFor(auth);
      if (!token) return null;
      const inv = await incidentAccessors.investigate(token, id, { now: new Date() });
      return inv ? incidentRead({ state: inv.verdict.state, label: inv.verdict.label, lastSeenAt: inv.verdict.lastSeenAt }) : null;
    },
    async job(name) {
      if (!ops) return null;
      jobs ??= import("@/lib/jobs/health").then(async (m) => (await m.checkScheduledJobHealth()).jobs);
      return jobRead((await jobs).find((j) => j.job === name) ?? null);
    },
    async provider(key) {
      if (!ops) return null;
      providers ??= import("@/lib/platform/provider-health").then(async (m) => (await m.getProviderHealth()).providers);
      return providerRead((await providers).find((p) => p.key === key) ?? null);
    },
  };
}
