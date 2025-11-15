# Uptime Kuma Indicator

GNOME Shell extension (GNOME 46–49) that embeds uptime information from your Uptime Kuma instance directly into the top bar.

## ✨ Features

- Persistent panel indicator with colored health dot and textual summary.
- Scrollable popup listing monitors with status, latency, and relative timestamps.
- Supports public status page JSON _and_ the authenticated REST API with Secret Service storage for the token.
- Configurable refresh cadence, appearance, list length, and logging verbosity.
- Inline search with substring matching for the monitor selector so you can jump to services without leaving the keyboard.
- Graceful error handling with informative tooltips and optional demo data for UI testing.
- Fully localized using GNU gettext (English, German, Swedish, and Japanese included).

## 📦 Requirements

- GNOME Shell 46, 47, 48, or 49
- GJS with Soup 3 and libadwaita 1.4+
- Uptime Kuma instance (0.10+) with either public status page JSON or API access

## 🚀 Installation

Quick install from the project root:

```bash
make install
```

Then reload GNOME Shell (see below) so the changes take effect.

Manual steps if you prefer to copy the files yourself:

1. Copy the extension directory into your local extensions folder:

   ```bash
   mkdir -p ~/.local/share/gnome-shell/extensions
   cp -r uptime-kuma-indicator ~/.local/share/gnome-shell/extensions/uptime-kuma-indicator@uptime.dumke.me
   ```

2. Compile the GSettings schema:

   ```bash
   glib-compile-schemas ~/.local/share/gnome-shell/extensions/uptime-kuma-indicator@uptime.dumke.me/schemas
   ```

3. Reload GNOME Shell:
   - Xorg: press <kbd>Alt</kbd> + <kbd>F2</kbd>, enter `r`, confirm.
   - Wayland: log out and back in.

4. Enable the extension via **GNOME Extensions** or **gnome-extensions-app**.

## ⚙️ Configuration

Open the preferences dialog from the popup menu and configure:

| Setting | Description |
| ------- | ----------- |
| **Base URL** | Fully qualified address of your Uptime Kuma instance (e.g. `https://status.example.com`). |
| **API mode** | Choose between _Status page JSON (public)_ or _Private API (token)_. |
| **Status page slug / endpoint** | Used for public status pages. Template supports `{{slug}}`. |
| **Status page JSON URL** | Optional absolute URL if your deployment deviates from the default pattern. |
| **API endpoint** | Relative path for authenticated mode (default `api/monitor`). |
| **API token** | Stored securely in Secret Service. Tokens are never written to GSettings. |
| **Refresh interval** | Poll cadence in seconds (min 10). |
| **Maximum monitors** | Limits the number of monitors displayed in the popup. |
| **Show latency** | Toggle visibility of response times. |
| **Appearance** | Switch between normal and compact indicator layout. |
| **Demo data** | Display bundled mock monitors whenever no base URL is set. |
| **Log level** | Adjust verbosity of journal messages (Errors, Info, Debug). |

## 🧪 Development & Debugging

Clone this repository and work directly inside the `uptime-kuma-indicator` directory. Helpful commands:

```bash
# Compile schemas after changes
glib-compile-schemas schemas

# Tail GNOME Shell logs
journalctl -f -o cat /usr/bin/gnome-shell | grep -i "kuma-indicator"
```

To run the preferences dialog without the shell:

```bash
gnome-extensions prefs uptime-kuma-indicator@uptime.dumke.me
```

## 🔁 Behaviour Notes

- Polling loop stops automatically when the extension is disabled or reloaded.
- Network requests use Soup 3 with an 8 second timeout and exponential backoff (3 attempts).
- When the endpoint fails, the indicator turns grey and the tooltip shows the last error message.
- Relative timestamps are recalculated on each refresh.

## 🖼 Placeholder Screenshots

> Replace these files with real screenshots before publishing.

![Panel indicator placeholder](docs/screenshot-indicator.png)
![Popup placeholder](docs/screenshot-popup.png)

## 🧭 Known Variations

Some self-hosted deployments change the status page endpoint layout. Use the **Status page JSON URL** preference to point directly at the JSON resource when necessary.

## 📄 License

This project is distributed under the Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International License. See [`LICENSE`](LICENSE) for details.
