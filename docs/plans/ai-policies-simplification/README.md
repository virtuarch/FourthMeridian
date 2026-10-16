# AI Policies simplification — owner acceptance

Date: 2026-10-16 (Asia/Kuwait). Status: implementation and permitted validation complete; owner acceptance pending. Authenticated CONTROL mutation workflows remain unverified. This is not a claim of full CI or full functional acceptance.

## Branch and recoverable history

- Branch: `ui/full-platform-responsive-hardening`
- Worktree: `/Users/chrstn/dev/FourthMeridian-ui`
- Previous visual checkpoint retained: `5f015c3a6490685e937a7e911cb609fd49ec7522`
- Simplification checkpoint created before integration: `cc9c455` (four UI/component-test files).
- Integration commit / tested application code: `1f9987f47c7b6437d94cbff39c42e2773af90f4f`
- Exact integrated baseline: `ecf84a49aa9db64a79aa598134a3fd4f1dc0b36c`
- `git fetch origin` independently confirmed both `origin/v2.6` and local `v2.6` at that baseline after the owner's confirmation.
- Integration was a clean merge into the isolated UI branch. No conflicts, resets, discarded edits or rewritten commits.
- The final evidence-only commit follows the tested application commit; use `git rev-parse HEAD` for its SHA.

Review URL: http://localhost:3001/dashboard/platform/PLATFORM_OPS?workspace=platform-policies

The running listener is Next.js 16.2.7, PID 24386, cwd `/Users/chrstn/dev/FourthMeridian-ui`, started after integration and the successful local build. Authenticated GET `/api/platform/platform-ops/ai-cost-controls` returned 200. The browser renders the new Custom, Revert, enforcement and emergency controls. No environment or credential file was copied or modified; the process uses the existing Development configuration.

## Implemented controls and actual backend capabilities

| Surface | Visible setting | Authorized action | Persistence / limit |
| --- | --- | --- | --- |
| Daily allowance | Effective default; factory default; configured allowance | Custom opens the existing inline amount editor with Save / Cancel and required reason | Existing PATCH `allowance.usd`; whole-dollar bounds and optimistic version token retained |
| Enforcement | Actual enforced state | Direct Enforced / Not enforced choice opens an auditable change for confirmation | Existing PATCH `allowance.enforced`; disabling still requires confirmation |
| Max spend | Actual `allowance.ceilingUsd`, labelled fixed ceiling | Read only | Code-owned cap, not a separately editable backend policy; no fake ceiling control introduced |
| Daily Revert | Whether a stored setting exists | Revert opens the existing confirmation/reason flow | Existing PATCH with null values for stored allowance controls only; disabled when already default |
| Customer spending alert | Current threshold, default and last activity | Enable / disable, Edit amount, Revert | Existing user-alert controls and PATCH contract |
| Fleet spending alert | Current threshold, default and last activity | Enable / disable, Edit amount, Revert | Existing fleet-alert controls and PATCH contract |
| Emergency AI pause | ACTIVE / PAUSED from actual persisted pause boolean | One Pause AI / Resume AI action | Existing pause control; existing confirmation in both directions and audit reason retained; no Revert |

The prominent allowance and the configured allowance are deliberately distinguished: the first is the effective default after the existing policy ceiling; the second is the platform control's value in force. Default uses the API's `defaultValue`, not a hardcoded amount. Alerts remain estimated spending over the trailing 24 hours. Per-customer overrides stay in Customer Success.

All existing asynchronous mutation handlers, payload construction, response settlement and API URLs are unchanged. Buttons show busy states through the shared editor; submission stays disabled while busy, without a valid value or without a required reason. Canonical server responses update the displayed model; errors do not claim success. Conflict responses replace stale state and explain the conflict. The new view choices prepare drafts and do not persist on selection.

## What was actually verified

| Evidence level | Result |
| --- | --- |
| Source review | API supports seven existing control keys; GET requires READ, PATCH requires fresh CONTROL; required reason, version checks and existing audit behavior retained. Protected backend files match the approved baseline exactly. |
| Component / validation tests | Compact layout, disabled READ controls, dynamic values, applicable Revert, invalid-setting warnings, draft validation, reason gate, confirmation states, pause/resume, reset, conflict/error/success outcomes passed. |
| UI transport / interaction-contract tests | New test exercises custom draft and bounds, high-impact confirmation requirements, default-reset versions, the actual UI mutation adapter with mocked PATCH responses, canonical 200, 400/403/409 and network failure. This is mocked transport, not authenticated persistence. |
| Authenticated browser | Real Development application, existing authenticated WRITE session, live API responses, four widths. Cards, values, direct controls and explicit disabled/read-only state inspected. No fixtures or bypass. |
| Authenticated CONTROL workflow | Not verified: this session lacks CONTROL. No allowance, alert, enforcement, pause or resume setting was changed during this review. No action is claimed to have persisted successfully in this session. |

Existing broader application-space inventories remain in `docs/plans/UI-SURFACE-COVERAGE.md` and `docs/plans/UI-PLATFORM-COVERAGE.md`. This milestone changes and verifies only AI Cost Controls; it does not upgrade unrelated surfaces to browser-tested or authenticated-workflow-tested status.

## Before and after

Before this simplification: `../ai-cost-controls-review/desktop-1440.png` and `../ai-cost-controls-review/desktop-1440-cards-crop.png`, actual authenticated captures from the preserved card-design checkpoint. They show the previous Details & provenance presentation. Earlier pre-card synthetic/loading captures are not used as acceptance evidence.

After: the `authenticated-*.png` files are unretouched full-page Chrome captures at device pixel ratio 2. Their widths are 750, 1536, 2048 and 2880 physical pixels, corresponding to 375, 768, 1024 and 1440 CSS pixels. `cards-*.png` are explicitly labelled crops of those captures for easier card inspection. Browser full-page stitching can place fixed navigation at a viewport boundary within the long image; this is not retouched away or treated as proof about navigation behavior.

| Width | Grid | Specific visual inspection |
| --- | --- | --- |
| 375px | One column | Default/configured/ceiling rows fit; reminder wraps; enforcement and action buttons remain contained; card borders and spacing distinct. |
| 768px | Two columns | Values and action areas align; third card begins a separate row; emergency control remains separate below. |
| 1024px | Two columns beside sidebar | Labels, values and actions fit without observed overlap within AI cards; no narrow three-column layout. |
| 1440px | Three columns | Primary values and footer action areas align; routine and emergency settings visibly separated. |

All four AI-card screenshots were visually inspected. Authorized editor layouts and their real keyboard interactions remain unverified because CONTROL access is absent; their component-state assertions do not substitute for that browser check. No global-platform visual acceptance is claimed.

## Validation on integrated application code

- Full safe regression runner: **743/743 test files passed**; includes the added interaction/transport test and upstream reliability and Docker teardown tests (`regression.txt`).
- TypeScript: **passed**, exit 0.
- ESLint: **0 errors, 19 pre-existing warnings** (`lint.txt`).
- Required source-based architecture audits: **6/6 passed** (`architecture.txt`), including database authority, read identity, account reparenting, tombstones and forecast slice provenance.
- Local production build: **passed**, exit 0 (`build.txt`). No deployment.
- Real Docker cleanup smoke: **passed** (`docker-volume-smoke.json`). Created one throwaway Postgres container without starting it, observed its one anonymous volume, removed only that container with `docker rm -f -v`, and verified zero surviving volumes. No database initialization, migrations or seeds.
- Full CI wrapper and database-dependent audits / RLS acceptance suites: **not run**. The normal runner provisions schemas with migrations and seeds; the owner explicitly prohibits both. No prior CI result is presented as a result for this UI commit.
- Git scope audit: entire tracked branch diff against `ecf84a4` contains only UI/presentation components, tests, documentation and UI verification scripts. No prohibited paths. All existing UI fetch calls, serialized payloads and asynchronous handlers match the approved baseline (`scope-audit.json`). Backend/API/database/dependency/CI/Docker files have no diff from that baseline.

`changed-files.txt` lists the tracked branch changes against the baseline at the tested code HEAD. This review-evidence directory is an additional documentation-only change in the final evidence commit. The simplification itself changed `AiCostControlsPanel.tsx`, `ai-cost-controls.test.ts`, `policies.test.ts` and added `ai-policy-mutation.test.ts`; the Policies host/card separation from the previous checkpoint is retained.

## Owner acceptance steps and unresolved work

1. Open the review URL on localhost:3001 and scroll to AI Cost Controls. Review the compact cards and decide whether this is the visual benchmark to accept.
2. Compare the preserved before capture with the new after capture. Inspect at 375, 768, 1024 and 1440px; allow values and actions to wrap without forcing a three-column layout.
3. With the current WRITE session, verify all editing is disabled and the reason is visible. Do not elevate permissions merely to pass testing.
4. Using an already legitimately CONTROL-authorized Development session, open Custom and verify amount editing, reason, validation, Save, Cancel and unsaved-change handling. Verify enabling/disabling requires the existing safety confirmation where applicable. Verify applicable Revert and the emergency pause/resume confirmation/reason UI. Any actual policy-write acceptance exercise needs a deliberate Development-only test value and restoration; none was performed here.
5. Resolve the no-migrations/no-seeds constraint before demanding a full local CI/database-acceptance pass. The permitted source/test/build checks are green, but full CI is explicitly outstanding.
6. Provide explicit visual acceptance or requested adjustments. No unrelated page redesign or integration into v2.6 proceeds from this milestone without owner approval.

Production, Preview, Claude's worktrees and the original v2.6 checkout were not modified. No push, deployment, migration or seed occurred.
