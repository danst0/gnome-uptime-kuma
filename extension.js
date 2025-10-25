'use strict';

const { Clutter, GLib, GObject, Soup, St } = imports.gi;
const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const ExtensionUtils = imports.misc.extensionUtils;
const Gettext = imports.gettext;
const ByteArray = imports.byteArray;

const Me = ExtensionUtils.getCurrentExtension();
const _ = Gettext.domain(Me.metadata['gettext-domain'] || 'uptime-kuma').gettext;

const STATUS_MAP = new Map([
    [0, _('Pending')],
    [1, _('Up')],
    [2, _('Down')],
    [3, _('Maintenance')],
]);

const STATUS_ICON_MAP = new Map([
    [0, 'dialog-question-symbolic'],
    [1, 'emblem-ok-symbolic'],
    [2, 'dialog-error-symbolic'],
    [3, 'preferences-system-time-symbolic'],
]);

class HttpClient {
    constructor() {
        this._session = new Soup.Session();

        if (Soup.MAJOR_VERSION === 2) {
            Soup.Session.prototype.add_feature.call(
                this._session,
                new Soup.ProxyResolverDefault()
            );
        }
    }

    async get(url, headers = {}) {
        if (!url)
            throw new Error('Missing URL');

        if (Soup.MAJOR_VERSION === 2)
            return this._sendSoup2(url, headers);

        return this._sendSoup3(url, headers);
    }

    _sendSoup2(url, headers) {
        return new Promise((resolve, reject) => {
            const message = Soup.Message.new('GET', url);

            for (const [name, value] of Object.entries(headers))
                message.request_headers.append(name, value);

            this._session.queue_message(message, (_session, response) => {
                if (response.status_code >= 200 && response.status_code < 300)
                    resolve(response.response_body.data);
                else
                    reject(new Error(`Request failed with status ${response.status_code}`));
            });
        });
    }

    _sendSoup3(url, headers) {
        return new Promise((resolve, reject) => {
            const message = Soup.Message.new('GET', url);

            for (const [name, value] of Object.entries(headers))
                message.request_headers.append(name, value);

            this._session.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                null,
                (session, result) => {
                    try {
                        const bytes = session.send_and_read_finish(result);
                        const status = message.get_status();

                        if (status >= 200 && status < 300)
                            resolve(ByteArray.toString(bytes.get_data()));
                        else
                            reject(new Error(`Request failed with status ${status}`));
                    } catch (error) {
                        reject(error);
                    }
                }
            );
        });
    }
}

var UptimeKumaIndicator = GObject.registerClass(
class UptimeKumaIndicator extends PanelMenu.Button {
    _init(settings) {
        super._init(0.0, 'UptimeKumaIndicator');

        this._settings = settings;
        this._httpClient = new HttpClient();
        this._timeoutId = 0;
        this._settingsHandlerIds = [];
        this._refreshing = false;

        const box = new St.BoxLayout({ style_class: 'panel-status-menu-box' });
        this._icon = new St.Icon({
            icon_name: 'network-workgroup-symbolic',
            style_class: 'system-status-icon',
        });
        this._label = new St.Label({
            text: _('...'),
            y_align: Clutter.ActorAlign.CENTER,
        });

        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);

        this._settingsHandlerIds.push(
            this._settings.connect('changed::server-url', () => this._refresh())
        );
        this._settingsHandlerIds.push(
            this._settings.connect('changed::status-page-slug', () => this._refresh())
        );
        this._settingsHandlerIds.push(
            this._settings.connect('changed::monitor-ids', () => this._refresh())
        );
        this._settingsHandlerIds.push(
            this._settings.connect('changed::refresh-interval', () => this._scheduleRefresh())
        );

        this._refresh();
        this._scheduleRefresh();
    }

    destroy() {
        for (const handlerId of this._settingsHandlerIds)
            this._settings.disconnect(handlerId);
        this._settingsHandlerIds = [];

        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }

        super.destroy();
    }

    _scheduleRefresh() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }

        const interval = Math.max(10, this._settings.get_int('refresh-interval'));
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _refresh() {
        if (this._refreshing)
            return;

        this._refreshing = true;
        const url = this._buildUrl();

        if (!url) {
            this._setStatus(_('Configure Uptime Kuma in preferences'), 'dialog-information-symbolic');
            this._rebuildMenu([]);
            this._refreshing = false;
            return;
        }

        this._setStatus(_('Updating…'), 'network-transmit-receive-symbolic');

        try {
            const response = await this._httpClient.get(url);
            const text = typeof response === 'string' ? response : ByteArray.toString(response);
            const data = JSON.parse(text);
            const monitorIds = this._settings
                .get_string('monitor-ids')
                .split(',')
                .map(id => id.trim())
                .filter(Boolean);

            const { monitors, rawCount } = this._extractMonitors(data, monitorIds);
            this._updateIndicator(monitors);
            this._rebuildMenu(monitors, {
                filtered: monitorIds.length > 0,
                rawCount,
            });
        } catch (error) {
            logError(error, 'Failed to refresh Uptime Kuma status');
            this._setStatus(_('Error'), 'dialog-error-symbolic');
            this.menu.removeAll();
            const errorItem = new PopupMenu.PopupMenuItem(_('Failed to load data'), { reactive: false });
            errorItem.label.clutter_text.line_wrap = true;
            this.menu.addMenuItem(errorItem);
            const reasonItem = new PopupMenu.PopupMenuItem(error.message, { reactive: false });
            reasonItem.label.clutter_text.line_wrap = true;
            this.menu.addMenuItem(reasonItem);
        } finally {
            this._refreshing = false;
        }
    }

    _updateIndicator(monitors) {
        if (!monitors.length) {
            this._setStatus(_('No data'), 'dialog-warning-symbolic');
            return;
        }

        const worstMonitor = monitors.reduce((worst, monitor) => {
            if (!worst)
                return monitor;

            const worstScore = this._statusScore(worst.statusCode);
            const monitorScore = this._statusScore(monitor.statusCode);
            return monitorScore < worstScore ? monitor : worst;
        }, null);

        const icon = STATUS_ICON_MAP.get(worstMonitor.statusCode) || 'network-workgroup-symbolic';
        this._setStatus(worstMonitor.statusText, icon);
    }

    _statusScore(statusCode) {
        switch (statusCode) {
        case 1:
            return 3;
        case 0:
            return 2;
        case 3:
            return 1;
        case 2:
        default:
            return 0;
        }
    }

    _setStatus(text, iconName) {
        this._label.text = text;
        this._icon.icon_name = iconName;
    }

    _rebuildMenu(monitors, { filtered = false, rawCount = 0 } = {}) {
        this.menu.removeAll();

        if (!monitors.length) {
            const message = filtered && rawCount > 0
                ? _('No matching monitors found')
                : _('No monitors available');
            const placeholder = new PopupMenu.PopupMenuItem(message, { reactive: false });
            placeholder.label.clutter_text.line_wrap = true;
            this.menu.addMenuItem(placeholder);
            return;
        }

        for (const monitor of monitors) {
            const text = monitor.description
                ? `${monitor.name}: ${monitor.statusText}\n${monitor.description}`
                : `${monitor.name}: ${monitor.statusText}`;
            const item = new PopupMenu.PopupMenuItem(text, { reactive: false });
            item.add_style_class_name('uptime-kuma-menu-item');
            item.label.clutter_text.line_wrap = true;
            this.menu.addMenuItem(item);
        }

        const lastUpdated = GLib.DateTime.new_now_local().format('%X');
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const footer = new PopupMenu.PopupMenuItem(_('Last update: ') + lastUpdated, { reactive: false });
        footer.label.clutter_text.line_wrap = true;
        this.menu.addMenuItem(footer);
    }

    _buildUrl() {
        const baseUrl = this._settings.get_string('server-url').trim();
        if (!baseUrl)
            return null;

        const slug = this._settings.get_string('status-page-slug').trim();
        const normalizedBase = baseUrl.replace(/\/$/, '');
        if (!slug)
            return `${normalizedBase}/api/monitors`;

        return `${normalizedBase}/api/status-page/summary/${encodeURIComponent(slug)}`;
    }

    _extractMonitors(data, monitorIds) {
        const monitors = [];
        const seen = new Set();

        const rawMonitors = this._findMonitors(data);
        for (const monitor of rawMonitors) {
            if (monitorIds.length && !monitorIds.includes(String(monitor.id)))
                continue;

            const dedupeKey = monitor.id ? `id:${monitor.id}` : monitor.name ? `name:${monitor.name}` : null;
            if (dedupeKey && seen.has(dedupeKey))
                continue;

            const statusValue = monitor.status ?? monitor.statusClass ?? monitor.statusEnum ?? monitor.statusText;
            const statusCode = this._normalizeStatusCode(statusValue);
            monitors.push({
                id: monitor.id,
                name: monitor.name || _('Monitor'),
                statusCode,
                statusText: STATUS_MAP.get(statusCode) || _('Unknown'),
                description: monitor.description || monitor.note || null,
            });

            if (dedupeKey)
                seen.add(dedupeKey);
        }

        return { monitors, rawCount: rawMonitors.length };
    }

    _findMonitors(data) {
        if (!data || typeof data !== 'object')
            return [];

        if (Array.isArray(data)) {
            return data.flatMap(item => this._findMonitors(item));
        }

        if (Array.isArray(data.monitors))
            return data.monitors;

        const nested = [];
        for (const value of Object.values(data)) {
            if (typeof value === 'object')
                nested.push(...this._findMonitors(value));
        }

        return nested;
    }

    _normalizeStatusCode(status) {
        if (typeof status === 'number')
            return status;

        if (typeof status === 'string') {
            const lower = status.toLowerCase();
            if (lower === 'up' || lower === 'operational')
                return 1;
            if (lower === 'down' || lower === 'critical')
                return 2;
            if (lower === 'maintenance')
                return 3;
            if (lower === 'pending' || lower === 'unknown')
                return 0;
        }

        return 0;
    }
});

class Extension {
    constructor() {
        this._indicator = null;
        this._settings = null;
    }

    enable() {
        this._settings = ExtensionUtils.getSettings();
        this._indicator = new UptimeKumaIndicator(this._settings);
        Main.panel.addToStatusArea('uptime-kuma-indicator', this._indicator, 1, 'right');
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        this._settings = null;
    }
}

function init() {
    ExtensionUtils.initTranslations(Me.metadata['gettext-domain'] || 'uptime-kuma');
    return new Extension();
}
