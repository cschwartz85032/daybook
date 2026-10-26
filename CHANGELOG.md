# Changelog

## v1.0.0 — October 26, 2026

First public release of Daybook.

- Monday-style boards with Main Table, Kanban, and Calendar views; groups, subitems, inline editing, filters, bulk actions, and recoverable trash.
- Item and subitem updates with photo and document attachments, recurring items, and board automations.
- SQLite storage, single-owner authentication, CSV/JSON import, JSON export, and online database backups.
- Interactive Linux installer that configures Docker Compose, Caddy HTTPS, and the owner account. Run `./install.sh`; use `./install.sh --upgrade` for later versions.
- Original Daybook logo and public documentation. Personal boards, credentials, and imported attachments are excluded from the source release.

Requires a Linux server with Docker Engine and Compose V2, a public domain pointing to the server, and inbound TCP ports 80 and 443. See the [installation guide](https://github.com/cschwartz85032/daybook#install-on-a-linux-server).

Daybook is a single-owner app. Monday synchronization, collaboration permissions, and email or push notifications are not included.
