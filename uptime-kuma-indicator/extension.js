import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { MonitorFetcher } from './utils/network.js';
import { aggregateMonitors, mockMonitors } from './utils/parsers.js';
import { _, ngettext } from './utils/i18n.js';

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
    _init(monitor, showLatency) {
        super._init({
            style_class: 'kuma-list-row',
            vertical: false,
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

        this._latency = new St.Label({
            text: '',
            style_class: 'kuma-monitor-latency',
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
        this.add_child(this._latency);
        this.add_child(this._lastCheck);

        this.update(monitor, showLatency);
    }

    get monitorId() {
        return this._monitorId;
    }

    update(monitor, showLatency) {
        this._monitorId = monitor.id;
        this._name.text = monitor.name ?? '—';
        this._setStatusClass(monitor.status);

        // Note: Tooltips are not easily available in GNOME Shell 46+
        // The message field is typically empty anyway, so we skip tooltip support

        if (showLatency) {
            if (typeof monitor.latencyMs === 'number')
                this._latency.text = `${monitor.latencyMs} ms`;
            else
                this._latency.text = _('n/a');
            this._latency.visible = true;
        } else {
            this._latency.visible = false;
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
            vertical: true,
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
        this._isRefreshing = false;
        this._rows = new Map();
        this._lastRefresh = null;
        this._logLevelIndex = 1;
        this._fetcher = new MonitorFetcher();

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
            vertical: false,
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
    }

    destroy() {
        this.stop();
        super.destroy();
    }

    start() {
        this._log('debug', 'Indicator started');
        this._scheduleRefresh();
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

        if (this._fetcher) {
            this._fetcher.destroy();
            this._fetcher = null;
        }

        for (const id of this._settingsConnections)
            this._settings.disconnect(id);
        this._settingsConnections = [];
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
            'max-items',
            'appearance',
            'log-level',
            'demo-mode',
            'selected-services',
            'show-text',
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

                if (['base-url', 'api-mode', 'status-page-json-url', 'status-page-endpoint', 'status-page-slug', 'api-endpoint', 'metrics-endpoint', 'api-key', 'demo-mode', 'max-items', 'show-latency', 'selected-services'].includes(key))
                    this._refresh();
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
        this._config.maxItems = Math.max(1, this._settings.get_int('max-items'));
        this._config.appearance = this._settings.get_string('appearance') || 'normal';
        this._config.logLevel = this._settings.get_string('log-level') || 'info';
        this._config.demoMode = this._settings.get_boolean('demo-mode');
        this._config.selectedServices = this._settings.get_strv('selected-services');
        this._config.showText = this._settings.get_boolean('show-text');

        this._applyAppearance();
        this._updateLogLevel();
        this._updateTextVisibility();
        this._updateOpenItemSensitivity();
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

            monitors = monitors.slice(0, this._config.maxItems);
            this._updateMonitorList(monitors);
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
                row.update(monitor, this._config.showLatency);
            } else {
                row = new MonitorRow(monitor, this._config.showLatency);
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

    _updateSummary(monitors) {
        const summary = aggregateMonitors(monitors);
        this._summaryState = summary;
        this._lastRefresh = GLib.DateTime.new_now_local();

    const text = _('%d up / %d down').format(summary.up, summary.down);
        this._summaryLabel.text = text;
        this._switchDotClass(summary.status);
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
