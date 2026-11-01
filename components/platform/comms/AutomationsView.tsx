"use client";

/**
 * components/platform/comms/AutomationsView.tsx  (Customer Success — Communications Center › Automations)
 *
 * READ-ONLY in this release (contract §4.6). The automation routes belong to
 * Session 1's Phase B engine and are not deployed yet: the view PROBES
 * GET /automations, shows "coming soon" on 404 / 501, and renders the real list
 * and detail the moment the route answers 200 — no code change needed.
 *
 * Mutations (activate / pause / disable / dry run / test send) are NOT offered:
 * their routes do not exist. Each is listed as an explained, unavailable action
 * from AUTOMATION_ACTION_SEAMS (lib/platform/comms-center/client.ts) — the seam
 * a later change wires to its route, with the owner's permission rule in its copy.
 */

import { useCallback, useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Block, Surface } from "@/components/atlas/Surface";
import { AUTOMATION_ACTION_SEAMS, automationRunsUrl, automationUrl, automationsUrl } from "@/lib/platform/comms-center/client";
import type { AutomationDetail, AutomationsResponse, AutomationSummary, RunsResponse } from "@/lib/platform/comms-center/contract-v1-section-4";
import { DetailDrawer } from "../ui";
import { ToneBadge } from "../platform-surface";
import { AUTOMATION_STATE_TONE, CHANNEL_LABEL, COMMS_POLICY, SUPPRESSION_LABEL, humanize, utcStamp } from "./comms-model";
import { Chip, DrawerSection, FactList, ListMeta, PolicyNote, ReadState, okData, useCommsRead, type CommsRead } from "./comms-kit";

const n = (v: number) => v.toLocaleString("en-US");

export const AUTOMATIONS_COMING_SOON =
  "Automations arrive with the automation engine. Once it is live, every automation — its trigger, target message, state and recent runs — appears here, read-only first.";

function PolicyList() {
  return (
    <ul className="flex list-disc flex-col gap-1 pl-5 text-[11px] text-[var(--text-muted)]" aria-label="Automation rules" data-automation-policy>
      <li>{COMMS_POLICY.elevated} Pausing and disabling only reduce sending.</li>
      <li>{COMMS_POLICY.protectedAlerts}</li>
      <li>{COMMS_POLICY.storm}</li>
      <li>Operators choose a message and its conditions; copy and templates are code-reviewed, never typed here.</li>
    </ul>
  );
}

export function AutomationsSurface({ read, onOpen }: { read: CommsRead<AutomationsResponse>; onOpen: (id: string) => void }) {
  const data = okData(read);
  return (
    <div className="flex min-w-0 flex-col gap-8 md:gap-10" data-comms-view="automations">
      <Block id="comms-automations" label="Automations" className="min-w-0"
        hint={<span className="text-[11px] text-[var(--text-faint)]">Read-only</span>}>
        <Surface className="flex min-w-0 flex-col gap-4 p-4 sm:p-5">
          <ReadState read={read} what="automations" comingSoon={AUTOMATIONS_COMING_SOON} />
          {data && (
            <>
              {data.items.length === 0 ? <p role="status" className="text-xs text-[var(--text-secondary)]">No automations yet.</p> : (
                <ul aria-label="Automations" className="flex min-w-0 flex-col gap-2 md:gap-0 md:divide-y md:divide-[var(--border-hairline)]" data-automation-list>
                  {data.items.map((a) => <li key={a.id} className="min-w-0"><AutomationRow a={a} onOpen={onOpen} /></li>)}
                </ul>
              )}
              <ListMeta checkedAt={data.checkedAt} floor={data.floor} capped={data.capped} nextCursor={data.nextCursor} extra={`${n(data.items.length)} shown`} />
            </>
          )}
          <PolicyList />
        </Surface>
      </Block>
    </div>
  );
}

function AutomationRow({ a, onOpen }: { a: AutomationSummary; onOpen: (id: string) => void }) {
  return (
    <button type="button" onClick={() => onOpen(a.id)} aria-haspopup="dialog"
      className="flex min-h-11 w-full min-w-0 items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--meridian-400)] max-md:rounded-[var(--radius-md)] max-md:border max-md:border-[var(--border-hairline)]">
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="min-w-0 truncate text-sm font-medium text-[var(--text-primary)]">{a.name}</span>
          <ToneBadge word={humanize(a.state)} tone={AUTOMATION_STATE_TONE[a.state]} />
          {a.autoPausedReason && <Chip tone="warn">Auto-paused: {humanize(a.autoPausedReason)}</Chip>}
        </span>
        <span className="min-w-0 break-all font-mono text-[11px] text-[var(--text-muted)]">{a.triggerKey} → {a.definitionKey}@v{a.definitionVersion}</span>
        <span className="text-[11px] tabular-nums text-[var(--text-muted)]">
          {a.channels.map((c) => CHANNEL_LABEL[c]).join(" · ") || "No channels"} · last run {a.lastRun ? `${utcStamp(a.lastRun.at)} (${humanize(a.lastRun.status)})` : "never"}
        </span>
      </span>
      <ChevronRight size={14} aria-hidden className="mt-1 shrink-0 text-[var(--text-muted)]" />
    </button>
  );
}

export function AutomationDetailBody({ read, runs }: { read: CommsRead<AutomationDetail>; runs: CommsRead<RunsResponse> }) {
  const d = okData(read);
  if (!d) return <ReadState read={read} what="this automation" comingSoon={AUTOMATIONS_COMING_SOON} />;
  const r = okData(runs);
  return (
    <div className="flex min-w-0 flex-col gap-5" data-automation-detail={d.id}>
      <DrawerSection title="About">
        {d.description && <p className="text-xs text-[var(--text-secondary)]">{d.description}</p>}
        <FactList rows={[
          ["State", <ToneBadge key="s" word={humanize(d.state)} tone={AUTOMATION_STATE_TONE[d.state]} />],
          ["Trigger", <code key="t" className="break-all font-mono text-[11px]">{d.triggerKey}</code>],
          ["Message", <code key="m" className="break-all font-mono text-[11px]">{`${d.definitionKey}@v${d.definitionVersion}`}</code>],
          ["Channels", d.channels.map((c) => CHANNEL_LABEL[c]).join(", ") || "—"],
          ["Recipients", humanize(d.recipient.kind)],
          ["Delay", d.delay ? `${n(d.delay.minutes)} min (re-checked before sending)` : "None"],
          ["Dedupe key", <code key="dk" className="break-all font-mono text-[11px]">{d.dedupeKeyTemplate}</code>],
          ["Frequency cap", `${n(d.frequencyCap.max)} per ${n(d.frequencyCap.perHours)} h per recipient`],
          ["Retry", humanize(d.retryPolicy)],
          ["Max recipients per run", n(d.maxRecipientsPerRun)],
          ["Version", `v${d.version}${d.activatedVersion !== null ? ` · activated at v${d.activatedVersion}` : ""}`],
          ["Updated", utcStamp(d.updatedAt)],
        ]} />
        {d.autoPausedReason && <PolicyNote>Auto-paused: {humanize(d.autoPausedReason)}. Re-activating requires elevated operator permission.</PolicyNote>}
      </DrawerSection>

      <DrawerSection title="Conditions">
        {d.conditions.length === 0 ? <p className="text-xs text-[var(--text-secondary)]">None — every trigger event qualifies.</p> : (
          <ul className="flex flex-col gap-1" aria-label="Conditions">{d.conditions.map((c, i) => <li key={i}><code className="break-all font-mono text-[11px] text-[var(--text-secondary)]">{c.op}</code></li>)}</ul>
        )}
      </DrawerSection>

      <DrawerSection title="Recent runs">
        <ReadState read={runs} what="runs" />
        {r && (r.items.length === 0 ? <p className="text-xs text-[var(--text-secondary)]">No runs yet.</p> : (
          <ul className="flex flex-col divide-y divide-[var(--border-hairline)]" aria-label="Runs">
            {r.items.map((run) => {
              const suppressed = Object.values(run.counts.suppressed).reduce((a, v) => a + v, 0);
              return (
                <li key={run.id} className="flex min-w-0 flex-col gap-0.5 py-2 text-[11px] tabular-nums">
                  <span className="text-[var(--text-primary)]">{utcStamp(run.startedAt)} · {run.mode === "DRY_RUN" ? "Dry run" : "Live"} · {humanize(run.status)}{run.haltReason ? ` (${SUPPRESSION_LABEL[run.haltReason]})` : ""}</span>
                  <span className="text-[var(--text-muted)]">{`${n(run.counts.matched)} matched · ${n(run.counts.accepted)} accepted · ${n(run.counts.failed)} failed · ${n(run.counts.captured)} captured · ${n(run.counts.cancelled)} cancelled · ${n(suppressed)} suppressed`}</span>
                </li>
              );
            })}
          </ul>
        ))}
        {r && <ListMeta checkedAt={r.checkedAt} floor={r.floor} capped={r.capped} nextCursor={r.nextCursor} />}
      </DrawerSection>

      <DrawerSection title="History">
        {d.history.length === 0 ? <p className="text-xs text-[var(--text-secondary)]">No recorded actions.</p> : (
          <ul className="flex flex-col gap-1 text-[11px] tabular-nums text-[var(--text-secondary)]" aria-label="History">
            {d.history.map((h) => <li key={h.auditLogId}>{utcStamp(h.at)} · {humanize(h.action)} · {humanize(h.actorKind)}</li>)}
          </ul>
        )}
      </DrawerSection>

      {/* Seam: the actions the engine will accept. None is wired in this release. */}
      <DrawerSection title="Actions">
        <ul className="flex flex-col gap-1.5" aria-label="Automation actions (not yet available)" data-action-seams>
          {AUTOMATION_ACTION_SEAMS.map((s) => (
            <li key={s.action} className="flex min-w-0 flex-col gap-0.5 text-[11px]">
              <span className="font-medium text-[var(--text-secondary)]">{s.label}{s.elevated ? " · requires elevated operator permission" : ""} · not yet available</span>
              <span className="text-[var(--text-muted)]">{s.note}</span>
            </li>
          ))}
        </ul>
      </DrawerSection>
    </div>
  );
}

function AutomationDrawerBody({ id, onName }: { id: string; onName: (id: string, name: string) => void }) {
  const read = useCommsRead<AutomationDetail>(automationUrl(id));
  const detail = okData(read);
  const runs = useCommsRead<RunsResponse>(detail ? automationRunsUrl(id) : null);
  // The drawer title comes from the detail when the row is not in the loaded list.
  const detailName = detail?.name ?? null;
  useEffect(() => { if (detailName) onName(id, detailName); }, [id, detailName, onName]);
  return <AutomationDetailBody read={read} runs={runs} />;
}

export function CommsAutomationsLead() {
  const read = useCommsRead<AutomationsResponse>(automationsUrl());
  const [open, setOpen] = useState<string | null>(null);
  const [detailName, setDetailName] = useState<{ id: string; name: string } | null>(null);
  const onName = useCallback((id: string, name: string) => setDetailName({ id, name }), []);
  const name = okData(read)?.items.find((a) => a.id === open)?.name ?? (detailName && detailName.id === open ? detailName.name : undefined);
  return (
    <>
      <AutomationsSurface read={read} onOpen={setOpen} />
      <DetailDrawer open={open !== null} onClose={() => setOpen(null)} eyebrow="Automation" title={name ?? "Automation"} size="xl">
        {open && <AutomationDrawerBody key={open} id={open} onName={onName} />}
      </DetailDrawer>
    </>
  );
}
