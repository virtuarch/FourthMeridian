/**
 * components/platform/platform-ai-history.test.ts  (Platform AI conversations — parity PR4: history)
 *
 * The REAL orchestrator (PlatformAiConversations) on a stub React root — the
 * repo has no DOM, so the view is replaced through the component's `View` test
 * seam by a component that records its props and renders null (the
 * components/space/shell/space-history.test.ts technique). Around it: a model
 * of window.history / location / popstate that records every write and its
 * state argument, a fake same-origin API (synthetic ids and text only), and
 * spying localStorage / sessionStorage.
 *
 *   A. deep link: `?c=<id>` opens that thread on load, refresh and a new session; no write
 *   B. no `?c=`: the latest thread opens and the URL is normalised (REPLACE)
 *   C. unknown / foreign / malformed id ⇒ the IDENTICAL not-found, REPLACE to the cleared URL
 *   D. opening a thread PUSHES; Back / Forward re-open without writing
 *   E. New chat PUSHES the cleared URL (`?c=` removed); Back returns to the thread
 *   F. delete the open thread ⇒ the next most recent opens (REPLACE); the last ⇒ empty (REPLACE)
 *   G. a new conversation's first answer normalises the URL to its id (REPLACE)
 *   H. no empty-state flash: every state before the thread arrives renders the conversation layout
 *   I. every write passes `null` state (Next 16 `__NA`); only the rail key is ever stored
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/platform-ai-history.test.ts
 */

import { createElement, act } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// ── the browser model ───────────────────────────────────────────────────────
type Entry = { url: string; state: unknown };
const listeners = new Map<string, Set<(e: unknown) => void>>();
const g = globalThis as unknown as Record<string, unknown>;
const doc = { nodeType: 9, activeElement: null, addEventListener() {}, removeEventListener() {}, documentElement: {} };
g.document = doc;
g.window = globalThis;
g.HTMLIFrameElement = class {};
g.IS_REACT_ACT_ENVIRONMENT = true;
g.addEventListener = (t: string, fn: (e: unknown) => void) => { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t)!.add(fn); };
g.removeEventListener = (t: string, fn: (e: unknown) => void) => listeners.get(t)?.delete(fn);

const BASE = "http://localhost";
const PATH = "/dashboard/platform/ai";
let entries: Entry[] = [];
let index = 0;
const writes: { kind: "push" | "replace"; url: string; state: unknown }[] = [];
const cur = () => new URL(entries[index].url, BASE);
Object.defineProperty(g, "location", {
  configurable: true,
  get: () => { const u = cur(); return { pathname: u.pathname, search: u.search, hash: u.hash, href: u.href }; },
});
const rel = (u: string) => { const x = new URL(u, BASE); return x.pathname + x.search + x.hash; };
const history = {
  get length() { return entries.length; },
  get state() { return entries[index].state; },
  pushState(state: unknown, _t: string, url: string) {
    writes.push({ kind: "push", url: rel(url), state });
    entries = entries.slice(0, index + 1); entries.push({ url: rel(url), state }); index = entries.length - 1;
  },
  replaceState(state: unknown, _t: string, url: string) {
    writes.push({ kind: "replace", url: rel(url), state });
    entries[index] = { url: rel(url), state };
  },
  back() { go(-1); },
  forward() { go(1); },
};
g.history = history;
function go(delta: number) {
  const target = index + delta;
  if (target < 0 || target >= entries.length) throw new Error(`history.go(${delta}) leaves the document`);
  index = target;
  for (const fn of listeners.get("popstate") ?? []) fn({ state: entries[index].state });
}

// Spying storage: everything written is recorded.
const stored: { area: string; key: string; value: string }[] = [];
const storage = (area: string) => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { stored.push({ area, key: k, value: String(v) }); m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
    key: () => null,
    get length() { return m.size; },
  };
};
g.localStorage = storage("local");
g.sessionStorage = storage("session");

// ── the fake API (synthetic) ────────────────────────────────────────────────
const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
type Conv = { id: string; label: string; lastActivityAt: string; owner: "me" | "other" };
let store: Conv[] = [];
const fetched: string[] = [];
function resetStore() {
  store = [
    { id: "cnewest00000000000000001", label: "Synthetic newest question", lastActivityAt: iso(60_000), owner: "me" },
    { id: "cmiddle00000000000000002", label: "Synthetic middle question", lastActivityAt: iso(3_600_000), owner: "me" },
    { id: "coldest00000000000000003", label: "Synthetic oldest question", lastActivityAt: iso(3 * 86_400_000), owner: "me" },
    { id: "cforeign0000000000000009", label: "Someone else's question", lastActivityAt: iso(120_000), owner: "other" },
  ];
}
const wire = (c: Conv) => ({ id: c.id, area: "PLATFORM_OPS", areaLabel: "Platform Operations", createdAt: c.lastActivityAt, lastActivityAt: c.lastActivityAt, label: c.label, messageCount: 2, full: false });
const msg = (id: string, role: "USER" | "ASSISTANT", content: unknown, at: string) =>
  ({ id, role, status: "COMPLETE", createdAt: at, completedAt: at, content, citations: [], notes: [], failureCode: null, unavailable: false, stale: role === "ASSISTANT" });
const NOT_FOUND = { status: 404, body: { error: "Not found.", code: "NOT_FOUND" } };
function route(method: string, url: string, body: unknown): { status: number; body: unknown } {
  const mine = store.filter((c) => c.owner === "me").sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  if (url === "/api/platform/ai/conversations" && method === "GET") return { status: 200, body: { conversations: mine.map(wire), limits: { conversations: { used: mine.length, max: 50 } } } };
  if (url === "/api/platform/ai/conversations" && method === "POST") {
    const c: Conv = { id: "ccreated0000000000000004", label: (body as { question: string }).question, lastActivityAt: new Date(NOW).toISOString(), owner: "me" };
    store.push(c);
    return { status: 201, body: { conversation: wire(c), userMessage: msg("m-u-new", "USER", c.label, c.lastActivityAt), assistantMessage: { ...msg("m-a-new", "ASSISTANT", [{ kind: "text", text: "Synthetic answer." }], c.lastActivityAt), stale: false } } };
  }
  const m = url.match(/^\/api\/platform\/ai\/conversations\/([^/]+)$/);
  if (m) {
    const c = store.find((x) => x.id === decodeURIComponent(m[1]) && x.owner === "me"); // foreign ⇒ the same 404 as unknown
    if (!c) return NOT_FOUND;
    if (method === "DELETE") { store = store.filter((x) => x !== c); return { status: 204, body: null }; }
    return { status: 200, body: { conversation: wire(c), messages: [msg(`${c.id}-u`, "USER", c.label, c.lastActivityAt), msg(`${c.id}-a`, "ASSISTANT", [{ kind: "text", text: "Synthetic answer." }], c.lastActivityAt)] } };
  }
  return { status: 500, body: null };
}
g.fetch = async (url: string, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  fetched.push(`${method} ${url}`);
  const r = route(method, url, init?.body ? JSON.parse(String(init.body)) : null);
  return { status: r.status, json: async () => r.body };
};

async function main(): Promise<void> {
  const { createRoot } = await import("react-dom/client");
  const { PlatformAiConversations, PlatformAiConversationsView } = await import("./PlatformAiConversations");
  const { NOT_FOUND_COPY, RAIL_COLLAPSED_KEY } = await import("./platform-ai-conversations-model");
  type Props = Parameters<typeof PlatformAiConversationsView>[0];

  let props!: Props;
  const snapshots: Props[] = [];
  function Capture(p: Props) { props = p; snapshots.push(p); return null; }

  let root: ReturnType<typeof createRoot> | null = null;
  const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  /** A fresh document load (refresh / new tab / new session) at `url`, after one foreign entry. */
  async function load(url: string, keepStore = false) {
    if (root) await act(async () => root!.unmount());
    if (!keepStore) resetStore();
    entries = [{ url: "/dashboard/spaces", state: null }, { url, state: null }];
    index = 1; writes.length = 0; fetched.length = 0; snapshots.length = 0;
    const container = { nodeType: 1, nodeName: "DIV", tagName: "DIV", ownerDocument: doc, addEventListener() {}, removeEventListener() {}, childNodes: [], firstChild: null, appendChild() {}, removeChild() {} };
    root = createRoot(container as never);
    await act(async () => root!.render(createElement(PlatformAiConversations, { areaLabel: "Platform Operations", View: Capture })));
    await flush();
  }
  const step = async (fn: () => void) => { await act(async () => fn()); await flush(); };
  const url = () => rel(cur().href);
  const sel = () => props.selected?.conversation.id ?? null;
  const render = (p: Props) => renderToStaticMarkup(createElement(PlatformAiConversationsView, p));

  let failures = 0;
  function check(name: string, cond: boolean, detail?: unknown): void {
    if (cond) console.log(`  ✓ ${name}`);
    else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
  }

  console.log("A. deep link — ?c=<id> reopens the same thread on load, refresh and a new session");
  {
    await load(`${PATH}?c=cmiddle00000000000000002`);
    check("the thread named by ?c= is open (not the latest)", sel() === "cmiddle00000000000000002", sel());
    check("its messages are loaded from the server", props.selected?.messages.length === 2 && fetched.includes("GET /api/platform/ai/conversations/cmiddle00000000000000002"), fetched);
    check("opening from the URL writes nothing (the URL is already right)", writes.length === 0 && url() === `${PATH}?c=cmiddle00000000000000002`, writes);
    await load(`${PATH}?c=cmiddle00000000000000002`, true);
    check("refresh / new session: the same thread again, still no write", sel() === "cmiddle00000000000000002" && writes.length === 0, { sel: sel(), writes });
    check("only the opaque id is in the URL (no title, question or area)", cur().search === "?c=cmiddle00000000000000002" && !/Synthetic|PLATFORM_OPS|Platform/.test(url()));
  }

  console.log("\nB. no ?c= — the latest opens and the URL is normalised (REPLACE)");
  {
    await load(PATH);
    check("the latest conversation opens", sel() === "cnewest00000000000000001", sel());
    check("one REPLACE to ?c=<latest>; no new History entry", writes.length === 1 && writes[0].kind === "replace" && writes[0].url === `${PATH}?c=cnewest00000000000000001` && history.length === 2, writes);
  }

  console.log("\nC. unknown / foreign / malformed id ⇒ the identical not-found + REPLACE to the cleared URL");
  {
    const finals: string[] = [];
    for (const [name, q] of [["unknown", "cunknown0000000000000000"], ["foreign", "cforeign0000000000000009"], ["malformed", "%3Cscript%3E"]] as const) {
      await load(`${PATH}?c=${q}`);
      check(`${name}: nothing selected and the not-found line shows`, sel() === null && props.problem?.kind === "NOT_FOUND" && props.problem.text === NOT_FOUND_COPY, props.problem);
      check(`${name}: exactly one REPLACE to the cleared URL (no push, no new entry)`,
        writes.length === 1 && writes[0].kind === "replace" && writes[0].url === PATH && history.length === 2, writes);
      check(`${name}: the latest thread is NOT opened in its place`, !fetched.includes("GET /api/platform/ai/conversations/cnewest00000000000000001"), fetched);
      finals.push(render({ ...props, now: new Date(NOW) }));
    }
    check("unknown, foreign and malformed render byte-identical pages (no existence oracle)", finals[0] === finals[1] && finals[1] === finals[2]);
    check("the malformed value never reaches the API", !fetched.some((f) => /%3C|<script/i.test(f)), fetched);
  }

  console.log("\nD. opening a thread PUSHES; Back / Forward re-open without writing");
  {
    await load(PATH);
    writes.length = 0;
    await step(() => props.onSelect("coldest00000000000000003"));
    check("select ⇒ one PUSH of ?c=<id>", writes.length === 1 && writes[0].kind === "push" && url() === `${PATH}?c=coldest00000000000000003` && history.length === 3, writes);
    check("…and that thread is open", sel() === "coldest00000000000000003");
    await step(() => props.onSelect("cmiddle00000000000000002"));
    writes.length = 0;
    await step(() => history.back());
    check("Back ⇒ the previous thread, no write", sel() === "coldest00000000000000003" && writes.length === 0, { sel: sel(), writes });
    await step(() => history.back());
    check("Back again ⇒ the latest (the normalised load entry), no write", sel() === "cnewest00000000000000001" && writes.length === 0, { sel: sel(), writes });
    await step(() => history.forward());
    check("Forward ⇒ the thread again, no write", sel() === "coldest00000000000000003" && writes.length === 0, { sel: sel(), writes });
  }

  console.log("\nE. New chat PUSHES the cleared URL; Back returns to the thread");
  {
    await load(`${PATH}?c=cmiddle00000000000000002`);
    await step(() => props.onNew());
    check("New chat ⇒ one PUSH of the URL without ?c=", writes.length === 1 && writes[0].kind === "push" && url() === PATH && history.length === 3, writes);
    check("…the empty composer (nothing selected, no problem line)", sel() === null && props.problem === null);
    writes.length = 0;
    await step(() => history.back());
    check("Back ⇒ the thread reopens, no write", sel() === "cmiddle00000000000000002" && writes.length === 0, { sel: sel(), writes });
    await step(() => history.forward());
    check("Forward ⇒ the cleared state again (not the latest), no write", sel() === null && writes.length === 0, { sel: sel(), writes });
  }

  console.log("\nF. delete the open thread ⇒ the next most recent (REPLACE); the last ⇒ empty (REPLACE)");
  {
    await load(`${PATH}?c=cnewest00000000000000001`);
    const pick = (id: string) => props.conversations!.find((c) => c.id === id)!;
    // Delete a thread that is NOT open: no History write, the selection stays.
    await step(() => props.onAskDelete(pick("coldest00000000000000003")));
    await step(() => props.onConfirmDelete());
    check("deleting another thread: no History write, the open thread stays", writes.length === 0 && sel() === "cnewest00000000000000001", { writes, sel: sel() });
    await step(() => props.onAskDelete(pick("cnewest00000000000000001")));
    await step(() => props.onConfirmDelete());
    check("deleting the open thread opens the next most recent", sel() === "cmiddle00000000000000002", sel());
    check("…with ONE REPLACE (no push; Back cannot return to the deleted id)",
      writes.length === 1 && writes[0].kind === "replace" && url() === `${PATH}?c=cmiddle00000000000000002` && history.length === 2, writes);
    check("…and no not-found line", props.problem === null);
    writes.length = 0;
    await step(() => props.onAskDelete(pick("cmiddle00000000000000002")));
    await step(() => props.onConfirmDelete());
    check("deleting the last thread ⇒ the empty state, ONE REPLACE to the cleared URL",
      sel() === null && writes.length === 1 && writes[0].kind === "replace" && url() === PATH && history.length === 2 && props.problem === null, { writes, sel: sel() });
    check("…and the list is empty (the empty state, not a skeleton)", props.conversations?.length === 0 && /data-ai-layout="empty"/.test(render(props)));
  }

  console.log("\nG. a new conversation's first answer normalises the URL to its id (REPLACE)");
  {
    await load(PATH);
    await step(() => props.onNew());
    writes.length = 0;
    await step(() => props.onStarter("Synthetic starter question"));
    check("the created conversation is open", sel() === "ccreated0000000000000004", sel());
    check("ONE REPLACE to ?c=<new id> (Back still returns to the previous thread)",
      writes.length === 1 && writes[0].kind === "replace" && url() === `${PATH}?c=ccreated0000000000000004`, writes);
  }

  console.log("\nH. no empty-state flash while the list / thread load");
  {
    await load(`${PATH}?c=cmiddle00000000000000002`);
    const before = snapshots.filter((p) => p.selected === null);
    check("there were loading states before the thread arrived", before.length >= 1);
    check("every one renders the conversation layout with a skeleton — never the empty state or 'No conversations yet.'",
      before.every((p) => { const h = render(p); return /data-ai-layout="conversation"/.test(h) && /data-platform-ai-thread-loading/.test(h) && !/data-platform-ai-empty|No conversations yet\./.test(h); }));
    await load(PATH);
    const beforeLatest = snapshots.filter((p) => p.selected === null);
    check("the same with no ?c= (list, then the latest thread)",
      beforeLatest.length >= 1 && beforeLatest.every((p) => { const h = render(p); return /data-ai-layout="conversation"/.test(h) && !/data-platform-ai-empty/.test(h); }));
  }

  console.log("\nI. History writes use null state; nothing but the rail state is ever stored");
  {
    // Exercise the rail once so the one allowed key is written.
    await step(() => props.onRail(true));
    check("every History write in this run passed null state (Next 16 __NA rule)", writes.every((w) => w.state === null), writes);
    check("sessionStorage was never written", !stored.some((s) => s.area === "session"), stored);
    check("localStorage holds only the rail key", stored.length > 0 && stored.every((s) => s.area === "local" && s.key === RAIL_COLLAPSED_KEY && /^[01]$/.test(s.value)), stored);
    check("no conversation id or content in any stored key or value", !stored.some((s) => /^c[a-z]+0{4,}|Synthetic/.test(s.key + s.value)));
  }

  if (root) await act(async () => root!.unmount());
  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
  process.exit(0);
}

void main();
