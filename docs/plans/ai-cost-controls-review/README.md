# AI Cost Controls — owner review checkpoint

Status: visual benchmark implemented and inspected; owner acceptance pending. Integration and heavy verification paused by the owner's disk-recovery coordination instruction. This is not an integration-ready or full-regression completion claim.

## Identity

- Worktree: `/Users/chrstn/dev/FourthMeridian-ui`
- Branch: `ui/full-platform-responsive-hardening`
- Starting HEAD: `118a71101e896e942d89f64c628800c2cdff284e`
- Approved integration target: `c234f3034675c8e215b679a4e92ab8d9a304651e`, not yet integrated.
- Review URL: http://localhost:3001/dashboard/platform/PLATFORM_OPS?workspace=platform-policies
- Verified local listener: PID 47180, cwd `/Users/chrstn/dev/FourthMeridian-ui`, Next.js 16.2.7 development server on 3001. Source paths in authenticated browser DevTools also identify this worktree. Version 2.6.0 alone cannot identify a commit; use cwd plus Git HEAD and the redesigned headings.

## This milestone

Three individually bordered routine cards show the effective daily allowance and the two spending thresholds. The grid uses a content minimum of 18.5rem, collapses to the available width, and leaves emergency request availability in a separate full-width card. Provenance, bounds, explanations and override information remain in native expandable details. Active firing alerts stay visible in the summary. Edit, restore, validation, confirmation and publication handlers are retained. Access gating is unchanged.

Changes are limited to `AiCostControlsPanel.tsx`, its composition in `OpsPoliciesWidget.tsx`, one existing presentation assertion in `policies.test.ts`, and this review evidence. No unrelated page redesign occurred in this milestone.

## Actual authenticated browser evidence

Captured in native Chrome with the existing authenticated localhost session, using the real application and real GET responses. No mocked routes, fabricated data or authentication bypass. Session access is WRITE; CONTROL-only actions correctly do not render.

| Width | File | Observation |
| --- | --- | --- |
| 375px | mobile-375-expanded.png | One column; allowance details expanded and inspected; labels, metadata and override rows wrap within the card. |
| 768px | tablet-768.png | Two columns; third routine card on the next row; distinct borders and stable value alignment. |
| 1024px | laptop-1024.png | Two columns beside the desktop sidebar; no overlap observed in the AI cards. |
| 1440px | desktop-1440.png | Three columns; aligned headings, statuses and values; isolated emergency card below. |

`desktop-1440-cards-crop.png` is a crop of the real 1440px screenshot for convenient review, not a synthetic render. Browser Find leaves the heading selected in the desktop/laptop captures. Chrome full-page capture places fixed navigation at the current scroll position within the stitched image; this screenshot artifact must not be mistaken for proof about fixed-navigation behavior. The ordinary 1024px viewport was also visually inspected. Full-page images remain retained without retouching.

No authenticated pre-redesign screenshot was captured successfully before edits. Earlier loading-only or fixture captures are not valid before/after evidence. A trustworthy before capture remains outstanding.

## Checks and limits

- AI controls component suite: 94 checks passed on the current implementation.
- Policies component suite: 81 checks passed after updating the existing assertion to count visible summary values separately from collapsed metadata.
- Focused ESLint for the three changed component/test files: passed, no output or warnings.
- `git diff --check`: passed.
- Typecheck passed earlier in this work session, before the final footer/caption presentation adjustment; final-state typecheck remains pending.
- `scope-audit.json`: no prohibited paths changed; existing network calls, payload construction and asynchronous handler bodies match the starting milestone.
- Native details disclosure opened and closed in the authenticated application.
- Edit / restore / save / cancel and pause / resume confirmation states are component-tested; authenticated mutation workflows and editor layout require a legitimately CONTROL-authorized session and remain unverified. No live policy setting was changed during this review.
- Full regression, architecture checks and production build remain pending. No Docker test, container creation, migration or seed was run in this checkpoint. The normal full CI runner includes migrations and seeds; the owner's separate prohibition on those remains applicable after disk recovery unless clarified.

## Remaining acceptance work

1. Wait for confirmation that disk recovery is complete before integrating or resuming heavy verification.
2. Integrate only the approved `c234f30` into this isolated branch, retaining this checkpoint and all prior UI history. Stop for ambiguous conflicts.
3. Verify approved backend files match the integrated commit and run the permitted final-state regression, typecheck, lint, architecture checks and production build. Report database checks blocked by the no-migrations/no-seeds boundary separately.
4. Restart the isolated server on 3001 and recheck actual authenticated rendering at all four widths on the integrated HEAD.
5. Inspect with a legitimately CONTROL-authorized session: open each Edit, test local validation and Cancel; check Restore and the pause/resume confirmation UI. Do not change operational policies merely to obtain screenshots.
6. Present a valid before capture, final after captures, commit history, full changed-file list and all remaining limitations to the owner. Owner explicitly accepts or rejects this screen before any other page redesign.

Main `v2.6`, Claude's worktree, Production and Preview were not modified. Nothing was merged, rebased, pushed or deployed.
