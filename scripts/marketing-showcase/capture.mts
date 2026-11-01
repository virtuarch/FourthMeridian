/**
 * scripts/marketing-showcase/capture.mts — screenshots the harness scenes.
 *
 *   node scripts/marketing-showcase/build.mts
 *   node scripts/marketing-showcase/capture.mts [shot-name …]   (Node 24, repo root)
 *
 * Serves tmp/marketing-showcase/ on a loopback port, drives headless Chrome over
 * the DevTools protocol (Node's built-in WebSocket; no Playwright), and writes
 * WebP frames to site/public/showcase/. Each shot is a scene + viewport +
 * optional crop height — see SHOTS.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "tmp", "marketing-showcase");
const DEST = process.env.SHOWCASE_OUT ?? path.join(ROOT, "site", "public", "showcase");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// DevTools-protocol payloads are loosely shaped JSON; this script reads only a
// few known fields from them.
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Cdp = (method: string, params?: Record<string, unknown>) => Promise<Json>;
export interface Shot {
  name: string;
  scene: string;
  /** CSS-pixel viewport width (the scene lays out inside it). */
  width: number;
  dpr?: number;
  /** Clip the frame to this many CSS pixels from the top (a crop). */
  height?: number;
  quality?: number;
}

/* ── The capture list: one entry per WebP frame in site/public/showcase/ ──────
 * `scene` is the harness hash (scenes.tsx). Frames shown together in one loop
 * share a width AND a height, so the site stacks them in one fixed-aspect box
 * (no layout shift between frames). */
const NW = "scene=net-worth&detail=0";
const SPEND = "scene=spending&period=PAST_QUARTER&hide=spending-distribution,spending-insights";
const SHOTS: Shot[] = [
  // Personal Space — Net Worth, two periods (the period picker is the story).
  { name: "net-worth-1y", scene: `${NW}&range=PAST_YEAR`, width: 1088, height: 720, quality: 82 },
  { name: "net-worth-3m", scene: `${NW}&range=PAST_QUARTER`, width: 1088, height: 720, quality: 82 },
  { name: "net-worth-1y-m", scene: `${NW}&range=PAST_YEAR`, width: 390, height: 760, dpr: 2, quality: 82 },
  { name: "net-worth-3m-m", scene: `${NW}&range=PAST_QUARTER`, width: 390, height: 760, dpr: 2, quality: 82 },
  // Cash Flow — liquidity month, then the spending quarter heat map.
  { name: "cash-flow-month", scene: "scene=cash-flow", width: 1088, height: 900, quality: 82 },
  { name: "spending-quarter", scene: SPEND, width: 1088, height: 900, quality: 82 },
  { name: "cash-flow-month-m", scene: "scene=cash-flow", width: 390, height: 900, dpr: 2, quality: 82 },
  { name: "spending-quarter-m", scene: SPEND, width: 390, height: 900, dpr: 2, quality: 82 },
  // Conversations — the question, then the grounded answer.
  { name: "conversation-question", scene: "scene=conversation&stage=question&h=600", width: 1088, height: 648, quality: 82 },
  { name: "conversation-answer", scene: "scene=conversation&h=600", width: 1088, height: 648, quality: 82 },
  { name: "conversation-question-m", scene: "scene=conversation&stage=question&h=900", width: 390, height: 940, dpr: 2, quality: 82 },
  { name: "conversation-answer-m", scene: "scene=conversation&h=900", width: 390, height: 940, dpr: 2, quality: 82 },
  // Connections — one still per layout.
  { name: "connections", scene: "scene=connections", width: 1088, quality: 82 },
  { name: "connections-m", scene: "scene=connections", width: 390, dpr: 2, quality: 82 },
];

const wanted = new Set(process.argv.slice(2));
const shots = SHOTS.filter((s) => wanted.size === 0 || wanted.has(s.name));
console.log(`[showcase] ${shots.length} shot(s) → ${DEST}`);

const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = createServer((req, res) => {
  const p = path.join(SRC, decodeURIComponent((req.url ?? "/").split("?")[0].split("#")[0]).replace(/^\/$/, "/index.html"));
  if (!p.startsWith(SRC)) { res.writeHead(403).end(); return; }
  let body: Buffer;
  try { body = readFileSync(p); } catch { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": TYPES[path.extname(p)] ?? "application/octet-stream" }).end(body);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;

const profile = mkdtempSync(path.join(tmpdir(), "fm-showcase-"));
const chrome = spawn(CHROME, [
  "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--mute-audio",
  "--disable-extensions", "--disable-gpu", "--font-render-hinting=none", "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
const wsUrl: string = await new Promise((resolve, reject) => {
  let buf = "";
  chrome.stderr!.on("data", (d) => { buf += d; const m = buf.match(/ws:\/\/[^\s]+/); if (m) resolve(m[0]); });
  chrome.on("exit", () => reject(new Error(`chrome exited: ${buf}`)));
});

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
const listeners: ((m: Json) => void)[] = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(String(ev.data));
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id)!; pending.delete(m.id);
    if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
  } else listeners.forEach((l) => l(m));
});
const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
  new Promise<Json>((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, sessionId })); });

mkdirSync(DEST, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
for (const shot of shots) {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const cdp: Cdp = (m, p) => send(m, p, sessionId);
  const evalJs = async (expression: string) => {
    const r = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`${shot.name}: ${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
    return r.result.value;
  };
  const errors: string[] = [];
  listeners.push((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? "exception");
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a: Json) => a.value ?? a.description).join(" "));
  });
  try {
    await cdp("Runtime.enable");
    await cdp("Page.enable");
    await cdp("Emulation.setDeviceMetricsOverride", { width: shot.width, height: 900, deviceScaleFactor: shot.dpr ?? 2, mobile: false });
    await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await cdp("Page.navigate", { url: `http://127.0.0.1:${port}/index.html#${shot.scene}` });
    for (let i = 0; i < 100 && !(await evalJs("document.body?.dataset.ready === '1'").catch(() => false)); i++) await sleep(100);
    await sleep(250);
    // Frames of one loop share a height: pad a shorter scene down to it.
    if (shot.height) await evalJs(`document.querySelector('[data-capture]').style.minHeight = '${shot.height}px'`);
    const box = await evalJs(`(() => { const b = document.querySelector('[data-capture]').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
    const { data } = await cdp("Page.captureScreenshot", {
      format: "webp", quality: shot.quality ?? 86, captureBeyondViewport: true,
      clip: { ...box, height: shot.height ? Math.min(box.height, shot.height) : box.height, scale: 1 },
    });
    const file = path.join(DEST, `${shot.name}.webp`);
    writeFileSync(file, Buffer.from(data, "base64"));
    const kb = (Buffer.from(data, "base64").length / 1024).toFixed(0);
    console.log(`  ✓ ${shot.name}  ${Math.round(box.width)}×${Math.round(shot.height ? Math.min(box.height, shot.height) : box.height)} css @${shot.dpr ?? 2}x  ${kb} KB${errors.length ? `  ⚠ ${errors.join(" | ").slice(0, 300)}` : ""}`);
    if (errors.length) failed++;
  } catch (e) {
    failed++; console.error(`  ✗ ${shot.name}: ${(e as Error).message.slice(0, 200)}${errors.length ? `\n    page: ${errors.join(" | ").slice(0, 1200)}` : ""}`);
  } finally {
    await send("Target.closeTarget", { targetId }).catch(() => {});
  }
}
ws.close(); server.close();
await new Promise((r) => { chrome.once("exit", r); chrome.kill(); });
rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
process.exit(failed ? 1 : 0);
