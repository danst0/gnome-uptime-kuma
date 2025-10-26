import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { _ } from './utils/i18n.js';

let Secret = null;
let SECRET_SCHEMA = null;

function initLibs() {
    if (Secret) return;

    try {
        Secret = imports.gi.Secret;
        if (Secret) {
            SECRET_SCHEMA = new Secret.Schema('org.gnome.shell.extensions.kuma', Secret.SchemaFlags.NONE, {
                id: Secret.SchemaAttributeType.STRING,
            });
        }
    } catch (error) {
        log('[kuma-indicator] Secret service unavailable in prefs: ' + error.message);
    }
}
const SECRET_KEY_ATTRIBUTE = 'api-key';

export default class UptimeKumaPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        initLibs();
        const settings = this.getSettings();
        const builder = new PreferencesBuilder(settings, window, this.metadata);
        if (!Adw && builder.widget)
            window.add(builder.widget);
    }

    getPreferencesWidget() {
        initLibs();
        const settings = this.getSettings();
        const builder = new PreferencesBuilder(settings, null, this.metadata);
        return builder.widget;
    }
}

class PreferencesBuilder {
    constructor(settings, window, metadata) {
        this._settings = settings;
        this._window = window;
        this._metadata = metadata;
        this._secretAvailable = Boolean(Secret && SECRET_SCHEMA);

        this._apiModeWidgets = new Map();
        this._build();
    }

    _build() {
        if (Adw)
            this._buildAdw();
        else
            this._buildGtk();
    }

    _buildAdw() {
        const page = new Adw.PreferencesPage();

        this._buildConnectionGroup(page);
        this._buildBehaviourGroup(page);
        this._buildAboutGroup(page);

        if (this._window)
            this._window.add(page);
        else
            this.widget = page;
    }

    _buildGtk() {
        const vbox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, margin_top: 12, margin_bottom: 12, margin_start: 12, margin_end: 12 });

        const label = new Gtk.Label({
            label: _('GTK-only fallback – consider installing libadwaita.'),
            wrap: true,
            halign: Gtk.Align.START,
            margin_bottom: 12,
        });
        vbox.append(label);

        const entries = [
            this._buildEntry(_('Base URL'), 'base-url'),
            this._buildEntry(_('Status page slug'), 'status-page-slug'),
            this._buildEntry(_('Status page endpoint template'), 'status-page-endpoint'),
            this._buildEntry(_('Status page JSON URL'), 'status-page-json-url'),
            this._buildEntry(_('API endpoint'), 'api-endpoint'),
        ];
        entries.forEach(widget => vbox.append(widget));

        this.widget = vbox;
    }

    _buildConnectionGroup(page) {
        const group = new Adw.PreferencesGroup({ title: _('Connection'), description: _('Configure how to contact your Uptime Kuma instance.') });

        const baseUrlRow = new Adw.EntryRow({ title: _('Base URL'), text: this._settings.get_string('base-url') });
        baseUrlRow.set_show_apply_button(true);
        baseUrlRow.connect('apply', row => this._settings.set_string('base-url', row.text.trim()));
        group.add(baseUrlRow);

        const modeRow = new Adw.ActionRow({ title: _('API Mode'), subtitle: _('Choose between public status page JSON or private API with token.') });
        const modeSelector = Gtk.DropDown.new_from_strings([
            _('Status page JSON (public)'),
            _('Private API (token)'),
        ]);
        modeSelector.selected = this._settings.get_string('api-mode') === 'api-key' ? 1 : 0;
        modeSelector.connect('notify::selected', widget => {
            const value = widget.selected === 1 ? 'api-key' : 'status-page';
            this._settings.set_string('api-mode', value);
            this._updateVisibility(value);
        });
        modeRow.add_suffix(modeSelector);
        modeRow.activatable_widget = modeSelector;
        group.add(modeRow);
        this._apiModeWidgets.set('mode', modeSelector);

        const slugRow = new Adw.EntryRow({ title: _('Status page slug'), text: this._settings.get_string('status-page-slug') });
        slugRow.set_show_apply_button(true);
        slugRow.connect('apply', row => this._settings.set_string('status-page-slug', row.text.trim()));
        group.add(slugRow);
        this._apiModeWidgets.set('status', slugRow);

    const endpointRow = new Adw.EntryRow({ title: _('Status page endpoint template'), text: this._settings.get_string('status-page-endpoint') });
    endpointRow.set_show_apply_button(true);
    endpointRow.subtitle = _('Use {{slug}} as placeholder. Default: status/{{slug}}/status.json');
        endpointRow.connect('apply', row => this._settings.set_string('status-page-endpoint', row.text.trim()));
        group.add(endpointRow);
        this._apiModeWidgets.set('status-endpoint', endpointRow);

    const jsonRow = new Adw.EntryRow({ title: _('Status page JSON URL (optional)'), text: this._settings.get_string('status-page-json-url') });
    jsonRow.set_show_apply_button(true);
    jsonRow.subtitle = _('Override endpoint template with an explicit URL.');
        jsonRow.connect('apply', row => this._settings.set_string('status-page-json-url', row.text.trim()));
        group.add(jsonRow);
        this._apiModeWidgets.set('status-json', jsonRow);

    const apiEndpointRow = new Adw.EntryRow({ title: _('API endpoint'), text: this._settings.get_string('api-endpoint') });
    apiEndpointRow.set_show_apply_button(true);
    apiEndpointRow.subtitle = _('Relative path, default: api/monitor');
        apiEndpointRow.connect('apply', row => this._settings.set_string('api-endpoint', row.text.trim()));
        group.add(apiEndpointRow);
        this._apiModeWidgets.set('api-endpoint', apiEndpointRow);

        const apiRow = new Adw.ActionRow({ title: _('API token'), subtitle: this._secretAvailable ? _('Stored securely using Secret Service.') : _('Secret Service is unavailable; token cannot be saved securely.') });
        const tokenEntry = new Gtk.PasswordEntry({ placeholder_text: _('Enter new token'), width_chars: 28, show_peek_icon: true, sensitive: this._secretAvailable });
        tokenEntry.connect('activate', () => this._storeApiKey(tokenEntry.text));
        const saveButton = new Gtk.Button({ label: _('Save'), sensitive: this._secretAvailable && tokenEntry.text.length > 0 });
        saveButton.connect('clicked', () => {
            this._storeApiKey(tokenEntry.text);
            tokenEntry.text = '';
        });
        tokenEntry.connect('notify::text', entry => {
            saveButton.sensitive = entry.text.length > 0 && this._secretAvailable;
        });
        apiRow.add_suffix(tokenEntry);
        apiRow.add_suffix(saveButton);

        const deleteButton = new Gtk.Button({ label: _('Remove'), sensitive: this._secretAvailable });
        deleteButton.connect('clicked', () => this._clearApiKey());
        apiRow.add_suffix(deleteButton);

        this._apiKeyStatus = new Gtk.Label({ label: _('Not stored'), halign: Gtk.Align.END, xalign: 1.0 });
        apiRow.add_suffix(this._apiKeyStatus);

        group.add(apiRow);
        this._apiModeWidgets.set('api-token', apiRow);

        page.add(group);

        this._refreshApiKeyStatus();
        this._updateVisibility(this._settings.get_string('api-mode'));
    }

    _buildBehaviourGroup(page) {
        const group = new Adw.PreferencesGroup({ title: _('Behaviour') });

        const refreshRow = new Adw.SpinRow({ title: _('Refresh interval (seconds)'), subtitle: _('Minimum 10 seconds.'), adjustment: new Gtk.Adjustment({ lower: 10, upper: 3600, step_increment: 1, page_increment: 10, value: this._settings.get_int('refresh-seconds') }) });
        refreshRow.connect('notify::value', row => this._settings.set_int('refresh-seconds', Math.max(10, Math.round(row.value))));
        group.add(refreshRow);

        const maxItemsRow = new Adw.SpinRow({ title: _('Maximum monitors to display'), adjustment: new Gtk.Adjustment({ lower: 1, upper: 100, step_increment: 1, page_increment: 5, value: this._settings.get_int('max-items') }) });
        maxItemsRow.connect('notify::value', row => this._settings.set_int('max-items', Math.max(1, Math.round(row.value))));
        group.add(maxItemsRow);

        const latencyRow = new Adw.SwitchRow({ title: _('Show latency'), subtitle: _('Displays ping measurements when available.'), active: this._settings.get_boolean('show-latency') });
        latencyRow.connect('notify::active', row => this._settings.set_boolean('show-latency', row.active));
        group.add(latencyRow);

        const demoRow = new Adw.SwitchRow({ title: _('Enable demo data'), subtitle: _('Use mock monitors when no base URL is configured.'), active: this._settings.get_boolean('demo-mode') });
        demoRow.connect('notify::active', row => this._settings.set_boolean('demo-mode', row.active));
        group.add(demoRow);

        const appearanceRow = new Adw.ActionRow({ title: _('Appearance') });
        const appearanceDropDown = Gtk.DropDown.new_from_strings([
            _('Normal'),
            _('Compact'),
        ]);
        appearanceDropDown.selected = this._settings.get_string('appearance') === 'compact' ? 1 : 0;
        appearanceDropDown.connect('notify::selected', widget => {
            this._settings.set_string('appearance', widget.selected === 1 ? 'compact' : 'normal');
        });
        appearanceRow.add_suffix(appearanceDropDown);
        appearanceRow.activatable_widget = appearanceDropDown;
        group.add(appearanceRow);

        const logRow = new Adw.ActionRow({ title: _('Log level') });
        const logDropDown = Gtk.DropDown.new_from_strings([
            _('Errors only'),
            _('Informational'),
            _('Debug'),
        ]);
        const levels = ['error', 'info', 'debug'];
        const currentLogLevel = this._settings.get_string('log-level');
        logDropDown.selected = Math.max(0, levels.indexOf(currentLogLevel));
        logDropDown.connect('notify::selected', widget => this._settings.set_string('log-level', levels[widget.selected]));
        logRow.add_suffix(logDropDown);
        logRow.activatable_widget = logDropDown;
        group.add(logRow);

        page.add(group);
    }

    _buildAboutGroup(page) {
        const group = new Adw.PreferencesGroup({ title: _('About') });
        const infoRow = new Adw.ActionRow({ title: _('Version'), subtitle: String(this._metadata?.version ?? '1') });
        infoRow.set_sensitive(false);
        group.add(infoRow);

        const docsRow = new Adw.ActionRow({ title: _('Need help?'), subtitle: _('Check the README for configuration examples.') });
        docsRow.set_sensitive(false);
        group.add(docsRow);

        page.add(group);
    }

    _buildEntry(label, key) {
        const entry = new Gtk.Entry({ text: this._settings.get_string(key), hexpand: true });
        entry.connect('changed', widget => this._settings.set_string(key, widget.text.trim()));
        const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
        box.append(new Gtk.Label({ label, halign: Gtk.Align.START }));
        box.append(entry);
        return box;
    }

    _updateVisibility(mode) {
        const currentMode = mode === 'api-key' ? 'api-key' : 'status-page';

        const statusWidgets = [
            this._apiModeWidgets.get('status'),
            this._apiModeWidgets.get('status-endpoint'),
            this._apiModeWidgets.get('status-json'),
        ];
        const apiWidgets = [
            this._apiModeWidgets.get('api-endpoint'),
            this._apiModeWidgets.get('api-token'),
        ];

        statusWidgets.forEach(widget => {
            if (widget)
                widget.visible = currentMode === 'status-page';
        });

        apiWidgets.forEach(widget => {
            if (widget)
                widget.visible = currentMode === 'api-key';
        });
    }

    async _storeApiKey(token) {
        if (!this._secretAvailable || !token)
            return;

        await new Promise((resolve, reject) => {
            Secret.password_store(SECRET_SCHEMA, { id: SECRET_KEY_ATTRIBUTE }, Secret.COLLECTION_DEFAULT, 'Uptime Kuma Indicator token', token, null, (source, result) => {
                try {
                    Secret.password_store_finish(result);
                    resolve();
                } catch (error) {
                    logError(error, '[kuma-indicator] Failed to store token');
                    reject(error);
                }
            });
        }).catch(() => {});

        this._refreshApiKeyStatus();
    }

    async _clearApiKey() {
        if (!this._secretAvailable)
            return;

        await new Promise(resolve => {
            Secret.password_clear(SECRET_SCHEMA, { id: SECRET_KEY_ATTRIBUTE }, null, (source, result) => {
                try {
                    Secret.password_clear_finish(result);
                } catch (error) {
                    logError(error, '[kuma-indicator] Failed to clear token');
                } finally {
                    resolve();
                }
            });
        });

        this._refreshApiKeyStatus();
    }

    async _refreshApiKeyStatus() {
        if (!this._apiKeyStatus)
            return;

        if (!this._secretAvailable) {
            this._apiKeyStatus.label = _('Unavailable');
            return;
        }

        const token = await new Promise(resolve => {
            Secret.password_lookup(SECRET_SCHEMA, { id: SECRET_KEY_ATTRIBUTE }, null, (source, result) => {
                try {
                    const value = Secret.password_lookup_finish(result);
                    resolve(value ?? null);
                } catch (error) {
                    logError(error, '[kuma-indicator] Failed to read token');
                    resolve(null);
                }
            });
        });

        this._apiKeyStatus.label = token ? _('Stored') : _('Not stored');
    }
}
