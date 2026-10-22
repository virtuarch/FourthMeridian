# RESUME — read this first after any interruption

Canonical state lives on the local branch `remediation/beta-1` (worktree `/Users/chrstn/dev/FourthMeridian-remediation/base`). Nothing has been pushed; `main` and `v2.6` are untouched.

## How to recover
1. `git -C /Users/chrstn/dev/FourthMeridian-remediation/base log --oneline cde8fa0..HEAD` — integrated work.
2. For each agent worktree `…-remediation/{a..g}`: `git log --oneline cde8fa0..HEAD` and `git status --short`. Uncommitted work is NOT disposable — commit or hand it back to its owner (ownership in `02-AGENT-OWNERSHIP.md`).
3. Read `03-IMPLEMENTATION-LOG.md` (last rows) and the agent reports in `agent-reports/`.
4. Resource policy (owner, 2026-10-22): at most two coding agents and one heavy process (typecheck / full tests / build / `npm run ci`) at a time. Node 24: `export PATH=/opt/homebrew/opt/node@24/bin:$PATH`. Use `bash -c` for loops (zsh does not word-split).
5. Docker Desktop may die under memory pressure: `open -a Docker`. Never prune volumes. Throwaway containers: `docker rm -f -v <name>` only for ones this program created (`rem-*`, `fm-ci-*` you started).

## Merge status (integration 1)
| Branch | Merged |
|---|---|
| f-release-eng, a-security, b-financial, e-observability, d-ai-reliability | yes |
| c-idempotency | yes (`46a31cd`) |
| g-hygiene | yes (`d736943`) |

## Next steps (queue)
1. Merge C (schema owner) and G when their agents report; run `rls:accept:allowance` (D touched the reservation) and the full `npm run ci` on the merged HEAD — one heavy process at a time.
2. Fix integration regressions; record exact results in `04-TEST-EVIDENCE.md`.
3. Wave 2: H AI tools modularisation (`lib/ai/conversation/tools.ts`; D's report has the inventory), I UI hardening (UI-003/006/007/001/009/018 + A's UserSearchInput floor), J auth/route handler tests (TEST-004).
4. Leftovers from reports: SEC-013 (merchant-ops/decide raw message), C adopts `verifyCronAuthorization` (SEC-009), OBS-012 dispatcher heartbeat (C), PRIV-002 historical scrub, FIN-005 restricted-cash column (C), FIN-013 remaining round2 copies.
5. Phase 6 docs: 05–10, 12, findings register statuses, STATUS.md re-baseline.
