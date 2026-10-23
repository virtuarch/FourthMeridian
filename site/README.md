# site/ — fourthmeridian.com

The public Fourth Meridian website. **A disposable, zero-authority security domain.**
A complete compromise of this project grants nothing in the financial application:
no session, no database, no provider credential, no secret, no API.

The authenticated application (`app.fourthmeridian.com`) is the repository root and the
sole financial authority. Architecture and staging: `docs/plans/PUBLIC-APP-DOMAIN-SPLIT-ARCHITECTURE.md` §18.

## What it is

| | |
|---|---|
| Framework | Next 16.2.7 (App Router), React 19.2.4, own `package.json` + `package-lock.json` |
| Output | **Static HTML export** (`output: "export"`): no server runtime, no route handlers, no middleware, no image optimizer |
| Pages | `/` `/about` `/security` `/request-access` `/terms` `/privacy` `/legal/ai`, plus `robots.txt`, `sitemap.xml`, icons, 404 |
| Runtime dependencies | `next`, `react`, `react-dom`, `react-markdown`, `remark-gfm` |
| Secrets | **None.** It reads two public origins and nothing else |
| Cookies / sessions | None read, none written. It does not know whether a visitor is signed in |
| Network calls | None. "Sign in", "Get Started" and "Open Fourth Meridian" are plain links into the app |

## Environment — the complete list

| Variable | Production | Preview | Local `next dev` |
|---|---|---|---|
| `NEXT_PUBLIC_SITE_ORIGIN` | `https://fourthmeridian.com` | `https://preview.fourthmeridian.com` | default `http://localhost:3001` |
| `NEXT_PUBLIC_APP_ORIGIN` | `https://app.fourthmeridian.com` | `https://preview-app.fourthmeridian.com` | default `http://localhost:3000` |

Both are public origins, not secrets. `lib/public-config.ts` is the only reader and **fails the
build closed**:

- A production build without either origin fails.
- A production build with an origin that is http, loopback, or carries a path or credentials fails.
- A **Preview build naming a Production origin** fails.
- Only the Production site origin on a Production build is indexable. Everything else emits
  `Disallow: /` and `noindex`.

`VERCEL_ENV` and `NODE_ENV` are read for those checks; Vercel sets them, you do not.

## Commands

```bash
cd site
npm ci
npm run dev               # http://localhost:3001, linking to the app at http://localhost:3000
npm run verify            # structural tests + typecheck + lint + clean-environment build
npm run build:clean-env   # `next build` with ONLY PATH/HOME + the two origins, then audits out/
```

Node 24 (`site/.nvmrc`, same major as the app).

## The boundary, and what proves it

| Property | Proof |
|---|---|
| Every import resolves inside `site/` or to an allowlisted, declared package; no `@/` (the app's alias), no `next/headers`/`next/server` | `tests/imports.test.mts` (TypeScript AST) |
| No database, session, provider, telemetry or credential package at **any depth** of the lockfile; nothing linked from the repo | `tests/packages.test.mts` |
| Only `lib/public-config.ts` reads `process.env`, only four allowlisted names, by literal access; no env file but `.env.example` | `tests/public-env.test.mts` |
| No `/api`, route handler, middleware, server action, `fetch`, form, cookie or storage access; every absolute URL comes from the config; `vercel.json` has headers only | `tests/surface.test.mts` |
| tsconfig/eslint/test/Next roots never leave `site/` | `tests/discovery.test.mts` |
| Builds with no application secret; output has no secret-shaped string, no `/api` reference, no foreign origin, no server function | `scripts/clean-env-build.mts` |
| The **app's** tsc, eslint, Tailwind scan and test discovery skip `site/`; the app imports nothing from it; legal text, copy and design tokens stay identical | `lib/public-site-boundary.test.ts` (root suite) |

`eslint.config.mjs` mirrors the import and env rules so violations show in the editor too.

## Deliberate copies (guarded, temporary)

- `content/legal/*.md` and `content/copy.ts` are **byte-identical** to the app's `content/marketing/*`.
  The app still serves its own marketing pages until domain-split Stage F, so two copies exist. The
  root test fails on any difference: edit both together.
- `app/globals.css` carries the 19 design tokens the site uses, verbatim from the app's
  `app/globals.css` (dark theme). The root test fails on drift: change the app first, then port.
- `public/brand/fm-mark-dark-128.png` and `public/hero/earth-mena.jpg` are derived from the app's
  `public/fm-mark-dark.png` (1254 px, 1.4 MB) and `public/hero/earth-mena.png` (2.2 MB), because a
  static export serves images unoptimised:
  `sips -s format png -z 128 128 public/fm-mark-dark.png --out site/public/brand/fm-mark-dark-128.png`,
  `sips -s format jpeg -s formatOptions 72 public/hero/earth-mena.png --out site/public/hero/earth-mena.jpg`.
  Icons are copies of `app/favicon.ico`, `app/icon.png` (resized to 192 px) and `public/icons/apple-touch-icon.png`.

## Owner actions: create the Vercel project (Stage B)

**Nothing in this list touches the existing application project, a domain, DNS, Plaid or a secret.**

1. Vercel → **Add New → Project** → import this repository.
2. **Project name:** e.g. `fourth-meridian-site`.
3. **Framework preset:** Next.js. **Root Directory:** `site`.
4. **Build & Output settings:** leave the defaults (`npm install` / `next build`). `site/vercel.json` supplies the headers.
5. **Settings → General → Root Directory → "Include files outside of the Root Directory in the Build Step": OFF.**
6. **Node.js version:** 24.x (matches `engines.node`).
7. **Environment Variables:** add exactly two, both plain (not Sensitive; they are public):
   - Production: `NEXT_PUBLIC_SITE_ORIGIN=https://fourthmeridian.com`, `NEXT_PUBLIC_APP_ORIGIN=https://app.fourthmeridian.com`
   - Preview: `NEXT_PUBLIC_SITE_ORIGIN=https://preview.fourthmeridian.com`, `NEXT_PUBLIC_APP_ORIGIN=https://preview-app.fourthmeridian.com`

   Add nothing else. In particular, never copy a variable from the application project.
8. **Shared Environment Variables:** link **none** (Team → Settings → Environment Variables: confirm none is attached to this project).
9. **Crons:** none. `site/vercel.json` declares `"crons": []`; the project's Cron Jobs tab must be empty.
10. **Ignored Build Step:** `git diff --quiet HEAD^ HEAD -- .`, so the site rebuilds only when `site/` changes.
    (The application project should likewise ignore `site/`-only changes; see §18 of the plan.)
11. **Domains: attach none yet.** Verify on the project's `*.vercel.app` URL:
    - every page renders;
    - "Sign in", "Get Started" and "Open Fourth Meridian" point at the configured app origin;
    - `/robots.txt` says `Disallow: /` on Preview;
    - the response headers include the CSP, HSTS and `X-Frame-Options: DENY`;
    - the browser console shows no CSP violation.

    Because the origin checks fail closed, a `*.vercel.app` Production deployment builds only with
    the two Production origins set. That is expected: the links point at the app, which is not yet
    on `app.` (Stage C).

Domain attachment is Stage D and comes after `app.fourthmeridian.com` is live (Stage C).
