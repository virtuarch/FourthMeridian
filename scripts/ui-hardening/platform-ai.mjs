// Platform AI conversation scene (parity PR5): the same viewport sweep as the
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
const sizes = [[320,568],[360,640],[375,812],[390,844],[430,932],[600,900],[639,700],[640,700],[768,1024],[820,1180],[844,390],[1023,768],[1024,768],[1025,768],[1280,800],[1366,768],[1440,900],[1728,1117],[1920,1080],[2560,1440]];
const shots = [375, 390, 768, 1024, 1280, 1920];
const LG = 1024, SM = 640;
// The owner-approved OD-5 wording, read from the model constant (pinned by the unit tests).
const OD5 = fs.readFileSync(path.resolve(process.cwd(), 'components/platform/platform-ai-conversations-model.ts'), 'utf8')
  .match(/PLATFORM_AI_CONVERSATIONS_DISCLOSURE =\s*"([^"]+)"/)[1];
// Keyboard-open geometries (visual viewport ~440-480 px tall on a phone).
const KEYBOARD_OPEN = [[320,480],[360,440],[375,440],[390,440]];
const textOf = (loc) => loc.evaluate((el) => el.textContent.replace(/\s+/g, ' ').trim());
/** No ancestor of the notice (nor the notice) is a scroll container. */
const noScrollAncestor = (page) => page.locator('#platform-ai-notice').evaluate((el) => {
  for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (/(auto|scroll)/.test(cs.overflowY + ' ' + cs.overflowX)) return n.outerHTML.slice(0, 120);
  }
  return true;
});
/** The notice is rendered in full: visible, inside the shell and above the bottom bar, the composer on-screen too. */
async function noticeFullyVisible(page, width, height, at) {
  const notice = page.locator('#platform-ai-notice');
  assert(await notice.isVisible(), 'OD-5 notice visible at ' + at);
  assert.equal(await textOf(page.locator('#platform-ai-conversations-disclosure')), OD5, 'OD-5 text identical to the constant at ' + at);
  assert.equal(await noScrollAncestor(page), true, 'no scroll container wraps the notice at ' + at);
  const shell = await page.locator('[data-ai-layout]').boundingBox();
  const n = await notice.boundingBox();
  assert(n.y >= shell.y - 1 && n.y + n.height <= shell.y + shell.height + 1 && n.y + n.height <= height - 40, 'notice fully on screen at ' + at + ' ' + JSON.stringify({ n, shell }));
  const form = await page.locator('[data-ai-dock] form').boundingBox();
  assert(form.y >= 0 && form.y + form.height <= height - 40, 'composer on screen at ' + at);
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
    assert(await page.locator('#platform-ai-privacy-hint').isVisible(), 'privacy hint always visible at ' + at);
    assert.equal(await box.getAttribute('aria-describedby'), 'platform-ai-privacy-hint platform-ai-conversations-disclosure', 'describedby at ' + at);
    assert.equal(await page.locator('#platform-ai-conversations-disclosure').count(), 1, 'OD-5 text in the DOM at ' + at);
    assert.equal(await noScrollAncestor(page), true, 'no scroll container wraps the notice (ongoing) at ' + at);
    const noticeToggle = page.locator('[data-platform-ai-notice-toggle]');
    if (width < SM) {
      // Ongoing: a compact "Privacy & retention" disclosure button reveals the full text inline.
      assert(await noticeToggle.isVisible(), 'Privacy & retention control visible at ' + at);
      assert.equal(await noticeToggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await noticeToggle.getAttribute('aria-controls'), 'platform-ai-notice');
      assert(!(await page.locator('#platform-ai-notice').isVisible()), 'collapsed below sm at ' + at);
      await noticeToggle.click();
      assert.equal(await noticeToggle.getAttribute('aria-expanded'), 'true', 'toggles open at ' + at);
      if (height >= 560) await noticeFullyVisible(page, width, height, 'ongoing expanded ' + at);
      else assert(await page.locator('#platform-ai-notice').isVisible(), 'expanded notice visible at ' + at);
      if (width === 375) await page.screenshot({ path: `${evidence}/platform-ai-375-notice-expanded.png` });
      await noticeToggle.click();
      assert.equal(await noticeToggle.getAttribute('aria-expanded'), 'false', 'toggles closed at ' + at);
      assert(!(await page.locator('#platform-ai-notice').isVisible()), 'collapses again at ' + at);
    } else {
      // Room enough at sm+: shown inline, no control needed.
      assert(!(await noticeToggle.isVisible()), 'no control at sm+ at ' + at);
      assert(await page.locator('#platform-ai-notice').isVisible(), 'notice inline at sm+ at ' + at);
      assert.equal(await textOf(page.locator('#platform-ai-conversations-disclosure')), OD5);
    }
    assert.equal(await page.getByRole('button', { name: /Stop/ }).count(), 0, 'no Stop at ' + at);

    // Header controls fit; "Conversations" is sr-only below sm.
    const header = page.locator('[data-platform-ai-conversations] header');
    assert(await header.evaluate((h) => h.scrollWidth <= h.clientWidth + 1), 'header controls fit at ' + at);
    for (const b of await header.locator('button, [data-tone]').all()) {
      if (await b.isVisible()) assert(inside(await b.boundingBox(), width), 'header control inside the viewport at ' + at);
    }
    const toggle = page.locator('[data-platform-ai-sheet-toggle]');
    const rail = page.locator('[data-platform-ai-rail]');
    if (width < LG) {
      assert(await toggle.isVisible(), 'sheet toggle visible below lg at ' + at);
      assert(!(await rail.isVisible()), 'rail hidden below lg at ' + at);
      const label = await toggle.locator('span').last().boundingBox();
      if (width < SM) assert(label.width <= 1 && label.height <= 1, '"Conversations" label sr-only below sm at ' + at);
      else assert(label.width > 20, '"Conversations" label visible at sm+ at ' + at);
      await toggle.click();
      const sheet = page.getByRole('dialog', { name: 'Conversations' });
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
      // The composer is centred on the message column, not the full shell width.
      const r = await rail.boundingBox();
      const log = await page.getByRole('log').boundingBox();
      const form = await page.locator('[data-ai-dock] form').boundingBox();
      assert(form.x >= r.x + r.width, 'composer right of the rail at ' + at);
      assert(Math.abs(form.width - log.width) <= 16, 'composer width = message column width (± scrollbar) at ' + at + ' ' + JSON.stringify({ form, log }));
      assert(Math.abs((form.x + form.width / 2) - (log.x + log.width / 2)) <= 10, 'composer centred on the message column at ' + at + ' ' + JSON.stringify({ form, log }));
      // Collapsing the rail keeps the composer on the column.
      await page.getByRole('button', { name: 'Hide conversations' }).click();
      const log2 = await page.getByRole('log').boundingBox();
      const form2 = await page.locator('[data-ai-dock] form').boundingBox();
      assert(Math.abs((form2.x + form2.width / 2) - (log2.x + log2.width / 2)) <= 10, 'composer centred with the rail collapsed at ' + at);
      await page.getByRole('button', { name: 'Show conversations' }).click();
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
    assert.equal(chips.length, 4);
    const rows = new Set();
    for (const c of chips) { const b = await c.boundingBox(); assert(inside(b, width), 'chip inside the viewport at ' + at); rows.add(Math.round(b.y)); }
    if (width < SM) assert(rows.size > 1, 'chips wrap onto several rows at ' + at);
    const emptyDock = await page.locator('[data-ai-dock]').boundingBox();
    assert(emptyDock.y + emptyDock.height <= height - 40, 'empty: composer above the bottom bar at ' + at);
    assert.equal(await page.locator('[data-platform-ai-notice-toggle]').count(), 0, 'new conversation: no toggle at ' + at);
    if (height >= 440 || width >= SM) await noticeFullyVisible(page, width, height, 'empty ' + at);
    if (shots.includes(width)) await page.screenshot({ path: `${evidence}/platform-ai-empty-${width}.png` });

    results.push({ width, height, overflow: 'pass', dock: 'pass', rail: width < LG ? 'sheet' : 'rail+centred', header: 'pass', starters: 'pass' });
  }

  // Input growth and a simulated shorter viewport keep the dock above the bar.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/?platform-ai`);
  await page.getByRole('textbox', { name: 'Ask Platform AI' }).fill(Array(12).fill('Multiline fixture draft').join('\n'));
  let dock = await page.locator('[data-ai-dock]').boundingBox();
  assert(dock.y >= 0 && dock.y + dock.height <= 844 - 40, 'grown composer above the bar');
  assert.equal(await page.locator('[data-platform-ai-counter]').textContent(), `${Array(12).fill('Multiline fixture draft').join('\n').length}/500`);
  await page.setViewportSize({ width: 390, height: 440 });
  await page.waitForTimeout(250);
  dock = await page.locator('[data-ai-dock]').boundingBox();
  assert(dock.y + dock.height <= 440 - 40, 'shorter viewport: composer above the bar');
  assert(await noOverflow(page), 'shorter viewport: no horizontal overflow');
  const counter = await page.locator('[data-platform-ai-counter]').boundingBox();
  assert(counter.y >= 0 && counter.y + counter.height <= 440 - 40, 'shorter viewport: counter visible above the bar');

  // New conversation with the keyboard open: the full OD-5 text is unscrolled and fully
  // visible, the composer stays on screen (the starters give way).
  for (const [width, height] of KEYBOARD_OPEN) {
    await page.setViewportSize({ width, height });
    await page.goto(`${base}/?platform-ai=empty`);
    await page.getByRole('textbox', { name: 'Ask Platform AI' }).fill('Which fixture jobs ran late?');
    await page.waitForTimeout(150);
    await noticeFullyVisible(page, width, height, 'keyboard-open empty ' + width + 'x' + height);
    assert(await noOverflow(page), 'keyboard-open empty: no horizontal overflow');
  }
  // Ongoing, keyboard open: collapsed notice keeps the composer and the control on screen.
  for (const [width, height] of KEYBOARD_OPEN) {
    await page.setViewportSize({ width, height });
    await page.goto(`${base}/?platform-ai`);
    const form = await page.locator('[data-ai-dock] form').boundingBox();
    const ctl = await page.locator('[data-platform-ai-notice-toggle]').boundingBox();
    assert(form.y >= 0 && form.y + form.height <= height - 40 && ctl.y + ctl.height <= height - 40, 'keyboard-open ongoing: composer + control on screen at ' + width + 'x' + height);
  }
  // 375 px evidence: the new-conversation notice.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${base}/?platform-ai=empty`);
  await page.locator('#platform-ai-notice').waitFor();
  await page.screenshot({ path: `${evidence}/platform-ai-375-empty-notice.png` });

  fs.writeFileSync(path.join(evidence, 'platform-ai-results.json'), JSON.stringify({ scope: 'Synthetic Platform AI conversation scene (fabricated data, pure view, no API)', results, softwareKeyboard: 'not verified; requires a device' }, null, 2));
  console.log('PASS', results.length, 'Platform AI viewport fixtures (thread, sheet/rail, empty starters, OD-5 notice) + input growth + keyboard-open');
} finally {
  await browser.close();
}
