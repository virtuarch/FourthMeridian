# Full-platform UI hardening — implementation and verification report

Date: 16 October 2026 (Asia/Kuwait).

**Status: implementation delivered for review; full-platform acceptance remains incomplete.** Shared-component fixture results do not establish acceptance of every authenticated screen. Do not merge on the strength of screenshots alone.

## A. Executive summary

Work was isolated at `/Users/chrstn/dev/FourthMeridian-ui`, on `ui/full-platform-responsive-hardening`, from fetched `origin/v2.6` commit `595886e`. The owner's original checkout remains on `v2.6`; its untracked connector architecture document was preserved. `STATUS.md` and the Atlas modal/material/product-language guidance were read. `595886e` is the fetched integration reference, not a newly claimed CI-certified commit; STATUS records earlier verified gates at `a01bbbb`.

The existing Atlas visual vocabulary is retained. Shared sheets now have real handle-only mouse/touch resizing, keyboard alternatives and 45/70/92-percent snap points. Dragging changes presentation height and never dismisses or saves. Long content scrolls independently; desktop panels remain edge-docked. Sheet snap heights and drag movement now use the same visible-viewport coordinate system, including when its height differs from the layout viewport. Both shared overlay families follow the visual viewport, contain scrolling, retain fixed header/footer regions, use dialog semantics and restore focus/scroll. Only the top registered overlay handles Escape. Shared dirty guards confirm dismissal; selected asset and policy forms now opt in.

AI uses one stationary header, one independently scrolling reading area and one anchored composer in both empty and populated states. The original disclosure text opens in a shared panel. Multiline input can scroll, and visual-viewport resizing adjusts the shell. Existing send/stop and data behavior is preserved.

Platform facts, provenance, policy controls, directory descriptions and dense catalogue cells wrap. AI Budget has quiet section separators and content-width breakpoints. AI Cost Controls avoids premature three-column layouts. Tiny nonzero utilization reads `<1%` with a visible minimum indicator; underlying figures are untouched. Customer ledgers retain values while wrapping long identities and amounts. Browser zoom is enabled, bottom padding includes the safe area, and narrow context navigation collapses visual labels while retaining accessible names.

## B. Space coverage

Inventory reconciliation found **39 page routes, 28 universal workspace identities, 5 platform areas, 44 platform sections and 12 templates, with zero missing entries**. The [machine reconciliation record](ui-hardening-evidence/inventory-audit.json) checks the actual routing and imported registries against the document. The complete matrices are [UI-SURFACE-COVERAGE.md](UI-SURFACE-COVERAGE.md) and [UI-PLATFORM-COVERAGE.md](UI-PLATFORM-COVERAGE.md). They enumerate tracked App Router pages, registered workspace/lens/template definitions, every platform area and composition, forms/tables/charts/overlays, nearby tests and verification limits. Inline page markup has a supplementary inventory.

| Surface family | Discovery / changes | Verification status |
|---|---|---|
| Platform Operations: Overview, Jobs, Policies, Pipeline, Providers, History, AI, Economics | All registered; shared presentation and focused policy/budget changes | Platform automated checks; Budget/Cost Controls synthetic browser fixture; authenticated routes unverified |
| Security Operations | Registered; shared wrapping/panels | Automated contracts; live security workflows unverified |
| Growth & Revenue | Registered; catalogue wrapping and responsive metric groups | Automated contracts; authenticated route unverified |
| Customer Success | Registered; detail draft-dismissal protection | Automated contracts; saving/reloading assignments unverified |
| Merchant Operations | Registered; inherited shared layout | Registry/contracts; authenticated route unverified |
| Customer workspaces and lenses | Every registry entry accounted for; ledger and shared overlay changes | Existing contracts; route-by-route visual acceptance unverified |
| Customer AI | Stationary shell/composer, disclosure panel | Component/render contracts and synthetic browser interactions; actual AI service/message lifecycle unverified |
| Brief, Connections, Spaces, settings, onboarding and authentication | All routes inventoried; shared overlay adoption where applicable | Applicable contracts; actual forms and authenticated pages unverified |
| Legacy admin | Provider drawer and three security dialogs adopt shared overlays | Lint/enrollment contracts; no security action invoked |
| Public routes / sibling marketing site | App public routes inventoried; separate zero-authority `site/` unchanged | Full rendered marketing/auth regression unverified |

## C. Shared components and consumers

- `OverlaySurface` and Atlas `Panel` share `SheetHandle`/`useSheetResize`, viewport tracking and existing scroll/focus utilities. Gestures are confined to the handle, so text selection, scrolling and form controls do not compete with resizing. Touch cancellation releases the gesture. Arrow keys, Home/End and button activation provide alternatives.
- `dirty` is optional and guards Escape, scrim and built-in close. `preventClose` blocks built-in dismissal while busy. Successful domain save callbacks still use their original completion path. Wallet/manual asset Cancel and policy-editor Cancel protect drafts separately.
- Brief, provider diagnostics, legacy admin security modals, public-space preview, debt transaction browser, payoff planner and legacy analysis adopt canonical overlays. The desktop drawer/centered-modal distinction is retained.
- The overlay header puts optional controls on a second grid row on phones. Long titles wrap, close controls are enlarged, and content uses overscroll containment. No new animation dependency or design system was added.
- Navigation routes and names are unchanged. The mobile bottom bar has slightly larger labels. The context switch hides only visual labels below 400px, retaining full accessible labels.

## D. Responsive matrix

The actual shared components and prop-driven Budget/Cost Controls were rendered in headless Chromium using synthetic data. Every entry below passed bounds/overflow checks; mobile widths also passed handle keyboard snapping and mouse dragging. AI conversation scrolling preserved composer position. Desktop sheets retained their docked layout.

| Viewport | Result |
|---|---|
| 320 × 568 | Shared/AI/platform synthetic fixture pass |
| 360 × 640 | Shared/AI/platform synthetic fixture pass |
| 375 × 812 | Shared/AI/platform synthetic fixture pass |
| 390 × 844 | Shared/AI/platform synthetic fixture pass |
| 430 × 932 | Shared/AI/platform synthetic fixture pass |
| 600 × 900 | Shared/AI/platform synthetic fixture pass |
| 768 × 1024 | Shared/AI/platform synthetic fixture pass |
| 820 × 1180 | Shared/AI/platform synthetic fixture pass |
| 1024 × 768 | Shared/AI/platform synthetic fixture pass |
| 1280 × 800 | Shared/AI/platform synthetic fixture pass |
| 1366 × 768 | Shared/AI/platform synthetic fixture pass |
| 1440 × 900 | Shared/AI/platform synthetic fixture pass |
| 1728 × 1117 | Shared/AI/platform synthetic fixture pass |
| 1920 × 1080 | Shared/AI/platform synthetic fixture pass |
| 2560 × 1440 | Shared/AI/platform synthetic fixture pass |
| 639 × 700 | Shared/AI/platform synthetic fixture pass |
| 640 × 700 | Shared/AI/platform synthetic fixture pass |
| 1023 × 768 | Shared/AI/platform synthetic fixture pass |
| 1025 × 768 | Shared/AI/platform synthetic fixture pass |
| 844 × 390 | Shared/AI/platform synthetic fixture pass |

These are **not route-wide passes**. No authenticated customer/operator account was provisioned or bypassed. Real iOS/Android keyboard, safe-area device hardware, browser chrome changes and screen-reader use remain unverified. Shrinking a Chromium viewport is explicitly recorded as a simulation.

## E. Visual evidence

[Browser result record](ui-hardening-evidence/browser-results.json) and PNGs under [ui-hardening-evidence](ui-hardening-evidence/) include AI, panel and platform fixtures at 375, 768, 1280 and 1920px. `before-*` images render baseline `595886e` components using the same synthetic fixtures. These are component comparisons, not screenshots of authenticated application routes. Images were visually inspected for mobile sheet geometry, anchored composer and platform grouping.

The focused modal correction additionally has [long desktop](ui-hardening-evidence/modal-1280x800.png), [short desktop](ui-hardening-evidence/modal-short-1280x800.png), [phone](ui-hardening-evidence/modal-375x812.png) and [landscape](ui-hardening-evidence/modal-844x390.png) screenshots, with [bounds/footers recorded](ui-hardening-evidence/modal-results.json). [Visible-viewport coordinate consistency](ui-hardening-evidence/visual-viewport-results.json) is tested separately with a simulated 440px visual viewport inside an 844px layout viewport.

Representative comparisons:

| Fixture | Before | After |
|---|---|---|
| Phone AI | [375px](ui-hardening-evidence/before-ai-375.png) | [375px](ui-hardening-evidence/ai-375.png) |
| Phone panel | [375px](ui-hardening-evidence/before-panel-375.png) | [375px](ui-hardening-evidence/panel-375.png) |
| Phone budget/controls | [375px](ui-hardening-evidence/before-platform-375.png) | [375px](ui-hardening-evidence/platform-375.png) |
| Desktop budget/controls | [1280px](ui-hardening-evidence/before-platform-1280.png) | [1280px](ui-hardening-evidence/platform-1280.png) |

## F. Interactions

Browser fixtures passed: mouse handle dragging; keyboard snap alternatives; Chromium-generated touch dragging; content scrolling without resizing; dialog bounds; nested Escape closing only the top surface; decline/accept unsaved dismissal; focus restoration; body scroll restoration; 14 forward/reverse keyboard tabs and reduced-motion behavior; repeated open/close; anchored AI composer; multiline input; reduced viewport sizing; disclosure open/close. The suite uses actual shared components. The optional browser fixture and reproduction instructions are in [scripts/ui-hardening/README.md](../../scripts/ui-hardening/README.md).

Real policy assignment/save, financial form persistence, connection actions, validation from APIs, loading/error races, all nested select/popover combinations and real mobile keyboard behavior are **not** established by these fixtures. The synthetic Save button does not persist anything. No API or provider requests were used to test mutations.

## G. Automated regression results

| Gate | Outcome |
|---|---|
| Independent unit suite | **739/739 test files pass**, Node 24.21.0, concurrency 4; also repeated in final clean-copy CI |
| Clean-copy CI test job, final code `d11622f` | **Pass**: 739/739 test files, typecheck, lint |
| Repository typecheck | **Pass**; final shared modal correction also checked |
| Repository ESLint | **0 errors, 19 warnings**, all warnings in unchanged files; changed shared files and browser tooling targeted lint clean |
| Production build | **Pass** on final code `d11622f`, including visible-viewport normalization, snap transitions and modal clearance |
| Browser shared/AI/platform fixtures | **Pass**, 20 viewport dimensions; final modal bounds/footer checks also pass |
| Keyboard/reduced motion fixture | **Pass**: 14 forward and 14 reverse tabs stay inside the panel; reduced-motion transition suppressed |
| Platform scripts | **29/29 pass**, plus targeted legacy-admin enrollment test |
| Customer/debt/advice checks | **Pass**: ledger/workspace/template/debt render contracts and AI escaping/hardening checks |
| Clean-copy CI architecture job, final code `d11622f` | **Pass**: 25 required audits; only the runner's disposable test database |
| RLS adversarial suites | **Pass**: 34/34, 98/98, 72/72, 20/20, 67/67 |
| Clean-copy CI sibling site job | **Pass**: 45 tests plus typecheck, lint and static build |
| Overall `npm run ci`, final code `d11622f` | **PASS — every CI job green on a clean copy of HEAD** |

The initial CI clean-copy result covers `9b80c2a`; its architecture job was blocked before Docker was enabled. The final full CI run covers `d11622f` with Docker available. No commits were pushed to GitHub. Verification records are preserved under [evidence/logs](ui-hardening-evidence/logs/), including [final CI](ui-hardening-evidence/logs/ci-final.txt) and [production build](ui-hardening-evidence/logs/production-build.txt). Credential-like test values are redacted, and terminal carriage returns/trailing whitespace normalized. Expected permission-refusal traces in the RLS logs are negative-control passes.

The first broad unit run was against moving source: three UI source pins were corrected by the platform/shared workers, chrome geometry pins were updated for the intentional visual-viewport fallback and safe-area reserve, and one existing under-one-second financial test failed at 2271ms under concurrent load. That financial test passed unchanged alone at 134ms and passed in the subsequent broad run. No financial logic or timing expectation was changed.

The shared snap selector has real boundary tests. Existing panel invariants now follow the extracted handle component and guarded close handler. AI geometry checks still assert the same header/navigation footprint and now also assert visual-viewport listener cleanup. Identity scans still reject identities in rendered content; they exclude CSS class attributes so Tailwind container syntax is not mistaken for an email.

## H. File change audit

Only frontend presentation, frontend tests/browser fixtures and documentation were changed. App changes are global CSS and viewport metadata (enabling zoom). `ai-budget-view.ts` changes only percentage text; `useOverlayBehavior.ts` changes only dismissal ordering. Mixed UI modules retain their existing API/action/data handlers. The admin worker compared existing async/read/write/clipboard handlers byte-for-byte. The payoff planner retains its arithmetic; only overlay wrappers and redundant overlay listeners changed.

The complete Git path audit—including all staged documentation, screenshots and verification records—found **zero out-of-scope paths**. Independent reviewers inspected every changed hunk across the platform/admin/AI and customer/shared/app slices. The AST audit found **all existing network requests, serialized payloads and async handlers unchanged** in changed components. [File/handler audit](ui-hardening-evidence/file-audit.json). No server routes, Prisma schema/migrations/seeds, authorization/authentication services, billing/financial calculations, AI provider integration, environment files, credentials, deployment configuration or production data were modified. No remote branch was pushed and no merge was performed.

Changed implementation/test files at the code audit:

- `app/globals.css`
- `app/layout.tsx`
- `components/admin/AdminSecurityConsole.tsx`
- `components/admin/ProviderDiagnosticsDrawer.tsx`
- `components/ai/AiDisclosure.tsx`
- `components/ai/AiShell.tsx`
- `components/ai/Composer.tsx`
- `components/ai/ai.test.ts`
- `components/atlas/OverlaySurface.tsx`
- `components/atlas/SheetHandle.tsx`
- `components/atlas/panels/Panel.tsx`
- `components/atlas/panels/PanelParts.tsx`
- `components/atlas/panels/panels.test.ts`
- `components/atlas/sheet-resize.test.ts`
- `components/atlas/useOverlayBehavior.ts`
- `components/atlas/useVisualViewport.ts`
- `components/brief/BriefModal.tsx`
- `components/dashboard/AddManualAssetModal.tsx`
- `components/dashboard/AddWalletModal.tsx`
- `components/dashboard/AdviceBanner.tsx`
- `components/dashboard/DebtClient.tsx`
- `components/dashboard/SpacesClient.tsx`
- `components/platform/PlatformSpaceDirectory.tsx`
- `components/platform/platform-surface.tsx`
- `components/platform/widget-kit.tsx`
- `components/platform/widgets/AiCostControlsPanel.tsx`
- `components/platform/widgets/CsCustomersWidget.tsx`
- `components/platform/widgets/GrowthPolicyGroupsWidget.tsx`
- `components/platform/widgets/OpsAiBudgetWidget.tsx`
- `components/platform/widgets/OpsAiInvocationsWidget.tsx`
- `components/platform/widgets/OpsConnectionDiagnosticsWidget.tsx`
- `components/platform/widgets/OpsEmailDeliveryWidget.tsx`
- `components/platform/widgets/ai-budget-view.ts`
- `components/platform/widgets/ai-budget.test.ts`
- `components/platform/widgets/ai-cost-controls.test.ts`
- `components/platform/widgets/operator-identity.test.ts`
- `components/platform/widgets/overview/ai-economics-activity.test.ts`
- `components/platform/widgets/policies.test.ts`
- `components/platform/widgets/policy-editor-kit.tsx`
- `components/space/sections/DebtPayoffSection.tsx`
- `components/space/widgets/investments/HoldingsLedger.tsx`
- `components/space/widgets/liquidity/SourcesLedger.tsx`
- `components/ui/BottomNav.tsx`
- `components/ui/DashboardChrome.tsx`
- `components/ui/PlatformContextSwitch.tsx`
- `components/ui/chrome.test.ts`
- `components/ui/platform-context-switch.test.ts`
- `docs/plans/UI-PLATFORM-COVERAGE.md`
- `docs/plans/UI-SURFACE-COVERAGE.md`
- `scripts/ui-hardening/browser.mjs`
- `scripts/ui-hardening/build.mjs`
- `scripts/ui-hardening/fixture.tsx`
- `scripts/ui-hardening/platform-fixtures.json`

The documentation/evidence commit additionally contains this report, coverage updates, browser result JSON, test logs and screenshots. `git diff 595886e --name-only` is the authoritative complete list.

## I. Remaining issues and acceptance gaps

1. **Full-platform acceptance incomplete:** route-by-route authenticated visual and workflow checks across the viewport matrix remain. The inventory deliberately labels these unverified.
2. Actual iOS/Android keyboard opening/closing, device safe areas, orientation changes with active input and assistive-technology testing remain.
3. Broader form dirty-state coverage needs workflow validation: guards are explicit, not a generic detector of every field in the product. Immediate-save forms retain their existing behavior. Dragging itself never discards data.
4. Real saving/restoring policies, assignment modifications and backend error states must be exercised in an authorized non-production test account. These were not simulated as successes.
5. Chart readability and every data-heavy table at every route are not visually certified; shared containment and existing local-scroll presentations remain, with focused ledger/controls changes.
6. Contrast, screen-reader behavior and complete keyboard coverage across every page remain unverified. Shared focus/motion checks cover only the fixture surfaces.

## J. Deployment status

**Production was not modified.** No deployment, live database migration/seed, credential change, remote push or integration merge was performed. Local Prisma client generation does not migrate a database. Docker-backed CI uses only its own disposable PostgreSQL container: any migrations/seeds in CI apply solely to that test database, with live database URLs removed by the existing runner. The isolated feature branch is left for owner review.

## K. Commits

Implementation commits (all on `ui/full-platform-responsive-hardening`, not `v2.6`):

- `57fa404` — anchored AI composer and disclosure panel.
- `f424edc` — customer ledgers and unsaved asset forms.
- `2d59a02` — platform policy/budget responsiveness.
- `12da6c4` — shared legacy-admin security overlays.
- `d0d7e69` — customer preview/debt overlay consolidation.
- `9b80c2a` — shared sheet interactions, accessibility and mobile navigation.
- `5125d1c` — legacy advice analysis overlay consolidation.
- `fb6ff69` — desktop modal clearance and snap transition correction.
- `92c6dbe` — explicit verification levels and reproducible accessibility checks.
- `d11622f` — normalized visible-viewport dragging, focused viewport test and complete inventory reconciliation.

This report and its evidence are committed separately; the final handoff identifies that documentation commit. `git log --oneline 595886e..HEAD` enumerates the complete branch history.

## L. Exact owner acceptance steps

1. **Check the isolated checkout.** Open `/Users/chrstn/dev/FourthMeridian-ui`; verify `git branch --show-current` reports `ui/full-platform-responsive-hardening`, and compare `git rev-parse HEAD` with the final handoff SHA. Do not merge or deploy as part of acceptance.
2. **Review the evidence and replay the safe fixtures.** Follow [the fixture README](../../scripts/ui-hardening/README.md), start its loopback server on port 4179 and run `browser.mjs`, `accessibility.mjs` and `visual-viewport.mjs`. Open `http://127.0.0.1:4179` for sheets/AI and `http://127.0.0.1:4179/?platform` for Budget/Cost Controls. The fixture Save control intentionally does not persist.
3. **Start the real application using the existing approved Development configuration and a test account.** In the isolated checkout, the app command is `npm run dev -- --port 3001`; load Development settings using the owner's existing approved launcher. This checkout intentionally has no copied `.env.local` or credentials. Open `http://localhost:3001`. Do not point acceptance at Production or change configuration to bypass access. If a non-production login is unavailable, keep authenticated-workflow status unverified.
4. **Exercise the actual screens at 375, 768, 1280, 1440 and 1920px**, plus 320px for the narrowest case. Use the matrices to visit every registered destination, including Settings, Connections, platform areas and customer workspaces. Check navigation, long titles/values, tables/charts, scrolling and reachable form actions. Record the route, dimensions and result; a fixture pass must not be substituted for this step.
5. **Validate sheets and drafts.** Open short and long details; drag up/down to each snap with mouse and touch; scroll content without moving the sheet; use Arrow keys/Home/End, Tab/Shift+Tab and Escape. Open a nested dialog and ensure only it closes. Edit wallet/manual asset/customer-policy drafts, attempt dismissal, decline discard and confirm the draft remains. Then accept discard. Repeat opening/closing and verify the underlying page returns to the same scroll position.
6. **Validate consequential workflows only on non-production test records.** In Policies, record original control values, edit a value/reason, cancel and decline discard, then use the existing confirmation/save flow; reopen and verify persistence. Restore the original through the normal UI. Repeat for Customer Success assignment/allowance/cohort changes. Confirm validation, forbidden/busy/error states and reload behavior. Review admin security dialog presentation; invoking real security actions is not needed to accept its layout.
7. **Use a real iOS or Android device.** In AI, test empty and long conversations, long responses, send/stop/loading/error states, multiline input, keyboard open/closed and portrait/landscape. Confirm the title stays fixed, only messages scroll and the composer remains above navigation and keyboard. Open About, close it, and confirm draft/focus remain. Repeat a long sheet form with the keyboard open. Desktop viewport shrinking does not satisfy this step.
8. **Check accessibility and sign off explicitly.** Review 200% zoom, reduced motion, keyboard focus and a screen reader. Update the matrix's authenticated-workflow and browser columns only for what was actually exercised. Report any failure with route, viewport and reproduction steps. The full local CI contract is green. Full-platform acceptance remains incomplete until these manual gaps are closed; any future merge into `v2.6` or deployment requires separate owner authorization.
