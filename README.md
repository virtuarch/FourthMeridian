# FinTracker

A local-first personal finance intelligence platform. Runs on your laptop via Docker Compose, accessible from any device via a Cloudflare tunnel, and installable as a PWA from your iPhone home screen.

---

## Project Status

**v2.0** — Workspace Platform

FinTracker is an actively developed personal project. The v2.0 release introduces the full multi-user workspace architecture on top of the v1.0 financial foundation. Features, APIs, and schemas evolve between versions.

---

## Major Features

### Multi-Workspace Architecture
Every user gets a personal workspace on signup. Additional shared workspaces can be created for households, investment clubs, advisory relationships, or any collaborative finance context — each with its own dashboard, goals, and account visibility rules.

### Roles and Permissions
Each workspace has four roles: **Owner**, **Admin**, **Member**, and **Viewer**. Role enforcement runs at both the API and UI layer. Owners can manage members, configure sections, and control what each participant can see.

### Account Sharing
Accounts are explicitly shared into workspaces rather than duplicated. Each share grants either **Full Access** (balance, transactions, holdings) or **Balance Only** visibility. Shares are revocable at any time and the underlying account data remains private to its owner.

### Personal Dashboard
The personal workspace dashboard covers net worth, checking and savings, investments, crypto wallets, debt, and cash-to-play — all in a single mobile-first view. Accounts are grouped by institution with asset drawers for detailed breakdowns.

### Plaid Integration
Connect banks and brokerages via Plaid Link. Transactions sync incrementally using a cursor-based approach. OAuth institutions (Chase, Bank of America, etc.) are supported via `/plaid-oauth-return`. Access tokens are encrypted at rest with AES-256-GCM before DB storage.

### Crypto Wallets
Track public wallet addresses across seven chains — BTC, ETH, SOL, BNB, MATIC, ADA, XRP — without storing private keys. Exchange accounts show a holdings breakdown with a TradingView chart via the asset drawer.

### Manual Assets
Any tangible asset — property, vehicle, equipment — can be added as a manual account. The workspace dashboard renders a live value widget showing current estimate, purchase price, gain/loss, and acquisition date.

### Daily Brief
A full-screen ambient view that summarises net worth movement, upcoming attention items, and financial insights since the last visit. Designed for morning review. Accessible from the bottom nav.

### 2FA / TOTP
Two-factor authentication is fully implemented: setup flow, authenticator QR code, login verification, recovery codes, and an admin reset flow. Platform-level enforcement (require 2FA for all system admins, or all users) is configurable via the admin security panel.

### Admin Panel
Available at `/admin` to system admin accounts. Covers user management, workspace oversight, platform-wide audit log, session revocation, TOTP enforcement settings, and live security status.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript (strict) |
| Styling | Tailwind CSS v4 |
| Database | PostgreSQL |
| ORM | Prisma v5 |
| Auth | NextAuth v4 (JWT sessions) |
| Encryption | AES-256-GCM (`lib/plaid/encryption.ts`) |
| Bank data | Plaid |
| Crypto data | Public blockchain APIs |
| Hosting | Docker Compose (local) |
| External access | Cloudflare Tunnel |

---

## Local Setup

### Prerequisites

- Node.js 20+
- Docker + Docker Compose
- A [Plaid](https://plaid.com) developer account (sandbox is free)

### 1. Clone and install

```bash
git clone https://github.com/virtuarch/fintracker.git
cd fintracker
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your values. **Never commit `.env`.**

```bash
openssl rand -base64 32   # → NEXTAUTH_SECRET
openssl rand -hex 32      # → ENCRYPTION_KEY
```

### 3. Start the database

```bash
docker compose up -d db
```

### 4. Run migrations and generate client

```bash
npx prisma migrate dev
npx prisma generate
```

### 5. Seed demo data (optional)

```bash
npm run db:seed
```

Creates two fictional demo users with sample accounts, holdings, and transactions.

| User | Email | Username | Password |
|---|---|---|---|
| Jane Smith | `jane@example.com` | `janesmith` | `ChangeMe123!` |
| John Doe | `john@example.com` | `johndoe` | `ChangeMe123!` |
| Alex Chen | `alex@example.com` | `alexchen` | `ChangeMe123!` |
| System Admin | `admin@example.com` | `admin` | `ChangeMe123!` |

> Change these before any real deployment.

### 6. Start the app

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Useful Commands

```bash
npm run dev           # Start dev server
npm run build         # Production build
npm run lint          # ESLint
npm run db:migrate    # Run pending Prisma migrations
npm run db:seed       # Seed demo data
npm run db:studio     # Open Prisma Studio
npm run db:reset      # Reset DB and re-run migrations (destroys data)
```

---

## Security

- Passwords hashed with bcrypt (cost 12)
- Plaid access tokens encrypted at rest (AES-256-GCM)
- Route protection via `proxy.ts` — all `/dashboard/*` and `/admin/*` routes require a valid JWT session
- TOTP/2FA fully implemented with platform-level enforcement
- Audit log on every login, account change, session event, and workspace action
- System admin kill switch via `DISABLE_SYSTEM_ADMIN` env var
- Database never exposed publicly — accessible only inside the Docker network

---

## Roadmap

| Version | Theme |
|---|---|
| **v2.0** | Workspace Platform *(current)* |
| **v2.0.1** | Cloud Staging — Vercel + Supabase |
| **v2.1** | Collaborative Workspace Experience |
| **v2.2** | Ambient Intelligence Foundation |
| **v2.3** | Adaptive Dashboards & Specialized Workspace Intelligence |

---

## License

No license has been granted for this project at this time. The source code is published publicly for reference and portfolio purposes. All rights reserved unless otherwise stated.
