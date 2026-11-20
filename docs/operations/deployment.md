# Deployment Operations — `wazir.wael.bot`

## Infrastructure Discovery
- `wazir.wael.bot` is routed through Cloudflare (`cf-ray`, HTTP/2 TLS at Cloudflare edge).
- Authenticated `wrangler` CLI (`4.152.0`) is available on `WaelMacPro.local` with `pages (write)` and `workers (write)` permissions.
- `cable.wael.bot` is a separate existing deployment and must **not** be modified.

## Deployment Workflow
1. Build portal assets in `apps/portal/` and copy verified `dist/release-manifest.json` + downloadable artifacts.
2. Deploy to staging preview URL via `wrangler pages deploy apps/portal --project-name wazir-portal --branch staging`.
3. Verify HTTP 200, TLS, component explorer, public demo separation, downloads, and zero console errors.
4. Promote to production (`--branch main`) and bind custom domain `wazir.wael.bot` if not already bound, or update Cloudflare Worker/Pages route.
