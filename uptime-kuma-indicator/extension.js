import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Rsvg from 'gi://Rsvg?version=2.0';
import St from 'gi://St';

import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { MonitorFetcher } from './utils/network.js';
import { aggregateMonitors, mockMonitors } from './utils/parsers.js';
import { UptimeTracker } from './utils/uptime-tracker.js';
import { _, ngettext } from './utils/i18n.js';

// GNOME Shell 48 added St.BoxLayout:orientation; GNOME Shell 51 removed the
// older :vertical property, so neither one works across the whole supported
// range. Pick the right constructor property from the running shell version.
const [SHELL_MAJOR] = Config.PACKAGE_VERSION.split('.');
const SHELL_VERSION = Number.parseInt(SHELL_MAJOR);

function boxOrientation(vertical) {
    if (SHELL_VERSION >= 48) {
        return {
            orientation: vertical
                ? Clutter.Orientation.VERTICAL
                : Clutter.Orientation.HORIZONTAL,
        };
    }

    return { vertical };
}

const INDICATOR_NAME = 'uptime-kuma-indicator';
const STATUS_CLASS_MAP = {
    up: 'ok',
    degraded: 'warn',
    maintenance: 'warn',
    down: 'fail',
    unknown: 'unknown',
};

const LOG_LEVELS = ['error', 'info', 'debug'];

const USEC_PER_SEC = 1_000_000;
const REFRESH_ON_ENABLE_DELAY_MS = 200;
// The prefs entries write on every keystroke, so coalesce the resulting
// refreshes instead of firing a request (and an error log) per character.
const SETTINGS_REFRESH_DEBOUNCE_MS = 500;
const BADGE_CACHE_TTL_MS = 10 * 60 * 1000;
const BADGE_CACHE_ROOT = GLib.get_user_cache_dir() || GLib.get_home_dir() || GLib.get_tmp_dir();
const BADGE_CACHE_DIR = GLib.build_filenamev([
    BADGE_CACHE_ROOT,
    'uptime-kuma-indicator',
    'badges',
]);
const UPTIME_HISTORY_PATH = GLib.build_filenamev([
    BADGE_CACHE_ROOT,
    'uptime-kuma-indicator',
    'uptime-history.json',
]);

Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'query_info_async');

const LOGIN1_BUS_NAME = 'org.freedesktop.login1';
const LOGIN1_OBJECT_PATH = '/org/freedesktop/login1';
const LOGIN1_INTERFACE = 'org.freedesktop.login1.Manager';

// Rasterizes in memory only; the caller writes the result asynchronously.
function renderSvgToPng(svgContent) {
    if (typeof svgContent !== 'string' || svgContent.length === 0)
        throw new Error('SVG content is empty');

    let handle;
    try {
        handle = Rsvg.Handle.new_from_data(new TextEncoder().encode(svgContent));
    } catch (error) {
        throw new Error(`Failed to parse SVG: ${error.message}`);
    }

    const pixbuf = handle.get_pixbuf();
    if (!pixbuf)
        throw new Error('Failed to render SVG');

    const [ok, buffer] = pixbuf.save_to_bufferv('png', [], []);
    if (!ok)
        throw new Error('Failed to encode PNG');

    return new GLib.Bytes(buffer);
}

async function fileExists(path, cancellable) {
    try {
        await Gio.File.new_for_path(path).query_info_async(
            'standard::type', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
        return true;
    } catch (error) {
        return false;
    }
}

function hashBadgeKey(key) {
    if (!key)
        return 'badge';
    return GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, key, key.length);
}

function estimateBadgeTextWidth(text) {
    let width = 0;
    for (const ch of text) {
        if (ch === ' ' || ch === '.' || ch === ':' || ch === ',')
            width += 4;
        else if (ch === '%' || ch === '1' || ch === 'i' || ch === 'l')
            width += 5;
        else if (ch >= '0' && ch <= '9')
            width += 7;
        else if (ch >= 'A' && ch <= 'Z')
            width += 9;
        else
            width += 7;
    }
    return width;
}

function uptimeBadgeColor(percentage) {
    if (percentage >= 99)
        return '#66c20a';
    if (percentage >= 90)
        return '#dfb317';
    return '#e05d44';
}

function buildUptimeBadgeSvg(percentage) {
    const label = '24h';
    const value = percentage >= 100 ? '100%' : `${percentage.toFixed(2)}%`;
    const color = uptimeBadgeColor(percentage);

    const labelTextWidth = estimateBadgeTextWidth(label);
    const valueTextWidth = estimateBadgeTextWidth(value);
    const labelWidth = labelTextWidth + 10;
    const valueWidth = valueTextWidth + 10;
    const totalWidth = labelWidth + valueWidth;

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="${label}: ${value}">` +
        `<title>${label}: ${value}</title>` +
        '<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>' +
        `<clipPath id="r"><rect width="${totalWidth}" height="20" rx="3" fill="#fff"/></clipPath>` +
        '<g clip-path="url(#r)">' +
        `<rect width="${labelWidth}" height="20" fill="#555"/>` +
        `<rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${color}"/>` +
        `<rect width="${totalWidth}" height="20" fill="url(#s)"/>` +
        '</g>' +
        '<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">' +
        `<text aria-hidden="true" x="${labelWidth * 5}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${labelTextWidth * 10}">${label}</text>` +
        `<text x="${labelWidth * 5}" y="140" transform="scale(.1)" fill="#fff" textLength="${labelTextWidth * 10}">${label}</text>` +
        `<text aria-hidden="true" x="${(labelWidth + valueWidth / 2) * 10}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${valueTextWidth * 10}">${value}</text>` +
        `<text x="${(labelWidth + valueWidth / 2) * 10}" y="140" transform="scale(.1)" fill="#fff" textLength="${valueTextWidth * 10}">${value}</text>` +
        '</g></svg>';

    return { svg, width: totalWidth, height: 20 };
}

function toDateTime(value) {
    if (!value)
        return null;

    if (value instanceof GLib.DateTime)
        return value;

    if (typeof value === 'number') {
        const seconds = Math.floor(value / 1000);
        return GLib.DateTime.new_from_unix_utc(seconds);
    }

    if (typeof value === 'string') {
        try {
            return GLib.DateTime.new_from_iso8601(value, null);
        } catch (error) {
            return null;
        }
    }

    return null;
}

function formatRelative(deltaSeconds) {
    const abs = Math.max(0, Math.floor(deltaSeconds));

    if (abs < 60)
        return ngettext('%d second ago', '%d seconds ago', abs).format(abs);

    const minutes = Math.floor(abs / 60);
    if (minutes < 60)
        return ngettext('%d minute ago', '%d minutes ago', minutes).format(minutes);

    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return ngettext('%d hour ago', '%d hours ago', hours).format(hours);

    const days = Math.floor(hours / 24);
    if (days < 7)
        return ngettext('%d day ago', '%d days ago', days).format(days);

    const weeks = Math.floor(days / 7);
    return ngettext('%d week ago', '%d weeks ago', weeks).format(weeks);
}

const MonitorRow = GObject.registerClass(
class MonitorRow extends St.BoxLayout {
    _init(monitor, showLatency, showBadges) {
        super._init({
            style_class: 'kuma-list-row',
            ...boxOrientation(false),
            x_expand: true,
            y_expand: false,
        });

        if (typeof this.set_spacing === 'function')
            this.set_spacing(8);
        else
            this.spacing = 8;

        this._monitorId = monitor.id;

        this._dot = new St.Label({
            text: '●',
            style_class: 'kuma-status-dot',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._name = new St.Label({
            text: monitor.name ?? '—',
            style_class: 'kuma-monitor-name',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        if (this._name.clutter_text)
            this._name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._badgeIcon = new St.Icon({
            style_class: 'kuma-badge-icon',
            icon_size: 16,
            visible: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._latency = new St.Label({
            text: '',
            style_class: 'kuma-monitor-latency',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.END,
        });

        this._uptime = new St.Label({
            text: '',
            style_class: 'kuma-monitor-uptime',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.END,
        });

        this._lastCheck = new St.Label({
            text: '',
            style_class: 'kuma-monitor-last-check',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.END,
        });

        this.add_child(this._dot);
        this.add_child(this._name);
        this.add_child(this._badgeIcon);
        this.add_child(this._latency);
        this.add_child(this._uptime);
        this.add_child(this._lastCheck);
        this.update(monitor, showLatency, showBadges);
    }

    get monitorId() {
        return this._monitorId;
    }

    update(monitor, showLatency, showBadges) {
        this._monitorId = monitor.id;
        this._name.text = monitor.name ?? '—';
        this._setStatusClass(monitor.status);

        if (showLatency) {
            if (typeof monitor.latencyMs === 'number')
                this._latency.text = `${monitor.latencyMs} ms`;
            else
                this._latency.text = _('n/a');
            this._latency.visible = true;
        } else {
            this._latency.visible = false;
        }

        if (showBadges) {
            const iconPath = monitor.badgeIconPath;
            const hasIcon = typeof iconPath === 'string' && iconPath.length > 0;
            if (hasIcon) {
                try {
                    const file = Gio.File.new_for_path(iconPath);
                    this._badgeIcon.gicon = new Gio.FileIcon({ file });
                    const width = Number.isFinite(monitor.badgeIconWidth) && monitor.badgeIconWidth > 0
                        ? Math.round(monitor.badgeIconWidth)
                        : 16;
                    this._badgeIcon.icon_size = width;
                    this._badgeIcon.visible = true;
                } catch (error) {
                    this._badgeIcon.visible = false;
                }
                this._uptime.visible = false;
            } else if (typeof monitor.uptime24h === 'number') {
                const value = monitor.uptime24h;
                const rounded = value >= 100 ? value.toFixed(0) : value.toFixed(2);
                this._uptime.text = `24h ${rounded}%`;
                this._uptime.visible = true;
                this._badgeIcon.visible = false;
            } else {
                this._uptime.visible = false;
                this._badgeIcon.visible = false;
            }
        } else {
            this._uptime.visible = false;
            this._badgeIcon.visible = false;
        }

        if (monitor.relativeLastCheck) {
            this._lastCheck.text = monitor.relativeLastCheck;
            this._lastCheck.visible = true;
        } else {
            this._lastCheck.visible = false;
        }
    }

    _setStatusClass(status) {
        this._dot.remove_style_class_name('ok');
        this._dot.remove_style_class_name('warn');
        this._dot.remove_style_class_name('fail');
        this._dot.remove_style_class_name('unknown');

        const style = STATUS_CLASS_MAP[status] ?? 'unknown';
        this._dot.add_style_class_name(style);
    }

});

const ScrollSection = GObject.registerClass(
class ScrollSection extends PopupMenu.PopupBaseMenuItem {
    _init(maxHeight) {
        super._init({ reactive: false, can_focus: false });

        this._scrollView = new St.ScrollView({
            style_class: 'kuma-scroll-view',
            overlay_scrollbars: true,
        });
        this._scrollView.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this._scrollView.style = `max-height: ${maxHeight}px;`;

        this._list = new St.BoxLayout({
            ...boxOrientation(true),
            style_class: 'kuma-monitor-list',
        });
        this._scrollView.add_child(this._list);
        this.add_child(this._scrollView);
    }

    clear() {
        this._list.destroy_all_children();
    }

    addRow(row) {
        this._list.add_child(row);
    }

    removeRow(row) {
        if (row.get_parent() === this._list)
            this._list.remove_child(row);
    }

    reorderRow(row, position) {
        if (row.get_parent() !== this._list)
            return;
        this._list.remove_child(row);
        this._list.insert_child_at_index(row, position);
    }

    children() {
        return this._list.get_children();
    }
});

const KumaIndicator = GObject.registerClass(
class KumaIndicator extends PanelMenu.Button {
    constructor(extension) {
        super(0.0, INDICATOR_NAME, false);

        this._extension = extension;
        this._metadata = extension.metadata;
        this._settings = extension.getSettings();
        this._settingsConnections = [];
        this._refreshLoopId = 0;
        this._enableTimeoutId = 0;
        this._settingsRefreshId = 0;
        this._isRefreshing = false;
        this._rows = new Map();
        this._lastRefresh = null;
        this._logLevelIndex = 1;
        this._fetcher = new MonitorFetcher();
        this._sleepSubscriptionId = 0;
        this._previousMonitorStates = new Map(); // Track previous states for notifications
        this._badgeCache = new Map();
        this._badgeCacheDir = BADGE_CACHE_DIR;
        this._ioCancellable = new Gio.Cancellable();
        this._uptimeTracker = new UptimeTracker(UPTIME_HISTORY_PATH);
        this._ensureBadgeCacheDir();

        this._summaryState = {
            up: 0,
            down: 0,
            degraded: 0,
            unknown: 0,
            total: 0,
            status: 'unknown',
        };

        this._indicatorBox = new St.BoxLayout({
            style_class: 'kuma-indicator-box',
            ...boxOrientation(false),
            x_expand: true,
        });
        if (typeof this._indicatorBox.set_spacing === 'function')
            this._indicatorBox.set_spacing(6);
        else
            this._indicatorBox.spacing = 6;

        this._dotActor = new St.Label({
            text: '●',
            style_class: 'kuma-indicator-dot unknown',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._summaryLabel = new St.Label({
            text: _('—/—'),
            style_class: 'kuma-indicator-summary',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        if (this._summaryLabel.clutter_text)
            this._summaryLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        this._indicatorBox.add_child(this._dotActor);
        this._indicatorBox.add_child(this._summaryLabel);
        this.add_child(this._indicatorBox);

        this._monitorSection = new ScrollSection(320);
        this.menu.addMenuItem(this._monitorSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._refreshItem = this.menu.addAction(_('Refresh now'), () => this._manualRefresh());
        this._refreshItem.actor.add_style_class_name('kuma-refresh-item');

        this._openItem = this.menu.addAction(_('Open Uptime Kuma'), () => this._openBaseUrl());
        this._prefsItem = this.menu.addAction(_('Preferences…'), () => this._extension.openPreferences());
        this._aboutItem = this.menu.addAction(_('About / Version'), () => this._showAbout());

        this._config = {};
        this._loadSettings();
        this._bindSettings();
        this._subscribePowerEvents();
    }

    destroy() {
        this.stop();
        super.destroy();
    }

    start() {
        this._log('debug', 'Indicator started');
        this._scheduleRefresh();
        if (this._enableTimeoutId) {
            GLib.source_remove(this._enableTimeoutId);
        }
        this._enableTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFRESH_ON_ENABLE_DELAY_MS, () => {
            this._refresh();
            this._enableTimeoutId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    stop() {
        if (this._refreshLoopId) {
            GLib.source_remove(this._refreshLoopId);
            this._refreshLoopId = 0;
        }

        if (this._enableTimeoutId) {
            GLib.source_remove(this._enableTimeoutId);
            this._enableTimeoutId = 0;
        }

        if (this._settingsRefreshId) {
            GLib.source_remove(this._settingsRefreshId);
            this._settingsRefreshId = 0;
        }

        // Destroy all monitor rows
        for (const row of this._rows.values()) {
            row.destroy();
        }
        this._rows.clear();
        this._badgeCache.clear();
        this._ioCancellable.cancel();
        if (this._uptimeTracker) {
            this._uptimeTracker.destroy();
            this._uptimeTracker = null;
        }

        if (this._fetcher) {
            this._fetcher.destroy();
            this._fetcher = null;
        }

        this._unsubscribePowerEvents();

        for (const id of this._settingsConnections)
            this._settings.disconnect(id);
        this._settingsConnections = [];

        // Release settings reference
        if (this._settings) {
            this._settings = null;
        }
    }

    _queueRefresh() {
        if (this._settingsRefreshId)
            GLib.source_remove(this._settingsRefreshId);

        this._settingsRefreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTINGS_REFRESH_DEBOUNCE_MS, () => {
            this._settingsRefreshId = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _bindSettings() {
        const keys = [
            'base-url',
            'api-mode',
            'status-page-slug',
            'status-page-endpoint',
            'status-page-json-url',
            'api-endpoint',
            'metrics-endpoint',
            'api-key',
            'refresh-seconds',
            'show-latency',
            'appearance',
            'log-level',
            'demo-mode',
            'selected-services',
            'show-text',
            'show-badges',
            'enable-notifications',
            'notify-on-recovery',
        ];

        for (const key of keys) {
            const id = this._settings.connect(`changed::${key}`, () => {
                this._log('debug', `Setting changed: ${key}`);
                this._loadSettings();
                if (key === 'refresh-seconds')
                    this._scheduleRefresh();
                else if (key === 'appearance')
                    this._applyAppearance();
                else if (key === 'log-level')
                    this._updateLogLevel();
                else if (key === 'show-text')
                    this._updateTextVisibility();

                if (['base-url', 'api-mode', 'status-page-json-url', 'status-page-endpoint', 'status-page-slug', 'api-endpoint', 'metrics-endpoint', 'api-key', 'demo-mode', 'show-latency', 'selected-services', 'enable-notifications', 'notify-on-recovery', 'show-badges'].includes(key))
                    this._queueRefresh();
            });
            this._settingsConnections.push(id);
        }
    }

    _loadSettings() {
        this._config.baseUrl = this._settings.get_string('base-url').trim();
        this._config.apiMode = this._settings.get_string('api-mode') || 'status-page';
        this._config.statusPageSlug = this._settings.get_string('status-page-slug').trim();
        this._config.statusPageEndpoint = this._settings.get_string('status-page-endpoint').trim();
        this._config.statusPageJsonUrl = this._settings.get_string('status-page-json-url').trim();
        this._config.apiEndpoint = this._settings.get_string('api-endpoint').trim();
    this._config.metricsEndpoint = this._settings.get_string('metrics-endpoint').trim();
        this._config.refreshSeconds = Math.max(10, this._settings.get_int('refresh-seconds'));
        this._config.showLatency = this._settings.get_boolean('show-latency');
        this._config.appearance = this._settings.get_string('appearance') || 'normal';
        this._config.logLevel = this._settings.get_string('log-level') || 'info';
        this._config.demoMode = this._settings.get_boolean('demo-mode');
        this._config.selectedServices = this._settings.get_strv('selected-services');
        this._config.showText = this._settings.get_boolean('show-text');
        this._config.showBadges = this._settings.get_boolean('show-badges');
        this._config.enableNotifications = this._settings.get_boolean('enable-notifications');
        this._config.notifyOnRecovery = this._settings.get_boolean('notify-on-recovery');

        this._applyAppearance();
        this._updateLogLevel();
        this._updateTextVisibility();
        this._updateOpenItemSensitivity();
    }

    _ensureBadgeCacheDir() {
        if (!this._badgeCacheDir)
            return;

        try {
            GLib.mkdir_with_parents(this._badgeCacheDir, 0o755);
        } catch (error) {
            this._log('debug', `Unable to ensure badge cache directory: ${error.message}`);
        }
    }

    _getBadgeFileBase(cacheKey) {
        this._ensureBadgeCacheDir();
        const safeKey = hashBadgeKey(cacheKey ?? 'badge');
        return GLib.build_filenamev([this._badgeCacheDir, safeKey]);
    }

    async _writeBadgePng(cacheKey, svgContent) {
        const pngPath = `${this._getBadgeFileBase(cacheKey)}.png`;
        const bytes = renderSvgToPng(svgContent);
        await Gio.File.new_for_path(pngPath).replace_contents_bytes_async(
            bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, this._ioCancellable);
        return pngPath;
    }

    _applyAppearance() {
        this._indicatorBox.remove_style_class_name('kuma-appearance-compact');
        this._indicatorBox.remove_style_class_name('kuma-appearance-normal');
        const appearance = this._config.appearance === 'compact' ? 'kuma-appearance-compact' : 'kuma-appearance-normal';
        this._indicatorBox.add_style_class_name(appearance);
    }

    _updateLogLevel() {
        const level = this._config.logLevel;
        const index = LOG_LEVELS.indexOf(level);
        this._logLevelIndex = index >= 0 ? index : 1;
    }

    _updateTextVisibility() {
        this._summaryLabel.visible = this._config.showText;
    }

    _scheduleRefresh() {
        if (this._refreshLoopId) {
            GLib.source_remove(this._refreshLoopId);
            this._refreshLoopId = 0;
        }

        this._refreshLoopId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._config.refreshSeconds, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _subscribePowerEvents() {
        if (this._sleepSubscriptionId)
            return;

        try {
            this._sleepSubscriptionId = Gio.DBus.system.signal_subscribe(
                LOGIN1_BUS_NAME,
                LOGIN1_INTERFACE,
                'PrepareForSleep',
                LOGIN1_OBJECT_PATH,
                null,
                Gio.DBusSignalFlags.NONE,
                this._onPrepareForSleep.bind(this)
            );
        } catch (error) {
            this._sleepSubscriptionId = 0;
            this._log('debug', `Failed to subscribe to sleep events: ${error.message}`);
        }
    }

    _unsubscribePowerEvents() {
        if (!this._sleepSubscriptionId)
            return;

        Gio.DBus.system.signal_unsubscribe(this._sleepSubscriptionId);
        this._sleepSubscriptionId = 0;
    }

    _onPrepareForSleep(connection, senderName, objectPath, interfaceName, signalName, parameters) {
        let goingToSleep = true;

        try {
            const unpacked = parameters?.deep_unpack?.();
            if (Array.isArray(unpacked) && unpacked.length > 0)
                goingToSleep = Boolean(unpacked[0]);
        } catch (error) {
            this._log('debug', `Failed to decode sleep signal: ${error.message}`);
        }

        if (goingToSleep) {
            this._log('debug', 'System preparing for sleep – aborting in-flight refresh');
            this._abortInFlightRefresh();
            return;
        }

        this._log('info', 'System resumed from sleep – resetting network session');
        this._resetFetcher();
        this._refresh();
    }

    _abortInFlightRefresh() {
        if (!this._isRefreshing)
            return;

        this._isRefreshing = false;
        this._resetFetcher();

        if (this._refreshItem && this._refreshItem.actor) {
            this._refreshItem.actor.reactive = true;
            this._refreshItem.actor.opacity = 255;
        }
    }

    _resetFetcher() {
        if (this._fetcher)
            this._fetcher.destroy();
        this._fetcher = new MonitorFetcher();
    }

    async _refresh() {
        if (this._isRefreshing) {
            this._log('debug', 'Refresh skipped because a refresh is already running');
            return;
        }

        this._isRefreshing = true;
        this._refreshItem.actor.reactive = false;
        this._refreshItem.actor.opacity = 128;

        try {
            let monitors;
            // Use mock data only if demo mode is enabled AND no baseUrl is configured
            // OR if baseUrl is missing (regardless of demo mode)
            if (!this._config.baseUrl || (this._config.demoMode && !this._config.baseUrl)) {
                this._log('info', 'Using mock monitors (demo mode or missing baseUrl)');
                monitors = mockMonitors();
            } else {
                const payload = await this._fetcher.fetch(this._config, {
                    getApiKey: () => this._lookupApiKey(),
                    log: (level, message) => this._log(level, message),
                });
                monitors = payload.monitors;
            }

            // Filter by selected services if any are configured
            if (this._config.selectedServices && this._config.selectedServices.length > 0) {
                const selectedSet = new Set(this._config.selectedServices);
                monitors = monitors.filter(m => {
                    // Ensure monitor ID is a string for comparison
                    const monitorId = String(m.id);
                    return selectedSet.has(monitorId);
                });
                this._log('debug', `Filtered to ${monitors.length} selected services`);
            }

            await this._populateUptimeBadges(monitors);
            this._updateMonitorList(monitors);
            this._checkForStatusChanges(monitors);
            this._updateSummary(monitors);
            // Tooltips not supported in GNOME Shell 46+ for panel buttons
            // this._setTooltipFromSummary();
        } catch (error) {
            this._log('error', `Refresh failed: ${error.message}`);
            this._setErrorState(error);
        } finally {
            this._isRefreshing = false;
            this._refreshItem.actor.reactive = true;
            this._refreshItem.actor.opacity = 255;
        }
    }

    _setErrorState(error) {
        this._summaryState = {
            up: 0,
            down: 0,
            degraded: 0,
            unknown: 0,
            total: 0,
            status: 'unknown',
        };
        this._summaryLabel.text = _('Error');
        this._switchDotClass('unknown');
        // Tooltips not supported in GNOME Shell 46+ for panel buttons
        // const tooltip = _('Uptime Kuma – error: %s').format(error.message ?? _('Unknown error'));
        // this.set_tooltip_text(tooltip);
    }

    _updateMonitorList(monitors) {
        const now = GLib.DateTime.new_now_local();
        const seen = new Set();

        monitors.forEach((monitor, index) => {
            const dt = toDateTime(monitor.lastCheck);
            if (dt) {
                const diff = now.difference(dt) / USEC_PER_SEC;
                monitor.relativeLastCheck = formatRelative(diff);
            } else {
                monitor.relativeLastCheck = null;
            }

            const id = monitor.id || `${monitor.name}-${index}`;
            monitor.id = id;
            seen.add(id);

            let row = this._rows.get(id);
            if (row) {
                row.update(monitor, this._config.showLatency, this._config.showBadges);
            } else {
                row = new MonitorRow(monitor, this._config.showLatency, this._config.showBadges);
                this._rows.set(id, row);
            }

            const parent = row.get_parent();
            if (parent)
                parent.remove_child(row);
            this._monitorSection.addRow(row);
        });

        for (const [id, row] of this._rows.entries()) {
            if (!seen.has(id)) {
                this._monitorSection.removeRow(row);
                row.destroy();
                this._rows.delete(id);
            }
        }
    }

    async _populateUptimeBadges(monitors) {
        if (!Array.isArray(monitors) || monitors.length === 0)
            return;

        this._uptimeTracker?.record(monitors);

        if (!this._config.showBadges) {
            for (const monitor of monitors) {
                if (monitor) {
                    monitor.uptime24h = null;
                    monitor.badgeIconPath = null;
                }
            }
            return;
        }

        const now = Date.now();
        const tasks = monitors.map(async monitor => {
            if (!monitor)
                return;

            const rawId = monitor.id;
            const cacheKey = `${String(rawId ?? 'unknown')}-uptime-24h`;

            let percentage = typeof monitor.uptime24h === 'number' ? monitor.uptime24h : null;

            if (percentage === null && rawId !== undefined && rawId !== null && /^\d+$/.test(String(rawId))) {
                const cached = this._badgeCache.get(cacheKey);
                if (cached && (now - cached.timestamp) < BADGE_CACHE_TTL_MS) {
                    percentage = typeof cached.value === 'number' ? cached.value : null;
                } else if (this._config.baseUrl) {
                    try {
                        const payload = await this._fetcher.fetchUptimeBadge(rawId, this._config, {
                            log: (level, message) => this._log(level, message),
                        });
                        percentage = (typeof payload?.percentage === 'number') ? payload.percentage : null;
                        this._badgeCache.set(cacheKey, {
                            value: percentage,
                            timestamp: Date.now(),
                        });
                    } catch (error) {
                        this._log('debug', `Failed to fetch uptime badge for ${cacheKey}: ${error.message}`);
                    }
                }
            }

            if (percentage === null)
                percentage = this._uptimeTracker?.uptimePercent(rawId) ?? null;

            monitor.uptime24h = percentage;
            monitor.badgeIconPath = null;

            if (percentage === null)
                return;

            try {
                const badge = await this._renderUptimeBadge(cacheKey, percentage);
                monitor.badgeIconPath = badge.path;
                monitor.badgeIconWidth = badge.width;
            } catch (error) {
                this._log('debug', `Failed to render uptime badge (${cacheKey}): ${error.message}`);
            }
        });

        await Promise.all(tasks);
    }

    async _renderUptimeBadge(cacheKey, percentage) {
        const rounded = Math.round(percentage * 100) / 100;
        const badgeCacheKey = `${cacheKey}:${rounded}`;
        const cached = this._badgeCache.get(badgeCacheKey);
        if (cached?.pngPath && await fileExists(cached.pngPath, this._ioCancellable))
            return { path: cached.pngPath, width: cached.width };

        const { svg, width } = buildUptimeBadgeSvg(percentage);
        const pngPath = await this._writeBadgePng(badgeCacheKey, svg);
        this._badgeCache.set(badgeCacheKey, { pngPath, width, timestamp: Date.now() });
        return { path: pngPath, width };
    }

    _updateSummary(monitors) {
        const summary = aggregateMonitors(monitors);
        this._summaryState = summary;
        this._lastRefresh = GLib.DateTime.new_now_local();

        const text = _('%d up / %d down').format(summary.up, summary.down);
        this._summaryLabel.text = text;
        this._switchDotClass(summary.status);
    }

    _checkForStatusChanges(monitors) {
        if (!this._config.enableNotifications)
            return;

        for (const monitor of monitors) {
            const id = monitor.id;
            const currentStatus = monitor.status;
            const previousStatus = this._previousMonitorStates.get(id);

            // Skip if this is the first time we see this monitor
            if (previousStatus === undefined) {
                this._previousMonitorStates.set(id, currentStatus);
                continue;
            }

            // Check if status changed from up to down
            if (previousStatus === 'up' && (currentStatus === 'down' || currentStatus === 'degraded')) {
                this._sendNotification(
                    _('Service Offline'),
                    _('"%s" is now offline or degraded.').format(monitor.name)
                );
                this._log('info', `Monitor ${monitor.name} (${id}) went offline: ${previousStatus} → ${currentStatus}`);
            }
            // Check if status changed from down/degraded to up
            else if ((previousStatus === 'down' || previousStatus === 'degraded') && currentStatus === 'up') {
                if (this._config.notifyOnRecovery) {
                    this._sendNotification(
                        _('Service Recovered'),
                        _('"%s" is back online.').format(monitor.name)
                    );
                    this._log('info', `Monitor ${monitor.name} (${id}) recovered: ${previousStatus} → ${currentStatus}`);
                }
            }

            // Update the stored state
            this._previousMonitorStates.set(id, currentStatus);
        }
    }

    _sendNotification(title, message) {
        try {
            Main.notify(title, message);
        } catch (error) {
            this._log('error', `Failed to send notification: ${error.message}`);
        }
    }

    // Tooltips not supported in GNOME Shell 46+ for panel buttons
    // Keeping this method for potential future use but it's currently disabled
    _setTooltipFromSummary() {
        // if (!this._lastRefresh) {
        //     this.set_tooltip_text(_('Uptime Kuma – no data yet'));
        //     return;
        // }

        // const timeString = this._lastRefresh.format('%H:%M:%S');
    // const tooltip = _('Uptime Kuma – %d up / %d down (as of %s)').format(
    //     this._summaryState.up,
    //     this._summaryState.down,
    //     timeString,
    // );
        // this.set_tooltip_text(tooltip);
    }

    _switchDotClass(status) {
        const styleName = STATUS_CLASS_MAP[status] ?? 'unknown';
        this._dotActor.remove_style_class_name('ok');
        this._dotActor.remove_style_class_name('warn');
        this._dotActor.remove_style_class_name('fail');
        this._dotActor.remove_style_class_name('unknown');
        this._dotActor.add_style_class_name(styleName);
    }

    async _lookupApiKey() {
        // Simply read from GSettings
        const token = this._settings.get_string('api-key');
        return (token && token.length > 0) ? token : null;
    }

    _openBaseUrl() {
        if (!this._config.baseUrl) {
            this._log('info', 'Cannot open base URL because it is not configured');
            return;
        }

        const uri = this._config.baseUrl;
        try {
            Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1, null));
        } catch (error) {
            this._log('error', `Failed to open URL ${uri}: ${error.message}`);
            Main.notify(_('Uptime Kuma Indicator'), _('Failed to open base URL.'));
        }
    }

    _showAbout() {
        const version = this._metadata.version ?? '1';
        Main.notify(_('Uptime Kuma Indicator'), _('Version %s').format(version));
    }

    _manualRefresh() {
        this._log('info', 'Manual refresh triggered');
        this._refresh();
    }

    _updateOpenItemSensitivity() {
        this._openItem.setSensitive(Boolean(this._config.baseUrl));
    }

    _log(level, message) {
        const idx = LOG_LEVELS.indexOf(level);
        const effectiveLevel = idx === -1 ? 'debug' : level;
        if (idx > this._logLevelIndex)
            return;

        const prefix = '[kuma-indicator]';
        if (effectiveLevel === 'error')
            console.error(`${prefix} ${message}`);
        else if (effectiveLevel === 'debug')
            console.debug(`${prefix} ${message}`);
        else
            console.log(`${prefix} [${effectiveLevel}] ${message}`);
    }
});

export default class UptimeKumaIndicatorExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._indicator = null;
    }

    enable() {
        this._indicator = new KumaIndicator(this);
        Main.panel.addToStatusArea(INDICATOR_NAME, this._indicator);
        this._indicator.start();
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
