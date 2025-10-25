# Goal
Small widget for GNOME to show the status of selected services on a self hosted Uptime Kuma server.

## Features
- Panel indicator that summarises the overall health of your chosen monitors.
- Drop-down menu listing monitor statuses and descriptions.
- Configurable server URL, status page slug and monitor filters.
- Adjustable refresh interval.

## Installation
1. Copy the contents of this repository to `~/.local/share/gnome-shell/extensions/uptime-kuma@local/`.
2. Compile the settings schema:
   ```bash
   glib-compile-schemas ~/.local/share/gnome-shell/extensions/uptime-kuma@local/schemas
   ```
3. Enable the extension using the GNOME Extensions app or `gnome-extensions enable uptime-kuma@local`.

## Configuration
Open the extension preferences via the Extensions app:
- **Server URL** – Base URL of your self-hosted Uptime Kuma instance.
- **Status Page Slug** – Optional slug of a public status page; leave empty to use the monitor API.
- **Monitor IDs** – Comma-separated list of monitor IDs to show (empty to display all monitors returned by the API).
- **Refresh Interval** – Number of seconds between status updates.

## Notes
- The extension expects either the `/api/monitors` endpoint (requires an accessible session) or the `/api/status-page/summary/<slug>` endpoint to be reachable.
- For private instances, prefer exposing a status page slug and optionally protect it with a token supported by Uptime Kuma.
