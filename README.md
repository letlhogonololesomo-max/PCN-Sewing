# PCN Sewing — Downtime & Maintenance Tools

Sewing-floor version of the PMT suite, on the Bullmer framework:
GitHub → Cloudflare Worker (static assets + `/api`) → D1 database `pcn_app`.

## Files
| File | Purpose |
|---|---|
| `index.html` | Launcher (home screen) |
| `scan.html` | Asset Tracker |
| `downtime.html` | Downtime Tracker (supervisor + mechanic) |
| `parts-request.html` | Standalone parts request |
| `dashboard.html` | Dashboard (Asset Tracking, Downtime, Asset Profile, Inventory, Line Change, Mechanics) |
| `config.js` | **All settings**: mechanics, lines, sections, shift times, faults, error codes, clerks, machine types, OneSignal App ID |
| `worker.js` | All `/api/*` routes |
| `wrangler.toml` | Worker name + D1 binding |
| `schema.sql` | Run once in the D1 console |
| `.assetsignore` | Keeps worker.js / wrangler.toml / schema.sql from being served publicly |

## Setup
1. Cloudflare → D1 → `pcn_app` → **Console**: paste `schema.sql`, run.
2. Copy the `pcn_app` **Database ID** into `wrangler.toml`.
3. Push all files to the GitHub repo root.
4. Cloudflare → Workers & Pages → Create → **Import a repository** → pick the repo (same as Bullmer). Deploy.
5. Open `https://pcn-sewing.lesomo-tools.uk` (custom domain set in wrangler.toml).

## Push notifications (optional)
1. OneSignal → New App → Web → Typical Site → Site URL = `https://pcn-sewing.lesomo-tools.uk`.
2. Paste the App ID into `config.js` → `oneSignalAppId`.
3. Worker → Settings → Variables and Secrets: add `ONESIGNAL_APP_ID` and `ONESIGNAL_REST_API_KEY` (encrypted).

## PINs
Inventory actions: 2587 · Mechanics tab: 2589 (stored as SHA-256 hashes in dashboard.html).
