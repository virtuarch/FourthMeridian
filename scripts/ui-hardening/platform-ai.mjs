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
    assert(await page.locator('#platform-ai-privacy-hint').isVisible() && await page.locator('#platform-ai-conversations-disclosure').isVisible(), 'privacy hint + OD-5 visible at ' + at);
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
  const notes = page.locator('[data-platform-ai-composer-notes]');
  assert(await notes.evaluate((el) => el.scrollHeight > el.clientHeight), 'shorter viewport: the long notice scrolls inside its capped group');
  await notes.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  assert(await page.locator('#platform-ai-conversations-disclosure').isVisible(), 'shorter viewport: the OD-5 line is reachable');

  fs.writeFileSync(path.join(evidence, 'platform-ai-results.json'), JSON.stringify({ scope: 'Synthetic Platform AI conversation scene (fabricated data, pure view, no API)', results, softwareKeyboard: 'not verified; requires a device' }, null, 2));
  console.log('PASS', results.length, 'Platform AI viewport fixtures (thread, sheet/rail, empty starters) + input growth');
} finally {
  await browser.close();
}
