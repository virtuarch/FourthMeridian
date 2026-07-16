# Fourth Meridian

A multi-tenant personal-finance intelligence platform built on Next.js 16 / Prisma / PostgreSQL, deployed to **Vercel** with a **Supabase** Postgres database. Members organize accounts into collaborative **Spaces**, and a deterministic-first AI analyst narrates pre-computed, provenance-carrying facts (it never calculates figures itself).

---

## Project Status & Documentation

- **[`STATUS.md`](STATUS.md)** — the current-state snapshot (version, active work, blockers, next steps, production readiness).
- **[`docs/`](docs/README.md)** — the durable documentation set: `doctrine/` (the rules that bind the code), `systems/` (why each subsystem exists + its contracts), `architecture/` (decision records), `plans/` (roadmap + parked ideas), `operations/`, `releases/`, `audits/`, `design/`.

Features, APIs, and schemas evolve between versions. `docs/` is the source of intent; the code is the source of truth.

---

## Major Features

### Multi-Space Architecture
Every user gets a personal space on signup. Additional shared spaces can be created for households, investment clubs, advisory relationships, or any collaborative finance context — each with its own dashboard, goals, and account visibility rules.

### Roles and Permissions
Each space has four roles: **Owner**, **Admin**, **Member**, and **Viewer**. Role enforcement runs at both the API and UI layer. Owners can manage members, configure sections, and control what each participant can see.

### Account Sharing
Accounts are explicitly shared into spaces rather than duplicated. Each share grants either **Full Access** (balance, transactions, holdings) or **Balance Only** visibility. Shares are revocable at any time and the underlying account data remains private to its owner.

### Personal Dashboard
The personal space dashboard covers net worth, checking and savings, investments, crypto wallets, debt, and cash-to-play — all in a single mobile-first view. Accounts are grouped by institution with asset drawers for detailed breakdowns.

### Plaid Integration
Connect banks and brokerages via Plaid Link. Transactions sync incrementally using a cursor-based approach. OAuth institutions (Chase, Bank of America, etc.) are supported via `/plaid-oauth-return`. Access tokens are encrypted at rest with AES-256-GCM before DB storage.

### Crypto Wallets
Track public wallet addresses across seven chains — BTC, ETH, SOL, BNB, MATIC, ADA, XRP — without storing private keys. Exchange accounts show a holdings breakdown with a TradingView chart via the asset drawer.

### Manual Assets
Any tangible asset — property, vehicle, equipment — can be added as a manual account. The space dashboard renders a live value widget showing current estimate, purchase price, gain/loss, and acquisition date.

### Daily Brief
A full-screen ambient view that summarises net worth movement, upcoming attention items, and financial insights since the last visit. Designed for morning review. Accessible from the bottom nav.

### 2FA / TOTP
Two-factor authentication is fully implemented: setup flow, authenticator QR code, login verification, recovery codes, and an admin reset flow. Platform-level enforcement (require 2FA for all system admins, or all users) is configurable via the admin security panel.

### Admin Panel
Available at `/admin` to system admin accounts. Covers user management, space oversight, platform-wide audit log, session revocation, TOTP enforcement settings, and live security status.

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
| Hosting | Vercel (production); Docker Compose Postgres for local dev |
| Database (prod) | Supabase Postgres |
| Background jobs | Vercel Cron → typed job registry + dispatcher (`lib/jobs/`) |

---

## Local Setup

Production runs on Vercel + Supabase; the steps below spin up a local Postgres (via Docker) for development. For staging/production, set `DATABASE_URL` / `DIRECT_URL` to the Supabase connection strings (see `.env.example`) instead of running the local db.

### Prerequisites

- Node.js 20+
- Docker + Docker Compose (local Postgres only)
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

### Alternative: run everything in Docker

```bash
docker compose up -d          # app + db containers
npx prisma migrate dev && npx prisma generate
open http://localhost:3000
```

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
- Audit log on every login, account change, session event, and space action
- System admin kill switch via `DISABLE_SYSTEM_ADMIN` env var
- Database never exposed publicly — accessible only inside the Docker network

---

## Roadmap

See [`docs/plans/ROADMAP.md`](docs/plans/ROADMAP.md) for the current roadmap with phase exit criteria, and [`STATUS.md`](STATUS.md) for what's active right now.

---

## License

No license has been granted for this project at this time. The source code is published publicly for reference and portfolio purposes. All rights reserved unless otherwise stated.
