# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

GNOME Shell extension (GJS, ESM modules) that polls an Uptime Kuma instance and renders monitor status in the top panel plus a popup. UUID `uptime-kuma-indicator@uptime.dumke.me`, schema id `org.gnome.shell.extensions.kuma`. Targets GNOME Shell 46–50. No npm/test toolchain — everything runs inside `gjs` as loaded by gnome-shell.

The actual extension lives in `uptime-kuma-indicator/`; the repo root is just packaging + docs.

## Common commands

All run from the repo root:

| Command | What it does |
|---|---|
| `make translations` | Compile every `.po` to `.mo` (needed before pack/install) |
| `make pack` | Build `uptime-kuma-indicator@uptime.dumke.me.shell-extension.zip` (strips `.po`/`.pot` from the zip via a backup-restore dance, only `.mo` ships) |
| `make install` | `pack` + `gnome-extensions install --force` the resulting zip |
| `make clean` | Remove the packaged zip |
| `make release` | Tag `v$VERSION` (read from `metadata.json` `version-name`), push tag, create a draft GitHub release with the zip attached (needs `gh` auth) |
| `make tag-release` | Same tag/push without creating a release |

After installing, GNOME Shell must be reloaded — Xorg: <kbd>Alt</kbd>+<kbd>F2</kbd> → `r`; Wayland: log out/in. Then `gnome-extensions enable uptime-kuma-indicator@uptime.dumke.me`.

### Iterating on changes

- Edit a schema key → `glib-compile-schemas uptime-kuma-indicator/schemas` (the `gschemas.compiled` is gitignored).
- Edit a translation → `make translations` (or just `make pack`/`install` which depends on it).
- Test the prefs dialog without reloading the shell: `gnome-extensions prefs uptime-kuma-indicator@uptime.dumke.me`.
- Tail extension logs: `journalctl -f -o cat /usr/bin/gnome-shell | grep -i kuma-indicator`. Log prefix in code is `[kuma-indicator]`. Log level is controlled by the `log-level` GSetting (`error`/`info`/`debug`).
- There is no test suite. The fastest UI smoke test is enabling Demo Data in prefs — `mockMonitors()` from `utils/parsers.js` feeds the indicator without any network.

## Architecture

Three source files do the real work; everything else is plumbing.

### `uptime-kuma-indicator/extension.js` — panel indicator + lifecycle

- `Extension` subclass owns a `MonitorFetcher` and a `GLib.timeout_add_seconds` poll loop driven by the `refresh-seconds` GSetting (min 10s, see schema).
- The `PanelMenu.Button` shows a colored health dot + Up/Down/Total summary; popup is a scrollable `PopupMenu` of monitors with status/latency/relative-time. Status → CSS class via `STATUS_CLASS_MAP` (`ok`/`warn`/`fail`/`unknown`), styled in `stylesheet.css`.
- Suspend/resume handling: subscribes to `org.freedesktop.login1` `PrepareForSleep` over D-Bus and rebuilds the Soup session on resume — important when touching network teardown.
- Optional badge rendering uses `Rsvg` + `Cairo` to rasterize Uptime Kuma SVG status badges to PNG, cached under `$XDG_CACHE_HOME/uptime-kuma-indicator/badges/` with a 10-min TTL.
- Polling is stopped in `disable()`; never start GLib timeouts that aren't tracked for cleanup.

### `uptime-kuma-indicator/utils/network.js` — `MonitorFetcher`

- Single `Soup.Session` (Soup 3) with 8s timeout, 3 retries, 1.6× exponential backoff. Tracks active retry timeouts in a `Set` so `destroy()` can cancel them.
- Dispatches to one of three fetchers based on the `api-mode` GSetting:
  - `status-page` — public `status/{slug}/status.json`, parsed by `normalizeStatusPage` + heartbeat history fetch via `normalizeHeartbeatHistory`.
  - `api-key` — private REST API (default `api/monitor`) with bearer token from Secret Service, parsed by `normalizeApi`.
  - `metrics` — Prometheus scrape at `metrics` (path is hard-locked to default to avoid misconfiguration), parsed by `normalizeMetrics`. Also used opportunistically to extract uptime % from SVG badges (`BADGE_PERCENTAGE_PATTERN`).
- Tokens/API keys are loaded from GNOME Keyring (Secret Service), never from GSettings — keep it that way.

### `uptime-kuma-indicator/utils/parsers.js` — normalizers

Each `normalize*` function converts a different Uptime Kuma response shape into the same monitor record (`{ id, name, status, latency, lastCheck, ... }`) so the UI layer is source-agnostic. `STATUS_PRIORITY` defines worst-first ordering used to compute the aggregate panel state in `aggregateMonitors`. `normalizeStatus` accepts both the numeric Uptime Kuma codes (0=down, 1=up, 2=degraded, 3=maintenance) and string aliases — extend both branches when adding a status.

### `uptime-kuma-indicator/prefs.js` — Adwaita preferences

`ExtensionPreferences` subclass with an Adw fallback to plain Gtk. Builds Connection / Service Selection / Behaviour / About groups. Service Selection auto-fetches the monitor list from the configured endpoint to populate dropdowns — touches `MonitorFetcher`/`normalizeMetrics` from prefs context, so changes to those parsers must keep working without a running shell session.

### Schema and i18n

- `schemas/org.gnome.shell.extensions.kuma.gschema.xml` is the source of truth for every GSetting. Keys are kebab-case; access them via `settings.get_string('api-mode')` etc. Add a key → recompile schemas → reference it from `extension.js` and `prefs.js`.
- `locale/<lang>/LC_MESSAGES/uptime-kuma-indicator.po` plus `locale/uptime-kuma-indicator.pot`. Currently shipped: en, de, sv, ja. Note that `utils/i18n.js` is a stub (`_` is identity, `ngettext` picks by count) — actual gettext binding happens at extension load via the standard GNOME Shell extension i18n machinery, not in this file.

## Versioning / releases

`metadata.json` `version-name` is the human version (e.g. `1.5.1`) and is what `make release`/`tag-release` read. There is also a numeric `version` that GNOME EGO increments — leave alone unless preparing an EGO submission. Bump `version-name` and update the README "What's New" before tagging.

## Conventions worth knowing

- ESM only (`import` syntax); GJS resolves `gi://` and `resource:///org/gnome/shell/...` imports.
- All long-running resources (`Soup.Session`, GLib timeouts, D-Bus subscriptions) must be torn down in `destroy()`/`disable()` — leaks survive across enable/disable cycles and can crash the shell on extension reload.
- Don't introduce node/npm tooling; `jsconfig.json` exists only for editor type-checking against Workbench's GJS type stubs.
