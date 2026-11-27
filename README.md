# Daybook

Daybook is a self-hosted board workspace for projects, routines, and everyday tasks. Organize items into groups, track subitems and updates, and automate recurring work. It runs on Node.js and SQLite, with no hosted account or paid service required. Its board interface, data model, and logo are independent of monday.com; Daybook is not affiliated with monday.com.

## Features

- Main Table, Kanban, and Calendar views for boards and items.
- Colored groups and status labels; inline editing; drag-to-reorder groups and items, including moves between groups; board and group menus.
- Board-specific Text, Numbers, Date, and Status columns with editable item values, header menus, and saved column settings.
- Subitems with their own status, assignee, date, updates, and attachments.
- Item and subitem updates with photos and documents (5 MB per file).
- Board automations for status-driven moves, completion dates, update posts, due-date reminders, and monthly item creation. Due-date reminders appear in the automation run log; email and push delivery are not included.
- Search, filters, sorting, favorites, bulk actions, recurring items, and 30-day recoverable trash. Deleted boards and items are permanently removed after 30 days, including their updates and attachments.
- CSV/JSON import and JSON export, including source-ID deduplication for repeat imports.
- Named board invitations with View or Edit permission, optional sharing, and individual revocation.
- Reopen the last board you visited when you sign in on another device. Direct board, item, and invitation links open their destinations.
- Expiring account sessions, CSRF protection, SQLite persistence, and online backups.

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

The account command creates the sole owner account. Running it again changes the credentials and signs out the owner’s existing sessions. There is no default production password. The base Compose file binds Daybook only to the server's loopback address and keeps SQLite and backup files in named volumes.

## Share a board

Open a board and select **Share**. Enter an email address or mobile number, choose **View** or **Edit**, and select **Invite**. Daybook creates a pending account for a new contact and reuses that account on subsequent invitations. Ten-digit mobile numbers default to +1. Include the country code for other numbers. Existing Daybook usernames also work.

When Twilio is configured, selecting **Invite** sends a mobile recipient a text directly from Daybook. For a new account the text contains a board link and a setup code valid for 30 minutes. The recipient enters their number and code, chooses a password, and opens the board. Existing members sign in and accept the invitation. The owner and the member who sent the invitation can check delivery status and resend a pending text. A resend replaces the previous setup code.

For email invitations, or mobile invitations on installations without Twilio, the owner selects **Email invitation** or **Text invitation** to send a first-time setup message from their device. If another member created the invitation, the owner expands the recipient under **People with access** and selects **Prepare email** or **Prepare text message**. Existing accounts can use **Share invitation** or **Copy link**. Accepted boards appear under **Shared with me**.

Accounts may also be provisioned or reset from the installation directory:

```bash
docker compose -p daybook -f compose.yaml -f compose.install.yaml exec daybook node scripts/account.mjs --member
```

For local development use `npm run account -- --member`. Running the member command with an existing member’s username resets that member’s password.

The owner may enable **Sharing Allowed** for either permission. View members with sharing enabled may invite viewers. Edit members with sharing enabled may invite viewers or editors. Under **People with access**, the owner may adjust permissions, cancel a pending invitation, or remove one member. Removing a member preserves other accepted memberships and cancels that member’s outstanding invitations. Only the owner may invite a removed member back.

### Configure invitation texts

Set `DAYBOOK_TWILIO_ACCOUNT_SID` and `DAYBOOK_TWILIO_AUTH_TOKEN` in the installation's private `.env` or secret manager. Set `DAYBOOK_TWILIO_MESSAGING_SERVICE_SID` to the Messaging Service for Daybook, or set `DAYBOOK_TWILIO_FROM_NUMBER` to its SMS-capable number in international format. Setting both selects a specific sender in that service. Recreate the Daybook container after changing these settings.

Each invitation supplies its own delivery callback under `PUBLIC_URL`. The reverse proxy must forward POST requests to that URL. Daybook verifies Twilio's signature before recording a status. Unconfirmed sends can be checked in the Share panel before resending. Setup codes go directly to the recipient.

Before sending or resending an invitation text, the inviter reads the disclosure to the recipient and records their agreement in Share. Daybook records the disclosure, inviter, recipient account, and time for each submission.

For a server-only SMS program, create an `sms-program` directory beside the SQLite database and restart Daybook. While the sender is offline, mobile invitations stay pending for an explicit send when it becomes available. To publish the operator’s program notices, install `terms.html`, `privacy.html`, and `invitations.html` in that directory. Daybook serves them at `sms/terms`, `sms/privacy`, and `sms/invitations` under the workspace URL. A demonstration screenshot named `share.png` can accompany the invitation instructions. Use demonstration accounts for any public screenshot.

The sender and error handling in `lib/twilio` are adapted from LoanServe’s MIT-licensed `server/services/sms-provider-factory.ts`, `server/communications/sms/provider-errors.ts` and `server/webhooks/twilio-request.ts` at revision `70ecf319`.

To identify the registered business in invitation texts, place its name on one line in `sms-program/operator.txt` and restart Daybook. The sender then appears as “Daybook (business name)” in both new-account and existing-account invitations.

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

Requires Node.js 24.8 or newer in the Node 24 line.

```bash
npm ci
npm run account
npm start
```

The development server binds to `127.0.0.1:8098`. `npm test` runs the persistence, import, automation, and authentication tests; `npm run check` checks the JavaScript syntax. Node's built-in SQLite module may print an experimental warning on some Node 24 releases.

## Scope

Daybook has one workspace owner who creates boards, manages accounts, and imports data. Members use the boards shared with them. Monday webhooks, email/push notifications, and time tracking are outside the current scope.
