# Fourth Meridian — Project State
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
- **Space** — financial namespace; type PERSONAL or SHARED; `isPublic`, `description` (renamed from `Workspace` — Fourth Meridian Phase 1, `@@map`, no DDL)
- **SpaceMember** — user ↔ space with role (OWNER/ADMIN/MEMBER/VIEWER) (renamed from `WorkspaceMember`)
- **SpaceInvite** — invite queue with status (PENDING/ACCEPTED/DECLINED) (renamed from `WorkspaceInvite`)
- **Account** — financial account (checking/savings/investment/crypto/debt); soft-deleted via `deletedAt`
- **PlaidItem** — Plaid institution link; encrypted access token; status (ACTIVE/NEEDS_REAUTH/ERROR/REVOKED)
- **Transaction** — Plaid-synced transactions with category, merchant, amount, pending flag
- **Holding** — individual positions inside investment/crypto accounts
- **SpaceSnapshot** — daily net worth snapshots per space for historical charting (renamed from `WorkspaceSnapshot`)
- **AiAdvice** — AI-generated advice records with actionReady signal and risk level
- **AiAgent** — one agent per space; advice records are linked to it
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
- [x] Registration with personal space auto-creation
- [x] Login with bcrypt password validation (cost 12)
- [x] JWT sessions via NextAuth v4
- [x] 2FA/TOTP model wired (UI flow not yet built)
- [x] Audit logging on login, account changes, space events
- [x] SYSTEM_ADMIN kill switch via `DISABLE_SYSTEM_ADMIN` env var

### Dashboard
- [x] Net worth hero number
- [x] Checking & savings balances grouped by institution
- [x] Investment accounts with holdings (symbol, quantity, price, 24h change)
- [x] Crypto — exchange accounts (with holdings breakdown) and self-custody wallets
- [x] Debt balances
- [x] Cash on hand
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
- [x] SpaceSnapshot written on each sync
- [ ] Background cron jobs (next milestone — Plaid every 4h weekdays, daily weekends)
- [ ] Crypto wallet balance refresh jobs (Blockstream/Etherscan/Helius)

### AI Advice Tab
- [x] ML Review tab — advice banner, schedule info, "What the Engine Reviews" grid (all 6 cells pull real space data), Action Readiness wired to `advice.actionReady`
- [x] AI Chat tab — mock responses keyed to topic; greeting uses session user's first name
- [ ] Live LLM integration (Milestone 5)

### Spaces
- [x] Personal space per user (auto-created at registration, non-deletable)
- [x] Create shared spaces (public or private, with description)
- [x] Public space discovery tab
- [x] Invite users by name or @username (OWNER/ADMIN only)
- [x] Pending invite queue with rescind; re-invite after rescind
- [x] Accept/decline invites
- [x] Remove members; leave space
- [x] Delete space (OWNER only)

### Admin Panel (`/admin`)
- [x] Overview stats — users, spaces, accounts, transactions, platform net worth
- [x] Users table
- [x] Spaces table
- [x] Audit log viewer (paginated)

### UI / Mobile
- [x] Mobile-first bottom nav (Dashboard → Spaces → AI)
- [x] Desktop sidebar
- [x] All modals as bottom sheets on mobile, centered on desktop
- [x] Modal height tuned for iPhone: `max-h-[calc(100dvh-180px)]` clears browser chrome + home indicator
- [x] Pagination in all list modals (4-item pages)
- [x] Category dropdowns on transaction views
- [x] TradingView chart in asset drawer
- [x] CoinIcon component for major crypto symbols
- [x] PWA manifest + service worker (configured, not yet tested on device)

### Seed Data
- [x] Jane Smith — low-risk profile: $28,700 net worth, Demo Bank / Example CU / Sample Brokerage / Fictional Crypto Exchange, FICO 720, action ready
- [x] John Doe — medium-risk profile: $16,200 net worth, Beacon Bank / Alpha Brokerage / Alpha Crypto Exchange, FICO 680, high debt, not action ready
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

### Milestone 1 — Active Space Experience
- Shared account visibility — space members see each other's linked accounts
- Per-space net worth view
- Space activity feed (who connected what, recent syncs)
- 2FA/TOTP setup screen and login verification

### Milestone 2 — Background Sync Jobs
- node-cron scheduler inside Docker
- Plaid sync: runs every 4 hours on weekdays, once daily on weekends
- Crypto wallet balance refresh: Blockstream (BTC), Etherscan (ETH/EVM), Helius (SOL)
- SpaceSnapshot written after every sync
- "Last synced" timestamp per account; "Refresh Now" button wired to API

### Milestone 3 — Historical Net Worth Charts
- `SpaceSnapshot` table already populated — build the chart UI
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
- Output: conservative suggestions, risk warnings, action-ready readiness signal
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
  dashboard/spaces/              — spaces page (dashboard/workspaces/ kept as a permanent redirect)
  admin/                         — admin panel
  api/
    auth/                        — register, [...nextauth]
    accounts/                    — CRUD + wallet add
    plaid/                       — link token, exchange, webhook
    sync/plaid                   — transaction + balance sync
    spaces/                      — space CRUD + invite system
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
- **`getDemoContext()`** in `lib/space.ts` (renamed from `lib/workspace.ts` — Fourth Meridian Phase 1) has been removed (2026-06-17 naming cleanup) — it had zero call sites anywhere in the codebase. `getSpaceContext()`/`resolveSpaceContext()` (renamed from `getWorkspaceContext()`/`resolveWorkspaceContext()`) are unaffected.
- **Admin has no space** — `admin@example.com` intentionally has no space memberships. The proxy redirects SYSTEM_ADMIN away from `/dashboard`. If an admin session somehow reaches a dashboard route, `resolveSpaceContext` will throw. This is expected behavior, not a bug.
