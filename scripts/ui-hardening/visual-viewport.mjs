import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const { chromium } = createRequire(path.resolve(process.env.FM_UI_BROWSER_TOOLS || '/tmp/fm-ui-browser', 'package.json'))('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.FM_UI_CHROME ? { executablePath: process.env.FM_UI_CHROME } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  // Model the visual/layout viewport difference without claiming a real keyboard.
  await page.addInitScript(() => Object.defineProperty(window.visualViewport, 'height', { get: () => 440 }));
  await page.goto('http://127.0.0.1:4179');
  await page.locator('#panel').click();
  const handle = page.getByRole('button', { name: /Resize panel/ });
  await handle.focus();
  await page.keyboard.press('Home');
  await page.waitForTimeout(350);
  const compact = await page.getByRole('dialog').boundingBox();
  assert(Math.abs(compact.height - 440 * .45) < 2, 'compact uses the visible viewport');
  await page.keyboard.press('End');
  await page.waitForTimeout(350);
  const expanded = await page.getByRole('dialog').boundingBox();
  assert(Math.abs(expanded.height - 440 * .92) < 2, 'expanded uses the same visible viewport');
  const rect = await handle.boundingBox();
  await page.mouse.move(195, rect.y + 22);
  await page.mouse.down();
  await page.mouse.move(195, rect.y + 72, { steps: 5 });
  const dragged = await page.getByRole('dialog').boundingBox();
  assert(Math.abs(expanded.height - dragged.height - 50) < 3, 'drag pixels and sheet height share coordinates');
  await page.mouse.up();
  fs.writeFileSync(path.join(process.cwd(), 'docs/plans/ui-hardening-evidence/visual-viewport-results.json'), JSON.stringify({ scope: 'Simulated 440px visual viewport within 844px layout viewport; no real keyboard', compactSnap: 'pass', expandedSnap: 'pass', pointerTracking: 'pass', realDeviceKeyboard: 'unverified' }, null, 2));
  console.log('PASS visible viewport snap and drag coordinate consistency');
} finally {
  await browser.close();
}
