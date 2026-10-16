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
```

Set `FM_UI_BROWSER_TOOLS` to change the external tool directory;
`FM_UI_BROWSER_OUTPUT` changes the generated fixture directory. The browser runner
uses localhost port 4179. `FM_UI_CHROME` optionally selects an installed Chromium
executable. Results and screenshots are written under
`docs/plans/ui-hardening-evidence/`.

The build extracts only the existing reason-code vocabulary from `lib/audit.ts`.
It does not bundle or mock audit operations: that server module's unrelated Node
imports are outside this presentation fixture. No API requests are made by the
prop-driven surfaces during these checks; do not submit policy changes in fixtures.
Real software-keyboard behavior still requires an actual device. Viewport shrinking
is recorded as a simulation, not keyboard acceptance.
