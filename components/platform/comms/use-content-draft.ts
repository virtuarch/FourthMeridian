"use client";

/**
 * components/platform/comms/use-content-draft.ts  (Customer Success — Communications Center › content editor state)
 *
 * THE one owner of the editor's draft. Every write outcome is applied with a
 * FUNCTIONAL update to the state at resolution time (content-model.ts reducers),
 * so text typed while a save / publish / restore is in flight is never reverted
 * by a refusal and never replaced by a success.
 *
 *   save(send)         snapshot → send → stateAfterSave(prev, sent, result)
 *   liveChanged(c)     publish / restore landed: a dirty draft is kept as typed
 *   conflict           set by a 409 CONFLICT; resolved ONLY by a SUCCESSFUL
 *                      reload (`loadCount` rising past the conflict) whose
 *                      revision has reached the server's `current` — a failed
 *                      or older reload leaves the draft and the conflict untouched
 *   beforeunload       guarded while the draft is dirty
 *
 * DOM-less: tested by content-editor-state.test.ts with the repo's stub-root harness.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ContentBody, TemplateVersionDTO } from "@/lib/notifications/content/types";
import type { CommsReadResult } from "@/lib/platform/comms-center/client";
import { editDraft, rebaseDraft, sameBody, saveOutcome, stateAfterLiveChange, stateAfterSave, type Draft, type EditorState, type SaveOutcome } from "./content-model";

/** A save's outcome plus whether the operator typed while it was in flight. */
export type SaveResult = SaveOutcome & { typedSince: boolean };

export interface ContentDraftApi {
  state: EditorState | null;
  conflict: { current: number | null } | null;
  /** The state as of now (for a snapshot inside an async handler). */
  latest: () => EditorState | null;
  /** First mount when the live version arrives late; ignored once a draft exists. */
  init: (s: EditorState) => void;
  /** An edit as a function of the CURRENT body. */
  edit: (fn: (b: ContentBody) => ContentBody) => void;
  /** Any other synchronous user action (open a version, accept / discard a suggestion, discard). */
  replace: (fn: (s: EditorState) => EditorState) => void;
  save: (send: (sent: Draft) => Promise<CommsReadResult<{ result: TemplateVersionDTO }>>) => Promise<SaveResult | null>;
  liveChanged: (c: { revision: number; published: TemplateVersionDTO | null; body: ContentBody }) => void;
  setConflict: (current: number | null) => void;
}

/**
 * `loadCount` counts SUCCESSFUL reads of the stream (useLastGoodRead); `revision`
 * is the latest successfully read revision.
 */
export function useContentDraft(initial: () => EditorState | null, reload: { loadCount: number; revision: number }): ContentDraftApi {
  const [state, setState] = useState<EditorState | null>(initial);
  const [conflict, setConflictState] = useState<{ current: number | null; atLoad: number } | null>(null);
  // The last COMMITTED state and load count, for handlers (save's snapshot and its
  // `typedSince`, setConflict's `atLoad`). Written after every commit — each
  // keystroke is a discrete event React commits synchronously, so a handler that
  // runs later always sees it.
  const ref = useRef(state);
  const loads = useRef(reload.loadCount);
  useLayoutEffect(() => {
    ref.current = state;
    loads.current = reload.loadCount;
  });

  // A conflict is resolved by the first SUCCESSFUL reload after it whose revision
  // reached the server's token (an older read leaves it open). Adjusted while
  // rendering, when the inputs change — no effect, no cascading commit.
  if (conflict && reload.loadCount > conflict.atLoad && (conflict.current === null || reload.revision >= conflict.current)) {
    setConflictState(null);
    setState((prev) => (prev ? { ...prev, draft: rebaseDraft(prev.draft, { revision: reload.revision }) } : prev));
  }

  // Leaving the page with unsaved text asks first.
  const dirty = state?.draft.dirty ?? false;
  useEffect(() => {
    if (!dirty || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
    const onBeforeUnload = (e: { preventDefault: () => void; returnValue?: unknown }) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", onBeforeUnload as never);
    return () => window.removeEventListener("beforeunload", onBeforeUnload as never);
  }, [dirty]);

  const setConflict = (current: number | null) => setConflictState({ current, atLoad: loads.current });

  return {
    state,
    conflict: conflict ? { current: conflict.current } : null,
    latest: () => ref.current,
    init: (s) => setState((prev) => prev ?? s),
    edit: (fn) => setState((prev) => (prev ? { ...prev, draft: editDraft(prev.draft, fn(prev.draft.body)) } : prev)),
    replace: (fn) => setState((prev) => (prev ? fn(prev) : prev)),
    save: async (send) => {
      const snap = ref.current;
      if (!snap) return null;
      const sent = snap.draft;
      const r = await send(sent);
      // `typedSince` is decided HERE, at resolution, from the last RENDERED state
      // (every keystroke is a discrete event React renders synchronously, so the
      // ref already holds it) — never from a later read of state the save's own
      // update hasn't rendered yet. The updater below applies the same rule to
      // the state React actually commits.
      const atResolution = ref.current;
      const typedSince = atResolution !== null && !sameBody(atResolution.draft.body, sent.body);
      setState((prev) => (prev ? stateAfterSave(prev, sent.body, r) : prev));
      const o = saveOutcome(r);
      if (o.kind === "conflict") setConflict(o.current);
      return { ...o, typedSince };
    },
    liveChanged: (c) => setState((prev) => (prev ? stateAfterLiveChange(prev, c) : prev)),
    setConflict,
  };
}
