"use client";

/**
 * components/admin/PlatformAiCapsAdmin.tsx  (PLATFORM AI CAPS D5 PR5 — Admin → Platform AI caps)
 *
 * The SYSTEM_ADMIN editor over GET/POST /api/admin/platform-ai-caps (D5 PR4). It
 * mirrors the Personal AI allowance tools (AI Cost Controls) on purpose: the same
 * editor grammar (CadenceForm — value → consequences → required reason → optional
 * note → Save / Clear-or-Reset / Cancel), the same estimate wording.
 *
 *   Blanket card     "Per operator per day" and "Platform per day", each with its
 *                    value, source and "Fits about N questions at worst case", and
 *                    EACH its own form with its own Save and Clear: the two keys
 *                    are never saved together (one SET_BLANKET per request).
 *   Operators        every current operator (SYSTEM_ADMIN + ACTIVE grant holders)
 *                    by the server's label — never a raw id — with the effective
 *                    cap, the override or "Default", and a "You" badge for self.
 *                    Row actions: Set override (0..$20, required reason) and
 *                    Reset to default (required reason). Self-edit is allowed and
 *                    the editor says it is recorded as a self-edit.
 *
 * Every write carries `expectedUpdatedAt` from the loaded model (null = no row);
 * a CONFLICT says so and offers Reload. Refusals render inline by code
 * (platform-ai-caps-view.ts, pure + tested). Lowering the platform cap below
 * existing overrides is allowed; the count warning is shown after the save.
 *
 * The SERVER is the authority (fresh SA guard, bounds, eligibility, platform-cap
 * bound, concurrency, audit). Access to the page is app/admin/layout.tsx
 * (SYSTEM_ADMIN only). 390px: the operator table collapses to stacked cards.
 */

import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { AlertTriangle, Gauge, Loader2, Pencil, RefreshCw, RotateCcw } from "lucide-react";
import { BTN, BTN_NEUTRAL, BTN_QUIET, CadenceForm, FIELD, Notice, type OperatorReasonInput, type PolicyNotice } from "@/components/platform/widgets/policy-editor-kit";
import { TONE_COLOR } from "@/components/platform/platform-surface";
import { PlatformAiUsageTodayCard } from "@/components/platform/widgets/PlatformAiUsageToday";
import { operatorTodayLine, refusalText, stateBadge } from "@/components/platform/widgets/platform-ai-usage-view";
import {
  BLANKET_CAPTION, BLANKET_TITLE, CLEAR_TEXT, PAGE_INTRO, PAGE_TITLE, PLATFORM_AI_CAPS_URL, RESET_OVERRIDE_TEXT, SELF_EDIT_NOTE, VIA_WORD, YOU_BADGE,
  appliedText, blanketBody, capValueText, fitsText, isSelf, loweringWarningText, newCapLine, overrideBody, overrideText, platformCapUsd, resetBody,
  resolveCapsResponse, sourceText, storedText, usd, validateUsdInput,
  type BlanketCapView, type CapsBody, type CapsOutcome, type OperatorCapView, type PlatformAiCapsReadModel,
} from "./platform-ai-caps-view";

// ── Network (the page's only write idiom) ────────────────────────────────────

async function postCaps(body: CapsBody, current: PlatformAiCapsReadModel | null): Promise<CapsOutcome> {
  try {
    const r = await fetch(PLATFORM_AI_CAPS_URL, {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return resolveCapsResponse(r.status, await r.json().catch(() => null), current);
  } catch {
    return { kind: "failed", message: "The request could not be sent. Nothing was changed." };
  }
}

export type Submit = (body: CapsBody) => Promise<CapsOutcome>;

async function fetchCaps(): Promise<{ model: PlatformAiCapsReadModel } | { error: string }> {
  try {
    const r = await fetch(PLATFORM_AI_CAPS_URL, { credentials: "same-origin", cache: "no-store" });
    if (!r.ok) return { error: r.status === 403 ? "Only a System Admin can view Platform AI caps." : `Could not load Platform AI caps (${r.status}).` };
    return { model: (await r.json()) as PlatformAiCapsReadModel };
  } catch {
    return { error: "Could not load Platform AI caps." };
  }
}

/** One editable unit's state: its mode, its notice, and whether a conflict asks for a reload. */
function useUnit(submit: Submit) {
  const [mode, setMode] = useState<"view" | "edit" | "reset">("view");
  const [notice, setNotice] = useState<PolicyNotice | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const open = (m: "edit" | "reset") => { setNotice(null); setConflict(false); setMode(m); };
  const close = () => setMode("view");
  const run = async (body: CapsBody | null, warningOf?: (o: Extract<CapsOutcome, { kind: "applied" }>) => string | null) => {
    if (!body) return; // no reason ⇒ no request (the form's Save is disabled anyway)
    setBusy(true); setNotice(null); setConflict(false);
    const o = await submit(body);
    setBusy(false);
    if (o.kind === "applied") {
      close();
      const warn = warningOf?.(o) ?? null;
      setNotice(warn ? { tone: "warn", text: `${appliedText(body, o.result)} ${warn}` } : { tone: "ok", text: appliedText(body, o.result) });
    } else if (o.kind === "refused") {
      setNotice({ tone: o.conflict ? "warn" : "bad", text: o.message });
      setConflict(o.conflict);
    } else {
      setNotice({ tone: "bad", text: o.message });
    }
  };
  return { mode, notice, conflict, busy, open, close, run, clearConflict: () => setConflict(false) };
}

function ReloadButton({ onReload }: { onReload: () => void }) {
  return (
    <button type="button" onClick={onReload} className={`${BTN} self-start`} style={BTN_QUIET}>
      <RefreshCw size={12} aria-hidden /> Reload
    </button>
  );
}

export function UsdInput({ label, raw, max, busy, onChange, hint }: { label: string; raw: string; max: number; busy: boolean; onChange: (raw: string) => void; hint: string }) {
  const id = useId();
  const v = validateUsdInput(raw, max);
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[11px] text-[var(--text-secondary)]">{label}</label>
      <div className="flex flex-wrap items-center gap-2">
        <input id={id} type="number" inputMode="numeric" min={0} max={max} step={1} value={raw} onChange={(e) => onChange(e.target.value)} disabled={busy}
          aria-invalid={v.error !== null} aria-describedby={`${id}-hint`} className={`${FIELD} w-28 tabular-nums`}
          style={{ borderColor: v.error ? TONE_COLOR.bad : "var(--border-hairline)" }} />
        <span id={`${id}-hint`} className="text-[11px] text-[var(--text-muted)]">{hint}</span>
      </div>
      {v.error && <p className="text-[11px]" style={{ color: TONE_COLOR.bad }} role="alert">{v.error}</p>}
    </div>
  );
}

// ── Blanket card: two caps, two separate forms ───────────────────────────────

function BlanketCap({ view, reserveUsd, submit, onReload }: { view: BlanketCapView; reserveUsd: number | null; submit: Submit; onReload: () => void }) {
  const u = useUnit(submit);
  const [raw, setRaw] = useState("");
  const startEdit = () => { setRaw(view.stored.state === "SET" && view.stored.usd !== null ? String(view.stored.usd) : ""); u.open("edit"); };
  const parsed = validateUsdInput(raw, view.ceilingUsd);
  const title = BLANKET_TITLE[view.key];
  const lowering = (o: Extract<CapsOutcome, { kind: "applied" }>) => loweringWarningText(o.result.warning);
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-2xl border border-[var(--border-hairline-strong)] bg-[var(--surface-muted)] p-5" aria-label={title}>
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h3>
        <p className="text-xs leading-5 text-[var(--text-secondary)]">{BLANKET_CAPTION[view.key]}</p>
      </div>
      <p className="text-3xl font-semibold tabular-nums text-[var(--text-primary)]">{capValueText(view.effective)}</p>
      <dl className="flex flex-col gap-1 text-xs">
        <div className="flex flex-wrap justify-between gap-x-4"><dt className="text-[var(--text-muted)]">Source</dt><dd className="text-[var(--text-primary)]">{sourceText(view.effective)}</dd></div>
        <div className="flex flex-wrap justify-between gap-x-4"><dt className="text-[var(--text-muted)]">Stored setting</dt><dd className="text-[var(--text-primary)]">{storedText(view)}</dd></div>
        <div className="flex flex-wrap justify-between gap-x-4"><dt className="text-[var(--text-muted)]">Max</dt><dd className="text-[var(--text-primary)]">{usd(view.ceilingUsd)} / UTC day · fixed ceiling</dd></div>
      </dl>
      <p className="text-xs text-[var(--text-secondary)]">{fitsText(view.fitsTurns, view.effective)}</p>
      {view.stored.state === "INVALID" && (
        <p className="text-xs" style={{ color: TONE_COLOR.warn }} role="alert">The stored value is unreadable. Save a new value or clear it.</p>
      )}
      <div className="mt-auto border-t border-[var(--border-hairline)] pt-3 flex flex-col gap-2">
        {u.mode === "view" ? (
          <>
            <Notice notice={u.notice} />
            {u.conflict && <ReloadButton onReload={() => { u.clearConflict(); onReload(); }} />}
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={startEdit} className={BTN} style={BTN_QUIET} aria-label={`Edit ${title}`}><Pencil size={12} aria-hidden /> Edit</button>
              <button type="button" onClick={() => u.open("reset")} disabled={view.stored.state === "ABSENT"} className={BTN} style={BTN_NEUTRAL} aria-label={`Clear ${title}`}>
                <RotateCcw size={12} aria-hidden /> Clear
              </button>
            </div>
          </>
        ) : (
          <>
            <CadenceForm
              key={u.mode}
              ariaLabel={`${u.mode === "reset" ? "Clear" : "Edit"} ${title}`}
              intent={u.mode}
              control={<UsdInput label={`${title} (estimated, whole dollars)`} raw={raw} max={view.ceilingUsd} busy={u.busy} onChange={setRaw} hint={`$0 to ${usd(view.ceilingUsd)}`} />}
              consequences={[
                parsed.value !== null ? newCapLine(parsed.value, reserveUsd) : "",
                view.key === "platform" ? "Operators whose cap is above a lower platform cap are held to the platform cap." : "Operators with an override keep their override.",
              ].filter(Boolean)}
              busy={u.busy}
              notice={u.notice}
              canSave={parsed.value !== null && !(view.stored.state === "SET" && view.stored.usd === parsed.value)}
              dirty={raw !== (view.stored.usd === null ? "" : String(view.stored.usd))}
              canReset={view.stored.state !== "ABSENT"}
              saveLabel="Save"
              resetLabel="Clear"
              confirmResetLabel="Confirm clear"
              resetText={CLEAR_TEXT}
              onSave={(reason: OperatorReasonInput) => u.run(parsed.value === null ? null : blanketBody(view, parsed.value, reason), lowering)}
              onReset={(reason: OperatorReasonInput) => u.run(blanketBody(view, null, reason), lowering)}
              onCancel={u.close}
            />
            {u.conflict && <ReloadButton onReload={() => { u.clearConflict(); u.close(); onReload(); }} />}
          </>
        )}
      </div>
    </section>
  );
}

// ── Operators: one responsive grid (a table on desktop, stacked cards at 390px) ─

const ROW_GRID = "md:grid md:grid-cols-[minmax(0,1.6fr)_minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1.8fr)_auto] md:items-center md:gap-4";

/** Today's usage cell: spend vs cap, questions, and the limit the next question meets (estimated). */
function TodayCell({ today }: { today: OperatorCapView["today"] }) {
  if (!today) return <Cell label="Today">—</Cell>;
  const badge = stateBadge(today.state);
  return (
    <Cell label="Today">
      <span className="tabular-nums" style={today.state === "OK" ? undefined : { color: TONE_COLOR[badge.tone] }}>{operatorTodayLine(today)}</span>
      {today.refusal && <span className="block text-[11px] text-[var(--text-muted)]">{refusalText(today.refusal)}</span>}
    </Cell>
  );
}

function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 md:block">
      <span className="text-[11px] text-[var(--text-muted)] md:hidden">{label}</span>
      <span className="min-w-0 break-words text-right text-sm text-[var(--text-primary)] md:text-left">{children}</span>
    </div>
  );
}

function OperatorRow({ op, self, maxUsd, platformUsd, submit, onReload }: { op: OperatorCapView; self: boolean; maxUsd: number; platformUsd: number | null; submit: Submit; onReload: () => void }) {
  const u = useUnit(submit);
  const [raw, setRaw] = useState("");
  const max = maxUsd; // the operator ceiling (the read model's per-operator ceilingUsd); the server refuses above it regardless
  const parsed = validateUsdInput(raw, max);
  const startEdit = () => { setRaw(op.override?.dailyUsd != null ? String(op.override.dailyUsd) : ""); u.open("edit"); };
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-[var(--border-hairline)] p-4 md:rounded-none md:border-0 md:border-b md:px-4 md:py-3" aria-label={op.label}>
      <div className={`flex flex-col gap-2 ${ROW_GRID}`}>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-[var(--text-primary)]">{op.label}</span>
          {self && <span className="rounded-full border px-2 py-0.5 text-[10px] font-semibold" style={{ color: "var(--brass-300)", borderColor: "color-mix(in srgb, var(--brass-300) 30%, transparent)" }}>{YOU_BADGE}</span>}
          <span className="text-[11px] text-[var(--text-muted)]">{VIA_WORD[op.via]}</span>
        </div>
        <Cell label="Estimated daily spend cap">{capValueText(op.effective)} <span className="text-[11px] text-[var(--text-muted)]">· {sourceText(op.effective)}</span></Cell>
        <Cell label="Override">{overrideText(op)}</Cell>
        <Cell label="Worst case">{op.fitsTurns === null ? "—" : `about ${op.fitsTurns} question${op.fitsTurns === 1 ? "" : "s"}`}</Cell>
        <TodayCell today={op.today} />
        <div className="flex flex-wrap gap-2 md:justify-end">
          <button type="button" onClick={startEdit} disabled={u.mode !== "view"} className={BTN} style={BTN_QUIET} aria-label={`Set override for ${op.label}`}>
            <Pencil size={12} aria-hidden /> Set override
          </button>
          <button type="button" onClick={() => u.open("reset")} disabled={!op.override || u.mode !== "view"} className={BTN} style={BTN_NEUTRAL} aria-label={`Reset ${op.label} to default`}>
            <RotateCcw size={12} aria-hidden /> Reset to default
          </button>
        </div>
      </div>
      {u.mode === "view" ? (
        <>
          <Notice notice={u.notice} />
          {u.conflict && <ReloadButton onReload={() => { u.clearConflict(); onReload(); }} />}
        </>
      ) : (
        <>
          <CadenceForm
            key={u.mode}
            ariaLabel={`${u.mode === "reset" ? "Reset" : "Set override for"} ${op.label}`}
            intent={u.mode}
            control={<UsdInput label={`Daily cap override for ${op.label} (estimated, whole dollars)`} raw={raw} max={max} busy={u.busy} onChange={setRaw}
              hint={`$0 to ${usd(max)}${platformUsd === null ? "" : ` · platform cap ${usd(platformUsd)}`}`} />}
            consequences={[
              "An override replaces the per-operator default for this operator only. $0 turns Platform AI off for them.",
              ...(self ? [SELF_EDIT_NOTE] : []),
            ]}
            busy={u.busy}
            notice={u.notice}
            canSave={parsed.value !== null && parsed.value !== op.override?.dailyUsd}
            dirty={raw !== (op.override?.dailyUsd == null ? "" : String(op.override.dailyUsd))}
            canReset={!!op.override}
            saveLabel="Save override"
            resetLabel="Reset to default"
            confirmResetLabel="Confirm reset"
            resetText={self ? `${RESET_OVERRIDE_TEXT} ${SELF_EDIT_NOTE}` : RESET_OVERRIDE_TEXT}
            onSave={(reason: OperatorReasonInput) => u.run(parsed.value === null ? null : overrideBody(op, parsed.value, reason))}
            onReset={(reason: OperatorReasonInput) => u.run(resetBody(op, reason))}
            onCancel={u.close}
          />
          {u.conflict && <ReloadButton onReload={() => { u.clearConflict(); u.close(); onReload(); }} />}
        </>
      )}
    </li>
  );
}

// ── The surface (prop-driven: every state provable by props) ─────────────────

export function PlatformAiCapsSurface({ model, selfUserId, submit, onReload }: { model: PlatformAiCapsReadModel; selfUserId: string | null; submit: Submit; onReload: () => void }) {
  const reload = onReload;
  const platformUsd = platformCapUsd(model);
  const hasSelf = model.operators.some((op) => isSelf(op, selfUserId));
  return (
    <>
      {model.usageToday !== undefined && <PlatformAiUsageTodayCard usage={model.usageToday} />}

      <section aria-labelledby="pa-caps-blanket" className="space-y-3">
        <h2 id="pa-caps-blanket" className="text-lg font-semibold text-[var(--text-primary)]">Platform-wide defaults</h2>
        <div className="grid items-stretch gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 18.5rem), 1fr))" }}>
          <BlanketCap view={model.blanket.perOperator} reserveUsd={model.reserveUsd} submit={submit} onReload={reload} />
          <BlanketCap view={model.blanket.platform} reserveUsd={model.reserveUsd} submit={submit} onReload={reload} />
        </div>
        {model.overridesAbovePlatformCap !== null && model.overridesAbovePlatformCap > 0 && (
          <p className="text-xs" style={{ color: TONE_COLOR.warn }} role="status">{loweringWarningText({ count: model.overridesAbovePlatformCap })}</p>
        )}
        <p className="text-xs text-[var(--text-muted)]">{model.note}</p>
      </section>

      <section aria-labelledby="pa-caps-operators" className="space-y-3">
        <h2 id="pa-caps-operators" className="text-lg font-semibold text-[var(--text-primary)]">Operators</h2>
        {hasSelf && <p className="text-xs text-[var(--text-muted)]">{SELF_EDIT_NOTE}</p>}
        {model.operators.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">No current operators.</p>
        ) : (
          <div className="md:rounded-2xl md:border md:border-[var(--border-hairline-strong)] md:bg-[var(--surface-muted)]">
            <div className={`hidden border-b border-[var(--border-hairline)] px-4 py-3 text-xs font-medium text-[var(--text-muted)] ${ROW_GRID}`} aria-hidden>
              <span>Operator</span><span>Estimated daily spend cap</span><span>Override</span><span>Worst case</span><span>Today (estimated)</span><span className="text-right">Actions</span>
            </div>
            <ul className="flex flex-col gap-3 md:gap-0" aria-label="Operators">
              {model.operators.map((op) => (
                <OperatorRow key={op.ref} op={op} self={isSelf(op, selfUserId)} maxUsd={model.blanket.perOperator.ceilingUsd} platformUsd={platformUsd} submit={submit} onReload={reload} />
              ))}
            </ul>
          </div>
        )}
      </section>
    </>
  );
}

// ── The page ──────────────────────────────────────────────────────────────────

export function PlatformAiCapsAdmin({ selfUserId }: { selfUserId: string | null }) {
  const [model, setModel] = useState<PlatformAiCapsReadModel | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const apply = useCallback((r: { model: PlatformAiCapsReadModel } | { error: string }) => {
    if ("model" in r) { setModel(r.model); setLoadError(null); } else setLoadError(r.error);
    setLoading(false);
  }, []);

  useEffect(() => { void fetchCaps().then(apply); }, [apply]);

  const submit: Submit = async (body) => {
    const o = await postCaps(body, model);
    if (o.kind === "applied") setModel(o.model);
    return o;
  };
  const reload = () => { setLoading(true); void fetchCaps().then(apply); };

  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-[var(--text-primary)]">
            <Gauge size={20} className="text-[var(--accent-negative)]" aria-hidden />
            {PAGE_TITLE}
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-[var(--text-secondary)]">{PAGE_INTRO}</p>
        </div>
        <button type="button" onClick={reload} disabled={loading} className="flex items-center gap-2 rounded-xl border border-[var(--border-hairline-strong)] bg-[var(--surface-muted)] px-3 py-1.5 text-sm text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] disabled:opacity-50">
          <RefreshCw size={14} aria-hidden /> Reload
        </button>
      </div>

      {loading && !model ? (
        <p className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]" role="status"><Loader2 size={12} className="animate-spin" aria-hidden /> Loading…</p>
      ) : loadError || !model ? (
        <p className="flex items-start gap-1.5 text-sm" style={{ color: TONE_COLOR.bad }} role="alert"><AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden /><span>{loadError ?? "Could not load Platform AI caps."}</span></p>
      ) : (
        <PlatformAiCapsSurface model={model} selfUserId={selfUserId} submit={submit} onReload={reload} />
      )}
    </div>
  );
}
