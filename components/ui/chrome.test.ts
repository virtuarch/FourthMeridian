/**
 * components/ui/chrome.test.ts
 *
 * The dashboard chrome's contracts with the AI page and the account menu.
 * Standalone tsx (house pattern), exits 0/1. These components need the App Router
 * and a session to render, so this source-scans the load-bearing lines — and, for
 * geometry, checks that the numbers written in three different files still agree.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const read = (...p: string[]) => readFileSync(path.join(process.cwd(), ...p), 'utf8');

const chrome = read('components', 'ui', 'DashboardChrome.tsx');
const bottomNav = read('components', 'ui', 'BottomNav.tsx');
const header = read('components', 'ui', 'GlobalHeader.tsx');
const shell = read('components', 'ai', 'AiShell.tsx');
const menu = read('components', 'ui', 'UserMenu.tsx');
const nudge = read('components', 'dashboard', 'TotpNudgeBanner.tsx');
const settingsIndex = read('app', '(shell)', 'dashboard', 'settings', 'page.tsx');

console.log('2FA nudge: not mounted on the AI page, unchanged everywhere else');
{
  check('the route predicate is the existing AI destination rule',
    /const conversationSurface = isGlobalDestActive\("ai", pathname\);/.test(chrome));
  check('the nudge is mounted only when NOT on the AI page (not hidden after mounting)',
    /\{!conversationSurface && <TotpNudgeBanner \/>\}/.test(chrome) && (chrome.match(/<TotpNudgeBanner/g) ?? []).length === 1);
  check('no CSS suppression of the nudge', !/TotpNudgeBanner[^\n]*(hidden|display)/.test(chrome));
  check('other routes keep the original <main> padding', chrome.includes('"min-w-0 flex-1 pb-24 pt-6 lg:pb-16"'));
  check('the nudge itself is untouched: same dismissal key, same status request, still skips SYSTEM_ADMIN',
    nudge.includes('"fm.totpNudge.dismissed"') && nudge.includes('fetch("/api/user/totp/status")') && /isSystemAdmin\) return null/.test(nudge));
}

console.log('AI page geometry: the numbers in three files agree');
{
  // Above the page: GlobalHeader h-12 + border-b (49px) + main pt-6 (24px) = 73px = 4.5625rem.
  check('GlobalHeader is still h-12 with a bottom border', /flex h-12 items-center/.test(header) && /border-b/.test(header));
  check('main keeps pt-6 on the AI route', /conversationSurface\s*\?\s*"min-w-0 flex-1 pt-6 /.test(chrome));
  // Below the page on mobile: BottomNav h-14 (3.5rem) + border-t (1px) + safe-area padding.
  check('BottomNav is still h-14, border-t, padded by the safe-area inset',
    /flex h-14 items-stretch/.test(bottomNav) && /border-t/.test(bottomNav) && bottomNav.includes('paddingBottom: "env(safe-area-inset-bottom)"'));
  const reserve = '3.5rem+1px+env(safe-area-inset-bottom)';
  check('AI <main> pads by exactly the BottomNav footprint (mobile) and 16px (lg)',
    chrome.includes(`pb-[calc(${reserve})] lg:pb-4`));
  check('AiShell subtracts the same chrome from 100dvh (mobile)',
    shell.includes('h-[calc(100dvh-4.5625rem-3.5rem-1px-env(safe-area-inset-bottom))]'));
  check('AiShell desktop height = 100dvh − (49 + 24 + 16)px', shell.includes('lg:h-[calc(100dvh-5.5625rem)]'));
  const shellCode = shell.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('no ResizeObserver / document-offset sizing left in AiShell (code, not comments)',
    !/ResizeObserver|window\.scrollY|style\.height|paddingBottom/.test(shellCode));
  check('no lg:-mb-12 hack and no min-h-[360px] floor', !shell.includes('-mb-12') && !shell.includes('min-h-[360px]'));
}

console.log('account menu: Settings stays, the duplicate Profile goes');
{
  check('Settings links to /dashboard/settings', /href="\/dashboard\/settings"/.test(menu) && />Settings</.test(menu));
  check('no Profile item', !/Profile</.test(menu) && !menu.includes('href="/dashboard/settings/account"') && !menu.includes('CircleUser'));
  check('Settings already lands where Profile pointed', /redirect\("\/dashboard\/settings\/account"\)/.test(settingsIndex));
  check('Sign out unchanged', /signOut\(\{ redirect: false \}\)/.test(menu) && />Sign out</.test(menu) && menu.includes('window.location.href = "/login"'));
  check('identity block unchanged', menu.includes('{user?.name ?? "—"}') && menu.includes('{username}'));
}

console.log('bottom bar reads its own model');
{
  check('BottomNav renders BOTTOM_NAV with its own active rule',
    /BOTTOM_NAV\.map/.test(bottomNav) && /isBottomDestActive\(d\.id, pathname\)/.test(bottomNav) && !/GLOBAL_NAV/.test(bottomNav.replace(/\/\*[\s\S]*?\*\//g, '')));
  check('no Settings icon on the bar', !/Settings as SettingsIcon/.test(bottomNav));
  check('AI keeps its filled-disc emphasis', /const isAI = d\.id === "ai";/.test(bottomNav));
}

if (failures > 0) {
  console.error(`\nchrome.test: ${failures} failure(s).`);
  process.exit(1);
}
console.log('\nchrome.test: all passed.');
