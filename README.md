# FinTracker

A local-first personal finance dashboard. Runs on your laptop, accessible from your iPhone and any device via a Cloudflare tunnel. Installable as a PWA from the iPhone home screen.

---

## 🚧 Project Status

FinTracker is an actively developed personal project and long-term financial intelligence platform.

The current public release (v1) represents the foundational architecture and is under active development. Features, APIs, database schemas, and user interfaces may evolve significantly between versions as the platform grows.

While the project is functional, it should currently be considered a development build rather than a finished product.

---

## 🎯 Vision

The long-term goal of FinTracker is to become an AI-native financial intelligence platform built around private personal workspaces and collaborative shared workspaces.

Rather than acting solely as a budgeting application, the platform is being designed to combine financial aggregation, portfolio analysis, debt tracking, historical net worth analysis, AI-assisted financial guidance, collaborative workspaces, and privacy-preserving financial sharing.

Future versions are planned to include persistent AI memory, workspace-based intelligence, automated financial insights, and advanced collaboration features — while maintaining strong security and user privacy.

---

## 📸 Screenshots

<p align="center">
  <img src="docs/images/dashboard.png" alt="Dashboard" width="900" />
</p>

<p align="center">
  <img src="docs/images/workspaces.png" alt="Workspaces" width="900" />
</p>

<p align="center">
  <img src="docs/images/ai-advice.png" alt="AI Advice" width="900" />
</p>

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript |
| Styling | Tailwind CSS v4 |
| Database | PostgreSQL |
| ORM | Prisma v5 |
| Auth | NextAuth v4 (JWT sessions) |
| Encryption | AES-256-GCM (custom, `lib/encryption.ts`) |
| Bank data | Plaid |
| Crypto data | Public blockchain APIs |
| Hosting | Docker Compose (local) |
| External access | Cloudflare Tunnel (planned) |

---

## Core Features

- **Net worth dashboard** — checking, savings, investments, crypto, debt, and cash-to-play in one view
- **Plaid integration** — connect banks and brokerages via Plaid Link; incremental transaction sync
- **Crypto wallets** — track public wallet addresses (BTC, ETH, SOL, BNB, MATIC, ADA, XRP) without storing private keys
- **Asset drawer** — TradingView chart for single-asset wallets; holdings breakdown for exchange accounts
- **Workspaces** — collaborate on shared finances; public/private workspaces, invite by username, role-based access
- **Admin panel** — user management, audit log, platform-wide stats at `/admin`
- **PWA-ready** — mobile-first layout, bottom nav, installable from iPhone Safari

---

## Security

- Passwords hashed with bcrypt (cost 12)
- Plaid access tokens encrypted at rest with AES-256-GCM before DB storage
- Route protection via `proxy.ts` (Next.js 16) — all `/dashboard/*` and `/admin/*` routes require a valid JWT session
- Audit log on every login, account change, and workspace event
- Database never exposed publicly — only accessible inside the Docker network
- 2FA/TOTP model is in the schema; UI flow is a planned milestone

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

### 2. Set environment variables

```bash
cp .env.example .env
```

Then fill in `.env` with your real values (see [Environment Variables](#environment-variables) below). **Never commit `.env`.**

### 3. Start PostgreSQL

```bash
docker compose up -d db
```

### 4. Run migrations and generate Prisma client

```bash
npx prisma migrate dev
npx prisma generate
```

### 5. (Optional) Seed demo data

```bash
npm run db:seed
```

This creates two fictional demo users with sample accounts, holdings, and transactions. All data is entirely made up — no real names, balances, or institutions.

**Demo credentials (local dev only — change before any real deployment):**

| User | Email | Username | Password |
|---|---|---|---|
| Jane Smith (primary) | `jane@example.com` | `janesmith` | `ChangeMe123!` |
| John Doe (secondary) | `john@example.com` | `johndoe` | `ChangeMe123!` |
| System Admin | `admin@example.com` | `admin` | `ChangeMe123!` |


### 6. Start the app

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Environment Variables

Copy `.env.example` to `.env` and replace every `change_me` value.

```env
# PostgreSQL
POSTGRES_USER=fintracker
POSTGRES_PASSWORD=your_strong_password
POSTGRES_DB=fintracker
DATABASE_URL="postgresql://fintracker:your_strong_password@localhost:5432/fintracker?schema=public"

# NextAuth
NEXTAUTH_SECRET=        # openssl rand -base64 32
NEXTAUTH_URL=http://localhost:3000

# Token encryption (AES-256-GCM)
ENCRYPTION_KEY=         # openssl rand -hex 32

# Plaid
PLAID_CLIENT_ID=your_plaid_client_id
PLAID_SECRET=your_plaid_secret
PLAID_ENV=sandbox       # sandbox | development | production

# AI advice engine (future)
ANTHROPIC_API_KEY=

# Crypto wallet sync (future)
ETHERSCAN_API_KEY=
HELIUS_API_KEY=
```

Generate secrets:

```bash
openssl rand -base64 32   # NEXTAUTH_SECRET
openssl rand -hex 32      # ENCRYPTION_KEY
```

---

## Useful Commands

```bash
npm run dev           # Start dev server
npm run build         # Production build
npm run lint          # ESLint
npm run db:migrate    # Run pending Prisma migrations
npm run db:seed       # Seed demo data
npm run db:studio     # Open Prisma Studio (DB browser)
npm run db:reset      # Reset DB and re-run migrations (destroys data)
```

---

## Known Limitations

- Background sync jobs are not yet running — data refreshes are manual (the Refresh button triggers a Plaid sync; crypto wallet balances update on each sync run)
- 2FA/TOTP model exists in the schema but the setup and login-verification UI is not built yet
- Cloudflare tunnel setup is documented but not configured — the app is local-only until that step
- Historical net worth chart UI is not built yet (snapshots are being written to the DB already)
- AI advice engine is not yet implemented

---

## Roadmap

See [ROADMAP.md](./ROADMAP.md) for the full milestone plan.

Next up: background sync jobs → historical charts → FICO/manual entry → AI advice → Cloudflare tunnel.

## License

No license has been granted for this project at this time.

The source code is published publicly for reference and portfolio purposes. All rights are reserved unless otherwise stated.