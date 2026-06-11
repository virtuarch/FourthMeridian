# FinTracker — Architecture & Planning Reference

> ⚠️ **ARCHIVED — does not reflect the current v1 architecture.**
> This was the original pre-code planning document generated before implementation began.
> Use **README.md**, **ROADMAP.md**, and **docs/PROJECT_STATE.md** as the source of truth.

> Generated: June 8, 2026. Approved before code was written.

---

## 1. Full Project Architecture

**Runtime stack:**
- **Next.js 14 (App Router)** — frontend + API routes
- **PostgreSQL** — primary datastore
- **Prisma** — type-safe ORM + migrations
- **NextAuth.js** — credentials + TOTP 2FA
- **node-cron** — background jobs (dedicated worker container)
- **Docker Compose** — local orchestration

**Docker services:**

| Service | Image | Role |
|---|---|---|
| `app` | custom Next.js | Web app + API, port 3000 (internal only) |
| `db` | postgres:16 | Database, port 5432 (internal only) |
| `worker` | same as app | Cron scheduler + sync jobs |
| `cloudflared` | cloudflare/cloudflared | Tunnel daemon |

**Request flow:**
```
iPhone Safari
  → Cloudflare Edge (TLS)
  → Cloudflare Tunnel
  → cloudflared container
  → app container :3000
  → PostgreSQL (Docker network only)
```

---

## 2. Database Schema

```sql
users
  id UUID PK, email TEXT UNIQUE, password_hash TEXT,
  totp_secret TEXT (encrypted), totp_enabled BOOLEAN, created_at TIMESTAMPTZ

sessions                        -- NextAuth managed
  id, sessionToken, userId, expires

accounts
  id UUID PK, user_id UUID FK, name TEXT,
  type ENUM(checking|savings|investment|crypto|debt|other),
  institution TEXT, plaid_account_id TEXT NULL,
  is_manual BOOLEAN, currency TEXT, created_at TIMESTAMPTZ

balances
  id UUID PK, account_id UUID FK, balance DECIMAL(18,2),
  recorded_at TIMESTAMPTZ (indexed)

holdings
  id UUID PK, account_id UUID FK, symbol TEXT,
  quantity DECIMAL(24,8), cost_basis DECIMAL(18,2) NULL,
  market_value DECIMAL(18,2), recorded_at TIMESTAMPTZ

plaid_items
  id UUID PK, user_id UUID FK, access_token TEXT (AES-256-GCM encrypted),
  item_id TEXT, institution_name TEXT, last_synced_at TIMESTAMPTZ

api_credentials
  id UUID PK, user_id UUID FK, service TEXT,
  encrypted_key TEXT, encrypted_secret TEXT NULL, created_at TIMESTAMPTZ

manual_entries
  id UUID PK, user_id UUID FK, field TEXT,
  value DECIMAL(18,2), notes TEXT NULL, recorded_at TIMESTAMPTZ

snapshots
  id UUID PK, user_id UUID FK, net_worth DECIMAL(18,2),
  total_assets DECIMAL(18,2), total_debt DECIMAL(18,2),
  total_cash DECIMAL(18,2), total_investments DECIMAL(18,2),
  total_crypto DECIMAL(18,2), cash_to_play DECIMAL(18,2),
  recorded_at TIMESTAMPTZ

ai_advice
  id UUID PK, user_id UUID FK, advice_text TEXT,
  risk_level ENUM(low|medium|high), play_ready BOOLEAN,
  summary TEXT, generated_at TIMESTAMPTZ

audit_logs
  id UUID PK, user_id UUID FK NULL, action TEXT,
  ip_address TEXT, user_agent TEXT, metadata JSONB NULL, created_at TIMESTAMPTZ
```

---

## 3. Folder Structure

```
fintracker/
├── docker-compose.yml
├── .env.example
├── .env.local                  ← gitignored, real secrets live here
├── PLAN.md                     ← this file
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── public/
│   ├── manifest.json
│   ├── sw.js
│   └── icons/
├── app/
│   ├── layout.tsx
│   ├── page.tsx                ← redirects to /dashboard
│   ├── (auth)/login/
│   ├── (auth)/setup-2fa/
│   ├── dashboard/
│   │   ├── layout.tsx          ← header + bottom nav
│   │   ├── page.tsx            ← main dashboard
│   │   ├── accounts/
│   │   ├── holdings/
│   │   ├── history/
│   │   └── advice/
│   └── api/
│       ├── auth/[...nextauth]/
│       ├── accounts/
│       ├── balances/
│       ├── holdings/
│       ├── snapshots/
│       ├── advice/
│       ├── plaid/
│       ├── credentials/
│       └── manual/
├── components/
│   ├── ui/                     ← Card, BottomNav, etc.
│   ├── dashboard/              ← NetWorthCard, AccountCard, etc.
│   └── charts/                 ← NetWorthChart, AllocationChart, etc.
├── lib/
│   ├── prisma.ts
│   ├── auth.ts
│   ├── encryption.ts           ← AES-256-GCM helpers
│   ├── plaid.ts
│   ├── simplefin.ts
│   ├── crypto-apis.ts
│   ├── ai-advice.ts
│   └── market-data.ts
├── jobs/
│   ├── scheduler.ts
│   ├── sync-banks.ts
│   ├── sync-crypto.ts
│   ├── take-snapshot.ts
│   └── run-ai-advice.ts
├── types/
│   └── index.ts
└── cloudflared/
    └── config.yml
```

---

## 4. Security Model

- **Passwords:** bcrypt, cost factor 12. Never stored plaintext.
- **Sessions:** DB-backed (not JWT) — revocable server-side.
- **2FA:** TOTP via `speakeasy`. Secret encrypted at rest. QR shown once.
- **Rate limiting:** 5 login attempts / 15 min per IP via middleware.
- **Token encryption:** AES-256-GCM. Each value has its own IV. Key in `.env.local` only.
- **Network:** App container never binds to public interface. DB never exposed. All traffic via Cloudflare Tunnel.
- **Headers:** CSP, HSTS, X-Frame-Options: DENY, X-Content-Type-Options via Next.js middleware.
- **Audit logs:** Append-only. Login, sync, 2FA, and credential events logged with IP + user agent.
- **Never stored:** Bank passwords, brokerage passwords, plaintext API tokens.

---

## 5. Data-Source Plan

### Banks & Investments
- **Plaid (primary):** OAuth Link flow, encrypted access_token, `/accounts/balance/get` + `/investments/holdings/get`
- **SimpleFIN (alternative):** $1.50 one-time, REST API, faster to set up, no approval needed

### Crypto
| Source | Method |
|---|---|
| Coinbase, Kraken, Binance | Read-only API keys (encrypted at rest) |
| BTC wallets | Blockchain.com / Blockstream public API |
| ETH / ERC-20 | Etherscan API (free tier) |
| SOL | Helius / Solscan API |
| Prices | CoinGecko free API |

### Debt
- Plaid Liabilities product covers credit cards, loans, mortgages
- Manual entry fallback for anything Plaid misses

### FICO Score
- **Recommendation: manual entry.** Banks (Chase, Citi, Amex) show free FICO scores.
- Monthly update reminder built into AI advice engine.
- Experian API exists but requires business approval + is paid.

---

## 6. Hosting Plan

```
Docker Compose on laptop
  ├── app :3000 (internal only)
  ├── db  :5432 (internal only)
  ├── worker
  └── cloudflared ──► Cloudflare Edge ──► fintracker.yourdomain.com
```

**Setup steps:**
1. Create Cloudflare account (free)
2. Add domain (~$10/yr) or use free `*.trycloudflare.com` for dev
3. Create tunnel in Zero Trust dashboard → get tunnel token
4. cloudflared container authenticates + creates persistent tunnel
5. Ingress rule: `fintracker.yourdomain.com → http://app:3000`
6. Cloudflare manages DNS CNAME automatically
7. HTTPS handled entirely by Cloudflare (TLS 1.3)

**Keep laptop awake:** `caffeinate -i` on macOS, or System Settings → prevent sleep when plugged in.

**Cost:** ~$10/year for domain. Everything else is free.

---

## 7. PWA Install Plan

**`public/manifest.json`** — `display: standalone`, `start_url: /dashboard`, themed icons

**iOS meta tags in `layout.tsx`:**
```html
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="FinTracker" />
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
```

**Service worker:** cache app shell on install; network-first for API routes.

**Install steps on iPhone:**
1. Open `https://fintracker.yourdomain.com` in **Safari**
2. Tap Share → "Add to Home Screen"
3. Name it → Add
4. Opens full-screen, no browser chrome

**Notes:** iOS 16.4+ has solid PWA + service worker support. No push notifications by default (iOS 17.4+ with Web Push).

---

## 8. Build Roadmap

| # | Milestone | What gets built | Est. effort |
|---|---|---|---|
| M1 | **Scaffold** | Docker Compose, Next.js project, Prisma schema, `.env` setup, Cloudflare Tunnel live | 1 day |
| M2 | **Auth** | NextAuth credentials login, bcrypt, protected routes, TOTP 2FA setup/verify, audit log | 1–2 days |
| M3 | **Manual Data Entry** | Account CRUD, balance entry, FICO/debt forms, basic dashboard layout | 1–2 days |
| M4 | **PWA** | manifest.json, service worker, iOS meta tags, icons, Add to Home Screen tested | 0.5 day |
| M5 | **Plaid Integration** | Plaid Link flow, encrypted token storage, balance + holdings sync, sync job | 2–3 days |
| M6 | **Crypto Integration** | API key management, exchange sync, public wallet support, CoinGecko prices | 1–2 days |
| M7 | **Dashboard UI** | Net worth card, account cards, holdings table, debt tracker, FICO, cash-to-play, mobile-first polish | 2–3 days |
| M8 | **Historical Snapshots** | Daily snapshot cron, net worth chart, debt paydown chart, cash reserves chart | 1 day |
| M9 | **AI Advice Engine** | Cron schedule, prompt builder from snapshots + market data, LLM call, advice storage, dashboard banner + play/no-play | 2–3 days |
| M10 | **Hardening** | Rate limiting, CSP headers, security audit, error handling, loading states, offline SW, FICO reminder | 1–2 days |

**Total: ~2–3 weeks of focused evenings/weekends.**

**Dependency order:** M2 → everything. M3 ∥ M4. M5 ∥ M6 (after M3). M7 needs M5+M6. M8 needs M7. M9 needs M8.

---

## Open Decisions (resolve before M1)

1. **Plaid vs SimpleFIN first?** Recommend SimpleFIN — instant setup, no approval. Add Plaid later.
2. **LLM for advice engine?** Claude API (recommended), OpenAI, or local Ollama (data never leaves laptop).
3. **Custom domain now?** Recommend yes — stable PWA URL from day 1.
