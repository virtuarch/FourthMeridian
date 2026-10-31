/**
 * components/platform/comms/content-editor-state.test.ts  (Customer Success — Communications Center › content editor state, async)
 *
 * The editor's REAL state hooks under the repo's DOM-less harness (the recipe of
 * components/space/shell/space-history.test.ts: a React root on a stub
 * container, rendering null, so only hooks + effects run):
 *
 *   a. start a save, type, the save resolves 409 ⇒ the newly typed text is still there;
 *   b. after a conflict the reload FAILS (503) ⇒ the last good stream is kept (the
 *      panel keeps the editor mounted), the draft and the conflict are untouched;
 *      the next SUCCESSFUL reload rebases (same text, new revision);
 *   c. start a save, type, the save succeeds ⇒ the typed text survives, dirty,
 *      now based on the saved version;
 *   d. a publish landing while the operator has unsaved text never clobbers it;
 *   e. beforeunload is guarded exactly while the draft is dirty.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/comms/content-editor-state.test.ts
 */

import { createElement, act } from "react";
import type { ContentBody, TemplateVersionDTO, VersionsResponse } from "@/lib/notifications/content/types";
import type { CommsReadResult } from "@/lib/platform/comms-center/client";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ""}`); }
}

// ── stub DOM (the repo has no DOM environment) ───────────────────────────────
const g = globalThis as unknown as Record<string, unknown>;
const listeners = new Map<string, Set<unknown>>();
const doc = { nodeType: 9, activeElement: null, addEventListener() {}, removeEventListener() {}, documentElement: {} };
g.document = doc;
g.window = globalThis;
g.HTMLIFrameElement = class {};
g.IS_REACT_ACT_ENVIRONMENT = true;
g.addEventListener = (t: string, fn: unknown) => { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t)!.add(fn); };
g.removeEventListener = (t: string, fn: unknown) => { listeners.get(t)?.delete(fn); };

// ── a controllable fetch for the stream read ─────────────────────────────────
const responses: Array<{ status: number; body: unknown }> = [];
g.fetch = async () => {
  const r = responses.shift() ?? { status: 503, body: { error: "down", code: "UNAVAILABLE" } };
  return { status: r.status, json: async () => r.body };
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const BODY: ContentBody = { subject: "Sync failed for {{institutionName}}", preheader: "Reconnect", blocks: [{ kind: "paragraph", text: "Hello." }] };

function version(id: string, n: number, revision: number, body: ContentBody, state: TemplateVersionDTO["state"] = "DRAFT"): TemplateVersionDTO {
  return {
    id, version: n, state, subject: body.subject, preheader: body.preheader, blocks: body.blocks, placeholdersUsed: [],
    createdBy: { kind: "OPERATOR", actorKind: "PLATFORM_OPERATOR" }, createdAt: "2026-10-31T12:00:00.000Z", publishedAt: null, auditLogId: "a", revision,
    stream: { definitionKey: "SYNC_FAILED", channel: "EMAIL", variant: "sync-failed" }, publishAuditLogId: null, parentVersionId: null,
    basePublishedVersionId: null, restoredFromVersionId: null, sourceSuggestionId: null, aiEditedAfterAccept: null, issues: [],
  };
}

function stream(revision: number): VersionsResponse {
  return {
    items: [], checkedAt: "2026-10-31T12:00:00.000Z", nextCursor: null, limit: 50, floor: false, capped: false,
    stream: { definitionKey: "SYNC_FAILED", channel: "EMAIL", variant: "sync-failed" }, revision, live: { source: "CODE_DEFAULT" },
    codeDefault: { ...BODY, placeholdersUsed: ["institutionName"] }, placeholders: [], limits: { blocks: 12, subject: 120, preheader: 140, paragraph: 1200, ctaLabel: 40 },
    contentEditable: true, locked: null, viewer: {} as never, ai: { available: false, reason: "KILL_SWITCH", checkedAt: "2026-10-31T12:00:00.000Z" },
  };
}

async function main() {
  const { createRoot } = await import("react-dom/client");
  const { useContentDraft } = await import("./use-content-draft");
  const { useLastGoodRead } = await import("./comms-kit");
  const { draftFrom, setField } = await import("./content-model");
  type Api = ReturnType<typeof useContentDraft>;
  type Read = ReturnType<typeof useLastGoodRead<VersionsResponse>>;

  const container = () => ({ nodeType: 1, nodeName: "DIV", tagName: "DIV", ownerDocument: doc, addEventListener() {}, removeEventListener() {}, childNodes: [], firstChild: null, appendChild() {}, removeChild() {} });
  const typeSubject = (api: Api, text: string) => api.edit((b) => setField(b, { field: "subject" }, text));

  // ── a + c: the save harness (the draft hook alone) ──
  let api!: Api;
  function SaveHarness() {
    api = useContentDraft(() => ({ draft: draftFrom(BODY, null, 3), base: null }), { loadCount: 1, revision: 3 });
    return null;
  }

  console.log("a. start a save, type, resolve 409 ⇒ the new text is still present");
  {
    const root = createRoot(container() as never);
    await act(async () => root.render(createElement(SaveHarness)));
    await act(async () => typeSubject(api, "First edit {{institutionName}}"));
    const pending = deferred<CommsReadResult<{ result: TemplateVersionDTO }>>();
    let sentBody: ContentBody | null = null;
    let saving!: Promise<unknown>;
    await act(async () => { saving = api.save(async (sent) => { sentBody = sent.body; return pending.promise; }); });
    await act(async () => typeSubject(api, "Typed while saving {{institutionName}}"));
    await act(async () => { pending.resolve({ kind: "error", status: 409, code: "CONFLICT", error: "Stale.", current: 4 }); await saving; });
    check("the request carried the text at the click", (sentBody as ContentBody | null)?.subject === "First edit {{institutionName}}");
    check("after the 409 the text typed DURING the request is still in the editor", api.state?.draft.body.subject === "Typed while saving {{institutionName}}", api.state?.draft.body.subject);
    check("still dirty, revision untouched until a reload, conflict raised with the server's token", api.state?.draft.dirty === true && api.state.draft.revision === 3 && api.conflict?.current === 4);
    await act(async () => root.unmount());
  }

  console.log("c. start a save, type, resolve success ⇒ the typed text survives and the editor shows dirty");
  {
    const root = createRoot(container() as never);
    await act(async () => root.render(createElement(SaveHarness)));
    await act(async () => typeSubject(api, "Saved text {{institutionName}}"));
    const pending = deferred<CommsReadResult<{ result: TemplateVersionDTO }>>();
    let saving!: Promise<unknown>;
    let sent!: ContentBody;
    await act(async () => { saving = api.save(async (d) => { sent = d.body; return pending.promise; }); });
    await act(async () => typeSubject(api, "Newer text {{institutionName}}"));
    await act(async () => { pending.resolve({ kind: "ok", data: { result: version("v5", 5, 4, sent) } }); await saving; });
    check("the newer typing survives the success", api.state?.draft.body.subject === "Newer text {{institutionName}}", api.state?.draft.body.subject);
    check("dirty, based on the saved v5 at its revision, base = v5", api.state?.draft.dirty === true && api.state.draft.parentVersionId === "v5" && api.state.draft.revision === 4 && api.state.base?.id === "v5");
    // Control: a save with NO typing in flight lands clean.
    const p2 = deferred<CommsReadResult<{ result: TemplateVersionDTO }>>();
    let s2!: Promise<unknown>;
    let sent2!: ContentBody;
    await act(async () => { s2 = api.save(async (d) => { sent2 = d.body; return p2.promise; }); });
    await act(async () => { p2.resolve({ kind: "ok", data: { result: version("v6", 6, 5, sent2) } }); await s2; });
    check("control: nothing typed in flight ⇒ clean on v6", api.state?.draft.dirty === false && api.state.draft.parentVersionId === "v6" && api.state.draft.body.subject === "Newer text {{institutionName}}");

    console.log("d. a publish landing over unsaved text never clobbers it");
    await act(async () => typeSubject(api, "Unsaved again {{institutionName}}"));
    await act(async () => api.liveChanged({ revision: 9, published: version("v6", 6, 9, sent2, "PUBLISHED"), body: sent2 }));
    check("text kept, still dirty, revision moved to 9", api.state?.draft.body.subject === "Unsaved again {{institutionName}}" && api.state.draft.dirty && api.state.draft.revision === 9);

    console.log("e. beforeunload while dirty");
    check("a beforeunload guard is registered while dirty", (listeners.get("beforeunload")?.size ?? 0) === 1);
    await act(async () => api.replace((s) => ({ ...s, draft: draftFrom(s.draft.body, s.draft.parentVersionId, s.draft.revision) })));
    check("…and removed once clean", (listeners.get("beforeunload")?.size ?? 0) === 0);
    await act(async () => root.unmount());
  }

  console.log("b. reload fails after a conflict ⇒ the editor stays mounted with the text");
  {
    let read!: Read;
    function PanelHarness() {
      // ContentPanel's composition: the last good stream read feeds the draft hook.
      read = useLastGoodRead<VersionsResponse>("/api/platform/customer-success/notifications/catalog/SYNC_FAILED/versions?channel=EMAIL");
      const data = read.data;
      api = useContentDraft(() => null, { loadCount: read.loads, revision: data?.revision ?? 0 });
      if (data && !api.state) api.init({ draft: draftFrom(BODY, null, data.revision), base: null });
      return null;
    }
    responses.push({ status: 200, body: stream(1) });
    const root = createRoot(container() as never);
    await act(async () => root.render(createElement(PanelHarness)));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    check("first read lands; the editor's mount condition (data) holds", read.data?.revision === 1 && read.loads === 1 && api.state?.draft.revision === 1, { loads: read.loads });
    await act(async () => typeSubject(api, "My work {{institutionName}}"));
    await act(async () => { await api.save(async () => ({ kind: "error", status: 409, code: "CONFLICT", error: "Stale.", current: 2 })); });
    check("conflict raised", api.conflict?.current === 2);

    responses.push({ status: 503, body: { error: "The notification content is unavailable.", code: "UNAVAILABLE" } });
    await act(async () => { read.read.retry?.(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    check("the reload failed (503) and is reported", read.failure !== null && !read.read.loading && read.read.result?.kind === "unavailable");
    check("the last good stream is KEPT ⇒ ContentPanel keeps the editor mounted", read.data !== null && read.data.revision === 1);
    check("draft text untouched, revision NOT rebased, conflict still open", api.state?.draft.body.subject === "My work {{institutionName}}" && api.state.draft.revision === 1 && api.conflict !== null);

    responses.push({ status: 200, body: stream(2) });
    await act(async () => { read.read.retry?.(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    check("a SUCCESSFUL reload rebases: same text, revision 2, conflict cleared", api.state?.draft.body.subject === "My work {{institutionName}}" && api.state.draft.revision === 2 && api.conflict === null && api.state.draft.dirty,
      { rev: api.state?.draft.revision, conflict: api.conflict, loads: read.loads });
    await act(async () => root.unmount());
  }

  if (failures > 0) { console.error(`\ncontent-editor-state.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\ncontent-editor-state.test: all passed.");
}

void main();
