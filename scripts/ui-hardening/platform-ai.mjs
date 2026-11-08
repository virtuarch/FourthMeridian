// Platform AI conversation scene (parity PR5/PR6): the same viewport sweep as the
// Personal AI fixture in browser.mjs, against the real PlatformAiConversationsView
// rendered with fabricated data (scripts/ui-hardening/platform-ai-scene.tsx).
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const { chromium } = createRequire(path.resolve(process.env.FM_UI_BROWSER_TOOLS || '/tmp/fm-ui-browser', 'package.json'))('playwright');
const base = 'http://127.0.0.1:4179';
const evidence = path.resolve(process.cwd(), process.env.FM_UI_EVIDENCE_DIR || 'tmp/ui-hardening-evidence');
fs.mkdirSync(evidence, { recursive: true });
const sizes = [[320,568],[360,640],[375,688],[375,812],[390,844],[430,932],[600,900],[639,700],[640,700],[768,1024],[820,1180],[844,390],[1023,768],[1024,768],[1025,768],[1280,800],[1366,768],[1440,900],[1728,1117],[1920,1080],[2560,1440]];
const shots = [375, 390, 768, 1024, 1280, 1920];
const LG = 1024, SM = 640;
// The owner-approved OD-5 wording, read from the model constant (pinned by the unit tests).
const OD5 = fs.readFileSync(path.resolve(process.cwd(), 'components/platform/platform-ai-conversations-model.ts'), 'utf8')
  .match(/PLATFORM_AI_CONVERSATIONS_DISCLOSURE =\s*"([^"]+)"/)[1];
// Keyboard-open geometries (visual viewport ~440-480 px tall on a phone).
const KEYBOARD_OPEN = [[320,440],[320,480],[360,440],[375,440],[390,440]];
const STARTERS = 6;
const textOf = (loc) => loc.evaluate((el) => el.textContent.replace(/\s+/g, ' ').trim());
/**
 * S2 C1–C4: the short line is visible beneath the composer at every width (never
 * truncated: its text fits its box), the "Privacy & retention" button is reachable by
 * keyboard and expands the FULL OD-5 text inline (no dialog, no scroll ancestor other
 * than the reading region, nothing clipped), focus stays on the button, and the full
 * text is always in the DOM as the box's aria-describedby target.
 */
async function disclosureLine(page, width, height, at, { expand = false } = {}) {
  const line = page.locator('[data-ai-dock] [data-platform-ai-line]');
  assert.equal(await line.count(), 1, 'one short line at ' + at);
  assert(await line.isVisible(), 'short line visible at ' + at);
  const b = await line.boundingBox();
  assert(inside(b, width) && b.y + b.height <= height - 40, 'short line on screen at ' + at + ' ' + JSON.stringify(b));
  assert(await line.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && getComputedStyle(el).textOverflow !== 'ellipsis'), 'short line not truncated at ' + at);
  assert.equal(await page.locator('#platform-ai-conversations-disclosure').count(), 1, 'OD-5 describedby target in the DOM at ' + at);
  assert.equal(await page.getByRole('textbox', { name: 'Ask Platform AI' }).getAttribute('aria-describedby'), 'platform-ai-privacy-hint platform-ai-conversations-disclosure');
  const toggle = page.locator('[data-platform-ai-notice-toggle]');
  assert(await toggle.isVisible(), 'Privacy & retention visible at ' + at);
  if (!expand) return;
  const wasOpen = (await toggle.getAttribute('aria-expanded')) === 'true';
  if (!wasOpen) { await toggle.focus(); await page.keyboard.press('Enter'); }
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'expands by keyboard at ' + at);
  assert(await toggle.evaluate((el) => document.activeElement === el) || wasOpen, 'focus stays on the control at ' + at);
  assert.equal(await page.getByRole('dialog').count(), 0, 'no dialog at ' + at);
  const notice = page.locator('#platform-ai-conversations-disclosure');
  assert(await notice.isVisible(), 'full notice visible at ' + at);
  assert.equal(await textOf(notice), OD5, 'OD-5 text identical at ' + at);
  const scrollers = await notice.evaluate((el) => { const out = []; for (let n = el; n && n !== document.documentElement; n = n.parentElement) { const cs = getComputedStyle(n); if (/(auto|scroll)/.test(cs.overflowY + ' ' + cs.overflowX)) out.push(n.hasAttribute('data-ai-scroll') ? 'log' : n.outerHTML.slice(0, 80)); } return out; });
  assert(scrollers.every((x) => x === 'log'), 'no scroll box around the notice at ' + at + ' ' + JSON.stringify(scrollers));
  if (!scrollers.length) {
    const shell = await page.locator('[data-ai-layout]').boundingBox(); const n = await notice.boundingBox();
    assert(n.y >= shell.y - 1 && n.y + n.height <= shell.y + shell.height + 1, 'footer notice not clipped at ' + at + ' ' + JSON.stringify({ n, shell }));
  }
  if (width === 375) await page.screenshot({ path: `${evidence}/platform-ai-375-notice-${wasOpen ? 'first' : 'expanded'}.png` });
  if (!wasOpen) { await toggle.click(); assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'collapses at ' + at); assert(!(await notice.isVisible()), 'hidden again at ' + at); }
}
/**
 * Scrolled to its end, the reading region shows every starter chip clear of the dock: no
 * chip's rect intersects the dock's painted rect (the dock box plus anything it paints
 * above itself — its fade), and the last chip can sit fully between the top of the reading
 * region and that painted top. Returns 'pass', or 'n/a' (with the room) where the reading
 * region left above the fade is shorter than one chip (a landscape phone), which no
 * padding can fix; the no-intersection rule still holds there.
 */
async function startersClearDock(page, at) {
  await page.locator('[data-ai-scroll]').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(50);
  const g = await page.evaluate(() => {
    const rect = (r) => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
    const dockEl = document.querySelector('[data-ai-dock]');
    const dock = rect(dockEl.getBoundingClientRect());
    for (const d of dockEl.querySelectorAll('*')) {
      const r = d.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) { dock.top = Math.min(dock.top, r.top); dock.bottom = Math.max(dock.bottom, r.bottom); dock.left = Math.min(dock.left, r.left); dock.right = Math.max(dock.right, r.right); }
    }
    const log = rect(document.querySelector('[data-ai-scroll]').getBoundingClientRect());
    const chips = [...document.querySelectorAll('[data-platform-ai-starters] button')].map((b) => rect(b.getBoundingClientRect()));
    return { dock, log, chips };
  });
  const hits = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  assert.equal(g.chips.length, STARTERS, 'six starter chips at ' + at);
  g.chips.forEach((c, i) => assert(!hits(c, g.dock), `starter ${i + 1} intersects the dock at ${at} ` + JSON.stringify({ chip: c, dock: g.dock })));
  const last = g.chips.reduce((m, c) => (c.bottom > m.bottom ? c : m));
  const room = Math.min(g.dock.top, g.log.bottom) - g.log.top;
  if (room < last.bottom - last.top) return `n/a (${Math.round(room)} px above the fade)`;
  // At the end it lies on or above the painted top; scrolling back by the gap brings it fully into view.
  assert(last.bottom <= g.dock.top + 0.5, 'last starter above the dock at the end at ' + at + ' ' + JSON.stringify({ last, dock: g.dock }));
  return 'pass';
}
const browser = await chromium.launch({ headless: true, ...(process.env.FM_UI_CHROME ? { executablePath: process.env.FM_UI_CHROME } : {}) });
const results = [];
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const inside = (b, width) => b && b.x >= -1 && b.x + b.width <= width + 1;
try {
  const page = await browser.newPage();
  for (const [width, height] of sizes) {
    const at = `${width}x${height}`;
    await page.setViewportSize({ width, height });

    // ── Thread ─────────────────────────────────────────────────────────────
    await page.goto(`${base}/?platform-ai`);
    await page.locator('[data-ai-dock]').waitFor();
    assert(await noOverflow(page), 'thread: horizontal overflow at ' + at);
    const dock = page.locator('[data-ai-dock]');
    const before = await dock.boundingBox();
    await page.locator('[data-ai-scroll]').evaluate((el) => { el.scrollTop = 0; });
    const after = await dock.boundingBox();
    assert.equal(before.y, after.y, 'composer stationary at ' + at);
    assert(before.y >= 0 && before.y + before.height <= height - 40, 'composer docked above the bottom bar at ' + at + ' ' + JSON.stringify(before));
    assert(inside(before, width), 'dock inside the viewport at ' + at);
    const box = page.getByRole('textbox', { name: 'Ask Platform AI' });
    assert(await box.isVisible(), 'composer visible at ' + at);
    assert.equal(await box.getAttribute('aria-describedby'), 'platform-ai-privacy-hint platform-ai-conversations-disclosure', 'describedby at ' + at);
    await disclosureLine(page, width, height, 'thread ' + at, { expand: height >= 560 });
    assert.equal(await page.locator('[data-platform-ai-counter]').count(), 0, 'no counter on an empty draft at ' + at);
    assert.equal(await page.getByRole('button', { name: /Stop/ }).count(), 0, 'no Stop at ' + at);

    // Header controls fit; "History" is sr-only below sm; exactly one New chat.
    const header = page.locator('[data-platform-ai-conversations] header');
    assert(await header.evaluate((h) => h.scrollWidth <= h.clientWidth + 1), 'header controls fit at ' + at);
    assert.equal(await page.getByRole('button', { name: 'New chat' }).count(), 1, 'one New chat at ' + at);
    for (const b of await header.locator('button').all()) {
      if (await b.isVisible()) assert(inside(await b.boundingBox(), width), 'header control inside the viewport at ' + at);
    }
    const toggle = page.locator('[data-platform-ai-sheet-toggle]');
    const rail = page.locator('[data-platform-ai-rail]');
    if (width < LG) {
      assert(await toggle.isVisible(), 'sheet toggle visible below lg at ' + at);
      assert(!(await rail.isVisible()), 'rail hidden below lg at ' + at);
      const label = await toggle.locator('span').last().boundingBox();
      if (width < SM) assert(label.width <= 1 && label.height <= 1, '"History" label sr-only below sm at ' + at);
      else assert(label.width > 20, '"History" label visible at sm+ at ' + at);
      await toggle.click();
      const sheet = page.getByRole('dialog', { name: 'Conversation history' });
      await sheet.waitFor();
      await page.waitForTimeout(350);
      const s = await sheet.boundingBox();
      assert(s.x >= -1 && s.y >= -1 && s.x + s.width <= width + 1 && s.y + s.height <= height + 1, 'sheet inside the viewport at ' + at + ' ' + JSON.stringify(s));
      assert(await sheet.locator('[data-platform-ai-conversation-list]').isVisible(), 'sheet holds the list at ' + at);
      assert(await noOverflow(page), 'sheet: horizontal overflow at ' + at);
      if (shots.includes(width)) await page.screenshot({ path: `${evidence}/platform-ai-sheet-${width}.png` });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      assert.equal(await page.getByRole('dialog').count(), 0, 'sheet closes at ' + at);
    } else {
      assert(!(await toggle.isVisible()), 'sheet toggle hidden at lg+ at ' + at);
      assert(await rail.isVisible(), 'rail visible at lg+ at ' + at);
      // Collapsed by default: the toggle only; opening it shows the list.
      assert.equal(await rail.getAttribute('data-platform-ai-rail'), 'collapsed', 'rail collapsed by default at ' + at);
      assert(!(await rail.locator('[data-platform-ai-conversation-list]').count()), 'no list while collapsed at ' + at);
      await page.getByRole('button', { name: 'Show history' }).click();
      assert(await rail.locator('[data-platform-ai-conversation-list]').isVisible(), 'list in the open rail at ' + at);
      // The composer is centred on the message column, not the full shell width.
      const r = await rail.boundingBox();
      const log = await page.getByRole('log').boundingBox();
      const form = await page.locator('[data-ai-dock] form').boundingBox();
      assert(form.x >= r.x + r.width, 'composer right of the rail at ' + at);
      assert(Math.abs(form.width - log.width) <= 16, 'composer width = message column width (± scrollbar) at ' + at + ' ' + JSON.stringify({ form, log }));
      assert(Math.abs((form.x + form.width / 2) - (log.x + log.width / 2)) <= 10, 'composer centred on the message column at ' + at + ' ' + JSON.stringify({ form, log }));
      // Collapsing the rail keeps the composer on the column.
      await page.getByRole('button', { name: 'Hide history' }).click();
      const log2 = await page.getByRole('log').boundingBox();
      const form2 = await page.locator('[data-ai-dock] form').boundingBox();
      assert(Math.abs((form2.x + form2.width / 2) - (log2.x + log2.width / 2)) <= 10, 'composer centred with the rail collapsed at ' + at);
    }
    if (shots.includes(width)) await page.screenshot({ path: `${evidence}/platform-ai-${width}.png` });

    // ── Empty state: starter chips wrap ───────────────────────────────────
    await page.goto(`${base}/?platform-ai=empty`);
    const starters = page.locator('[data-platform-ai-starters]');
    await starters.waitFor();
    assert(await noOverflow(page), 'empty: horizontal overflow at ' + at);
    assert.equal(await starters.evaluate((el) => getComputedStyle(el).flexWrap), 'wrap', 'starters wrap at ' + at);
    assert(await starters.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'starters fit their row at ' + at);
    const chips = await starters.locator('button').all();
    assert.equal(chips.length, STARTERS);
    const rows = new Set();
    for (const c of chips) { const b = await c.boundingBox(); assert(inside(b, width), 'chip inside the viewport at ' + at); rows.add(Math.round(b.y)); }
    if (width < SM) assert(rows.size > 1, 'chips wrap onto several rows at ' + at);
    const emptyDock = await page.locator('[data-ai-dock]').boundingBox();
    assert(emptyDock.y + emptyDock.height <= height - 40, 'empty: composer above the bottom bar at ' + at);
    await disclosureLine(page, width, height, 'empty ' + at);
    // First visit (no conversations): the full notice is expanded in the empty state's reading region.
    await page.goto(`${base}/?platform-ai=first`);
    await page.locator('[data-platform-ai-notice-lead] #platform-ai-notice').waitFor();
    assert.equal(await page.locator('[data-platform-ai-notice-toggle]').getAttribute('aria-expanded'), 'true', 'first visit expanded at ' + at);
    await disclosureLine(page, width, height, 'first ' + at, { expand: true });
    await page.goto(`${base}/?platform-ai=empty`);
    await page.locator('[data-platform-ai-starters]').waitFor();
    if (shots.includes(width)) await page.screenshot({ path: `${evidence}/platform-ai-empty-${width}.png` });
    const clearDock = await startersClearDock(page, 'empty ' + at);
    if (width === 375 && height === 688) await page.screenshot({ path: `${evidence}/platform-ai-empty-375x688-scrolled.png` });

    results.push({ width, height, overflow: 'pass', dock: 'pass', rail: width < LG ? 'sheet' : 'collapsed rail+centred', header: 'pass', starters: 'pass', disclosure: 'line + inline notice', startersClearDock: clearDock });
  }

  // Input growth and a simulated shorter viewport keep the dock above the bar; the counter appears near the limit only.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/?platform-ai`);
  const short = Array(12).fill('Multiline fixture draft').join('\n');
  await page.getByRole('textbox', { name: 'Ask Platform AI' }).fill(short);
  let dock = await page.locator('[data-ai-dock]').boundingBox();
  assert(dock.y >= 0 && dock.y + dock.height <= 844 - 40, 'grown composer above the bar');
  assert.equal(await page.locator('[data-platform-ai-counter]').count(), 0, 'no counter below 400 characters');
  const long = Array(19).fill('Multiline fixture draft').join('\n') + 'x'.repeat(20);
  await page.getByRole('textbox', { name: 'Ask Platform AI' }).fill(long);
  assert.equal(await page.locator('[data-platform-ai-counter]').textContent(), `${long.length}/500`);
  await page.setViewportSize({ width: 390, height: 440 });
  await page.waitForTimeout(250);
  dock = await page.locator('[data-ai-dock]').boundingBox();
  assert(dock.y + dock.height <= 440 - 40, 'shorter viewport: composer above the bar');
  assert(await noOverflow(page), 'shorter viewport: no horizontal overflow');
  const counter = await page.locator('[data-platform-ai-counter]').boundingBox();
  assert(counter.y >= 0 && counter.y + counter.height <= 440 - 40, 'shorter viewport: counter visible above the bar');

  // Keyboard open (empty and ongoing): the composer and the one disclosure line stay on screen.
  for (const [width, height] of KEYBOARD_OPEN) {
    for (const scene of ['empty', '']) {
      await page.setViewportSize({ width, height });
      await page.goto(`${base}/?platform-ai${scene ? '=' + scene : ''}`);
      await page.getByRole('textbox', { name: 'Ask Platform AI' }).fill('Which fixture jobs ran late?');
      await page.waitForTimeout(150);
      const form = await page.locator('[data-ai-dock] form').boundingBox();
      assert(form.y >= 0 && form.y + form.height <= height - 40, `keyboard-open ${scene || 'ongoing'}: composer on screen at ${width}x${height}`);
      await disclosureLine(page, width, height, `keyboard-open ${scene || 'ongoing'} ${width}x${height}`);
      assert(await noOverflow(page), 'keyboard-open: no horizontal overflow');
    }
  }

  // WCAG AA contrast (4.5:1) of the visible short line against its actual
  // (composited) background, in both themes, from computed styles.
  const contrast = {};
  for (const theme of ['dark', 'light']) {
    for (const [scene, w] of [['empty', 390], ['empty', 320]]) {
      await page.setViewportSize({ width: w, height: 844 });
      await page.goto(`${base}/?platform-ai=${scene}`);
      await page.evaluate((t) => { document.documentElement.setAttribute('data-theme', t); }, theme);
      await page.waitForTimeout(100);
      for (const id of ['line']) {
        const r = await page.locator('[data-ai-dock] [data-platform-ai-line]').evaluate((el) => {
          const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) throw new Error('unparsed colour ' + c); const v = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return { r: v[0], g: v[1], b: v[2], a: v.length > 3 ? v[3] : 1 }; };
          const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
          // Background: composite every ancestor's background colour, bottom-up, over white.
          const layers = [];
          for (let n = el; n; n = n.parentElement) { const bg = parse(getComputedStyle(n).backgroundColor); if (bg.a > 0) layers.push(bg); if (bg.a >= 1) break; }
          let bg = { r: 255, g: 255, b: 255, a: 1 };
          for (const l of layers.reverse()) bg = over(l, bg);
          const fg = over(parse(getComputedStyle(el).color), bg);
          const lum = ({ r, g, b }) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
          const [L1, L2] = [lum(fg), lum(bg)].sort((x, y) => y - x);
          return { ratio: Math.round(((L1 + 0.05) / (L2 + 0.05)) * 100) / 100, color: getComputedStyle(el).color, background: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})` };
        });
        const key = `${theme}/disclosure-line/${w}`;
        contrast[key] = r;
        console.log('contrast', key, r.ratio, r.color, 'on', r.background);
        assert(r.ratio >= 4.5, 'WCAG AA 4.5:1 for ' + key + ' ' + JSON.stringify(r));
      }
    }
  }
  fs.writeFileSync(path.join(evidence, 'platform-ai-results.json'), JSON.stringify({ scope: 'Synthetic Platform AI conversation scene (fabricated data, pure view, no API)', results, contrast, softwareKeyboard: 'not verified; requires a device' }, null, 2));
  console.log('PASS', results.length, 'Platform AI viewport fixtures (thread, sheet/collapsed rail, empty starters, short line + inline Privacy & retention + first visit) + input growth + keyboard-open');
} finally {
  await browser.close();
}
