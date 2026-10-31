/**
 * lib/notifications/automations/dry-run.ts  (Comms Center B2 — POST /automations/[id]/dry-run, contract v1.1 §6.8)
 *
 * Replays the recorded trigger facts (facts.ts — the AuditLog rows the domain
 * events wrote) over the window, or one triggerRef, through the SAME evaluation
 * the live engine runs (engine.ts evaluateEligibility, resolveRecipients, the
 * §6.5 lifecycle matrix, the global freeze, the per-recipient storm-limit COUNT)
 * — AS A READ:
 *   · it SENDS NOTHING: no createNotification, no sendEmail;
 *   · it CLAIMS NO ITEM: no AutomationRunItem is written;
 *   · it writes NO CommsDelivery row.
 * The caller (store.ts recordDryRun) writes ONE AutomationRun{mode:"DRY_RUN"}
 * row with these counts plus the audit row, in one transaction.
 *
 * Examples are SYNTHETIC: the live content rendered with placeholder sample
 * values (never a real recipient, never real payload values).
 */

import type { CommsDefinition } from "@/lib/notifications/catalog/types";
import { renderCatalogPreview } from "@/lib/notifications/catalog/preview";
import { EMAIL_STORM_LIMIT } from "@/lib/notifications/catalog/types";
import { isStormLimitedKey } from "@/lib/notifications/catalog/definitions";
import type { UserLifecycleState } from "@/lib/entitlements/beta-lifecycle";
import type { GlobalCostFreezeVerdict } from "@/lib/platform/cost-freeze.core";
import { legSpec } from "@/lib/notifications/content/legs";
import { inAppRender, renderContentEmail, textValues } from "@/lib/notifications/content/render";
import { PREVIEW_APP_BASE } from "@/lib/email/preview";
import { NOTIFICATION_REGISTRY } from "@/lib/notifications/registry";
import type { LiveContentResolver } from "@/lib/notifications/content/send";
import { readFact, readFactsAfter, type FactReadClient, type TriggerFact } from "./facts";
import { emptyCounts, idempotencyKey } from "./rules";
import { dedupeKeyFor, evaluateEligibility, readGrantAreas, readRecipients, resolveRecipients, type EngineDb } from "./engine";
import type { AutomationChannel, AutomationRunCounts, Condition, DryRunResult } from "./types";
import type { RecipientResolver, TriggerKey } from "@/lib/notifications/catalog/types";

export interface DryRunAutomation {
  id: string;
  triggerKey: string;
  definitionKey: string;
  variant: string;
  channels: string[];
  conditions: unknown;
  recipient: unknown;
  dedupeKeyTemplate: string;
  frequencyCapMax: number;
  frequencyCapHours: number;
  maxRecipientsPerRun: number;
  activatedVersion: number | null;
}

export interface DryRunDeps {
  db: EngineDb;
  freeze(): Promise<GlobalCostFreezeVerdict>;
  lifecycle(userIds: readonly string[]): Promise<Map<string, UserLifecycleState>>;
  content: LiveContentResolver | null;
}

export interface DryRunEvaluation {
  counts: AutomationRunCounts;
  deduped: number;
  lifecycle: DryRunResult["lifecycle"];
  content: DryRunResult["content"];
  examples: DryRunResult["examples"];
  wouldExceedMaxRecipients: boolean;
  floor: boolean;
  window: { from: Date; to: Date } | null;
  haltReason: "PROVIDER_FREEZE" | null;
}

/** The replay ceiling: past it the counts are a FLOOR. */
export const DRY_RUN_MAX_FACTS = 500;
const LIFECYCLE_STATES: readonly UserLifecycleState[] = ["ACTIVE", "PAUSED", "ENDED", "COST_FREEZE", "UNKNOWN"];

/** C1 — people counts: 1–4 are withheld (small cell), 0 is observed. */
const aggregate = (n: number) => (n > 0 && n < 5 ? { value: null, withheld: true } : { value: n, withheld: false });

export async function evaluateDryRun(
  deps: DryRunDeps,
  a: DryRunAutomation,
  def: CommsDefinition,
  scope: { window: "7d" | "30d" } | { triggerRef: string },
  now: Date,
): Promise<DryRunEvaluation | { notFound: true }> {
  const db = deps.db;
  const trigger = a.triggerKey as TriggerKey;
  const resolver = a.recipient as RecipientResolver;
  const conditions = (Array.isArray(a.conditions) ? a.conditions : []) as Condition[];
  const channels = a.channels.filter((c): c is AutomationChannel => c === "EMAIL" || c === "IN_APP");
  const counts = emptyCounts();
  const people = new Map<UserLifecycleState, Set<string>>(LIFECYCLE_STATES.map((s) => [s, new Set()]));
  let deduped = 0;
  let wouldExceed = false;
  let floor = false;

  let facts: TriggerFact[];
  let window: { from: Date; to: Date } | null = null;
  if ("triggerRef" in scope) {
    const f = await readFact(db as unknown as FactReadClient, trigger, scope.triggerRef);
    if (!f) return { notFound: true };
    facts = [f];
  } else {
    const days = scope.window === "30d" ? 30 : 7;
    window = { from: new Date(now.getTime() - days * 86_400_000), to: now };
    facts = await readFactsAfter(db as unknown as FactReadClient, trigger, { at: window.from, id: null }, DRY_RUN_MAX_FACTS + 1, now);
    if (facts.length > DRY_RUN_MAX_FACTS) { floor = true; facts = facts.slice(0, DRY_RUN_MAX_FACTS); }
  }

  const live = await liveContent(deps, def, a.variant, channels);
  const examples = renderExamples(def, a.variant, live);
  const content: DryRunResult["content"] = live.map(({ channel, source, versionId }) => ({ channel, source, versionId }));

  // The GLOBAL freeze halts a live run before any recipient is resolved: the replay says so.
  let fr: GlobalCostFreezeVerdict;
  try { fr = await deps.freeze(); } catch { fr = { frozen: true, state: "UNAVAILABLE", reason: "POLICY_UNAVAILABLE" }; }
  if (fr.frozen) {
    return { counts, deduped, lifecycle: lifecycleOut(people), content, examples, wouldExceedMaxRecipients: false, floor, window, haltReason: "PROVIDER_FREEZE" };
  }

  // In-memory dedupe across the replay: what the live engine would have SCHEDULED by then.
  const replayOpen = new Set<string>();
  for (const fact of facts) {
    const recipients = await resolveRecipients(db, resolver, fact, a.maxRecipientsPerRun);
    counts.matched += recipients.length;
    if (recipients.length > a.maxRecipientsPerRun) { wouldExceed = true; continue; }
    const lifecycle = await deps.lifecycle(recipients);
    const users = await readRecipients(db, recipients);
    const grants = await readGrantAreas(db, recipients, conditions.some((c) => c.op === "recipient.has_platform_grant"));
    for (const r of recipients) {
      const state = lifecycle.get(r) ?? "UNKNOWN";
      people.get(state)!.add(r);
      for (const channel of channels) {
        // An existing claim for the live activation would make the live run a no-op: deduped.
        if (a.activatedVersion !== null) {
          const idem = idempotencyKey({ automationId: a.id, activatedVersion: a.activatedVersion, triggerRef: fact.ref, recipientId: r, channel });
          if (await db.automationRunItem.findUnique({ where: { idempotencyKey: idem }, select: { id: true } })) { deduped++; continue; }
        }
        const evalIn = {
          automation: { ...a, conditions, recipient: resolver }, def, fact, recipientId: r, channel,
          user: users.get(r) ?? null, grants: grants.get(r) ?? [], lifecycle: state,
        };
        let reason = await evaluateEligibility(db, evalIn, now);
        const dk = `${channel}:${dedupeKeyFor(evalIn)}`;
        if (!reason && replayOpen.has(dk)) reason = "DEDUPE_OPEN";
        // The storm limit, as a COUNT (sendEmail would hold the send): ≥ 5 accepted limited emails this hour.
        if (!reason && channel === "EMAIL" && isStormLimitedKey(def.key)) {
          const since = new Date(now.getTime() - EMAIL_STORM_LIMIT.windowMinutes * 60_000);
          const n = await db.commsDelivery.count({ where: { recipientUserId: r, channel: "EMAIL", status: "ACCEPTED", createdAt: { gte: since } } });
          if (n >= EMAIL_STORM_LIMIT.maxPerRecipient) reason = "RATE_LIMITED";
        }
        if (reason) { counts.suppressed[reason]++; continue; }
        replayOpen.add(dk);
        counts.eligible++;
        counts.scheduled++;
      }
    }
  }
  return { counts, deduped, lifecycle: lifecycleOut(people), content, examples, wouldExceedMaxRecipients: wouldExceed, floor, window, haltReason: null };
}

function lifecycleOut(people: Map<UserLifecycleState, Set<string>>): DryRunResult["lifecycle"] {
  return Object.fromEntries(LIFECYCLE_STATES.map((s) => [s, aggregate(people.get(s)!.size)])) as DryRunResult["lifecycle"];
}

type Live = DryRunResult["content"][number] & { body: import("@/lib/notifications/content/types").ContentBody | null };

async function liveContent(deps: DryRunDeps, def: CommsDefinition, variant: string, channels: AutomationChannel[]): Promise<Live[]> {
  const out: Live[] = [];
  for (const channel of channels) {
    let v: Awaited<ReturnType<LiveContentResolver>> = null;
    if (deps.content && legSpec(def.key, channel)) {
      try { v = await deps.content({ definitionKey: def.key, channel, variant }); } catch { v = null; }
    }
    out.push({ channel, source: v ? "PUBLISHED" : "CODE_DEFAULT", versionId: v?.versionId ?? null, body: v?.body ?? null });
  }
  return out;
}

/** One synthetic example: the LIVE content (published version or code default) with sample placeholder values only. */
function renderExamples(def: CommsDefinition, variant: string, content: Live[]): DryRunResult["examples"] {
  const ex: DryRunResult["examples"][number] = { variant, subject: null, inAppTitle: null };
  for (const live of content) {
    try {
      const spec = legSpec(def.key, live.channel);
      if (live.body && spec) {
        const values = textValues(spec, "SAMPLE");
        if (live.channel === "EMAIL") {
          ex.subject = renderContentEmail({ spec, body: live.body, values, variant, appBaseUrl: PREVIEW_APP_BASE, category: NOTIFICATION_REGISTRY[spec.key].category, preview: true }).subject;
        } else {
          ex.inAppTitle = inAppRender(spec, live.body, values, variant).title;
        }
        continue;
      }
      const r = renderCatalogPreview(def, live.channel === "EMAIL" ? "email-html" : "in-app", null);
      if (!r.ok) continue;
      if (live.channel === "EMAIL") ex.subject = r.body.subject;
      else ex.inAppTitle = r.body.inApp?.title ?? null;
    } catch { /* a leg with no rendition contributes nothing to the example */ }
  }
  return [ex];
}
