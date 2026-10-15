# UI surface coverage — 2026-10-16

Source discovery: all tracked App Router `page.tsx` entries; `lib/perspectives.ts`, `lib/platform/policy.ts`, `lib/platform/workspaces.ts`, `lib/space-templates/registry.ts`, and `components/space/workspaces/workspaceRenderers.tsx`. API routes are excluded because they are not UI destinations. Redirect/compatibility pages remain listed.

**Verification legend:** inventoried means source discovered, not browser passed. Automated source/pure tests do not establish visual, touch, focus, keyboard or authenticated workflow success. Every route below still requires authenticated or public browser verification unless the milestone report explicitly supplies evidence. No credentials or authorization were altered.

## Route matrix

Shared shell: `(shell)` routes use dashboard navigation and Atlas surfaces; `(public)` routes use public chrome; `(auth)` routes use auth layout. Admin/merchant routes have their own access/layout wrappers. Forms, tables/charts and overlays below are discovered transitively from local component imports; runtime conditional presence depends on state and permissions.

| Space / route | Major UI / forms and editors | Tables / charts | Drawers, sheets, modals | Existing nearby tests | Risk / verification |
|---|---|---|---|---|---|
| `/confirm-email-change` | Page-local content / redirect | No named data view found | No named overlay found | No colocated test discovered | Long labels / narrow width / short height; inventoried, browser unverified |
| `/forgot-password` | InlineBanner | No named data view found | No named overlay found | `components/atlas/GlassPanel.test.ts`; `components/atlas/SegmentedControl.test.ts` | Long labels / narrow width / short height; inventoried, browser unverified |
| `/login` | InlineBanner, TurnstileWidget | No named data view found | No named overlay found | `components/atlas/GlassPanel.test.ts`; `components/atlas/SegmentedControl.test.ts`; `components/ui/chrome.test.ts` | Long labels / narrow width / short height; inventoried, browser unverified |
| `/register` | InlineBanner, TurnstileWidget | No named data view found | No named overlay found | `components/atlas/GlassPanel.test.ts`; `components/atlas/SegmentedControl.test.ts`; `components/ui/chrome.test.ts` | Long labels / narrow width / short height; inventoried, browser unverified |
| `/reset-password` | InlineBanner | No named data view found | No named overlay found | `components/atlas/GlassPanel.test.ts`; `components/atlas/SegmentedControl.test.ts` | Long labels / narrow width / short height; inventoried, browser unverified |
| `/verify-email` | InlineBanner | No named data view found | No named overlay found | `components/atlas/GlassPanel.test.ts`; `components/atlas/SegmentedControl.test.ts` | Long labels / narrow width / short height; inventoried, browser unverified |
| `/about` | Container, PageHeader | No named data view found | No named overlay found | No colocated test discovered | Long labels / narrow width / short height; inventoried, browser unverified |
| `/legal/ai` | Container, LegalDocument | No named data view found | No named overlay found | No colocated test discovered | Long labels / narrow width / short height; inventoried, browser unverified |
| `/` | Reveal | No named data view found | No named overlay found | No colocated test discovered | Long labels / narrow width / short height; inventoried, browser unverified |
| `/privacy` | Container, LegalDocument | No named data view found | No named overlay found | No colocated test discovered | Long labels / narrow width / short height; inventoried, browser unverified |
| `/request-access` | Container, PageHeader, RequestAccessForm, TurnstileWidget; editors: RequestAccessForm | No named data view found | No named overlay found | No colocated test discovered | Long labels / narrow width / short height; inventoried, browser unverified |
| `/security` | Container, PageHeader | No named data view found | No named overlay found | No colocated test discovered | Long labels / narrow width / short height; inventoried, browser unverified |
| `/terms` | Container, LegalDocument | No named data view found | No named overlay found | No colocated test discovered | Long labels / narrow width / short height; inventoried, browser unverified |
| `/dashboard/analyze` | AdviceBanner, AnalyzeClient, ConfirmDialog, Dialog, GlassButton, GlassPanel, KnowledgeAcquisitionCard | No named data view found | ConfirmDialog, Dialog, GlassPanel, MemoryPanel, SheetHandle | `components/atlas/GlassPanel.test.ts`; `components/atlas/SegmentedControl.test.ts`; `components/dashboard/memory-panel.test.ts` | Long labels / narrow width / short height; inventoried, browser unverified |
| `/dashboard/brief` | AddManualAssetModal, BriefNewUser, DailyBriefClient, FormModal, GlassButton, GlassPanel, OverlaySurface; editors: AddManualAssetModal, FormModal | No named data view found | AddManualAssetModal, FormModal, GlassPanel, SheetHandle | `components/atlas/GlassPanel.test.ts`; `components/atlas/SegmentedControl.test.ts`; `components/brief/brief-flow.test.ts` | Long labels / narrow width / short height; inventoried, browser unverified |
| `/dashboard/connections` | AddManualAssetModal, AddWalletModal, AtlasLiquidCard, AtlasLiquidCta, BuildIntelligencePanel, ConfirmDialog, ConnectionCard; editors: AddManualAssetModal, AddWalletModal, FormModal | ImportHistoryButton, ImportHistoryWizard | AddManualAssetModal, AddWalletModal, BuildIntelligencePanel, ConfirmDialog, Dialog, FormModal, GlassPanel, SheetHandle | `components/atlas/GlassPanel.test.ts`; `components/atlas/SegmentedControl.test.ts`; `components/connections/import/import-ui.test.ts` | Long labels / narrow width / short height; inventoried, browser unverified |
| `/dashboard/credit` | BreakdownWidget, DataCard, DebtClient, DebtPayoffSection, EstimatedChip, FicoCard, GlassPanel | No named data view found | GlassPanel | `components/atlas/GlassPanel.test.ts`; `components/atlas/SegmentedControl.test.ts`; `components/dashboard/memory-panel.test.ts` | Long labels / narrow width / short height; inventoried, browser unverified |
| `/dashboard` | AccountDetail, AccountsLedger, AccountsPerspective, AccountsWorkspace, ActivityEventDetail, ActivityHero, ActivityTimeline; editors: AddManualAssetModal, FormModal, GeneralSettingsPanel, ManageSpaceModal | AccountsLedger, AssetValuationHistory, CalendarHeatmapGrid, CashFlowCalendar, CashFlowCategoryLedger, CashFlowHistoryWidget, DebtBalanceHistory | AddManualAssetModal, ConfirmDialog, DangerZonePanel, Dialog, EvidenceDrawer, FinancesPanel, FormModal, GeneralSettingsPanel | `components/atlas/GlassPanel.test.ts`; `components/atlas/SegmentedControl.test.ts`; `components/atlas/panels/../GlassPanel.test.ts` | Long labels / narrow width / short height; inventoried, browser unverified |
| `/dashboard/platform/[area]` | ActivityFeedBlock, AiActivityBlock, AiCostControlsPanel, AttentionBlock, ConfirmDialog, ConnectionHealthBlock, CsCustomersWidget | OpsAiTrendWidget, OpsHistoryWidget | AiCostControlsPanel, ConfirmDialog, Dialog, ExecutionTimelinePanel, GlassPanel, GrowthStagePanel, JobDetailPanel, SheetHandle | `components/atlas/GlassPanel.test.ts`; `components/atlas/SegmentedControl.test.ts`; `components/platform/platform-directory.test.ts` | Long labels / narrow width / short height; inventoried, browser unverified |
| `/dashboard/platform` | PlatformSpaceDirectory, Surface | No named data view found | No named overlay found | `components/atlas/GlassPanel.test.ts`; `components/atlas/SegmentedControl.test.ts`; `components/platform/platform-directory.test.ts` | Long labels / narrow width / short height; inventoried, browser unverified |
| `/dashboard/settings/account` | AccountSettings, DataCard, GlassPanel, InlineField, SettingsSection, Toast; editors: AccountSettings, SettingsSection | No named data view found | GlassPanel | `components/atlas/GlassPanel.test.ts`; `components/atlas/SegmentedControl.test.ts` | Long labels / narrow width / short height; inventoried, browser unverified |
| `/dashboard/settings/archived-assets` | ArchivedAssetsClient | No named data view found | No named overlay found | `components/dashboard/memory-panel.test.ts` | Long labels / narrow width / short height; inventoried, browser unverified |
| `/dashboard/settings/data` | DataCard, DataPrivacySettings, ExportDataCard, GlassPanel, SettingsSection; editors: DataPrivacySettings, SettingsSection | No named data view found | GlassPanel | `components/atlas/GlassPanel.test.ts`; `components/atlas/SegmentedControl.test.ts` | Long labels / narrow width / short height; inventoried, browser unverified |
| `/dashboard/settings/notifications` | DataCard, GlassPanel, InlineBanner, NotificationSettings, SettingsSection; editors: NotificationSettings, SettingsSection | No named data view found | GlassPanel | `components/atlas/GlassPanel.test.ts`; `components/atlas/SegmentedControl.test.ts` | Long labels / narrow width / short height; inventoried, browser unverified |
| `/dashboard/settings` | Page-local content / redirect | No named data view found | No named overlay found | No colocated test discovered | Long labels / narrow width / short height; inventoried, browser unverified |
| `/dashboard/settings/preferences` | DataCard, GlassPanel, InlineBanner, InlineField, PreferencesSettings, SettingsSection, Toast; editors: PreferencesSettings, SettingsSection | No named data view found | GlassPanel | `components/atlas/GlassPanel.test.ts`; `components/atlas/SegmentedControl.test.ts` | Long labels / narrow width / short height; inventoried, browser unverified |
| `/dashboard/settings/security` | ActiveSessions, ChangeEmailForm, DataCard, DeactivateAccountCard, DeleteAccountCard, Dialog, FormModal; editors: ChangeEmailForm, FormModal, SecuritySettings, SettingsSection | SecurityHistory | Dialog, FormModal, GlassPanel, SheetHandle | `components/atlas/GlassPanel.test.ts`; `components/atlas/SegmentedControl.test.ts`; `components/dashboard/memory-panel.test.ts` | Long labels / narrow width / short height; inventoried, browser unverified |
| `/dashboard/spaces` | AtlasLiquidCard, AtlasLiquidCta, GlassButton, GlassPanel, SpacesClient, Surface | No named data view found | GlassPanel | `components/atlas/GlassPanel.test.ts`; `components/atlas/SegmentedControl.test.ts`; `components/dashboard/memory-panel.test.ts` | Long labels / narrow width / short height; inventoried, browser unverified |
| `/dashboard/workspaces` | Page-local content / redirect | No named data view found | No named overlay found | No colocated test discovered | Long labels / narrow width / short height; inventoried, browser unverified |
| `/admin/audit` | Page-local content / redirect | No named data view found | No named overlay found | No colocated test discovered | Long labels / narrow width / short height; inventoried, browser unverified |
| `/admin` | Page-local content / redirect | No named data view found | No named overlay found | No colocated test discovered | Long labels / narrow width / short height; inventoried, browser unverified |
| `/admin/platform-access` | Page-local content / redirect | No named data view found | No named overlay found | No colocated test discovered | Long labels / narrow width / short height; inventoried, browser unverified |
| `/admin/providers` | AdminExpandHistoryFlow, Dialog, GlassPanel, OverlaySurface, ProviderActionsButton, ProviderDiagnosticsDrawer, SheetHandle | AdminExpandHistoryFlow | Dialog, GlassPanel, ProviderDiagnosticsDrawer, SheetHandle | `components/atlas/GlassPanel.test.ts`; `components/atlas/SegmentedControl.test.ts` | Long labels / narrow width / short height; inventoried, browser unverified |
| `/admin/security` | AdminSecurityConsole, AdminTotpEnrollment, Dialog, FormModal, GlassPanel, OverlaySurface, SessionsList; editors: FormModal | No named data view found | Dialog, FormModal, GlassPanel, SheetHandle | `components/atlas/GlassPanel.test.ts`; `components/atlas/SegmentedControl.test.ts`; `components/dashboard/memory-panel.test.ts` | Long labels / narrow width / short height; inventoried, browser unverified |
| `/admin/spaces` | Page-local content / redirect | No named data view found | No named overlay found | No colocated test discovered | Long labels / narrow width / short height; inventoried, browser unverified |
| `/admin/users` | Page-local content / redirect | No named data view found | No named overlay found | No colocated test discovered | Long labels / narrow width / short height; inventoried, browser unverified |
| `/admin/workspaces` | Page-local content / redirect | No named data view found | No named overlay found | No colocated test discovered | Long labels / narrow width / short height; inventoried, browser unverified |
| `/merchant-ops` | Page-local content / redirect | No named data view found | No named overlay found | No colocated test discovered | Long labels / narrow width / short height; inventoried, browser unverified |
| `/plaid-oauth-return` | Page-local content / redirect | No named data view found | No named overlay found | No colocated test discovered | Long labels / narrow width / short height; inventoried, browser unverified |

## Registered customer workspaces and lenses

All resolve through `/dashboard` and the space/workspace query navigation. Wealth owns investments, debt and liquidity drill views; their presence in the perspective engine does not imply a separate top-level rail destination.

| ID | Label | Availability | Coverage / verification |
|---|---|---|---|
| `overview` | Atlas | Registered | Source inventoried; browser unverified |
| `wealth` | Wealth | Registered | Source inventoried; browser unverified |
| `cashFlow` | Cash Flow | Registered | Source inventoried; browser unverified |
| `markets` | Markets | Registered | Source inventoried; browser unverified |
| `investments` | Investments | Registered | Source inventoried; browser unverified |
| `debt` | Debt | Registered | Source inventoried; browser unverified |
| `liquidity` | Liquidity | Registered | Source inventoried; browser unverified |
| `tax` | Tax | Coming soon | Source inventoried; browser unverified |
| `property` | Property | Coming soon | Source inventoried; browser unverified |
| `businessHealth` | Business Health | Coming soon | Source inventoried; browser unverified |
| `transactions` | Transactions | Registered | Source inventoried; browser unverified |
| `accounts` | Accounts | Registered | Source inventoried; browser unverified |
| `activity` | Activity | Registered | Source inventoried; browser unverified |
| `members` | Members | Registered | Source inventoried; browser unverified |

Customer data views: wealth totals/composition/trend and real assets editor; cash flow summary/calendar/spending/transactions; markets positions/history/allocation; investments holdings/account ledgers and holding detail; debt liabilities/payments/detail; liquidity tier/source ledgers and composition detail; accounts add/edit/import/share; activity timeline and event detail; members invite/role/remove. Shared panels are Atlas LeftPanel/RightPanel; account and transaction drawers use shared overlay primitives.

## Platform area and section matrix

| Space | Registered section key | Widget / major content | Risk / verification |
|---|---|---|---|
| PLATFORM_OPS | `ops_job_health` | Jobs | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| PLATFORM_OPS | `ops_rate_limits` | Rate Limits | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| PLATFORM_OPS | `ops_env_status` | Environment | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| PLATFORM_OPS | `ops_api_usage` | API Usage | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| PLATFORM_OPS | `ops_connection_health` | Connection Health | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| PLATFORM_OPS | `ops_connection_diagnostics` | Connection Diagnostics | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| PLATFORM_OPS | `ops_provider_cleanup` | Provider Cleanup | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| PLATFORM_OPS | `ops_email_delivery` | Email Delivery | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| PLATFORM_OPS | `ops_resource_freshness` | Resource Freshness | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| PLATFORM_OPS | `ops_manual_operations` | Manual Operations | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| PLATFORM_OPS | `ops_provider_health` | Provider Health | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| PLATFORM_OPS | `ops_alerts` | Alerts | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| PLATFORM_OPS | `ops_history` | Operational History | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| PLATFORM_OPS | `ops_convergence` | Convergence | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| PLATFORM_OPS | `ops_timeline` | Operational Timeline | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| PLATFORM_OPS | `ops_ai_trend` | AI Usage Trend | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| PLATFORM_OPS | `ops_cost` | Cost & Latency | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| PLATFORM_OPS | `ops_refresh_summary` | Refresh Summary | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| PLATFORM_OPS | `ops_refresh_executions` | Recent Executions | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| PLATFORM_OPS | `ops_refresh_coverage` | Account Coverage | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| PLATFORM_OPS | `ops_provider_operations` | Provider Operations | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| PLATFORM_OPS | `ops_scheduler` | Scheduler | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| PLATFORM_OPS | `ops_platform_health` | Platform Health | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| PLATFORM_OPS | `ops_policies` | Policies | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| PLATFORM_OPS | `ops_overview` | Operations | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| PLATFORM_OPS | `ops_ai_invocations` | AI Invocations | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| PLATFORM_OPS | `ops_brief_ops` | Daily Brief | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| PLATFORM_OPS | `ops_plaid_usage` | Plaid Usage | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| PLATFORM_OPS | `ops_ai_budget` | AI Budget | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| SECURITY_OPS | `sec_audit_feed` | Audit Feed | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| SECURITY_OPS | `sec_operator_actions` | Operator Actions | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| SECURITY_OPS | `sec_auth_posture` | Authentication Posture | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| SECURITY_OPS | `sec_sessions` | Sessions | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| SECURITY_OPS | `sec_anomalies` | Anomalies | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| GROWTH_REVENUE | `growth_signups` | Signups & Activation | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| GROWTH_REVENUE | `growth_beta_requests` | Beta Access Requests | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| GROWTH_REVENUE | `growth_users` | Users | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| GROWTH_REVENUE | `growth_activity` | User Activity | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| GROWTH_REVENUE | `growth_funnel` | Growth Funnel | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| GROWTH_REVENUE | `growth_policy_groups` | Policy Groups | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| GROWTH_REVENUE | `growth_product_analytics` | Product Analytics | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| CUSTOMER_SUCCESS | `cs_customers` | Customers | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| CUSTOMER_SUCCESS | `cs_sync_issues` | Sync Incidents | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |
| MERCHANT_OPS | `merchant_review` | Merge Review | Dense metrics, filters, tables and operator forms; source inventoried, authenticated browser unverified |

### Platform workspaces and compositions

The following is the literal registry composition, preserving all area destinations and section assignments (including representation-only sections):

```ts
export const PLATFORM_AREA_WORKSPACES: Record<PlatformArea, readonly PlatformWorkspaceComposition[]> = {
  PLATFORM_OPS: [
    {
      workspaceId: "platform-overview",
      // PLATFORM OPS OBSERVABILITY — Overview is the COCKPIT: one verdict per
      // operational domain (refresh pipeline, sources, jobs, Daily Brief, AI,
      // Plaid) from ops_overview, then the consolidated Platform Health surface
      // (alerts, provider health, resource freshness, rate limits, environment —
      // see PLATFORM_SECTION_REPRESENTATION). Every domain has a doorway into
      // the workspace that holds its detail, so "something is wrong" is two
      // clicks from "this exact execution failed".
      sections: ["ops_overview", "ops_platform_health"],
      doorways: ["platform-refresh", "platform-jobs", "platform-providers", "platform-ai", "platform-costs", "platform-policies", "platform-trends"],
    },
    // Jobs — the scheduler observation, the per-job health table, and the
    // manual Run Now / Dry Run controls (formerly their own Operations workspace:
    // "are scheduled jobs working? are manual runs working?" is one question).
    { workspaceId: "platform-jobs", sections: ["ops_scheduler", "ops_job_health", "ops_manual_operations"] },
    // Policies & controls — the financial refresh policy (with its CONTROL
    // editor) and the alert rules, which are declared policy too.
    { workspaceId: "platform-policies", sections: ["ops_policies", "ops_alerts"] },
    // Pipeline — the execution ROWS first (every source kind, filterable, each
    // opening its inspection), then outcomes, the operator's source health,
    // and per-account coverage.
    { workspaceId: "platform-refresh", sections: ["ops_refresh_executions", "ops_refresh_summary", "ops_connection_health", "ops_refresh_coverage"] },
    // Providers — health interpretation → observed behaviour → per-connection
    // diagnostics → consumption → freshness → delivery.
    // `ops_provider_cleanup` sits right after per-connection diagnostics: an
    // operator reading connection state should meet "and these removals were
    // never confirmed upstream" in the same breath, since those items are
    // REVOKED and appear in none of the health surfaces above.
    { workspaceId: "platform-providers", sections: ["ops_provider_health", "ops_provider_operations", "ops_connection_health", "ops_connection_diagnostics", "ops_provider_cleanup", "ops_api_usage", "ops_resource_freshness", "ops_email_delivery"] },
    // History — the OPS-5 Wave B intelligence layer.
    { workspaceId: "platform-trends", sections: ["ops_history", "ops_convergence", "ops_timeline"] },
    // AI — per-invocation operations + economics, Daily Brief operations, and
    // the day-grain usage trend.
    { workspaceId: "platform-ai", sections: ["ops_ai_invocations", "ops_brief_ops", "ops_ai_trend"] },
    // Economics — Plaid Item-months and their estimated cost, the operational
    // cost & latency intelligence, and the AI spend trend. Composition only.
    { workspaceId: "platform-costs", sections: ["ops_ai_budget", "ops_plaid_usage", "ops_cost", "ops_ai_trend"] },
  ],
  SECURITY_OPS: [
    // BETA V2 — one "Security posture" surface (hosted by the first composed key,
    // sec_auth_posture; SecurityPostureWidget) absorbs the four former card-grain
    // widgets, which stay registered and are REPRESENTED by the host below.
    { workspaceId: "platform-overview", sections: ["sec_auth_posture"] },
  ],
  GROWTH_REVENUE: [
    { workspaceId: "platform-overview", sections: ["growth_signups", "growth_product_analytics", "growth_beta_requests", "growth_users", "growth_activity", "growth_funnel", "growth_policy_groups"] },
  ],
  CUSTOMER_SUCCESS: [
    { workspaceId: "platform-overview", sections: ["cs_customers", "cs_sync_issues"] },
  ],
  MERCHANT_OPS: [
    { workspaceId: "platform-overview", sections: ["merchant_review"] },
  ],
};

// ── Consolidation: which sections a CONSOLIDATING section stands in for ─────────

/**
 * Declared CONSOLIDATION, owned by the same module that owns composition.
 *
 * A section key normally earns its place on a surface by appearing in some
 * workspace's `sections`. When a new surface ABSORBS an older one — same
 * operational question, one widget instead of five — the absorbed key stops
 * being composed anywhere. Without a record of that intent the key is
 * indistinguishable from one that was dropped by accident, which is exactly how
 * an operational surface goes silently missing.
 *
 * So absorption is DECLARED here: `absorbedKey → absorbingKey`. The absorbing
 * section must itself be a declared, reachable section (the reachability guard
 * in workspaces.test.ts walks this transitively), so consolidating into a
 * surface that is later removed from every workspace FAILS rather than quietly
 * hiding both.
 *
 * This is not a second composition truth: it grants no placement and renders
 * nothing. It records that the operator can still SEE the absorbed question,
 * inside the absorbing widget.
 *
 * PM-1 — the Platform Health surface answers "is the platform healthy?" across
 * alerts, provider health and resource freshness, and carries a Configuration
 * group covering rate-limit posture and environment status. Those five keys keep
 * their DB rows and their widgets (still composed by Alerts / Providers where
 * they carry a detail question of their own); only their OVERVIEW summary card
 * is what ops_platform_health replaces.
 */
```

Platform overlays include customer detail/assignment, connection diagnostics, refresh execution detail/timeline, manual operation confirmation, policy editors and grant dialogs. Tables must retain visible context and use contained scrolling where columns cannot stack. Charts require text figures as well as color. Existing component tests are indexed below; these are not proof of visual coverage.

## Template inventory

| Template | Picker status | Verification |
|---|---|---|
| family | live | Source inventoried; existing-space and picker browser unverified |
| custom | live | Source inventoried; existing-space and picker browser unverified |
| business | comingSoon | Source inventoried; existing-space and picker browser unverified |
| property | comingSoon | Source inventoried; existing-space and picker browser unverified |
| vehicle | comingSoon | Source inventoried; existing-space and picker browser unverified |
| trip | comingSoon | Source inventoried; existing-space and picker browser unverified |
| debt-payoff | hidden | Source inventoried; existing-space and picker browser unverified |
| emergency-fund | hidden | Source inventoried; existing-space and picker browser unverified |
| investment | hidden | Source inventoried; existing-space and picker browser unverified |
| equipment | hidden | Source inventoried; existing-space and picker browser unverified |
| other | hidden | Source inventoried; existing-space and picker browser unverified |
| personal | hidden | Source inventoried; existing-space and picker browser unverified |

All current category preset section lists are empty (`lib/space-presets.ts`); actual workspace registry and renderers remain authoritative. GOAL and RETIREMENT are retired, not missing coverage.

## Existing frontend tests

The repository uses isolated standalone TypeScript assertion scripts (`scripts/run-tests.ts`), including source contracts and server-render checks; no bundled authenticated browser fixture was discovered in package scripts.

- `components/ai/ai.test.ts`
- `components/ai/transcript-cache.test.ts`
- `components/atlas/GlassPanel.test.ts`
- `components/atlas/SegmentedControl.test.ts`
- `components/atlas/TimelineLens/TimelineLens.test.ts`
- `components/atlas/fields/fields.test.ts`
- `components/atlas/panels/panels.test.ts`
- `components/brief/brief-flow.test.ts`
- `components/brief/brief-provenance.test.ts`
- `components/connections/import/import-ui.test.ts`
- `components/dashboard/memory-panel.test.ts`
- `components/dashboard/widgets/transactions/transactions-redesign.test.ts`
- `components/history/exploration-panel.test.ts`
- `components/notifications/notification-icons.test.ts`
- `components/platform/platform-directory.test.ts`
- `components/platform/platform-shell.test.ts`
- `components/platform/platform-surface.test.ts`
- `components/platform/widget-fetch-static-url.test.ts`
- `components/platform/widgets/ai-budget.test.ts`
- `components/platform/widgets/ai-cost-controls.test.ts`
- `components/platform/widgets/connection-health.test.ts`
- `components/platform/widgets/cs-rollup.test.ts`
- `components/platform/widgets/deployment-evidence.test.ts`
- `components/platform/widgets/env-status-view.test.ts`
- `components/platform/widgets/execution-panel.test.ts`
- `components/platform/widgets/growth-funnel.test.ts`
- `components/platform/widgets/incident-preview.test.ts`
- `components/platform/widgets/jobs.test.ts`
- `components/platform/widgets/operator-identity.test.ts`
- `components/platform/widgets/overview/ai-economics-activity.test.ts`
- `components/platform/widgets/overview/attention-block.test.ts`
- `components/platform/widgets/overview/status-board.test.ts`
- `components/platform/widgets/overview-refresh-jobs.test.ts`
- `components/platform/widgets/platform-health.test.ts`
- `components/platform/widgets/policies.test.ts`
- `components/platform/widgets/product-analytics.test.ts`
- `components/platform/widgets/provider-health.test.ts`
- `components/platform/widgets/provider-operations.test.ts`
- `components/platform/widgets/refresh-format.test.ts`
- `components/platform/widgets/refresh-widgets.test.ts`
- `components/platform/widgets/scheduler.test.ts`
- `components/platform/widgets/security-posture.test.ts`
- `components/platform/workspace-session.test.ts`
- `components/space/manage/manage-space.test.ts`
- `components/space/shell/perspective-time-adapter.test.ts`
- `components/space/shell/space-history.test.ts`
- `components/space/shell/space-shell.test.ts`
- `components/space/shell/space-url-authority.test.ts`
- `components/space/shell/timeline-lens-coverage.test.ts`
- `components/space/shell/timeline-lens-exclusivity.test.ts`
- `components/space/trust/trust-indicator.render.test.ts`
- `components/space/widgets/BreakdownWidget.test.ts`
- `components/space/widgets/accounts/AccountsPerspective.test.ts`
- `components/space/widgets/activity/activity-grouping.test.ts`
- `components/space/widgets/cashflow/CashFlowWorkspace.test.ts`
- `components/space/widgets/cashflow/cash-flow-hero.render.test.ts`
- `components/space/widgets/cashflow/cash-flow-insights.test.ts`
- `components/space/widgets/cashflow/cash-flow-spending-total.render.test.ts`
- `components/space/widgets/cashflow/cash-out-hint.render.test.ts`
- `components/space/widgets/charts/trend-runs.core.test.ts`
- `components/space/widgets/debt/DebtWorkspace.test.ts`
- `components/space/widgets/debt/LiabilitiesLedger.render.test.ts`
- `components/space/widgets/debt/debt-experience.render.test.ts`
- `components/space/widgets/debt/debt-kpis.test.ts`
- `components/space/widgets/debt/debt-signals.test.ts`
- `components/space/widgets/display-currency-fallback.test.ts`
- `components/space/widgets/investments/InvestmentsWorkspace.test.ts`
- `components/space/widgets/investments/investments-activity.test.ts`
- `components/space/widgets/investments/investments-bridge.test.ts`
- `components/space/widgets/liquidity/LiquidityWorkspace.test.ts`
- `components/space/widgets/liquidity/liquidity-what-changed.test.ts`
- `components/space/widgets/members/members.test.ts`
- `components/space/widgets/shared/calendar-interaction.test.ts`
- `components/space/widgets/wealth/RealAssetsSection.test.ts`
- `components/space/widgets/wealth/UpdatePastNetWorthDialog.test.ts`
- `components/space/widgets/wealth/WealthChangeLedger.test.ts`
- `components/space/widgets/wealth/WealthWorkspace.test.ts`
- `components/space/widgets/wealth/wealth-composition.test.ts`
- `components/space/widgets/wealth/wealth-metric-facets.test.ts`
- `components/space/widgets/wealth/wealth-metric-surfaces.test.ts`
- `components/space/widgets/wealth/wealth-trend-points.test.ts`
- `components/space/widgets/wealth/where-it-sits.test.ts`
- `components/space/workspaces/workspaces.test.ts`
- `components/transactions/TransactionDetailDrawer.test.ts`
- `components/ui/chrome.test.ts`
- `components/ui/platform-context-switch.test.ts`
- `components/ui/site-nav-in-space.test.ts`
- `components/ui/space-markets-nav.test.ts`
- `components/ui/space-workspace-nav.test.ts`

## Required responsive / interaction verification

Pending browser matrix: 320×568, 360×640, 375×812, 390×844, 430×932, 600×900, 768×1024, 820×1180, 1024×768, 1280×800, 1366×768, 1440×900, 1728×1117, 1920×1080, 2560×1440; add widths adjacent to breakpoints. No viewport pass is inferred from code inspection.

Pending per surface: overflow, values and labels, empty/loading/error states, keyboard focus, pointer and touch drag/snap, nested scroll, Escape/close, dirty form dismissal, action reachability, safe areas, mobile keyboard, reduced motion. Real mobile keyboard and touchscreen checks require device verification.

## Customer changes in this milestone

- Holdings and liquidity ledger rows can wrap large monetary values below identities instead of squeezing labels or clipping figures; keyboard focus is explicit.
- Holdings full-list control and liquidity tier actions have larger touch targets; holdings search has visible focus and a mobile-sized input.
- Add wallet and add manual asset derive dirty state from editable values and pass it to shared FormModal dismissal protection. Wallet Cancel uses the same discard intent; successful submits retain their existing direct close callbacks.
- These presentation changes do not alter amounts, ordering, API contracts, authorizations or financial calculations.

Local checks run for these customer changes:

- ESLint passed for AddWalletModal, AddManualAssetModal, HoldingsLedger and SourcesLedger.
- `InvestmentsWorkspace.test.ts` passed all source/contract checks.
- `LiquidityWorkspace.test.ts` passed all source/contract checks.
- `git diff --check` passed at the time of this audit.

These checks do not exercise dragging, real keyboard focus, dirty dismissal prompts or CSS layout. No authenticated workflow or viewport is claimed passed by this inventory. Whole-repository gates and browser evidence belong to the milestone report.

## Customer legacy overlay migration follow-up

| Consumer | Shared presentation | Preserved workflow | Verification status |
|---|---|---|---|
| SpacesClient PublicSpaceDetailModal | OverlaySurface, retained category header toolbar, sticky joining footer | Public preview and disabled future joining action unchanged | Source migrated; browser unverified |
| DebtClient All Transactions | OverlaySurface workspace, filter toolbar, sticky pagination/Collapse footer | Search, flow filtering, paging and shared transaction detail opening unchanged | Source migrated; browser unverified |
| DebtPayoffSection fullscreen | OverlaySurface workspace, shared title and account/APR subtitle | Existing payment/account choices and financial engine calls unchanged | Source migrated; browser unverified |

Shared OverlaySurface now owns focus, Escape, body scroll lock, mobile viewport and sheet interaction for these consumers. The planner's duplicate global Escape listener/body lock were removed to avoid competing lifecycle behavior. Inputs are client-side exploratory choices rather than persisted edits; dismissal retains its original semantics. Actual drag, snap and authenticated workflow verification remains pending.

Follow-up verification: ESLint passed for all three migrated customer files; debt-experience server-render checks, template-truthfulness assertions and workspace source invariants all passed. These checks preserve existing financial presentation and registry behavior but do not establish browser interaction success. `git diff --check` passed.

## Inline route content supplement

The named-component matrix above also includes page-local markup. The following tracked routes declare controls or tables directly in their page source (counts are discovery evidence, not rendered or workflow verification).

| Route | Inline control/table declarations | Verification |
|---|---|---|
| `/forgot-password` | 1 form | Source inventoried; browser unverified |
| `/register` | 1 form, 1 input | Source inventoried; browser unverified |
| `/reset-password` | 1 form | Source inventoried; browser unverified |
| `/admin/audit` | 6 input, 1 select, 9 button, 1 table | Source inventoried; browser unverified |
| `/admin` | 2 table | Source inventoried; browser unverified |
| `/admin/platform-access` | 1 input, 3 button, 1 table | Source inventoried; browser unverified |
| `/admin/providers` | 1 table | Source inventoried; browser unverified |
| `/admin/spaces` | 1 input, 3 select, 3 button | Source inventoried; browser unverified |
| `/admin/users` | 1 input, 2 select, 3 button, 1 table | Source inventoried; browser unverified |
| `/plaid-oauth-return` | 1 button | Source inventoried; browser unverified |

The separate `site/` marketing project is a zero-authority sibling. Its mirrored public content is covered by the repository boundary checks; it was not modified by this application UI pass.

### Advice analysis overlay

`AdviceBanner.AnalysisModal` now uses shared OverlaySurface workspace presentation (title/icon, close callback, scroll/focus/viewport/sheet handling). The risk strip, generated timestamp, readiness label, summary, context, risk summary, extracted actions and escaped full analysis rendering are preserved. All extraction and HTML escaping logic is unchanged. Source migration is complete; authenticated browser interaction remains unverified.

Advice analysis migration checks: ESLint passed; `lib/ai/conversation/hardening.test.ts` passed all assertions including AdviceBanner HTML escaping; `git diff --check` passed.
