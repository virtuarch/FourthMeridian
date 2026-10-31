"use client";

/**
 * components/platform/comms/ContentEditor.tsx  (Customer Success — Communications Center › Library › content)
 *
 * The catalog drawer's content editor over Session 1's B1 endpoints (contract
 * v1.1 §1.1, §2, §3, §4):
 *
 *   leg picker (channel · variant, live source) → locked reason, or the editor:
 *   subject · preheader (email) · blocks (hero / paragraph / button / list /
 *   divider, §2.2 rules) with counters · placeholder picker ({{name}} at the
 *   cursor, filtered by the focused field's allowedIn) · live check (debounced
 *   POST /render, issues at their location) · preview (unsaved via render, a
 *   saved version via ?versionId) · Save draft → Publish (reason, warnings
 *   acknowledged) · version history (open read-only, diff against live,
 *   restore with a reason) · AI polish (a suggestion, never a version).
 *
 * The server is the authority: every control is driven by the `viewer` block
 * and the leg lock; a refusal (409 CONFLICT, 400 issues, 401/403 fresh-auth,
 * 429, 503) is told in one sentence and NEVER discards the operator's text.
 * Previews are synthetic only (each placeholder's `sample`), in the existing
 * sandboxed rendition with its [PREVIEW] banner. No customer data anywhere.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, Check, Eye, GitCompare, Loader2, Lock, Plus, RefreshCw, RotateCcw, Save, Sparkles, Trash2, Upload, X } from "lucide-react";
import type { CatalogDetail, PreviewChannel } from "@/lib/notifications/catalog/types";
import {
  AI_TONES,
  type AiSuggestMode, type AiSuggestResult, type AiTone, type CatalogDetailV11Additions, type ContentBody, type ContentIssue, type ContentPreviewResponse,
  type EditableChannel, type TemplateVersionDTO, type VersionsResponse,
} from "@/lib/notifications/content/types";
import {
  CODE_DEFAULT_VERSION_ID, postAiSuggest, postPublish, postRender, postRollback, postSaveDraft, previewUrl, readVersion, readVersions, versionsUrl,
  type CommsReadResult,
} from "@/lib/platform/comms-center/client";
import { OperatorReasonField, EMPTY_OPERATOR_REASON, reasonPayload, type OperatorReasonValue } from "../widgets/OperatorReasonField";
import { BTN, BTN_NEUTRAL, BTN_PRIMARY, BTN_QUIET, FIELD } from "../widgets/policy-editor-kit";
import { TONE_COLOR, ToneBadge } from "../platform-surface";
import { Segmented } from "../leads/visual-kit";
import { Chip, FilterSelect, PolicyNote, PreviewRendition, ReadState, WideTargets, okData, useCommsRead, useLastGoodRead } from "./comms-kit";
import { useContentDraft } from "./use-content-draft";
import { utcStamp } from "./comms-model";
import {
  BLOCK_KINDS, BLOCK_LABEL, CHANNEL_WORD, CREATED_BY_LABEL, LOCK_TEXT, RENDER_DEBOUNCE_MS, VERSION_STATE_LABEL, VERSION_STATE_TONE,
  acceptSuggestion, addBlock, aiAcceptWhy, aiRemainingText, bodyOfVersion, canAddBlock, canMoveBlock, canRemoveBlock, changeRows, charCount, diffBodies,
  discardSuggestion, draftFrom, editBlock, editorControls, editorFields, expiryText, insertToken, insertablePlaceholders, isRestorable, issueGate,
  legOptions, linkPlaceholders, liveText, lockedLegReason, moveBlock, notesByCategory, placeIssues, placeholderHint, provenanceText, removeBlock,
  guardDiscard, setField, writeRefusalText,
  type Control, type DiffRow, type Draft, type EditorField, type LegOption,
} from "./content-model";

type DetailV11 = CatalogDetail & Partial<CatalogDetailV11Additions>;
type Notice = { tone: "ok" | "warn" | "bad"; text: string } | null;

const PREVIEW_OF: Record<EditableChannel, PreviewChannel> = { EMAIL: "email-html", IN_APP: "in-app" };
const MODE_LABEL: Record<AiSuggestMode, string> = { POLISH: "Polish", CHECK: "Check only" };
const TONE_LABEL: Record<AiTone, string> = { NEUTRAL: "Neutral", WARM: "Warm", CONCISE: "Concise" };

// ── Small pieces ────────────────────────────────────────────────────────────────

function NoticeLine({ notice }: { notice: Notice }) {
  if (!notice) return null;
  const color = notice.tone === "ok" ? TONE_COLOR.ok : notice.tone === "warn" ? TONE_COLOR.warn : TONE_COLOR.bad;
  return <p role={notice.tone === "ok" ? "status" : "alert"} className="text-[11px] leading-relaxed" style={{ color }} data-editor-notice={notice.tone}>{notice.text}</p>;
}

/** The one line a disabled control shows. */
function Why({ c }: { c: Control }) {
  return c.shown && !c.enabled && c.why ? <p className="text-[11px] leading-relaxed text-[var(--text-muted)]" data-why>{c.why}</p> : null;
}

function IssueList({ issues, label }: { issues: readonly ContentIssue[] | undefined; label?: string }) {
  if (!issues || issues.length === 0) return null;
  return (
    <ul aria-label={label ?? "Issues"} className="flex min-w-0 flex-col gap-1" data-issues>
      {issues.map((i, k) => (
        <li key={`${i.code}-${k}`} className="flex min-w-0 items-start gap-1.5 text-[11px] leading-relaxed" style={{ color: i.severity === "error" ? TONE_COLOR.bad : TONE_COLOR.warn }} data-issue={i.severity}>
          <AlertTriangle size={11} aria-hidden className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">
            <span className="sr-only">{i.severity === "error" ? "Error: " : "Warning: "}</span>{i.message}
            <code className="ml-1.5 font-mono text-[10px] opacity-70">{i.code}</code>
          </span>
        </li>
      ))}
    </ul>
  );
}

function DiffList({ rows, empty }: { rows: readonly DiffRow[]; empty: string }) {
  if (rows.length === 0) return <p className="text-xs text-[var(--text-secondary)]">{empty}</p>;
  return (
    <ul aria-label="Differences" className="flex min-w-0 flex-col divide-y divide-[var(--border-hairline)]" data-diff>
      {rows.map((r) => (
        <li key={r.key} className="flex min-w-0 flex-col gap-1 py-2" data-diff-row={r.key}>
          <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{r.label}</span>
          <div className="grid min-w-0 grid-cols-1 gap-1.5 sm:grid-cols-2">
            <p className="min-w-0 whitespace-pre-wrap break-words rounded-[var(--radius-sm)] px-2 py-1 text-xs text-[var(--text-secondary)]"
              style={{ background: "color-mix(in srgb, var(--coral-400) 8%, transparent)" }} data-diff-before>
              <span className="sr-only">Before: </span>{r.before ?? <em className="text-[var(--text-muted)]">(none)</em>}
            </p>
            <p className="min-w-0 whitespace-pre-wrap break-words rounded-[var(--radius-sm)] px-2 py-1 text-xs text-[var(--text-primary)]"
              style={{ background: "color-mix(in srgb, var(--emerald-400) 8%, transparent)" }} data-diff-after>
              <span className="sr-only">After: </span>{r.after ?? <em className="text-[var(--text-muted)]">(removed)</em>}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}

function Sub({ title, children, hint }: { title: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--border-hairline)] p-3">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h4 className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">{title}</h4>
        {hint}
      </div>
      {children}
    </section>
  );
}

// ── The panel (leg picker + the stream read) ────────────────────────────────────

/**
 * The drawer's Content section. Renders nothing against a pre-v1.1 server
 * (no `content` on the detail). A definition with no email / in-app leg, or a
 * content-locked one, shows the lock and no control.
 */
export function ContentPanel({ detail, onDirty, onLiveChanged }: { detail: DetailV11; onDirty?: (dirty: boolean) => void; onLiveChanged?: () => void }) {
  const legs = legOptions(detail);
  const first = legs.find((l) => l.editable) ?? legs[0] ?? null;
  const [leg, setLeg] = useState<{ channel: EditableChannel; variant: string } | null>(first ? { channel: first.channel, variant: first.variants[0] } : null);
  const dirty = useRef(false);
  // The last good stream stays mounted through a failed reload (503 / 429 / 401 / network): the draft is never lost.
  const v = useLastGoodRead<VersionsResponse>(leg ? versionsUrl(detail.key, leg.channel, leg.variant) : null);
  if (detail.content === undefined) return null;
  if (!leg || legs.length === 0) {
    return <LockedNote reason={lockedLegReason(detail)} />;
  }
  const choose = (next: { channel: EditableChannel; variant: string }) => {
    if (next.channel === leg.channel && next.variant === leg.variant) return;
    if (!guardDiscard(dirty.current, (t) => window.confirm(t))) return;
    dirty.current = false;
    onDirty?.(false);
    setLeg(next);
  };
  const current = legs.find((l) => l.channel === leg.channel)!;
  const data = v.data;
  return (
    <div className="flex min-w-0 flex-col gap-3" data-content-panel={detail.key}>
      <LegPicker legs={legs} leg={leg} current={current} onChoose={choose} />
      {detail.divergesFrom === "connection-attention" && (
        <PolicyNote>Editing this changes the notification bell and email copy only — the Connections page keeps its own wording.</PolicyNote>
      )}
      {data && v.failure && !v.failure.loading && (
        <div role="alert" className="flex min-w-0 flex-wrap items-center gap-2 text-[11px]" style={{ color: TONE_COLOR.warn }} data-reload-failed>
          <span className="min-w-0 flex-1">Couldn’t read the latest content: {writeRefusalText(v.failure.result)} Your text is kept in the editor.</span>
          <button type="button" onClick={() => v.read.retry?.()} className={BTN} style={BTN_NEUTRAL}><RefreshCw size={11} aria-hidden /> Retry</button>
        </div>
      )}
      {!data ? <ReadState read={v.read} what="this message’s content" /> : (
        <ContentEditor key={`${leg.channel}|${leg.variant}`} itemKey={detail.key} channel={leg.channel} variant={leg.variant} data={data}
          refreshing={v.read.loading} loadCount={v.loads} onReload={() => v.read.retry?.()} onLiveChanged={onLiveChanged}
          onDirty={(d) => { dirty.current = d; onDirty?.(d); }} />
      )}
    </div>
  );
}

function LockedNote({ reason }: { reason: "PROTECTED" | "NOT_EDITABLE" }) {
  return (
    <p className="flex items-start gap-2 rounded-[var(--radius-md)] border border-[var(--border-hairline)] px-3 py-2.5 text-xs leading-relaxed text-[var(--text-secondary)]" data-content-locked={reason}>
      <Lock size={13} aria-hidden className="mt-0.5 shrink-0 text-[var(--text-muted)]" />
      <span className="min-w-0">{LOCK_TEXT[reason]}</span>
    </p>
  );
}

function LegPicker({ legs, leg, current, onChoose }: {
  legs: LegOption[];
  leg: { channel: EditableChannel; variant: string };
  current: LegOption;
  onChoose: (l: { channel: EditableChannel; variant: string }) => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-end gap-3" data-leg-picker>
      {legs.length > 1 && (
        <div className="max-w-full overflow-x-auto">
          <WideTargets>
            <Segmented label="Channel" value={leg.channel} onChange={(c) => onChoose({ channel: c, variant: legs.find((l) => l.channel === c)!.variants[0] })}
              options={legs.map((l) => ({ id: l.channel, label: `${CHANNEL_WORD[l.channel]}${l.editable ? "" : " (locked)"}` }))} />
          </WideTargets>
        </div>
      )}
      {current.variants.length > 1 && (
        <div className="min-w-[10rem] flex-1 sm:max-w-xs">
          <FilterSelect label="Variant" value={leg.variant} includeAny={false} options={current.variants.map((v) => ({ value: v, label: v }))}
            onChange={(v) => onChoose({ channel: leg.channel, variant: v ?? current.variants[0] })} />
        </div>
      )}
      <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-[var(--text-muted)]" data-live-source>
        Live now: <Chip tone={current.liveOf(leg.variant).startsWith("Published") ? "ok" : "muted"}>{current.liveOf(leg.variant)}</Chip>
      </span>
    </div>
  );
}

// ── The editor ──────────────────────────────────────────────────────────────────

interface Checked { forBody: string; issues: ContentIssue[]; preview: ContentPreviewResponse | null }
type CheckStatus = "idle" | "waiting" | "checking" | "limited" | "failed";

export interface ContentEditorProps {
  itemKey: string;
  channel: EditableChannel;
  variant: string;
  /** The LAST GOOD stream read (a failed reload keeps it). */
  data: VersionsResponse;
  refreshing: boolean;
  /** Successful reads of the stream so far: a conflict resolves only when this rises. */
  loadCount?: number;
  onReload: () => void;
  onDirty?: (dirty: boolean) => void;
  /** A publish / restore landed: the drawer re-reads the detail and the preview. */
  onLiveChanged?: () => void;
}

export function ContentEditor(p: ContentEditorProps) {
  const { data, channel, variant, itemKey } = p;
  const liveId = data.live.source === "PUBLISHED" ? data.live.versionId : null;
  const liveFromPage = liveId ? data.items.find((v) => v.id === liveId) ?? null : null;
  const [fetchedLive, setFetchedLive] = useState<{ id: string; v: TemplateVersionDTO | null; error: string | null } | null>(null);
  const [liveAttempt, setLiveAttempt] = useState(0);
  const liveVersion = liveFromPage ?? (fetchedLive && fetchedLive.id === liveId ? fetchedLive.v : null);
  const liveError = !liveFromPage && fetchedLive && fetchedLive.id === liveId ? fetchedLive.error : null;
  const codeDefault: ContentBody = { subject: data.codeDefault.subject, preheader: data.codeDefault.preheader, blocks: data.codeDefault.blocks };
  const liveBody: ContentBody | null = liveId === null ? codeDefault : liveVersion ? bodyOfVersion(liveVersion) : null;

  // The live version is normally on the first page; when not, read it (with an honest failure + Retry).
  useEffect(() => {
    if (!liveId || liveFromPage) return;
    let alive = true;
    void readVersion(itemKey, liveId).then((r) => {
      if (!alive) return;
      setFetchedLive(r.kind === "ok" ? { id: liveId, v: r.data, error: null } : { id: liveId, v: null, error: writeRefusalText(r) || "The live version couldn’t be read." });
    });
    return () => { alive = false; };
  }, [itemKey, liveId, liveFromPage, liveAttempt]);

  const ed = useContentDraft(() => (liveBody ? { draft: draftFrom(liveBody, liveId, data.revision), base: liveVersion } : null), { loadCount: p.loadCount ?? 0, revision: data.revision });
  const draft = ed.state?.draft ?? null;
  const base = ed.state?.base ?? null;
  useEffect(() => {
    if (!ed.state && liveBody) ed.init({ draft: draftFrom(liveBody, liveId, data.revision), base: liveVersion });
  });

  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState<null | "save" | "publish" | "rollback" | "ai">(null);
  const [savedIssues, setSavedIssues] = useState<ContentIssue[] | null>(null);
  const [suggestionExpired, setSuggestionExpired] = useState(false);

  const { onDirty } = p;
  useEffect(() => { onDirty?.(draft?.dirty ?? false); }, [draft?.dirty, onDirty]);

  // A conflict resolved by a successful reload (the hook rebased the draft): say so once.
  const hadConflict = useRef(false);
  useEffect(() => {
    if (ed.conflict) { hadConflict.current = true; return; }
    if (!hadConflict.current) return;
    hadConflict.current = false;
    setNotice({ tone: "warn", text: `Reloaded: live is now ${liveText(data.live)}. Your unsaved text is kept — review it against the history, then save again.` });
  }, [ed.conflict, data.live]);

  // ── Live check (POST /render, 30/min bucket: debounced + manual) ──
  const [checked, setChecked] = useState<Checked | null>(null);
  const [checkStatus, setCheckStatus] = useState<CheckStatus>("idle");
  const [checkNonce, setCheckNonce] = useState(0);
  const bodyJson = draft ? JSON.stringify(draft.body) : "";
  const editShown = !data.locked && data.contentEditable && data.viewer.canEditContent;
  const autoCheck = editShown && checkStatus !== "limited";
  const lastNonce = useRef(0);
  useEffect(() => {
    if (!draft || !editShown) return;
    const manual = checkNonce !== lastNonce.current;
    if (!manual && (!autoCheck || checked?.forBody === bodyJson)) return;
    lastNonce.current = checkNonce;
    const ctrl = new AbortController();
    setCheckStatus("waiting");
    const t = setTimeout(() => {
      setCheckStatus("checking");
      void postRender(itemKey, { channel, ...(variant !== "default" ? { variant } : {}), content: draft.body }, ctrl.signal).then((r) => {
        if (ctrl.signal.aborted) return;
        if (r.kind === "ok") { setChecked({ forBody: bodyJson, issues: r.data.issues ?? [], preview: r.data }); setCheckStatus("idle"); }
        else if (r.kind === "rate-limited") setCheckStatus("limited");
        else { setCheckStatus("failed"); if (r.kind === "error" && r.issues) setChecked({ forBody: bodyJson, issues: r.issues, preview: null }); }
      });
    }, manual ? 0 : RENDER_DEBOUNCE_MS);
    return () => { clearTimeout(t); ctrl.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the body's JSON and the manual nonce
  }, [bodyJson, checkNonce, editShown, autoCheck, itemKey, channel, variant]);

  const current = checked && checked.forBody === bodyJson ? checked : null;
  const liveIssues = current?.issues ?? savedIssues ?? [];
  const gate = issueGate(current?.issues ?? []);
  /** The freshest revision known: what the operator last saw, from their own writes or the latest read. */
  const freshRevision = Math.max(draft?.revision ?? 0, data.revision);

  const controls = editorControls({
    viewer: data.viewer, locked: data.locked, contentEditable: data.contentEditable, ai: data.ai,
    dirty: draft?.dirty ?? false, blockingErrors: gate.blocks, conflict: ed.conflict !== null,
    base: base ? { id: base.id, state: base.state } : null,
    suggestionExpired: suggestionExpired || (draft?.source.kind === "AI_SUGGESTION" && expiryText(draft.source.expiresAt, Date.now()).expired),
    hasRollbackTarget: data.live.source === "PUBLISHED" || data.items.some(isRestorable),
  });

  if (controls.locked) {
    return (
      <div className="flex min-w-0 flex-col gap-3" data-content-editor="locked">
        <LockedNote reason={data.locked?.reason ?? "NOT_EDITABLE"} />
        <PolicyNote>Live copy: {liveText(data.live)}. Preview it in the Preview section below.</PolicyNote>
      </div>
    );
  }
  if (!draft) {
    return liveError ? (
      <div role="alert" className="flex min-w-0 flex-wrap items-center gap-2 py-3 text-xs" style={{ color: TONE_COLOR.bad }} data-live-read-failed>
        <span className="min-w-0 flex-1">The live version couldn’t be read: {liveError}</span>
        <button type="button" onClick={() => { setFetchedLive(null); setLiveAttempt((x) => x + 1); }} className={BTN} style={BTN_NEUTRAL}><RefreshCw size={11} aria-hidden /> Retry</button>
      </div>
    ) : <p role="status" className="flex items-center gap-1.5 py-3 text-xs text-[var(--text-secondary)]"><Loader2 size={12} className="animate-spin" aria-hidden /> Reading the live version…</p>;
  }

  const update = (fn: (b: ContentBody) => ContentBody) => { ed.edit(fn); setSavedIssues(null); };

  const save = async () => {
    setBusy("save"); setNotice(null);
    const o = await ed.save((sent) => postSaveDraft(itemKey, {
      expectedRevision: sent.revision,
      body: {
        channel, ...(variant !== "default" ? { variant } : {}), parentVersionId: sent.parentVersionId, content: sent.body,
        source: sent.source.kind === "AI_SUGGESTION" ? { kind: "AI_SUGGESTION", suggestionId: sent.source.suggestionId } : { kind: "MANUAL" },
      },
    }));
    setBusy(null);
    if (!o) return;
    if (o.kind === "saved") {
      const typedSince = ed.latest()?.draft.dirty ?? false;
      setSavedIssues(o.version.issues); setSuggestionExpired(false);
      setNotice({ tone: "ok", text: typedSince ? `${o.notice} Your newer typing is kept as unsaved changes on top of it.` : o.notice });
      p.onReload();
    } else if (o.kind === "conflict") setNotice({ tone: "warn", text: o.notice });
    else if (o.kind === "invalid") { setSavedIssues(o.issues); setNotice({ tone: "bad", text: o.notice }); }
    else { if (o.expired) setSuggestionExpired(true); setNotice({ tone: "bad", text: o.notice }); }
  };

  const openVersion = (v: TemplateVersionDTO) => {
    if (draft.dirty && !window.confirm("Replace your unsaved text with this version?")) return;
    ed.replace((s) => ({ draft: draftFrom(bodyOfVersion(v), v.id, Math.max(s.draft.revision, data.revision)), base: v }));
    setSavedIssues(v.issues); setSuggestionExpired(false);
    setNotice({ tone: "ok", text: `Editing from v${v.version}. Saving creates a new draft; nothing changes until you publish.` });
  };

  const afterLiveChange = (text: string, revision: number, published: TemplateVersionDTO | null, body: ContentBody) => {
    const keptDirty = ed.latest()?.draft.dirty ?? false;
    ed.liveChanged({ revision, published, body });
    if (!keptDirty) setSavedIssues(published?.issues ?? null);
    setNotice({ tone: "ok", text: keptDirty ? `${text} Your unsaved text is kept in the editor.` : text });
    p.onReload();
    p.onLiveChanged?.();
  };

  const conflictNotice = (r: CommsReadResult<unknown>) => {
    if (r.kind === "error" && r.code === "CONFLICT") ed.setConflict(r.current ?? null);
  };

  const aiAcceptBlock = draft.dirty ? "Save or discard your changes first: the suggestion is based on the saved version."
    : null;

  return (
    <div className="flex min-w-0 flex-col gap-4" data-content-editor="editable" aria-busy={p.refreshing || undefined}>
      {ed.conflict && (
        <div role="alert" className="flex min-w-0 flex-wrap items-center gap-2 rounded-[var(--radius-md)] border px-3 py-2 text-xs" style={{ borderColor: TONE_COLOR.warn, color: TONE_COLOR.warn }} data-conflict>
          <span className="min-w-0 flex-1">Someone else changed this; reload. Your unsaved text stays in the editor.</span>
          <button type="button" onClick={p.onReload} disabled={p.refreshing} className={BTN} style={BTN_QUIET} data-reload>
            {p.refreshing ? <Loader2 size={11} className="animate-spin" aria-hidden /> : <RefreshCw size={11} aria-hidden />} Reload latest
          </button>
        </div>
      )}

      <BodyEditor data={data} channel={channel} draft={draft} edit={controls.edit} issues={liveIssues} onChange={update} />

      <Sub title="Live check" hint={<CheckLine status={checkStatus} stale={!current} gate={gate} />}>
        <IssueList issues={placeIssues(liveIssues, draft.body, channel, data.limits).top} label="Whole-message issues" />
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => { setCheckStatus("idle"); setCheckNonce((x) => x + 1); }} disabled={!controls.edit.enabled || checkStatus === "checking"}
            className={BTN} style={BTN_NEUTRAL} data-check-now>
            <RefreshCw size={11} aria-hidden /> Check now
          </button>
          <span className="text-[11px] text-[var(--text-muted)]">Checks run a few seconds after you stop typing, with synthetic sample values only.</span>
        </div>
      </Sub>

      <PreviewBlock itemKey={itemKey} channel={channel} draftPreview={current?.preview ?? null} draftBlocked={gate.blocks} base={base} dirty={draft.dirty} readOnly={!controls.edit.enabled} />

      <Sub title="Save and publish">
        {draft.source.kind === "AI_SUGGESTION" && (
          <SuggestionBanner expiresAt={draft.source.expiresAt} onDiscard={() => { ed.replace((s) => ({ ...s, draft: discardSuggestion(s.draft) })); setSuggestionExpired(false); setNotice(null); }} />
        )}
        <div className="flex flex-wrap items-center gap-2">
          {controls.save.shown && controls.edit.enabled && (
            <button type="button" onClick={() => void save()} disabled={!controls.save.enabled || busy !== null} className={BTN} style={BTN_PRIMARY} data-save-draft>
              {busy === "save" ? <Loader2 size={11} className="animate-spin" aria-hidden /> : <Save size={11} aria-hidden />} Save draft
            </button>
          )}
          {draft.dirty && (
            <button type="button" onClick={() => {
              if (!window.confirm("Discard your unsaved text?")) return;
              ed.replace((s) => ({ ...s, draft: draftFrom(s.base ? bodyOfVersion(s.base) : codeDefault, s.base?.id ?? null, s.draft.revision) }));
              setNotice(null);
            }} disabled={busy !== null} className={BTN} style={BTN_NEUTRAL}>
              <X size={11} aria-hidden /> Discard changes
            </button>
          )}
          <span className="text-[11px] tabular-nums text-[var(--text-muted)]" data-base>
            {draft.dirty ? "Unsaved changes" : "No unsaved changes"} · from {draft.parentVersionId === null ? "the code default" : base ? `v${base.version}` : "a saved version"}
          </span>
        </div>
        {draft.dirty && controls.edit.enabled && <Why c={controls.save} />}
        <NoticeLine notice={notice} />
        {controls.publish.shown && (
          <PublishBox key={base?.id ?? "none"} itemKey={itemKey} base={base} control={controls.publish} busy={busy === "publish"} revision={freshRevision}
            onBusy={(b) => setBusy(b ? "publish" : null)}
            onPublished={(v, revision) => afterLiveChange(`Published v${v.version}. Every send from now on uses it; messages already delivered keep their text.`, revision, v, bodyOfVersion(v))}
            onRefused={(r) => { conflictNotice(r); setNotice({ tone: r.kind === "error" && r.code === "CONFLICT" ? "warn" : "bad", text: `Not published: ${writeRefusalText(r)}` }); }} />
        )}
      </Sub>

      <AiBox itemKey={itemKey} data={data} base={base} control={controls.ai} busy={busy === "ai"} onBusy={(b) => setBusy(b ? "ai" : null)} acceptBlock={aiAcceptBlock}
        onAccept={(s) => { ed.replace((st) => ({ ...st, draft: acceptSuggestion(st.draft, s) })); setSuggestionExpired(false); setNotice({ tone: "ok", text: "Suggestion loaded into the editor as an unsaved draft. Review it, then save." }); }} />

      <HistoryBox key={data.revision} itemKey={itemKey} channel={channel} variant={variant} data={data} liveBody={liveBody} control={controls.rollback} canEdit={controls.edit.enabled}
        revision={freshRevision} busy={busy === "rollback"} onBusy={(b) => setBusy(b ? "rollback" : null)} onOpen={openVersion}
        onRestored={(text, revision, published) => afterLiveChange(text, revision, published, published ? bodyOfVersion(published) : codeDefault)}
        onRefused={(r) => { conflictNotice(r); setNotice({ tone: "bad", text: `Not restored: ${writeRefusalText(r)}` }); }} />
    </div>
  );
}

function CheckLine({ status, stale, gate }: { status: CheckStatus; stale: boolean; gate: ReturnType<typeof issueGate> }) {
  const text = status === "checking" ? "Checking…" : status === "waiting" ? "Waiting for you to pause…"
    : status === "limited" ? "Paused: too many checks this minute. Use Check now in a moment."
    : status === "failed" ? "The check couldn’t run. Saving still validates on the server."
    : stale ? "Not checked yet" : gate.summary;
  const tone = status === "limited" || status === "failed" ? TONE_COLOR.warn : !stale && gate.errors ? TONE_COLOR.bad : !stale && gate.warnings ? TONE_COLOR.warn : "var(--text-muted)";
  return <span role="status" className="text-[11px] tabular-nums" style={{ color: tone }} data-check-status={status}>{text}</span>;
}

function SuggestionBanner({ expiresAt, onDiscard }: { expiresAt: string; onDiscard: () => void }) {
  const e = expiryText(expiresAt, Date.now());
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11px]" data-ai-draft>
      <Chip tone="info"><Sparkles size={10} aria-hidden /> AI suggestion, unsaved</Chip>
      <span style={{ color: e.expired ? TONE_COLOR.bad : "var(--text-muted)" }}>{e.text}</span>
      <button type="button" onClick={onDiscard} className="min-h-11 text-[11px] text-[var(--text-secondary)] underline-offset-2 hover:underline lg:min-h-7">Discard suggestion</button>
    </div>
  );
}

// ── Body editor ─────────────────────────────────────────────────────────────────

function BodyEditor({ data, channel, draft, edit, issues, onChange }: {
  data: VersionsResponse;
  channel: EditableChannel;
  draft: Draft;
  edit: Control;
  issues: readonly ContentIssue[];
  /** An edit as a function of the CURRENT body (never a body captured at render). */
  onChange: (fn: (b: ContentBody) => ContentBody) => void;
}) {
  const body = draft.body;
  const fields = editorFields(body, channel, data.limits);
  const placed = placeIssues(issues, body, channel, data.limits);
  const refs = useRef<Record<string, HTMLInputElement | HTMLTextAreaElement | null>>({});
  const [focused, setFocused] = useState<EditorField | null>(null);
  const ro = !edit.enabled;
  const links = linkPlaceholders(data.placeholders);

  const insert = (name: string) => {
    if (!focused) return;
    const el = refs.current[focused.key];
    const cur = fields.find((f) => f.key === focused.key);
    if (!cur) return;
    const r = insertToken(cur.value, name, el?.selectionStart ?? null, el?.selectionEnd ?? null);
    onChange((b) => setField(b, cur.location, r.value));
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(r.caret, r.caret); });
  };

  const field = (f: EditorField) => (
    <TextField key={f.key} f={f} issues={placed.field[f.key]} readOnly={ro} registerRef={(el) => { refs.current[f.key] = el; }}
      onFocus={() => setFocused(f)} onChange={(v) => onChange((b) => setField(b, f.location, v))} />
  );
  const top = fields.filter((f) => f.location.field !== "block");

  return (
    <div className="flex min-w-0 flex-col gap-3" data-body-editor>
      <Why c={edit} />
      <div className="flex min-w-0 flex-col gap-3">{top.map(field)}</div>
      <ol aria-label="Blocks" className="flex min-w-0 flex-col gap-2">
        {body.blocks.map((b, i) => {
          const blockFields = fields.filter((f) => f.location.field === "block" && f.location.blockIndex === i);
          const up = canMoveBlock(body, i, -1);
          const down = canMoveBlock(body, i, 1);
          const del = canRemoveBlock(body, channel, i);
          return (
            <li key={i} className="flex min-w-0 flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--border-hairline)] p-2.5" data-block={b.kind}>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{i + 1} · {BLOCK_LABEL[b.kind] ?? String(b.kind)}</span>
                {!ro && (
                  <span className="ml-auto flex flex-wrap items-center gap-1">
                    <IconBtn label={`Move block ${i + 1} up`} disabled={!up.ok} title={up.why} onClick={() => onChange((b) => moveBlock(b, i, -1))}><ArrowUp size={12} aria-hidden /></IconBtn>
                    <IconBtn label={`Move block ${i + 1} down`} disabled={!down.ok} title={down.why} onClick={() => onChange((b) => moveBlock(b, i, 1))}><ArrowDown size={12} aria-hidden /></IconBtn>
                    <IconBtn label={`Remove block ${i + 1}`} disabled={!del.ok} title={del.why} onClick={() => onChange((b) => removeBlock(b, i))}><Trash2 size={12} aria-hidden /></IconBtn>
                  </span>
                )}
              </div>
              <IssueList issues={placed.block[i]} label={`Block ${i + 1} issues`} />
              {blockFields.map((f) => (
                <div key={f.key} className="flex min-w-0 items-end gap-1">
                  <div className="min-w-0 flex-1">{field(f)}</div>
                  {!ro && b.kind === "info" && f.location.field === "block" && f.location.prop === "items" && b.items.length > 1 && (
                    <IconBtn label={`Remove ${f.label.toLowerCase()}`} onClick={() => onChange((x) => editBlock(x, i, "remove-item", (f.location as { itemIndex?: number }).itemIndex))}><X size={12} aria-hidden /></IconBtn>
                  )}
                </div>
              ))}
              {b.kind === "cta" && (
                <div className="flex min-w-0 flex-col gap-1">
                  <label className="flex min-w-0 flex-col gap-1 text-[11px] text-[var(--text-secondary)]">
                    Button link (a link placeholder — never a typed URL)
                    <select value={b.link} disabled={ro} onChange={(e) => { const link = e.target.value; onChange((x) => setField(x, { field: "block", blockIndex: i, prop: "link" }, link)); }}
                      className={FIELD} style={{ borderColor: "var(--border-hairline)" }} data-cta-link>
                      {!links.some((l) => l.name === b.link) && <option value={b.link}>{b.link ? `Unknown: ${b.link}` : "Choose a link…"}</option>}
                      {links.map((l) => <option key={l.name} value={l.name}>{`{{${l.name}}}`} · sample {l.sample}</option>)}
                    </select>
                  </label>
                  <IssueList issues={placed.field[`b${i}.link`]} />
                </div>
              )}
              {!ro && b.kind === "info" && (
                <div className="flex flex-wrap gap-1.5">
                  <SmallBtn onClick={() => onChange((x) => editBlock(x, i, "add-item"))} disabled={b.items.length >= 8}><Plus size={11} aria-hidden /> Item</SmallBtn>
                  <SmallBtn onClick={() => onChange((x) => editBlock(x, i, "toggle-title"))}>{b.title === undefined ? "Add title" : "Remove title"}</SmallBtn>
                  <SmallBtn onClick={() => onChange((x) => editBlock(x, i, "toggle-ordered"))}>{b.ordered ? "Bulleted" : "Numbered"}</SmallBtn>
                </div>
              )}
              {!ro && b.kind === "hero" && (
                <div className="flex flex-wrap gap-1.5"><SmallBtn onClick={() => onChange((x) => editBlock(x, i, "toggle-greeting"))}>{b.greeting === undefined ? "Add greeting" : "Remove greeting"}</SmallBtn></div>
              )}
            </li>
          );
        })}
      </ol>
      {!ro && (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5" role="group" aria-label="Add a block" data-add-block>
          {BLOCK_KINDS[channel].map((k) => {
            const a = canAddBlock(body, channel, k, data.limits);
            return <SmallBtn key={k} disabled={!a.ok} title={a.why ?? undefined} onClick={() => onChange((x) => addBlock(x, channel, k, data.placeholders))}><Plus size={11} aria-hidden /> {BLOCK_LABEL[k]}</SmallBtn>;
          })}
          <span className="text-[11px] text-[var(--text-muted)]">{body.blocks.length} / {data.limits.blocks} blocks</span>
        </div>
      )}
      {!ro && <PlaceholderPicker data={data} focused={focused} onInsert={insert} />}
    </div>
  );
}

function TextField({ f, issues, readOnly, registerRef, onFocus, onChange }: {
  f: EditorField;
  issues: ContentIssue[] | undefined;
  readOnly: boolean;
  registerRef: (el: HTMLInputElement | HTMLTextAreaElement | null) => void;
  onFocus: () => void;
  onChange: (v: string) => void;
}) {
  const c = charCount(f.value, f.max);
  const id = `cf-${f.key.replace(/\./g, "-")}`;
  const hasError = issues?.some((i) => i.severity === "error") ?? false;
  const common = {
    id, value: f.value, readOnly, onFocus, onChange: (e: { target: { value: string } }) => onChange(e.target.value),
    "aria-invalid": hasError || c.over || undefined, "aria-describedby": `${id}-count`,
    className: `${FIELD} w-full`, style: { borderColor: hasError || c.over ? TONE_COLOR.bad : "var(--border-hairline)" },
  };
  return (
    <div className="flex min-w-0 flex-col gap-1" data-field={f.key}>
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <label htmlFor={id} className="min-w-0 text-[11px] text-[var(--text-secondary)]">{f.label}</label>
        <span id={`${id}-count`} className="shrink-0 text-[10px] tabular-nums" style={{ color: c.over ? TONE_COLOR.bad : c.near ? TONE_COLOR.warn : "var(--text-muted)" }} data-char-count>{c.text}</span>
      </div>
      {f.multiLine
        ? <textarea ref={registerRef} rows={4} {...common} className={`${common.className} resize-y`} />
        : <input ref={registerRef} type="text" {...common} />}
      <IssueList issues={issues} />
    </div>
  );
}

function IconBtn({ label, disabled, title, onClick, children }: { label: string; disabled?: boolean; title?: string | null; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={title ?? label} disabled={disabled} onClick={onClick}
      className="flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border-hairline)] text-[var(--text-secondary)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] lg:min-h-7 lg:min-w-7">
      {children}
    </button>
  );
}

function SmallBtn({ onClick, disabled, title, children }: { onClick: () => void; disabled?: boolean; title?: string; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title}
      className="inline-flex min-h-11 items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] px-2.5 text-[11px] text-[var(--text-secondary)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] lg:min-h-7">
      {children}
    </button>
  );
}

function PlaceholderPicker({ data, focused, onInsert }: { data: VersionsResponse; focused: EditorField | null; onInsert: (name: string) => void }) {
  const text = insertablePlaceholders(data.placeholders, focused?.where ?? null);
  const links = linkPlaceholders(data.placeholders);
  return (
    <Sub title="Placeholders" hint={<span className="text-[11px] text-[var(--text-muted)]">{focused ? `Inserts into: ${focused.label}` : "Click into a field, then pick one"}</span>}>
      {text.length === 0 ? <p className="text-[11px] text-[var(--text-muted)]">{focused ? "No placeholder may be used in this field." : "This message has no text placeholders."}</p> : (
        <ul aria-label="Text placeholders" className="flex min-w-0 flex-col gap-1.5" data-placeholders>
          {text.map((ph) => (
            <li key={ph.name} className="flex min-w-0 flex-wrap items-center gap-2">
              <button type="button" disabled={!focused} onMouseDown={(e) => e.preventDefault()} onClick={() => onInsert(ph.name)}
                className="inline-flex min-h-11 items-center rounded-[var(--radius-sm)] border border-[var(--border-hairline)] px-2 font-mono text-[11px] text-[var(--text-primary)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] lg:min-h-7"
                data-insert={ph.name}>
                {`{{${ph.name}}}`}
              </button>
              <span className="min-w-0 break-words text-[11px] text-[var(--text-muted)]">{placeholderHint(ph)}</span>
            </li>
          ))}
        </ul>
      )}
      {links.length > 0 && (
        <PolicyNote>Links ({links.map((l) => `{{${l.name}}}`).join(", ")}) are chosen on a button, never typed into text.</PolicyNote>
      )}
    </Sub>
  );
}

// ── Preview ─────────────────────────────────────────────────────────────────────

function PreviewBlock({ itemKey, channel, draftPreview, draftBlocked, base, dirty, readOnly }: {
  itemKey: string;
  channel: EditableChannel;
  draftPreview: ContentPreviewResponse | null;
  draftBlocked: boolean;
  base: TemplateVersionDTO | null;
  dirty: boolean;
  /** No live check runs for a viewer who can't edit: the saved version (or the drawer's live preview) is shown. */
  readOnly: boolean;
}) {
  const [mode, setMode] = useState<"draft" | "saved">(readOnly && base ? "saved" : "draft");
  const showSaved = mode === "saved" && base !== null;
  const read = useCommsRead<ContentPreviewResponse>(showSaved ? previewUrl(itemKey, PREVIEW_OF[channel], null, base!.id) : null);
  const saved = okData(read);
  if (readOnly && !base) return <PolicyNote>The live copy is the code default; it is shown in the Preview section below.</PolicyNote>;
  return (
    <Sub title="Preview" hint={base && !readOnly && (
      <WideTargets>
        <Segmented label="Preview source" value={mode} onChange={setMode}
          options={[{ id: "draft", label: dirty ? "Your edit (unsaved)" : "Editor" }, { id: "saved", label: `Saved v${base.version}` }]} />
      </WideTargets>
    )}>
      {showSaved ? (saved ? <PreviewRendition p={saved} /> : <ReadState read={read} what="the saved version’s preview" />)
        : draftPreview && (draftPreview.html !== null || draftPreview.inApp !== null || draftPreview.text !== null) ? <PreviewRendition p={draftPreview} />
        : <p role="status" className="text-xs text-[var(--text-secondary)]">{draftBlocked ? "The preview appears once the errors are fixed." : "The preview appears after the live check."}</p>}
    </Sub>
  );
}

// ── Publish ─────────────────────────────────────────────────────────────────────

function PublishBox({ itemKey, base, control, busy, revision, onBusy, onPublished, onRefused }: {
  itemKey: string;
  base: TemplateVersionDTO | null;
  control: Control;
  busy: boolean;
  revision: number;
  onBusy: (b: boolean) => void;
  onPublished: (v: TemplateVersionDTO, revision: number) => void;
  onRefused: (r: CommsReadResult<unknown>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<OperatorReasonValue>(EMPTY_OPERATOR_REASON);
  const [ack, setAck] = useState(false);
  const [extra, setExtra] = useState<ContentIssue[] | null>(null);
  const warnings = [...(base?.issues ?? []), ...(extra ?? [])].filter((i) => i.severity === "warning");
  const errors = (extra ?? []).filter((i) => i.severity === "error");
  const needAck = warnings.length > 0;
  const r = reasonPayload(reason);
  const go = async () => {
    if (!base || !r) return;
    onBusy(true);
    const res = await postPublish(itemKey, base.id, { reason: r, expectedRevision: revision, body: { acknowledgeWarnings: ack } });
    onBusy(false);
    if (res.kind === "ok") { setOpen(false); setReason(EMPTY_OPERATOR_REASON); setAck(false); setExtra(null); onPublished(res.data.result.published, res.data.result.revision); return; }
    if (res.kind === "error" && res.issues) setExtra(res.issues);
    onRefused(res);
  };
  return (
    <div className="flex min-w-0 flex-col gap-2 border-t border-[var(--border-hairline)] pt-3" data-publish>
      {!open ? (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => { setReason(EMPTY_OPERATOR_REASON); setAck(false); setExtra(null); setOpen(true); }} disabled={!control.enabled || busy} className={BTN} style={BTN_PRIMARY} data-publish-open>
            <Upload size={11} aria-hidden /> Publish{base && base.state === "DRAFT" ? ` v${base.version}` : ""}…
          </button>
          <Why c={control} />
        </div>
      ) : (
        <div role="group" aria-label="Publish this draft" className="flex min-w-0 flex-col gap-2 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] p-3">
          <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
            Publishing makes v{base?.version} the live copy: every send after this uses it, including scheduled ones. Messages already delivered keep their text. Automations are not paused.
          </p>
          <IssueList issues={errors} label="Errors" />
          {needAck && (
            <>
              <IssueList issues={warnings} label="Warnings" />
              <label className="flex min-h-11 items-start gap-2 text-[11px] leading-relaxed text-[var(--text-primary)] lg:min-h-0" data-ack>
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0" />
                I’ve read these warnings and still want to publish. They’re recorded with the publish.
              </label>
            </>
          )}
          <OperatorReasonField value={reason} onChange={setReason} disabled={busy} label="A reason is recorded with the publish" />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void go()} disabled={busy || !r || (needAck && !ack) || errors.length > 0} className={BTN} style={BTN_PRIMARY} data-publish-confirm>
              {busy ? <Loader2 size={11} className="animate-spin" aria-hidden /> : <Check size={11} aria-hidden />} Publish
            </button>
            <button type="button" onClick={() => { setOpen(false); setExtra(null); setAck(false); setReason(EMPTY_OPERATOR_REASON); }} disabled={busy} className={BTN} style={BTN_NEUTRAL}><X size={11} aria-hidden /> Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── AI ──────────────────────────────────────────────────────────────────────────

function AiBox({ itemKey, data, base, control, busy, onBusy, onAccept, acceptBlock }: {
  itemKey: string;
  data: VersionsResponse;
  base: TemplateVersionDTO | null;
  control: Control;
  busy: boolean;
  onBusy: (b: boolean) => void;
  onAccept: (s: AiSuggestResult) => void;
  /** Why Accept is off right now (unsaved edits), else null. */
  acceptBlock: string | null;
}) {
  const [mode, setMode] = useState<AiSuggestMode>("POLISH");
  const [tone, setTone] = useState<AiTone>("NEUTRAL");
  const [result, setResult] = useState<AiSuggestResult | null>(null);
  const [failure, setFailure] = useState<{ text: string; issues?: ContentIssue[] } | null>(null);
  if (!control.shown) return null;
  const remaining = aiRemainingText(data.ai);
  const run = async () => {
    if (!base) return;
    onBusy(true); setFailure(null); setResult(null);
    const r = await postAiSuggest(itemKey, base.id, { body: mode === "POLISH" ? { mode, tone } : { mode } });
    onBusy(false);
    if (r.kind === "ok") setResult(r.data);
    else setFailure({ text: writeRefusalText(r), ...(r.kind === "error" && r.issues ? { issues: r.issues } : {}) });
  };
  const exp = result ? expiryText(result.expiresAt, Date.now()) : null;
  const acceptWhy = result ? aiAcceptWhy(result, base, acceptBlock, exp?.expired ?? false) : null;
  return (
    <Sub title="Polish with Fourth Meridian AI" hint={remaining ? <span className="text-[11px] tabular-nums text-[var(--text-muted)]" data-ai-remaining>{remaining}</span> : undefined}>
      <PolicyNote>The AI sees only this saved version’s text and placeholder names — never customer data. It suggests; it can’t save or publish.</PolicyNote>
      <div className="flex min-w-0 flex-wrap items-end gap-3">
        <WideTargets><Segmented label="AI mode" value={mode} onChange={setMode} options={(["POLISH", "CHECK"] as const).map((m) => ({ id: m, label: MODE_LABEL[m] }))} /></WideTargets>
        {mode === "POLISH" && (
          <div className="min-w-[8rem]">
            <FilterSelect label="Tone" value={tone} includeAny={false} options={AI_TONES.map((t) => ({ value: t, label: TONE_LABEL[t] }))} onChange={(v) => setTone((v as AiTone | null) ?? "NEUTRAL")} />
          </div>
        )}
        <button type="button" onClick={() => void run()} disabled={!control.enabled || busy} className={BTN} style={BTN_QUIET} data-ai-run>
          {busy ? <Loader2 size={11} className="animate-spin" aria-hidden /> : <Sparkles size={11} aria-hidden />} {mode === "POLISH" ? "Suggest polish" : "Check copy"}{base ? ` (v${base.version})` : ""}
        </button>
      </div>
      <Why c={control} />
      {failure && (
        <div role="alert" className="flex min-w-0 flex-col gap-1 text-[11px]" style={{ color: TONE_COLOR.bad }} data-ai-failure>
          <p>{failure.text}</p>
          <IssueList issues={failure.issues} label="Why the suggestion was rejected" />
        </div>
      )}
      {result && (
        <div className="flex min-w-0 flex-col gap-2" data-ai-result={result.suggestionId}>
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-[var(--text-muted)]">
            <span>{result.changes.length === 0 ? "Nothing to change." : `${result.changes.length} change${result.changes.length === 1 ? "" : "s"} suggested`} · {MODE_LABEL[result.mode]} · {result.model}</span>
            {exp && <span style={{ color: exp.expired ? TONE_COLOR.bad : undefined }} data-ai-expiry>{exp.text}</span>}
          </div>
          <DiffList rows={changeRows(result)} empty="The suggestion matches your saved text." />
          {result.notes.length > 0 && (
            <div className="flex min-w-0 flex-col gap-1.5" data-ai-notes>
              {notesByCategory(result.notes, result.base).map((g) => (
                <div key={g.category} className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{g.label}</span>
                  <ul className="flex min-w-0 flex-col gap-0.5">{g.notes.map((x, k) => <li key={k} className="min-w-0 break-words text-[11px] text-[var(--text-secondary)]"><span className="text-[var(--text-muted)]">{x.where}: </span>{x.text}</li>)}</ul>
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => { onAccept(result); setResult(null); }} disabled={acceptWhy !== null} className={BTN} style={BTN_PRIMARY} data-ai-accept>
              <Check size={11} aria-hidden /> Accept into editor
            </button>
            <button type="button" onClick={() => setResult(null)} className={BTN} style={BTN_NEUTRAL}><X size={11} aria-hidden /> Discard</button>
          </div>
          {acceptWhy && <p className="text-[11px] leading-relaxed text-[var(--text-muted)]" data-ai-accept-why>{acceptWhy}</p>}
        </div>
      )}
    </Sub>
  );
}

// ── History ─────────────────────────────────────────────────────────────────────

function HistoryBox({ itemKey, channel, variant, data, liveBody, control, canEdit, revision, busy, onBusy, onOpen, onRestored, onRefused }: {
  itemKey: string;
  /** The freshest known stream revision (the same token save / publish send). */
  revision: number;
  channel: EditableChannel;
  variant: string;
  data: VersionsResponse;
  liveBody: ContentBody | null;
  control: Control;
  canEdit: boolean;
  busy: boolean;
  onBusy: (b: boolean) => void;
  onOpen: (v: TemplateVersionDTO) => void;
  onRestored: (text: string, revision: number, published: TemplateVersionDTO | null) => void;
  onRefused: (r: CommsReadResult<unknown>) => void;
}) {
  const [more, setMore] = useState<{ items: TemplateVersionDTO[]; nextCursor: string | null; loading: boolean } | null>(null);
  const [viewing, setViewing] = useState<TemplateVersionDTO | null>(null);
  const [restoring, setRestoring] = useState<{ id: string; label: string } | null>(null);
  const [reason, setReason] = useState<OperatorReasonValue>(EMPTY_OPERATOR_REASON);
  const items = [...data.items, ...(more?.items ?? [])];
  const nextCursor = more ? more.nextCursor : data.nextCursor;
  const loadMore = (cursor: string) => {
    setMore((m) => ({ items: m?.items ?? [], nextCursor: cursor, loading: true }));
    void readVersions(itemKey, channel, variant, cursor).then((r) => setMore((m) => (r.kind === "ok" ? { items: [...(m?.items ?? []), ...r.data.items], nextCursor: r.data.nextCursor, loading: false } : { items: m?.items ?? [], nextCursor: cursor, loading: false })));
  };
  const r = reasonPayload(reason);
  const restore = async () => {
    if (!restoring || !r) return;
    onBusy(true);
    const res = await postRollback(itemKey, restoring.id, {
      reason: r, expectedRevision: revision,
      ...(restoring.id === CODE_DEFAULT_VERSION_ID ? { body: { channel, ...(variant !== "default" ? { variant } : {}) } } : {}),
    });
    onBusy(false);
    if (res.kind === "ok") {
      const pub = res.data.result.published;
      const v = "id" in pub ? pub : null;
      setRestoring(null); setReason(EMPTY_OPERATOR_REASON);
      onRestored(v ? `Restored: v${v.version} (a copy of ${restoring.label}) is live.` : "Restored: the code default is live again.", res.data.result.revision, v);
      return;
    }
    onRefused(res);
  };
  return (
    <Sub title="Version history" hint={<span className="text-[11px] text-[var(--text-muted)]">Live: {liveText(data.live)} · revision {data.revision}</span>}>
      {items.length === 0 ? <p className="text-xs text-[var(--text-secondary)]">Nothing saved yet — the code default is live.</p> : (
        <ul aria-label="Versions" className="flex min-w-0 flex-col divide-y divide-[var(--border-hairline)]" data-versions>
          {items.map((v) => (
            <li key={v.id} className="flex min-w-0 flex-col gap-1.5 py-2" data-version={v.state}>
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-xs font-medium tabular-nums text-[var(--text-primary)]">v{v.version}</span>
                <ToneBadge word={VERSION_STATE_LABEL[v.state]} tone={VERSION_STATE_TONE[v.state]} />
                <Chip tone={v.createdBy.kind === "AI_ASSISTED" ? "info" : "muted"} title={provenanceText(v)}>{CREATED_BY_LABEL[v.createdBy.kind]}</Chip>
                {v.aiEditedAfterAccept && <Chip tone="info">Edited after AI</Chip>}
                {v.issues.length > 0 && <Chip tone="warn">{v.issues.length} warning{v.issues.length === 1 ? "" : "s"}</Chip>}
              </div>
              <span className="text-[11px] tabular-nums text-[var(--text-muted)]">
                Saved {utcStamp(v.createdAt)}{v.publishedAt ? ` · published ${utcStamp(v.publishedAt)}` : ""} · {provenanceText(v)}
              </span>
              <div className="flex flex-wrap gap-1.5">
                <SmallBtn onClick={() => setViewing(viewing?.id === v.id ? null : v)}><Eye size={11} aria-hidden /> {viewing?.id === v.id ? "Close" : "View"}</SmallBtn>
                {canEdit && <SmallBtn onClick={() => onOpen(v)}>Edit from this</SmallBtn>}
                {control.enabled && isRestorable(v) && <SmallBtn onClick={() => setRestoring({ id: v.id, label: `v${v.version}` })}><RotateCcw size={11} aria-hidden /> Restore…</SmallBtn>}
              </div>
              {viewing?.id === v.id && <VersionView itemKey={itemKey} channel={channel} v={v} liveBody={liveBody} isLive={v.state === "PUBLISHED"} />}
            </li>
          ))}
        </ul>
      )}
      {nextCursor && (
        <button type="button" disabled={more?.loading} onClick={() => loadMore(nextCursor)} className="min-h-11 self-start rounded-[var(--radius-sm)] border border-[var(--border-hairline)] px-3 text-xs text-[var(--text-secondary)] lg:min-h-8">
          {more?.loading ? "Loading…" : "Show older versions"}
        </button>
      )}
      {control.shown && (
        <div className="flex flex-wrap items-center gap-2">
          {control.enabled && data.live.source === "PUBLISHED" && (
            <SmallBtn onClick={() => setRestoring({ id: CODE_DEFAULT_VERSION_ID, label: "the code default" })}><RotateCcw size={11} aria-hidden /> Restore code default…</SmallBtn>
          )}
          <Why c={control} />
        </div>
      )}
      {restoring && (
        <div role="group" aria-label="Restore a version" className="flex min-w-0 flex-col gap-2 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] p-3" data-restore={restoring.id}>
          <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
            {restoring.id === CODE_DEFAULT_VERSION_ID
              ? "The code default becomes live again; the current version is kept in history."
              : `A new version, an exact copy of ${restoring.label}, is published. History is never rewritten.`}
          </p>
          <OperatorReasonField value={reason} onChange={setReason} disabled={busy} label="A reason is recorded with the restore" />
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void restore()} disabled={busy || !r} className={BTN} style={BTN_PRIMARY} data-restore-confirm>
              {busy ? <Loader2 size={11} className="animate-spin" aria-hidden /> : <RotateCcw size={11} aria-hidden />} Restore
            </button>
            <button type="button" onClick={() => setRestoring(null)} disabled={busy} className={BTN} style={BTN_NEUTRAL}><X size={11} aria-hidden /> Cancel</button>
          </div>
        </div>
      )}
    </Sub>
  );
}

function VersionView({ itemKey, channel, v, liveBody, isLive }: { itemKey: string; channel: EditableChannel; v: TemplateVersionDTO; liveBody: ContentBody | null; isLive: boolean }) {
  const [tab, setTab] = useState<"diff" | "preview">(isLive ? "preview" : "diff");
  const read = useCommsRead<ContentPreviewResponse>(tab === "preview" ? previewUrl(itemKey, PREVIEW_OF[channel], null, v.id) : null);
  const pv = okData(read);
  const body = bodyOfVersion(v);
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-[var(--radius-sm)] p-2.5" style={{ background: "var(--surface-inset)" }} data-version-view={v.id}>
      <WideTargets>
        <Segmented label={`Version ${v.version} view`} value={tab} onChange={setTab} options={[{ id: "diff", label: "Compare with live" }, { id: "preview", label: "Preview" }]} />
      </WideTargets>
      {tab === "diff"
        ? (liveBody ? <><span className="flex items-center gap-1 text-[11px] text-[var(--text-muted)]"><GitCompare size={11} aria-hidden /> Left: live · right: v{v.version} (read-only)</span>
            <DiffList rows={diffBodies(liveBody, body)} empty={isLive ? "This is the live version." : "Same text as live."} /></>
          : <p role="status" className="text-xs text-[var(--text-secondary)]">Reading the live version…</p>)
        : pv ? <PreviewRendition p={pv} /> : <ReadState read={read} what="this version’s preview" />}
      <IssueList issues={v.issues} label={`v${v.version} warnings`} />
    </div>
  );
}
