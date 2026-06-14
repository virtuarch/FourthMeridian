# FinTracker — Project State
**Last updated:** 2026-06-11  
**Version tag:** v1.0 (post-commit polish)  
**Status:** v1 committed to GitHub. Post-commit: branding finalized, workplaces → workspaces refactor complete. Next: background sync jobs (Milestone 2).

---

## What This Is

A local-first personal finance dashboard. Runs on your laptop via Docker Compose, accessible from your iPhone and any device through a Cloudflare tunnel pointed at a configurable custom domain. Installable as a PWA from the iPhone home screen.

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16 App Router + Tailwind CSS v4 |
| Backend | Next.js API routes |
| Database | PostgreSQL |
| ORM | Prisma v5 |
| Auth | NextAuth v4 (JWT sessions) |
| Encryption | AES-256-GCM (lib/encryption.ts) |
| Background jobs | node-cron (planned) |
| Hosting | Docker Compose (local) |
| External access | Cloudflare Tunnel (planned) |
| Bank data | Plaid |
| Crypto data | Public blockchain APIs + exchange APIs |

---

## Database Models

- **User** — email, username, hashed password, TOTP secret, role (USER/SYSTEM_ADMIN)
- **Workspace** — financial namespace; type PERSONAL or SHARED; `isPublic`, `description`
- **WorkspaceMember** — user ↔ workspace with role (OWNER/ADMIN/MEMBER/VIEWER)
- **WorkspaceInvite** — invite queue with status (PENDING/ACCEPTED/DECLINED)
- **Account** — financial account (checking/savings/investment/crypto/debt); soft-deleted via `deletedAt`
- **PlaidItem** — Plaid institution link; encrypted access token; status (ACTIVE/NEEDS_REAUTH/ERROR/REVOKED)
- **Transaction** — Plaid-synced transactions with category, merchant, amount, pending flag
- **Holding** — individual positions inside investment/crypto accounts
- **WorkspaceSnapshot** — daily net worth snapshots per workspace for historical charting
- **AiAdvice** — AI-generated advice records with playReady signal and risk level
- **AiAgent** — one agent per workspace; advice records are linked to it
- **CreditScore** — manual FICO score snapshots per user (dated)
- **AuditLog** — every sensitive action logged with actor, IP, and metadata
- **TotpDevice** — TOTP 2FA secrets per user

---

## Migrations

All migrations are applied. After cloning, run:

```bash
npx prisma migrate dev && npx prisma generate
```

No pending migrations as of v1.

---

## Features Complete

### Authentication
- [x] Registration with personal workspace auto-creation
- [x] Login with bcrypt password validation (cost 12)
- [x] JWT sessions via NextAuth v4
- [x] 2FA/TOTP model wired (UI flow not yet built)
- [x] Audit logging on login, account changes, workspace events
- [x] SYSTEM_ADMIN kill switch via `DISABLE_SYSTEM_ADMIN` env var

### Dashboard
- [x] Net worth hero number
- [x] Checking & savings balances grouped by institution
- [x] Investment accounts with holdings (symbol, quantity, price, 24h change)
- [x] Crypto — exchange accounts (with holdings breakdown) and self-custody wallets
- [x] Debt balances
- [x] Cash available to play
- [x] FICO score card
- [x] AssetDrawer — TradingView chart for single-asset wallets; holdings breakdown + allocation bar for exchange accounts
- [x] Collapsible institution groups — child rows visually distinct from parent header

### Account Management
- [x] Plaid Link flow to connect banks and brokerages
- [x] Add crypto wallet by public address (BTC, ETH, SOL, BNB, MATIC, ADA, XRP, Other)
- [x] Remove account with confirm step (soft-delete); auto-revokes Plaid item if last account removed
- [x] AccountModal — Holdings tab first/default for investment/crypto accounts; transactions with pagination, date presets, and category filter for all account types
- [x] CreditClient — transaction UI for debt accounts
- [x] InvestmentsClient — paginated holdings table

### Data Sync
- [x] Plaid token exchange and AES-256-GCM encryption on connect
- [x] Plaid transaction sync (incremental cursor-based; initial connect backfills up to 24 months)
- [x] WorkspaceSnapshot written on each sync
- [ ] Background cron jobs (next milestone — Plaid every 4h weekdays, daily weekends)
- [ ] Crypto wallet balance refresh jobs (Blockstream/Etherscan/Helius)

### AI Advice Tab
- [x] ML Review tab — advice banner, schedule info, "What the Engine Reviews" grid (all 6 cells pull real workspace data), Play Readiness wired to `advice.playReady`
- [x] AI Chat tab — mock responses keyed to topic; greeting uses session user's first name
- [ ] Live LLM integration (Milestone 5)

### Workspaces
- [x] Personal workspace per user (auto-created at registration, non-deletable)
- [x] Create shared workspaces (public or private, with description)
- [x] Public workspace discovery tab
- [x] Invite users by name or @username (OWNER/ADMIN only)
- [x] Pending invite queue with rescind; re-invite after rescind
- [x] Accept/decline invites
- [x] Remove members; leave workspace
- [x] Delete workspace (OWNER only)

### Admin Panel (`/admin`)
- [x] Overview stats — users, workspaces, accounts, transactions, platform net worth
- [x] Users table
- [x] Workspaces table
- [x] Audit log viewer (paginated)

### UI / Mobile
- [x] Mobile-first bottom nav (Dashboard → Workspaces → AI)
- [x] Desktop sidebar
- [x] All modals as bottom sheets on mobile, centered on desktop
- [x] Modal height tuned for iPhone: `max-h-[calc(100dvh-180px)]` clears browser chrome + home indicator
- [x] Pagination in all list modals (4-item pages)
- [x] Category dropdowns on transaction views
- [x] TradingView chart in asset drawer
- [x] CoinIcon component for major crypto symbols
- [x] PWA manifest + service worker (configured, not yet tested on device)

### Seed Data
- [x] Jane Smith — low-risk profile: $28,700 net worth, Demo Bank / Example CU / Sample Brokerage / Fictional Crypto Exchange, FICO 720, play ready
- [x] John Doe — medium-risk profile: $16,200 net worth, Beacon Bank / Alpha Brokerage / Alpha Crypto Exchange, FICO 680, high debt, not play ready
- [x] Both users have 365-day snapshot history, holdings, transactions, and AI advice records
- [x] All data is entirely fictional — no real names, balances, wallet addresses, or institution identifiers

### Repo / Privacy
- [x] All personal identifiers removed from committed code
- [x] Real secrets in gitignored `.env` / `.env.local` only
- [x] `.env.example` checked in with placeholder values
- [x] GitHub: https://github.com/virtuarch/fintracker
- [x] v1.0 committed and pushed

### Branding (post-v1 commit)
- [x] `public/logo-icon.png` — new square icon (used in sidebar, mobile header, PWA icons)
- [x] `public/logo-full.png` — wide wordmark (used on all auth pages)
- [x] All auth pages (login, register, forgot-password, reset-password) use `logo-full.png` wordmark; login shows it at 100px height
- [x] Desktop sidebar and mobile header both use `logo-icon.png` + "FinTracker" text at `gap-1.5`
- [x] PWA icons (apple-touch-icon 180px, icon-192, icon-512) regenerated from new `logo-icon.png`
- [x] Stale source files (`full logo.png`, `icon logo.png`) removed from repo root
- [x] README `docs/images/` screenshots section added (dashboard, workspaces, ai-advice)

### Naming Refactor (post-v1 commit)
- [x] `app/dashboard/workplaces/` renamed to `app/dashboard/workspaces/`
- [x] `WorkplacesClient.tsx` renamed to `WorkspacesClient.tsx`; export updated
- [x] All nav hrefs updated: `/dashboard/workplaces` → `/dashboard/workspaces`
- [x] `PROJECT_STATE.md` stale path and known-issue note removed
- [x] Zero remaining `workplace` references in active codebase (verified)

---

## What's Next (Priority Order)

### Milestone 1 — Active Workspace Experience
- Shared account visibility — workspace members see each other's linked accounts
- Per-workspace net worth view
- Workspace activity feed (who connected what, recent syncs)
- 2FA/TOTP setup screen and login verification

### Milestone 2 — Background Sync Jobs
- node-cron scheduler inside Docker
- Plaid sync: runs every 4 hours on weekdays, once daily on weekends
- Crypto wallet balance refresh: Blockstream (BTC), Etherscan (ETH/EVM), Helius (SOL)
- WorkspaceSnapshot written after every sync
- "Last synced" timestamp per account; "Refresh Now" button wired to API

### Milestone 3 — Historical Net Worth Charts
- `WorkspaceSnapshot` table already populated — build the chart UI
- Recharts line chart with 30D / 90D / 1Y / All views
- Per-category overlay (cash, investments, crypto, debt)
- Debt payoff progress tracker

### Milestone 4 — FICO Score & Manual Entry
- Manual FICO score entry (stored as dated snapshot)
- Manual balance override for accounts not supported by Plaid
- "Last updated" indicator on manually-entered fields

### Milestone 5 — AI Advice Engine
- Schedule: 2×/day on trading days (9am + 4pm ET), 1×/day on weekends
- Inputs: cash, debt, allocation, crypto exposure, recent snapshots, market movement
- Output: conservative suggestions, risk warnings, play/no-play readiness signal
- Stored in `AiAdvice` table; replaces mock data in the AI tab
- Advisory only — no auto-trading

### Milestone 6 — Cloudflare Tunnel + iPhone Access
- Set up only after 2FA and route protection are fully tested
- `cloudflared` in Docker Compose pointed at the Next.js container
- Custom domain via Cloudflare tunnel settings; set in `NEXTAUTH_URL`
- HTTPS enforced through Cloudflare
- Test PWA install from iPhone Safari (Add to Home Screen)

---

## Environment Variables Required

```env
DATABASE_URL=
NEXTAUTH_SECRET=
NEXTAUTH_URL=

PLAID_CLIENT_ID=
PLAID_SECRET=
PLAID_ENV=sandbox   # sandbox | development | production

ENCRYPTION_KEY=     # 32-byte hex string for AES-256-GCM

ANTHROPIC_API_KEY=  # for AI advice engine (future)
```

---

## Key File Locations

```
app/
  (auth)/login, register         — auth pages
  dashboard/                     — main dashboard
  dashboard/workspaces/          — workspaces page
  admin/                         — admin panel
  api/
    auth/                        — register, [...nextauth]
    accounts/                    — CRUD + wallet add
    plaid/                       — link token, exchange, webhook
    sync/plaid                   — transaction + balance sync
    workspaces/                  — workspace CRUD + invite system
    users/search                 — username search for invites
    admin/                       — admin data endpoints

components/
  dashboard/                     — all dashboard UI components
  ui/                            — shared UI (BottomNav, Sidebar, CoinIcon, etc.)
  charts/                        — TradingViewChart

lib/
  auth.ts                        — NextAuth config
  db.ts                          — Prisma client singleton
  encryption.ts                  — AES-256-GCM encrypt/decrypt
  plaid.ts                       — Plaid client

prisma/
  schema.prisma                  — full data model
  migrations/                    — all SQL migrations
  seed.ts                        — dev seed data
```

---

## Known Issues / Tech Debt

- **2FA/TOTP** — model and schema exist; setup screen and login verification flow not yet built
- **Crypto wallet balances** — not refreshed automatically; shows "Pending Sync" until Milestone 2 cron jobs are built
- **`prisma migrate dev && prisma generate`** must be run after cloning before the app compiles
- **`UserRole.SYSTEM_ADMIN`** is the schema name for the platform admin role. Used consistently throughout. Renaming requires a DB migration — deferred.
- **`getDemoContext()`** in `lib/workspace.ts` is a dev/cron helper; resolves to `jane@example.com` to match seed data. Do not use in routes or Server Components.
- **Admin has no workspace** — `admin@example.com` intentionally has no workspace memberships. The proxy redirects SYSTEM_ADMIN away from `/dashboard`. If an admin session somehow reaches a dashboard route, `resolveWorkspaceContext` will throw. This is expected behavior, not a bug.
