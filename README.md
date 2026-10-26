# Daybook

Daybook is a self-hosted work management app with Monday-style boards, groups, subitems, updates, and automations. It runs on Node.js and SQLite, with no hosted account or paid service required. Its board interface, data model, and logo are independent of monday.com; Daybook is not affiliated with monday.com.

## Features

- Main Table, Kanban, and Calendar views for boards and items.
- Colored groups and status labels; inline editing; drag-to-reorder groups; board and group menus.
- Subitems with their own status, assignee, date, updates, and attachments.
- Item and subitem updates with photos and documents (5 MB per file).
- Board automations for status-driven moves, completion dates, update posts, due-date reminders, and monthly item creation. Due-date reminders appear in the automation run log; email and push delivery are not included.
- Search, filters, sorting, favorites, bulk actions, recurring items, and recoverable trash.
- CSV/JSON import and JSON export, including source-ID deduplication for repeat imports.
- Single-owner authentication, expiring sessions, CSRF protection, SQLite persistence, and online backups.

The public repository contains the app and installer. It contains no personal boards, imported Monday data, account credentials, or uploaded attachments.

## Install on a Linux server

Use a Linux server with Docker Engine, Docker Compose V2, `curl`, `getent`, and `ss`. Point a public DNS name at the server and allow inbound TCP ports 80 and 443. Caddy obtains and renews the HTTPS certificate automatically. UDP 443 is optional for HTTP/3.

Clone the repository on the server, or download its ZIP and upload the extracted folder. Then run:

```bash
cd daybook
chmod +x install.sh
./install.sh
```

The installer asks for your domain, optional certificate email, time zone, private loopback port, and owner username/password. It validates the setup, builds the app, creates the owner account through a hidden password prompt, starts Daybook and Caddy, and waits for a successful HTTPS health check. The generated `.env` and `config/Caddyfile` stay out of Git.

To update an existing installation after pulling a new version:

```bash
./install.sh --upgrade
```

The upgrade creates an integrity-checked SQLite backup and retains the previous application image before rebuilding. If an initial installation stops after writing its config, run `./install.sh --resume` to finish it. Use `./install.sh --help` for prerequisites.

The installer assumes it can own ports 80 and 443 on this server. If another reverse proxy already owns those ports, use the [manual deployment](#manual-deployment) path instead. Production requires `PUBLIC_URL` to be HTTPS.

## Manual deployment

Set `PUBLIC_URL=https://your-domain.example`, `APP_TIMEZONE`, and optionally `DAYBOOK_PORT` in `.env` (see `.env.example`). Configure an HTTPS reverse proxy to forward requests to `127.0.0.1:${DAYBOOK_PORT:-8098}` and overwrite `X-Real-IP` with the actual connecting client IP. Set `TRUST_PROXY=1` only for that trusted proxy. Then:

```bash
docker compose build
docker compose run --rm --no-deps daybook node scripts/account.mjs
docker compose up -d
curl -fsS http://127.0.0.1:8098/healthz
```

The account command creates the sole owner account. Running it again changes the credentials and invalidates existing sessions. There is no default production password. The base Compose file binds Daybook only to the server's loopback address and keeps SQLite and backup files in named volumes.

## Backups and restore

Create a consistent, integrity-checked SQLite backup:

```bash
docker compose -p daybook -f compose.yaml -f compose.install.yaml exec -T daybook node scripts/backup.mjs
```

The command prints the snapshot path inside the `daybook-backups` volume. Copy backups to storage outside the server, along with `/app/data/upload-assets` from the data volume. JSON exports include attachment metadata but not file bytes or account credentials. Test a restore against a separate volume before replacing a live database. Never copy only the live SQLite file while it is using WAL.

For a manual deployment without Caddy, omit `-f compose.install.yaml` from the backup command.

## Import data

CSV accepts `Title` (or `Name`, `Task`, `Item`), `Status`, `Priority`, `Due date` (`YYYY-MM-DD`), `Notes`, `Category`, `Quantity`, and `ID`. IDs make repeat imports idempotent. Native Daybook JSON is the most complete interchange format. Files in `data/`, `imports/`, and `monday-assets/` are private and intentionally ignored by Git.

Imported Monday update attachments can be served from `/app/data/monday-assets` when copied into the data volume by the owner. They are not bundled with this repository. Daybook is a one-time import destination, not a live Monday synchronization client.

## Develop locally

Requires Node.js 24.8 or newer in the Node 24 line. There are no npm dependencies or build steps.

```bash
npm run account
npm start
```

The development server binds to `127.0.0.1:8098`. `npm test` runs the persistence, import, automation, and authentication tests; `npm run check` checks the JavaScript syntax. Node's built-in SQLite module may print an experimental warning on some Node 24 releases.

## Scope

Daybook is a single-owner app. It does not implement Monday webhooks, collaboration permissions, email/push notifications, or time tracking. Test it with your own data before relying on it for important workflows.
