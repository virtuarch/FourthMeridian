# Fourth Meridian — Roadmap

Last updated: June 2026 · v1.0

---

## ✅ Complete

### Foundation
- [x] Next.js 16 App Router + Tailwind CSS v4 (mobile-first, dark theme)
- [x] PostgreSQL + Prisma ORM + full schema
- [x] Docker Compose setup (app + db containers)
- [x] PWA manifest, icons, apple-touch-icon

### Auth & Security
- [x] Registration + bcrypt password hashing (cost 12)
- [x] NextAuth v4 JWT sessions with role support
- [x] Route protection via `proxy.ts` (Next.js 16) for `/dashboard/*` and `/admin/*`
- [x] AES-256-GCM encryption for Plaid access tokens at rest
- [x] Audit log on all logins, account changes, space events
- [x] SYSTEM_ADMIN kill switch via `DISABLE_SYSTEM_ADMIN` env var
- [ ] 2FA/TOTP UI — model + schema done; setup + login verification screens not yet built

### Dashboard
- [x] Net worth hero, cash-to-play, FICO card
- [x] Checking, savings, investment, crypto, debt sections
- [x] Account grouping by institution
- [x] AssetDrawer — TradingView chart (wallets) + holdings breakdown (exchange accounts)

### Account Management
- [x] Plaid Link integration — connect banks and brokerages
- [x] Incremental Plaid transaction sync (cursor-based)
- [x] Soft-delete accounts; Plaid item auto-revoked when last account removed
- [x] Crypto wallet tracking by public address (BTC, ETH, SOL, BNB, MATIC, ADA, XRP)
- [x] Transaction modal with pagination and category filter
- [x] Investment holdings table with pagination

### Spaces
- [x] Personal space per user (auto-created at registration)
- [x] Create public/private shared spaces
- [x] Invite users by name or @username (OWNER/ADMIN only)
- [x] Pending invite queue with rescind + re-invite
- [x] Accept/decline invites
- [x] Role-based access (OWNER, ADMIN, MEMBER, VIEWER)
- [x] Remove members; leave space; delete space

### Admin Panel
- [x] Overview stats — users, spaces, accounts, transactions, platform net worth
- [x] Users table, spaces table
- [x] Audit log viewer (paginated)

---

## 🔲 Next Milestones — In Order

### Milestone 1 — Active Space Experience
- [ ] Shared account visibility — space members see each other's linked accounts
- [ ] Per-space net worth view
- [ ] Space activity feed (who connected what, recent syncs)
- [ ] 2FA/TOTP setup screen and login verification

### Milestone 2 — Background Sync Jobs
- [ ] Plaid sync cron — runs every 4 hours on weekdays, once daily on weekends
- [ ] Crypto wallet balance refresh — Blockstream (BTC), Etherscan (ETH/EVM), Helius (SOL)
- [ ] SpaceSnapshot written after every sync (already writing on manual refresh)
- [ ] "Last synced" timestamp shown per account
- [ ] "Refresh Now" button wired to API (UI exists, endpoint needed)

### Milestone 3 — Historical Net Worth Charts
- [ ] `SpaceSnapshot` table is already populated — build the chart UI
- [ ] Recharts line chart with 30D / 90D / 1Y / All time views
- [ ] Per-category overlay (cash, investments, crypto, debt)
- [ ] Debt payoff progress tracker

### Milestone 4 — FICO Score & Manual Entry
- [ ] Manual FICO score entry (stored as dated snapshot)
- [ ] Manual balance override for accounts not supported by Plaid
- [ ] "Last updated" indicator on manually-entered fields

### Milestone 5 — AI Advice Engine
- [ ] Schedule: 2×/day on trading days (8am + 4:30pm ET), 1×/day on weekends
- [ ] Inputs: cash, debt, allocation, crypto exposure, recent snapshots, market movement
- [ ] Output: conservative suggestions, risk warnings, play/no-play readiness signal
- [ ] Stored in `AiAdvice` table; shown in the AI tab
- [ ] Advisory only — no auto-trading

### Milestone 6 — Cloudflare Tunnel + iPhone Access
- [ ] Set up only after 2FA and route protection are fully tested
- [ ] `cloudflared` in Docker Compose pointed at the Next.js container
- [ ] Custom domain: configure your own via Cloudflare tunnel settings
- [ ] HTTPS enforced through Cloudflare
- [ ] Test PWA install from iPhone Safari (Add to Home Screen)
- [ ] Push notifications via PWA for large balance swings or new AI advice

---

## ▶️ How to Run (Docker)

```bash
# Start database + app
docker compose up -d

# Apply any new migrations
npx prisma migrate dev
npx prisma generate

# Open
open http://localhost:3000
```

## ▶️ How to Run (local dev, no Docker for app)

```bash
# Start just the database
docker compose up -d db

# Run migrations (first time or after schema changes)
npx prisma migrate dev && npx prisma generate

# Start dev server
npm run dev

# App at http://localhost:3000
# iPhone on same WiFi: http://192.168.x.x:3000
```

---

## 🔑 Key Files

| File | Purpose |
|---|---|
| `proxy.ts` | Route protection (Next.js 16, replaces middleware.ts) |
| `prisma/schema.prisma` | Full data model |
| `prisma/seed.ts` | Demo data — fake accounts only, no real PII |
| `lib/encryption.ts` | AES-256-GCM for Plaid tokens |
| `lib/auth.ts` | NextAuth config + role handling |
| `context/PlaidContext.tsx` | Single Plaid Link instance (prevents duplicate script warning) |
| `app/dashboard/` | All dashboard pages |
| `components/dashboard/` | Dashboard UI components |
| `docs/PROJECT_STATE.md` | Full technical state snapshot |
