# kamai

Headless browser and search backend for LLM agentic apps. Express + Playwright (Chromium) with per-domain memory, session persistence, web/image/social search with automatic provider failover, and USDC micropayments on Celo.

Public URL: `https://kamai.minai.work` — LLM-facing integration spec: [`skill.md`](skill.md) (also served at `/skill.md`).

## Stack

- **TypeScript / Express 5** — source in `src/`, compiled to `dist/` (`npm run build`)
- **Playwright + Chromium** — headless browsing with stealth measures (`src/browser/`)
- **SQLite** (`better-sqlite3`) — per-domain memories (`browse_memories.db`), credit ledger (`credits.db`)
- **PM2** — process manager on the VPS (`pm2 start dist/index.js --name kamai`)

## Endpoints

| Route | Auth | Description |
|-------|------|-------------|
| `POST /api/v1/browse` | credits | Browse a URL with optional actions; returns text, links, forms, memories |
| `POST /api/v1/search/web` | credits | Web search — multi-provider with automatic failover |
| `POST /api/v1/search/news` | credits | News search — news indexes, exact freshness windows, recency-ranked, non-news sources filtered |
| `POST /api/v1/search/image` | credits | Image search — multi-provider with automatic failover |
| `POST /api/v1/search/social` | credits | Social search: x/twitter, reddit, linkedin, tiktok, instagram, youtube, threads, pinterest, facebook posts + events — freshness windows supported |
| `POST /api/v1/screenshot` | credits | Screenshot the relevant part of a URL — social posts via official embeds |
| `GET /api/v1/screenshot/:id/image` | — | Fetch the captured image (public, expiring) |
| `POST /api/v1/brochure/generate` | credits | Generate a PDF brochure from structured content |
| `GET /api/v1/brochure/:id/download` | — | Download a generated PDF |
| `GET /api/v1/brochure/templates` | — | List brochure templates |
| `PATCH /api/v1/brochure/:id` | credits | Update and re-render a brochure |
| `POST /api/v1/session` | rate-limited | Create an explicit browser session |
| `GET/DELETE /api/v1/session/:id` | rate-limited | Session status / destroy |
| `GET /api/v1/account` | wallet | Account info, balance, API key |
| `POST /api/v1/account/generate-key` | wallet | Generate/regenerate an API key |
| `POST /api/v1/deposit` | rate-limited | Register a USDC (Celo) deposit by tx hash |
| `GET /api/v1/deposit/balance` | wallet | Check credit balance |
| `GET/POST /browse/memories` | — | Read/save per-domain learnings (`DELETE /browse/memories/:id` too) |
| `GET /health` | — | Health check |
| `GET /` | — | Landing page (API documentation) |
| `GET /skill.md` | — | Machine-readable integration spec |

**Legacy aliases (no payment, for sister app backends):** `POST /browse`, `POST /search/web`, `POST /search/image`, and `/api/v1/browse/memories` (mirrors `/browse/memories`).

## Auth & pricing

Identify with `x-api-key` or `x-wallet-address` header. Sister apps (keys in `SISTER_API_KEYS`) bypass payment entirely. Everyone else pays per request from a USDC credit balance; first request each day is free.

| Request | Cost |
|---------|------|
| Browse (no actions) | $0.009 |
| Browse with actions | $0.013 |
| Search (web/news/image) | $0.003 |
| Screenshot | $0.015 |
| Brochure PDF | $0.050 |

## How it works

- **Browse** navigates with Playwright, optionally runs up to 20 actions (`type`, `click`, `click_and_wait`, `submit`, `select`, `wait`, `wait_ms`, `scroll_to`, `js_click`, `set_date`, `evaluate`), then extracts text/links/forms. Blocks `file:`, `data:`, localhost, private IPs.
- **Auto-sessions**: each caller identity (API key → wallet → IP) gets a persistent browser context; cookies/auth/localStorage survive across requests, expiring after 30 min idle.
- **Strategies**: known domains bypass Playwright — YouTube → yt-dlp, GitHub → API (`src/browser/strategies/`). A domain memory with a `strategy` field overrides routing.
- **Domain memories**: learnings saved via `POST /browse/memories` are attached to every browse response for that domain, so agents improve over time.
- **Screenshots** (`src/browser/screenshot.ts`): social posts are captured by rendering the platform's *own* embed iframe — verified working from this VPS's datacenter IP for X, Instagram, LinkedIn, Facebook, Threads, Bluesky and TikTok, none of which render a usable post from their raw permalink. Reddit blocks the server IP on every surface, so it goes through Apify and is rendered as a capture card. Ordinary pages are cropped to the LCP region. `fullPage` is never used: on a large real page it returns a **0-byte buffer after 51 seconds**, so capture is always `setViewportSize` → `scrollTo` → viewport shot, which is ~150x faster.
- **Search normalization** (`src/api/searchNormalize.ts`): news and social results are uniform regardless of which provider answered — `publishedAt` is always ISO 8601 or null (providers emit unix epochs, `"2 hours ago"`, `"Aug 5, 2026"`), ranking is newest-first, and `/news` drops non-news sources via a blocklist extendable with `NEWS_BLOCKED_HOSTS`.

## Deployment

Runs on a shared Vultr VPS (`45.76.180.229`, ssh alias `browse`) at `/opt/kamai`, behind nginx (`/etc/nginx/sites-enabled/kamai`, port 443 → 3100). TLS via certbot (Let's Encrypt, auto-renewal). The box hosts several other apps — be careful with `nginx -t` before any reload.

```bash
ssh browse
cd /opt/kamai
git pull origin main
npm install
npm run build
pm2 restart kamai        # runs dist/index.js; PORT/HOST come from .env
```

First-time env setup: copy `.env.example` to `.env` and fill in `SERPER_API_KEY`, `BRAVE_API_KEY`, `SOCIALCRAWL_API_KEY`, `SISTER_API_KEYS`, `WALLET_SEED`, `PAYMENT_RECIPIENT_ADDRESS`.

## Project structure

```
src/
  index.ts              — Express app wiring, route mounts, startup/shutdown
  api/
    middleware/         — rate-limit
    routes/             — browse, search, memories, brochure, session, account, deposit, health
    searchNormalize.ts  — ISO timestamp normalization, recency sort, news-source blocklist
    apifySearch.ts      — Apify actor registry + 72h actor health checks
    usage.ts            — request analytics + /adm dashboard
  browser/
    engine.ts           — shared Chromium instance + stealth context
    browse.ts           — navigate → actions → extract
    screenshot.ts       — capture engine (region selection, overlay nuke, validation)
    embeds.ts           — social post URL → official embed URL
    urlGuard.ts         — SSRF guard, re-checked after redirects
  screenshot/
    storage.ts          — SQLite + expiring image blobs
    reddit.ts           — Apify post fetch + capture-card rendering
    actions.ts          — the 11 action types, overlay dismissal, text= selectors
    extract.ts          — text/links/forms extraction
    session-manager.ts  — per-caller persistent contexts
    strategies/         — yt-dlp (YouTube), github-api
  payment/
    middleware.ts       — credit charging, sister-key bypass, daily freebie
    credits.ts          — SQLite credit ledger
    wallet.ts           — HD wallet deposit-address derivation
    verifier.ts         — on-chain deposit verification
    config.ts           — chains, pricing, sister keys
  brochure/             — react-pdf templates, renderer, expiring storage
dashboard/              — Next.js landing page (separate app, port 3200)
```
