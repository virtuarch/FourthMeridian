"use client";

/**
 * components/platform/comms/LibraryView.tsx  (Customer Success — Communications Center › Library)
 *
 * The notification catalog (contract §4.2–§4.5, merged in PR #168):
 *
 *   status chips (the server's totals) · filters (status / category / audience /
 *   channel / consent class, server-side) + search · the definition list ·
 *   the trigger catalog (AVAILABLE / PROPOSED)
 *
 * A row opens the detail drawer: description, trigger + producer files, payload
 * field NAMES with PII flags (never values), eligibility, dedupe, frequency cap,
 * retention, the recent day series (null = not observed; delivery counts are never withheld),
 * supported actions, the owner-surface link, the content editor (contract v1.1,
 * ContentEditor.tsx) and the synthetic preview.
 *
 * Nothing here sends a message: previews render server-side from synthetic
 * fixtures and the email HTML is shown in a script-less sandboxed iframe. The
 * only writes are the content editor's (drafts, publish, restore), through the
 * typed client.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { ChevronRight, ExternalLink, Search } from "lucide-react";
import { Block, Surface } from "@/components/atlas/Surface";
import type { CatalogDetail, CatalogItem, CatalogResponse, DefinitionStatus, PreviewChannel, PreviewResponse, TriggerItem, TriggersResponse } from "@/lib/notifications/catalog/types";
import {
  AUTOMATION_ACTION_SEAMS, EMPTY_CATALOG_FILTERS, catalogDetailUrl, catalogTotalsUrl, catalogUrl, previewUrl, readCatalog, triggersUrl,
  type CatalogFilters,
} from "@/lib/platform/comms-center/client";
import { DetailDrawer } from "../ui";
import type { CatalogDetailV11Additions } from "@/lib/notifications/content/types";
import { ContentPanel } from "./ContentEditor";
import { guardDiscard } from "./content-model";
import { ToneBadge } from "../platform-surface";
import { Segmented } from "../leads/visual-kit";
import {
  CHANNEL_LABEL, COMMS_POLICY, CONSENT_LABEL, FILTER_OPTIONS, isInternalPath, protectedNote, retentionText, PREVIEW_LABEL, SEVERITY_TONE, STATUS_LABEL, STATUS_TONE,
  automationsLine, humanize, previewChannelsFor, statusChips, stormNote, totalOf,
} from "./comms-model";
import {
  Chip, DaySeriesBars, DaySeriesLegend, DrawerSection, FactList, FilterSelect, ListMeta, PolicyNote, PreviewRendition, ProtectedBadge, ReadState, WideTargets, okData, staleData,
  useCommsRead, useLastGoodRead,
  type CommsRead,
} from "./comms-kit";

/** Moved to comms-kit (no LibraryView ⇄ ContentEditor cycle); re-exported for existing importers. */
export { PreviewRendition };

const n = (v: number) => v.toLocaleString("en-US");
const CHIP_BTN = "inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-[11px] font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] lg:min-h-7";

// ── Catalog list ────────────────────────────────────────────────────────────────

export interface LibrarySurfaceProps {
  read: CommsRead<CatalogResponse>;
  /** Rows loaded by "Show more" for the current filters (appended). */
  more: { items: CatalogItem[]; nextCursor: string | null; loading: boolean; error: string | null } | null;
  filters: CatalogFilters;
  draftQ: string;
  onDraftQ: (q: string) => void;
  onFilters: (f: CatalogFilters) => void;
  onOpen: (key: string) => void;
  onMore: (cursor: string) => void;
  triggers: CommsRead<TriggersResponse>;
  /**
   * Chip counts for the CURRENT filters EXCEPT status. The server computes
   * `totals` after applying the status filter, so with a status selected the
   * list's own totals would read 0 for every other status. null ⇒ not known
   * (yet): chips render without counts rather than with wrong ones.
   */
  chipTotals: Record<DefinitionStatus, number> | null;
}

export function LibrarySurface(p: LibrarySurfaceProps) {
  const current = okData(p.read);
  const previous = staleData(p.read);
  // While a filter change reloads, the previous rows stay visible, dimmed and aria-busy.
  const data = current ?? previous;
  const isStale = current === null && previous !== null;
  const items = data ? [...data.items, ...(current ? p.more?.items ?? [] : [])] : [];
  const nextCursor = current && p.more ? p.more.nextCursor : data?.nextCursor ?? null;
  const chipCount = (v: number) => (p.chipTotals ? <span className="text-[var(--text-muted)]">{n(v)}</span> : null);
  const set = (patch: Partial<CatalogFilters>) => p.onFilters({ ...p.filters, ...patch });
  const filtered = Object.entries(p.filters).some(([k, v]) => (k === "q" ? (v as string).trim() !== "" : v !== null));

  return (
    <div className="flex min-w-0 flex-col gap-8 md:gap-10" data-comms-view="library">
      <Block id="comms-catalog" label="Notification library" className="min-w-0"
        hint={<span className="text-[11px] text-[var(--text-faint)] max-sm:hidden">Every message the product can send</span>}>
        <Surface className="flex min-w-0 flex-col gap-4 p-4 sm:p-5">
          {/* Status chips. Their counts come from `chipTotals` — the other filters
              WITHOUT status (see the prop) — and are omitted while unknown. */}
          {data && (
            <div role="group" aria-label="Filter by status" className="flex min-w-0 flex-wrap gap-2" data-status-chips>
              <button type="button" aria-pressed={p.filters.status === null} onClick={() => set({ status: null })} className={CHIP_BTN}
                style={{ borderColor: p.filters.status === null ? "var(--border-hairline-strong)" : "var(--border-hairline)", color: p.filters.status === null ? "var(--text-primary)" : "var(--text-secondary)" }}>
                All {p.chipTotals && chipCount(totalOf(p.chipTotals))}
              </button>
              {statusChips(p.chipTotals ?? data.totals).map((c) => (
                <button key={c.status} type="button" aria-pressed={p.filters.status === c.status} onClick={() => set({ status: p.filters.status === c.status ? null : c.status })} className={CHIP_BTN}
                  data-status-chip={c.status}
                  style={{ borderColor: p.filters.status === c.status ? "var(--border-hairline-strong)" : "var(--border-hairline)", color: p.filters.status === c.status ? "var(--text-primary)" : "var(--text-secondary)" }}>
                  {c.label} {chipCount(c.count)}
                </button>
              ))}
            </div>
          )}

          {/* Server-side filters + search. */}
          <form role="search" className="flex min-w-0 flex-col gap-3" onSubmit={(e) => e.preventDefault()}>
            <label className="flex min-h-11 min-w-0 items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] px-2.5 sm:max-w-md lg:min-h-8">
              <Search size={12} aria-hidden className="shrink-0 text-[var(--text-faint)]" />
              <input type="search" value={p.draftQ} onChange={(e) => p.onDraftQ(e.target.value)} maxLength={100} placeholder="Search by name or key" aria-label="Search definitions by name or key"
                className="min-w-0 flex-1 bg-transparent text-xs text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:outline-none" />
            </label>
            <div className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <FilterSelect label="Status" value={p.filters.status} options={FILTER_OPTIONS.status} onChange={(v) => set({ status: v })} />
              <FilterSelect label="Category" value={p.filters.category} options={FILTER_OPTIONS.category} onChange={(v) => set({ category: v })} />
              <FilterSelect label="Audience" value={p.filters.audience} options={FILTER_OPTIONS.audience} onChange={(v) => set({ audience: v })} />
              <FilterSelect label="Channel" value={p.filters.channel} options={FILTER_OPTIONS.channel} onChange={(v) => set({ channel: v })} />
              <FilterSelect label="Consent class" value={p.filters.consentClass} options={FILTER_OPTIONS.consentClass} onChange={(v) => set({ consentClass: v })} />
            </div>
            {filtered && (
              <button type="button" onClick={() => { p.onDraftQ(""); p.onFilters(EMPTY_CATALOG_FILTERS); }}
                className="min-h-11 self-start text-[11px] text-[var(--text-secondary)] underline-offset-2 hover:underline lg:min-h-7">Clear filters</button>
            )}
          </form>

          <ReadState read={p.read} what="the notification catalog" />
          {data && (
            <>
              {items.length === 0 ? (
                isStale ? null : <p role="status" className="text-xs text-[var(--text-secondary)]">No definitions match these filters.</p>
              ) : (
                <ul aria-label="Notification definitions" aria-busy={isStale || undefined}
                  className={`flex min-w-0 flex-col gap-2 transition-opacity md:gap-0 md:divide-y md:divide-[var(--border-hairline)] ${isStale ? "opacity-50" : ""}`}
                  data-catalog-list data-stale={isStale || undefined}>
                  {items.map((it) => <li key={it.key} className="min-w-0"><CatalogRow item={it} onOpen={p.onOpen} /></li>)}
                </ul>
              )}
              {nextCursor && !isStale && (
                <button type="button" disabled={p.more?.loading} onClick={() => p.onMore(nextCursor)}
                  className="min-h-11 self-start rounded-[var(--radius-sm)] border border-[var(--border-hairline)] px-3 text-xs text-[var(--text-secondary)] lg:min-h-8">
                  {p.more?.loading ? "Loading…" : "Show more"}
                </button>
              )}
              {p.more?.error && <p role="alert" className="text-xs" style={{ color: "var(--coral-400)" }}>{p.more.error}</p>}
              <ListMeta checkedAt={data.checkedAt} floor={data.floor} capped={data.capped} nextCursor={nextCursor}
                extra={`${n(items.length)} shown · code registry`} />
            </>
          )}
        </Surface>
      </Block>

      <TriggersBlock read={p.triggers} />
    </div>
  );
}

function CatalogRow({ item, onOpen }: { item: CatalogItem; onOpen: (key: string) => void }) {
  return (
    <button type="button" onClick={() => onOpen(item.key)} aria-haspopup="dialog"
      className="flex min-h-11 w-full min-w-0 items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--meridian-400)] max-md:rounded-[var(--radius-md)] max-md:border max-md:border-[var(--border-hairline)]"
      data-catalog-row={item.key}>
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="min-w-0 truncate text-sm font-medium text-[var(--text-primary)]">{item.displayName}</span>
          <ToneBadge word={STATUS_LABEL[item.status]} tone={STATUS_TONE[item.status]} />
          {item.protected && <ProtectedBadge item={item} />}
        </span>
        <code className="min-w-0 truncate font-mono text-[11px] text-[var(--text-muted)]">{item.key}</code>
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Chip>{CONSENT_LABEL[item.consentClass]}</Chip>
          {item.channels.length === 0 ? <Chip>No channels</Chip> : item.channels.map((c) => <Chip key={c.channel}>{CHANNEL_LABEL[c.channel]}</Chip>)}
          <Chip tone={SEVERITY_TONE[item.severity]}>{humanize(item.severity)}</Chip>
        </span>
        <span className="text-[11px] tabular-nums text-[var(--text-muted)]">
          {item.editable ? "Editable by automations" : "Not editable"} · Automations: {automationsLine(item.automations)}
        </span>
      </span>
      <ChevronRight size={14} aria-hidden className="mt-1 shrink-0 text-[var(--text-muted)]" />
    </button>
  );
}

// ── Triggers ────────────────────────────────────────────────────────────────────

export function TriggersBlock({ read }: { read: CommsRead<TriggersResponse> }) {
  const data = okData(read);
  return (
    <Block id="comms-triggers" label="Triggers" className="min-w-0"
      hint={<span className="text-[11px] text-[var(--text-faint)] max-sm:hidden">Typed events an automation may start from</span>}>
      <Surface className="flex min-w-0 flex-col gap-3 p-4 sm:p-5">
        <ReadState read={read} what="the trigger catalog" />
        {data && (
          <>
            <ul aria-label="Triggers" className="flex min-w-0 flex-col divide-y divide-[var(--border-hairline)]" data-trigger-list>
              {data.items.map((t) => <TriggerRow key={t.key} t={t} />)}
            </ul>
            <ListMeta checkedAt={data.checkedAt} floor={data.floor} capped={data.capped} nextCursor={data.nextCursor} extra={`${n(data.items.length)} triggers`} />
          </>
        )}
      </Surface>
    </Block>
  );
}

function TriggerRow({ t }: { t: TriggerItem }) {
  return (
    <li className="flex min-w-0 flex-col gap-1 py-2.5" data-trigger={t.key}>
      <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 text-xs font-medium text-[var(--text-primary)]">{t.displayName}</span>
        <ToneBadge word={t.status === "AVAILABLE" ? "Available" : "Proposed"} tone={t.status === "AVAILABLE" ? "ok" : "muted"} />
      </span>
      <code className="min-w-0 break-all font-mono text-[11px] text-[var(--text-muted)]">{t.key}</code>
      <span className="text-[11px] text-[var(--text-secondary)]">{t.description}</span>
      <span className="text-[11px] text-[var(--text-muted)]">
        {humanize(t.source)} · recipients: {t.resolvers.map((r) => humanize(r.kind)).join(", ") || "none"}
        {t.payload.length > 0 ? ` · fields: ${t.payload.map((f) => `${f.name}${f.pii ? " (PII)" : ""}`).join(", ")}` : ""}
      </span>
    </li>
  );
}

// ── Detail ──────────────────────────────────────────────────────────────────────

export function CatalogDetailBody({ read, preview, content }: { read: CommsRead<CatalogDetail>; preview: ReactNode; content?: ReactNode }) {
  const d = okData(read);
  if (!d) return <ReadState read={read} what="this definition" />;
  const storm = stormNote(d);
  return (
    <div className="flex min-w-0 flex-col gap-5" data-catalog-detail={d.key}>
      <DrawerSection title="About">
        <p className="text-xs leading-relaxed text-[var(--text-secondary)]">{d.description}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <ToneBadge word={STATUS_LABEL[d.status]} tone={STATUS_TONE[d.status]} />
          {d.protected && <ProtectedBadge item={d} />}
        </div>
        {d.protected && <PolicyNote>{protectedNote(d)}</PolicyNote>}
        <FactList rows={[
          ["Key", <code key="k" className="break-all font-mono text-[11px]">{d.key}</code>],
          ["Definition version", `v${d.definitionVersion}`],
          ["Category", humanize(d.category)],
          ["Audience", humanize(d.audience)],
          ["Consent class", CONSENT_LABEL[d.consentClass]],
          ["Severity", humanize(d.severity)],
          ["User can turn off", d.userSuppressible ? "Yes" : "No"],
          ["Channels", d.channels.length === 0 ? "None" : d.channels.map((c) => `${CHANNEL_LABEL[c.channel]}${c.defaultOn ? " (on by default)" : ""} · ${humanize(c.path)}${c.templateVersion !== null ? ` · template v${c.templateVersion}` : ""}`).join("; ")],
          ["Automations", automationsLine(d.automations)],
        ]} />
      </DrawerSection>

      <DrawerSection title="Trigger">
        <FactList rows={[
          ["Kind", d.trigger.kind === "TRIGGER" ? "Controlled trigger" : "Code call site"],
          ["Trigger key", d.trigger.triggerKey ? <code key="t" className="break-all font-mono text-[11px]">{d.trigger.triggerKey}</code> : "—"],
          ...(d.trigger.additionalTriggerKeys && d.trigger.additionalTriggerKeys.length > 0
            ? [["Also triggered by", <span key="at" className="flex min-w-0 flex-col gap-0.5" data-additional-triggers>
                {d.trigger.additionalTriggerKeys.map((k) => <code key={k} className="break-all font-mono text-[11px]">{k}</code>)}
              </span>] as const]
            : []),
        ]} />
        {d.trigger.sources.length > 0 && (
          <ul aria-label="Producer source files" className="flex flex-col gap-1">
            {d.trigger.sources.map((s) => <li key={s}><code className="break-all font-mono text-[11px] text-[var(--text-secondary)]">{s}</code></li>)}
          </ul>
        )}
      </DrawerSection>

      <DrawerSection title="Payload fields">
        <PolicyNote>Field names and flags only — values are never shown.</PolicyNote>
        {d.payload.length === 0 ? <p className="text-xs text-[var(--text-secondary)]">No payload fields.</p> : (
          <ul aria-label="Payload fields" className="flex flex-col divide-y divide-[var(--border-hairline)]" data-payload-fields>
            {d.payload.map((f) => (
              <li key={f.name} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 py-1.5 text-xs">
                <code className="min-w-0 break-all font-mono text-[11px] text-[var(--text-primary)]">{f.name}</code>
                <span className="text-[var(--text-muted)]">{f.type} · {humanize(f.kind)}{f.required ? " · required" : ""}</span>
                {f.pii && <Chip tone="warn" title="Can identify a person: never stored on the delivery ledger, never in analytics">PII</Chip>}
              </li>
            ))}
          </ul>
        )}
      </DrawerSection>

      <DrawerSection title="Rules">
        <FactList rows={[
          ["Eligibility", d.eligibility.length ? d.eligibility.join(", ") : "None"],
          ["Dedupe", d.dedupe.strategy === "none" ? "None" : `${humanize(d.dedupe.strategy)}${d.dedupe.windowMinutes !== null ? ` · ${n(d.dedupe.windowMinutes)} min window` : ""}`],
          ["Dedupe key", d.dedupe.keyTemplate ? <code key="dk" className="break-all font-mono text-[11px]">{d.dedupe.keyTemplate}</code> : "—"],
          ["Frequency cap", d.frequencyCap ? `${n(d.frequencyCap.max)} per ${n(d.frequencyCap.perHours)} h per recipient` : "None"],
        ]} />
        {storm && <PolicyNote>{storm}</PolicyNote>}
      </DrawerSection>

      <DrawerSection title="Retention">
        <FactList rows={[
          ["In-app archive", d.retention.inAppArchiveDays !== null ? `${n(d.retention.inAppArchiveDays)} days` : "—"],
          ["In-app delete", d.retention.inAppDeleteDays !== null ? `${n(d.retention.inAppDeleteDays)} days` : "—"],
          ["Delivery records", retentionText(d.retention.deliveryDays)],
        ]} />
      </DrawerSection>

      <DrawerSection title={`Recent sends · last ${d.recent.days.length} UTC days`}>
        <DaySeriesBars series={d.recent} label={`${d.displayName} sends per UTC day`} />
        <DaySeriesLegend />
      </DrawerSection>

      <DrawerSection title="Actions">
        <div className="flex flex-wrap gap-1.5">{d.supportedActions.map((a) => <Chip key={a}>{humanize(a)}</Chip>)}</div>
        {d.supportedActions.includes("ACTIVATE_AUTOMATION") && <PolicyNote>{COMMS_POLICY.elevated}</PolicyNote>}
        {d.supportedActions.some((a) => a === "TEST_SEND" || a === "ACTIVATE_AUTOMATION" || a === "PAUSE_AUTOMATION") && (
          <PolicyNote>{`Test sends and automation actions arrive with the automation engine; ${AUTOMATION_ACTION_SEAMS.find((s) => s.action === "test-send")!.note.toLowerCase()}`}</PolicyNote>
        )}
        {d.ownerSurface && isInternalPath(d.ownerSurface.href) && (
          <Link href={d.ownerSurface.href} prefetch={false}
            className="inline-flex min-h-11 items-center gap-1.5 self-start text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] lg:min-h-8">
            Managed in {humanize(d.ownerSurface.area)} <ExternalLink size={12} aria-hidden />
          </Link>
        )}
      </DrawerSection>

      {content && <DrawerSection title="Content">{content}</DrawerSection>}

      {d.supportedActions.includes("PREVIEW") && <DrawerSection title="Preview">{preview}</DrawerSection>}
    </div>
  );
}

// ── Preview ─────────────────────────────────────────────────────────────────────

export function PreviewSurface({ channels, channel, onChannel, variant, onVariant, read }: {
  channels: PreviewChannel[];
  channel: PreviewChannel;
  onChannel: (c: PreviewChannel) => void;
  variant: string | null;
  onVariant: (v: string | null) => void;
  read: CommsRead<PreviewResponse>;
}) {
  const p = okData(read);
  return (
    <div className="flex min-w-0 flex-col gap-3" data-preview>
      <div className="flex min-w-0 flex-wrap items-end gap-3">
        {channels.length > 1 && (
          <div className="max-w-full overflow-x-auto">
            <WideTargets><Segmented label="Preview channel" value={channel} onChange={onChannel} options={channels.map((c) => ({ id: c, label: PREVIEW_LABEL[c] }))} /></WideTargets>
          </div>
        )}
        {p && p.variants.length > 1 && (
          <div className="min-w-[10rem] flex-1 sm:max-w-xs">
            <FilterSelect label="Variant" value={variant ?? p.variants[0]} anyLabel="Default" options={p.variants.map((v) => ({ value: v, label: v }))} onChange={onVariant} />
          </div>
        )}
      </div>
      {!p ? (
        read.loading || read.result.kind !== "error" || read.result.code !== "INVALID_STATE"
          ? <ReadState read={read} what="the preview" />
          : <p role="status" className="text-xs text-[var(--text-secondary)]">No {PREVIEW_LABEL[channel].toLowerCase()} rendition exists for this definition.</p>
      ) : (
        <PreviewRendition p={p} />
      )}
    </div>
  );
}

function PreviewPanel({ item }: { item: CatalogDetail }) {
  const channels = previewChannelsFor(item.channels);
  const [channel, setChannel] = useState<PreviewChannel>(channels[0] ?? "in-app");
  const [variant, setVariant] = useState<string | null>(null);
  const read = useCommsRead<PreviewResponse>(channels.length ? previewUrl(item.key, channel, variant) : null);
  if (channels.length === 0) return <p className="text-xs text-[var(--text-secondary)]">No previewable channel.</p>;
  return <PreviewSurface channels={channels} channel={channel} onChannel={(c) => { setChannel(c); setVariant(null); }} variant={variant} onVariant={setVariant} read={read} />;
}

function DetailDrawerBody({ itemKey, onDirty }: { itemKey: string; onDirty: (dirty: boolean) => void }) {
  // The last good detail stays on screen through a refresh (a publish / restore
  // re-reads it), so the content editor below is never unmounted with its draft.
  const { read, data: d } = useLastGoodRead<CatalogDetail>(catalogDetailUrl(itemKey));
  const [liveNonce, setLiveNonce] = useState(0);
  const shown: CommsRead<CatalogDetail> = d ? { loading: false, result: { kind: "ok", data: d } } : read;
  const onLiveChanged = () => { read.retry?.(); setLiveNonce((x) => x + 1); };
  // v1.1 servers add `content` / `viewer` to the detail; an older payload has no Content section.
  return <CatalogDetailBody read={shown} preview={d ? <PreviewPanel key={`${d.key}|${liveNonce}`} item={d} /> : null}
    content={d && "content" in d ? <ContentPanel key={d.key} detail={d as CatalogDetail & Partial<CatalogDetailV11Additions>} onDirty={onDirty} onLiveChanged={onLiveChanged} /> : null} />;
}

// ── The lead ────────────────────────────────────────────────────────────────────

export function CommsLibraryLead() {
  const [filters, setFilters] = useState<CatalogFilters>(EMPTY_CATALOG_FILTERS);
  const [draftQ, setDraftQ] = useState("");
  const [open, setOpenRaw] = useState<string | null>(null);
  const contentDirty = useRef(false);
  const setOpen = (next: string | null) => {
    if (next === open) return;
    if (!guardDiscard(contentDirty.current, (t) => window.confirm(t))) return;
    contentDirty.current = false;
    setOpenRaw(next);
  };
  const url = catalogUrl(filters);
  const read = useCommsRead<CatalogResponse>(url);
  // The server's `totals` count the result AFTER the status filter; with a
  // status selected the chips need the same filters WITHOUT status — one
  // lightweight read (limit=1: totals are computed before pagination).
  const chipRead = useCommsRead<CatalogResponse>(filters.status ? catalogTotalsUrl(filters) : null);
  const chipTotals = filters.status ? okData(chipRead)?.totals ?? null : okData(read)?.totals ?? null;
  const triggers = useCommsRead<TriggersResponse>(triggersUrl());
  const [more, setMore] = useState<{ forUrl: string; items: CatalogItem[]; nextCursor: string | null; loading: boolean; error: string | null } | null>(null);
  const activeMore = more && more.forUrl === url ? more : null;

  // Search applies after a short pause in typing (one request per settled query).
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === draftQ ? f : { ...f, q: draftQ })), 300);
    return () => clearTimeout(t);
  }, [draftQ]);

  const loadMore = (cursor: string) => {
    const forUrl = url;
    setMore((m) => ({ forUrl, items: m && m.forUrl === forUrl ? m.items : [], nextCursor: cursor, loading: true, error: null }));
    void readCatalog(filters, cursor).then((r) => {
      setMore((m) => {
        const prev = m && m.forUrl === forUrl ? m.items : [];
        return r.kind === "ok"
          ? { forUrl, items: [...prev, ...r.data.items], nextCursor: r.data.nextCursor, loading: false, error: null }
          : { forUrl, items: prev, nextCursor: cursor, loading: false, error: r.kind === "unavailable" ? "The catalog is unavailable right now (503)." : "Could not load more definitions." };
      });
    });
  };

  const openItem = okData(read)?.items.find((i) => i.key === open) ?? activeMore?.items.find((i) => i.key === open);
  return (
    <>
      <LibrarySurface read={read} more={activeMore} filters={filters} draftQ={draftQ} onDraftQ={setDraftQ}
        onFilters={(f) => { setFilters(f); if (f.q !== draftQ) setDraftQ(f.q); }} onOpen={setOpen} onMore={loadMore} triggers={triggers} chipTotals={chipTotals} />
      <DetailDrawer open={open !== null} onClose={() => setOpen(null)} eyebrow="Notification library" title={openItem?.displayName ?? open ?? ""} size="xl">
        {open && <DetailDrawerBody key={open} itemKey={open} onDirty={(d) => { contentDirty.current = d; }} />}
      </DetailDrawer>
    </>
  );
}
