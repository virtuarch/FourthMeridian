# 10 — Updated Scorecard (static vs runtime)

HEAD `cde8fa0` (v2.6) · runtime verification 2026-10-21 · isolated throwaway stack. The original static scores from `../SCORECARD.md` are kept visible. Runtime verification reproduced the static findings rather than overturning them, so most scores are unchanged; what changed is **confidence** and, where runtime narrowed a risk, the severity classification. No score was raised merely because tests passed, and no serious finding was downgraded because one test could not reproduce it.

## Group scores

| Group | Static | Runtime-adjusted | Confidence (static → runtime) | Basis for the runtime figure |
|---|---|---|---|---|
| A. Architecture & engineering | 6.7 | **6.7** | high → high | ARCH-003 mechanism reproduced; no structural claim re-tested at runtime |
| B. Security & privacy | 6.4 | **6.4** | high / live-RLS UNVERIFIED → **high (live RLS now verified)** | SEC-001 reproduced; RLS census closed the one UNVERIFIED gap; no privacy item worsened |
| C. Financial integrity (incl. idempotency) | 6.1 | **6.1** | high → **very high** | FIN-001/002/003/005/013 and IDEMP-001/002/003/009 all reproduced against shipping code |
| D. Reliability & operations (incl. database) | 5.6 | **5.7** | high / scaling PREDICTED → high | DB census + 306/306 suites lift the database leg; alerting defects confirmed; scaling still PREDICTED |
| E. Code quality & maintainability | 6.1 | **6.1** | high → high | not re-scored at runtime |
| F. Testing & delivery | 4.6 | **4.6** | high → high | TEST-002/004 counts confirmed; TEST-003 hole refuted but the gate gap stands |
| G. Customer-facing Spaces | 6.1 | **6.1** | medium → medium-high | pages render; membership enforcement confirmed; rendering/a11y still UNVERIFIED (no browser) |
| H. Operator-facing Spaces | 6.4 | **6.5** | medium → high (auth) | permission enforcement confirmed server-side; Platform Ops 7.0→7.2; UI-001 downgraded to P3 |
| I. Internal observability | 5.2 | **5.2** | high (code) / low (live) → **high** | OBS-001/002/003 confirmed live; scores already assumed the defects |
| **J. Overall beta readiness** | **5.9** | **5.9** | — | runtime hardened the P1 set, refuted one theoretical hole (TEST-003) and downgraded one (UI-001); the master gate (Production cutover) is untestable here and unchanged |

Overall stays **5.9 / 10 — CONDITIONAL GO**. Runtime verification did not surface a new P0 and did not refute any blocker; it raised confidence that the blockers are real and slightly lowered aggregate risk via the two reclassifications.

## Key per-item movements

| Item (report) | Static | Runtime | Reason |
|---|---|---|---|
| RLS coverage (D/B) | 7 (SQL only) | 7, confidence high | live catalog census: 62/62 ENABLE+FORCE, 246 policies, matches `db-authority` |
| Tenant isolation, DB layer (B/D) | 7 | 7, confidence high | 306/306 acceptance suites + live spot-checks (no identity ⇒ 0 rows) |
| TEST-003 cross-tenant-grant hole (F) | P1 potential exposure | **refuted hole**, residual = missing CI gate (P2 testing debt) | no tenant table is granted without a policy |
| AI fail-closed / kill switch / isolation (B) | 8/9/8 | confirmed working at runtime | reservation 503 on induced failure; pause before provider; 403 on Space mismatch |
| AI provider timeout/retry SEC-AI-003 (B) | 4 | 4, confirmed defect | 18 provider calls for one 429'd turn |
| Platform Operations Space (H) | 7.0 | 7.2 | permission enforcement confirmed server-side; UI-001 cosmetic |
| UI-001 operator widgets (G/H) | P2 | **P3 UX** | server refuses; controls are shown but not honoured |
| Forecast consistency / paycheck inference (C) | 5 | 5, very high confidence | FIN-001 reproduced: $15,000 → $0 |
| Balance consistency (C) | 7 | 6 | FIN-005 reproduced (restricted-cash divergence) |
| Observability items 10 & 26 (I) | 4 / 4 | 4 / 4, confirmed live | OBS-001/002/003 reproduced end-to-end |

## Updated single-number answers

| Score | Value /10 |
|---|---|
| Beta readiness | 5.9 |
| Security | 6.6 |
| Financial integrity | 6.1 |
| Idempotency | 6.2 |
| Reliability | 5.6 |
| Customer Spaces | 6.1 |
| Operator Spaces | 6.5 |
| Observability | 5.2 |

(Security 6.6 and the C/D sub-scores are the `03-SECURITY.md`/`06-DATABASE-RELIABILITY.md` leaf figures; the group roll-ups are in the table above. Confidence is uniformly higher than the static pass for every runtime-tested item.)
