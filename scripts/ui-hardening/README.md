# UI fixture verification

These are **synthetic component fixtures**, not authenticated end-to-end tests.
They render the actual shared sheets, AI shell/composer and prop-driven platform
AI Budget/Cost Controls, using synthetic models copied from the existing unit tests.
The fixture's sample Save button performs no persistence. Do not use this fixture
to claim real policy saving, customer navigation, provider actions or authentication
were tested.

Optional browser tools are installed outside the app; no application dependency or
lockfile changes are required:

```sh
npm install --prefix /tmp/fm-ui-browser playwright esbuild
/tmp/fm-ui-browser/node_modules/.bin/playwright install chromium
node scripts/ui-hardening/build.mjs
python3 -m http.server 4179 --bind 127.0.0.1 --directory /tmp/fm-ui-browser
# In another terminal:
node scripts/ui-hardening/browser.mjs
node scripts/ui-hardening/accessibility.mjs
node scripts/ui-hardening/visual-viewport.mjs
node scripts/ui-hardening/platform-ai.mjs
```

`platform-ai.mjs` sweeps the Platform AI conversation scene (`?platform-ai`,
`?platform-ai=empty`; `platform-ai-scene.tsx`): the real pure
`PlatformAiConversationsView` with fabricated conversations and no API calls.
It checks horizontal overflow, the docked composer, the History sheet at `<lg`
and the rail (collapsed by default, opened with "Show history") at `lg`, the
composer centred on the message column beside the rail, header fit with one
"New chat" and the sr-only "History" label below `sm`, six wrapping starter chips
(scrolled to the end of the reading region, no chip intersects the dock or its
fade; 375×688 included), and S2 C1–C4: the short disclosure line beneath the
composer (on screen and not truncated at every size, including keyboard-open
320×480 and 320/360/375/390×440), its "Privacy & retention" button expanding the
full OD-5 text inline by keyboard (no dialog, no scroll box, focus kept), the
full text always in the DOM as the box's aria-describedby target, and a first
visit (`?platform-ai=first`, no conversations) opening with the notice expanded
in the empty state. The counter appears only near the 500-character limit.
Local 375 px screenshots of the expanded notice are written to the evidence
directory.

Set `FM_UI_BROWSER_TOOLS` to change the external tool directory;
`FM_UI_BROWSER_OUTPUT` changes the generated fixture directory. The browser runner
uses localhost port 4179. `FM_UI_CHROME` optionally selects an installed Chromium
executable. Results and screenshots are written under `tmp/ui-hardening-evidence/`
(gitignored; override with `FM_UI_EVIDENCE_DIR`). Generated output is not committed.
Attach what a review needs to the PR instead (documentation lifecycle, ADR-008).

The build extracts only the existing reason-code vocabulary from `lib/audit.ts`.
It does not bundle or mock audit operations: that server module's unrelated Node
imports are outside this presentation fixture. No API requests are made by the
prop-driven surfaces during these checks; do not submit policy changes in fixtures.
Real software-keyboard behavior still requires an actual device. Viewport shrinking
is recorded as a simulation, not keyboard acceptance.
