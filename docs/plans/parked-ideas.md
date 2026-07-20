# Parked Ideas

*The roadmap ([ROADMAP.md](./ROADMAP.md)) ends at launch. These are deliberately parked, not forgotten. Each lists its unpark condition. Parked ideas are one-line ledger entries — the full investigation that justified parking lives in git history, not the working tree.*

| Idea | Why parked | Unpark condition |
|---|---|---|
| Marketplace / SpaceTemplate (matrix D9) | Zero users; no demand signal; distracts from launch | Real users requesting templates post-launch |
| Internal-ops Spaces (matrix D12) | No internal team; privileged ops data inside customer tenancy would weaken the strongest boundary. Dogfood via a normal BUSINESS Space instead | Internal headcount whose workflows outgrow the Admin Console; then `isInternal` + separate authz gate |
| ProviderAdapter abstraction | A generic interface before a second provider is speculation | A second sync provider committed (also unparks the `Connection` cutover) |
| PublishedAccountView | Public trust boundary over financial data; the private boundary isn't hardened yet | External security review of the private sharing boundary passed |
| Second sync provider / investment transactions / wallet providers | Launch doesn't require them; Plaid-only launch is fine | Post-launch, ranked by usage evidence |
| Agents / automation workflows | An assistant must never misstate a number when asked before it acts unprompted | Post-launch + validator track record |
| Billing / payouts / messaging / support tables (D10) | Ratified out of Phase 2 | Billing only: lifts at v3.0 |
| Decimal / int-cents money migration | High-churn schema period; migration is large. Precision debt is inventoried in [../architecture/decisions/DEC-0.md](../decisions/ADR-005-numeric-precision.md) | Plan during v2.5; execute post-v2.6b |
| Liquid / real-refraction glass material (backdrop lens) | **Evaluated and rejected** — backdrop refraction (`backdrop-filter: url(#svg)`) is Chromium-only. The *content-lens* Atlas Liquid card shipped; only the browser-wide *backdrop*-refraction direction is parked. Atlas stays on the CSS material simulation | A cross-browser true-backdrop-refraction primitive becomes viable |
| Mobile-auth flow (from the CASHFLOW_AND_MOBILE_AUTH plan) | The cash-flow half shipped under SD-6C; the mobile-auth half was never scheduled | A mobile-native auth requirement lands |
| Receipt Intelligence | Read-time posture satisfies most of the demand; the binding constraint is demand-side (gated on OPS-1 S10 / beta) | Beta users demonstrably need receipt capture |
| AI advice writer surfacing loop; Space clustering / financial topology; Meridian Analyst | Parked product ideas — decision still open | Revisit at a post-launch planning pass |
