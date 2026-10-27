# Kamai — STURDY public; SPEED private dashboard

Public browser/search API and payment-backed service used by other applications: test/verify and obtain explicit confirmation for public behavior changes. Purely private dashboard changes are SPEED after quick verification. Follow [/home/b11/code/AGENTS.md](/home/b11/code/AGENTS.md).

## Add a feature
- TypeScript/Express 5 backend: `src/api/` routes, `src/browser/` Playwright sessions/strategies, `src/payment/` credits/x402, `src/screenshot/`, `src/genimage/`, and `src/brochure/`.
- Update `skill.md` and the served copies when the API contract changes. Preserve normalized dates, provider failover, domain memories and request-key idempotency.
- The separate `dashboard/` is Next.js 15; it has its own `package.json`. Do not treat the root as a Next app.

## Fix and verify
- Backend: `npm ci`, `npm run build` (TypeScript), then targeted endpoint verification on an isolated instance.
- Dashboard: `npm --prefix dashboard run build`; its local dev command is `npm --prefix dashboard run dev` on 3200.
- No test or lint scripts are defined in either package. Inspect `src/api/` for the exact contract; do not claim a nonexistent suite passed.
- Health is `/health`. Search, screenshots, generation and Apify collection can incur charges; do not use a new paid job merely to test deployment.

## Deploy and roll back
- Current destination: `b11-apps:/opt/kamai`, `ovh-kamai.service`, port 3100, public https://kamai.b11.dev. Use `sudo ssh b11-apps`, not `ssh browse` or `ssh kamai`.
- Inspect `sudo ssh b11-apps 'systemctl show ovh-kamai.service -p WorkingDirectory -p ExecStart -p ActiveState'`.
- Read `/home/b11/PRODUCTION-ACCESS.md`: `/usr/local/libexec/kamai-sentigen-target/target-runtime.py` guards startup against `/etc/kamai-sentigen-target/`. A checked build must be staged with a coherent successor startup inventory before a targeted restart.
- Preserve the previous code/dist/dependencies and guard configuration for rollback; preserve the production environment, `browse_memories.db`, `credits.db`, browser/session data and image stores. Use consistent SQLite backups for schema changes.
- Verify served `/skill.md`, release hashes, health and changed endpoints. Restore the previous code/guard pair for rollback; never restore stale credit data.
- Own only Kamai's process and scoped `kamai-domain-cert-renew.timer/service`. Coordinate shared runtime/ingress changes with Sentigen and callers.

## Pitfalls
- README still describes Vultr/PM2. The current service is systemd with pinned startup inputs; neither a successful build nor a PM2 command proves deployment.
- HTTP 404 means a route is missing; empty/private social content is a successful empty result, not “route not deployed.”
- The checkout has pre-existing URL/documentation edits. Preserve them. Do not copy local `.env` into a release.
- Native `better-sqlite3` and Chromium need the destination's platform; do not copy Arch `node_modules` to Ubuntu.

Inspected 2026-10-27.
