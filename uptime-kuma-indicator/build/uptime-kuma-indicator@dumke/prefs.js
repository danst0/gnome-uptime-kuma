import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { _ } from './utils/i18n.js';

export default class UptimeKumaPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const builder = new PreferencesBuilder(settings, window, this.metadata);
        if (!Adw && builder.widget)
            window.add(builder.widget);
    }

    getPreferencesWidget() {
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

        this._apiModeWidgets = new Map();
        this._availableServices = [];
        this._serviceDropdowns = [];
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
        this._buildServiceSelectionGroup(page);
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
        baseUrlRow.set_show_apply_button(false);
        baseUrlRow.connect('notify::text', row => this._settings.set_string('base-url', row.text.trim()));
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
        slugRow.set_show_apply_button(false);
        slugRow.connect('notify::text', row => this._settings.set_string('status-page-slug', row.text.trim()));
        group.add(slugRow);
        this._apiModeWidgets.set('status', slugRow);

    const endpointRow = new Adw.EntryRow({ title: _('Status page endpoint template'), text: this._settings.get_string('status-page-endpoint') });
    endpointRow.set_show_apply_button(false);
    endpointRow.subtitle = _('Use {{slug}} as placeholder. Default: status/{{slug}}/status.json');
        endpointRow.connect('notify::text', row => this._settings.set_string('status-page-endpoint', row.text.trim()));
        group.add(endpointRow);
        this._apiModeWidgets.set('status-endpoint', endpointRow);

    const jsonRow = new Adw.EntryRow({ title: _('Status page JSON URL (optional)'), text: this._settings.get_string('status-page-json-url') });
    jsonRow.set_show_apply_button(false);
    jsonRow.subtitle = _('Override endpoint template with an explicit URL.');
        jsonRow.connect('notify::text', row => this._settings.set_string('status-page-json-url', row.text.trim()));
        group.add(jsonRow);
        this._apiModeWidgets.set('status-json', jsonRow);

    const apiEndpointRow = new Adw.EntryRow({ title: _('API endpoint'), text: this._settings.get_string('api-endpoint') });
    apiEndpointRow.set_show_apply_button(false);
    apiEndpointRow.subtitle = _('Relative path, default: api/monitor');
        apiEndpointRow.connect('notify::text', row => this._settings.set_string('api-endpoint', row.text.trim()));
        group.add(apiEndpointRow);
        this._apiModeWidgets.set('api-endpoint', apiEndpointRow);

        // API Token Entry Row
        const tokenRow = new Adw.EntryRow({ 
            title: _('API token'),
            text: this._settings.get_string('api-key'),
            show_apply_button: false
        });
        tokenRow.connect('notify::text', row => {
            this._settings.set_string('api-key', row.text.trim());
        });
        
        group.add(tokenRow);
        this._apiModeWidgets.set('api-token', tokenRow);

        page.add(group);

        this._updateVisibility(this._settings.get_string('api-mode'));
    }

    _buildServiceSelectionGroup(page) {
        const group = new Adw.PreferencesGroup({ 
            title: _('Service Selection'), 
            description: _('Select up to 4 specific services to monitor. Leave empty to monitor all services.') 
        });

        // Fetch services button
        const fetchRow = new Adw.ActionRow({ 
            title: _('Fetch Services'), 
            subtitle: _('Load available services from your Uptime Kuma instance.') 
        });
        const fetchButton = new Gtk.Button({ 
            label: _('Fetch'),
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.END
        });
        fetchButton.add_css_class('suggested-action');
        fetchButton.connect('clicked', () => this._fetchServices(fetchButton));
        fetchRow.add_suffix(fetchButton);
        fetchRow.activatable_widget = fetchButton;
        group.add(fetchRow);

        // Service dropdowns
        const selectedServices = this._settings.get_strv('selected-services');
        for (let i = 0; i < 4; i++) {
            const serviceRow = new Adw.ActionRow({ 
                title: `${_('Service')} ${i + 1}`,
                subtitle: _('Select a service to monitor')
            });
            
            const dropdown = new Gtk.DropDown({
                valign: Gtk.Align.CENTER,
                model: new Gtk.StringList()
            });
            
            // Add "None" option
            dropdown.model.append(_('(None)'));
            dropdown.selected = 0;
            
            // If there's a saved selection, we'll restore it after fetching
            if (selectedServices[i]) {
                dropdown.model.append(selectedServices[i]);
                dropdown.selected = 1;
            }
            
            dropdown.connect('notify::selected', () => this._onServiceSelected());
            
            this._serviceDropdowns.push(dropdown);
            serviceRow.add_suffix(dropdown);
            serviceRow.activatable_widget = dropdown;
            group.add(serviceRow);
        }

        page.add(group);
    }

    async _fetchServices(button) {
        // Disable button during fetch
        button.sensitive = false;
        button.label = _('Fetching...');

        try {
            const baseUrl = this._settings.get_string('base-url');
            const apiMode = this._settings.get_string('api-mode');
            
            if (!baseUrl) {
                this._showError(_('Please configure Base URL first.'));
                return;
            }

            let services = [];
            
            if (apiMode === 'api-key') {
                // Fetch from private API
                const apiKey = this._settings.get_string('api-key');
                if (!apiKey) {
                    this._showError(_('Please configure API token first.'));
                    return;
                }
                
                const apiEndpoint = this._settings.get_string('api-endpoint') || 'api/monitor';
                services = await this._fetchFromPrivateApi(baseUrl, apiEndpoint, apiKey);
            } else {
                // Fetch from status page
                const statusPageSlug = this._settings.get_string('status-page-slug') || 'default';
                const statusPageEndpoint = this._settings.get_string('status-page-endpoint') || 'status/{{slug}}/status.json';
                const statusPageJsonUrl = this._settings.get_string('status-page-json-url');
                services = await this._fetchFromStatusPage(baseUrl, statusPageSlug, statusPageEndpoint, statusPageJsonUrl);
            }

            this._availableServices = services;
            this._updateServiceDropdowns();
            
        } catch (error) {
            this._showError(`${_('Failed to fetch services')}: ${error.message}`);
            console.error('Service fetch error:', error);
        } finally {
            button.sensitive = true;
            button.label = _('Fetch');
        }
    }

    async _fetchFromStatusPage(baseUrl, slug, endpointTemplate, jsonUrl) {
        let endpoint = jsonUrl || '';
        if (!endpoint) {
            const template = endpointTemplate || 'status/{{slug}}/status.json';
            const encodedSlug = encodeURIComponent(slug);
            endpoint = template.includes('{{slug}}') ? template.replace('{{slug}}', encodedSlug) : `${template}/${encodedSlug}`;
        }

        const url = this._joinUrl(baseUrl, endpoint);
        const json = await this._getJson(url);
        
        // Parse status page format
        const publicGroupList = json?.publicGroupList || [];
        const services = [];
        
        for (const group of publicGroupList) {
            const monitorList = group?.monitorList || [];
            for (const monitor of monitorList) {
                if (monitor.id && monitor.name) {
                    services.push({
                        id: String(monitor.id),
                        name: monitor.name
                    });
                }
            }
        }
        
        return services;
    }

    async _fetchFromPrivateApi(baseUrl, apiEndpoint, apiKey) {
        const url = this._joinUrl(baseUrl, apiEndpoint);
        const json = await this._getJson(url, {
            'Accept': 'application/json',
            'Authorization': apiKey
        });
        
        // Parse API format
        const monitorList = json?.monitorList || [];
        const services = [];
        
        for (const monitor of monitorList) {
            if (monitor.id && monitor.name) {
                services.push({
                    id: String(monitor.id),
                    name: monitor.name
                });
            }
        }
        
        return services;
    }

    async _getJson(url, headers = {}) {
        return new Promise((resolve, reject) => {
            const session = new Soup.Session({ timeout: 10 });
            const message = Soup.Message.new('GET', url);
            
            message.request_headers.replace('Accept', 'application/json');
            for (const [key, value] of Object.entries(headers)) {
                message.request_headers.replace(key, value);
            }

            session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (sess, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    const status = message.get_status();

                    if (status < 200 || status >= 300) {
                        reject(new Error(`HTTP ${status}`));
                        return;
                    }

                    const data = bytes.get_data();
                    const text = new TextDecoder().decode(data);
                    resolve(JSON.parse(text));
                } catch (error) {
                    reject(error);
                }
            });
        });
    }

    _joinUrl(base, path) {
        if (!base) return path;
        if (!path) return base;
        if (path.startsWith('http://') || path.startsWith('https://')) return path;
        const cleanedBase = base.endsWith('/') ? base.slice(0, -1) : base;
        const cleanedPath = path.startsWith('/') ? path.slice(1) : path;
        return `${cleanedBase}/${cleanedPath}`;
    }

    _updateServiceDropdowns() {
        const selectedServices = this._settings.get_strv('selected-services');
        
        for (let i = 0; i < this._serviceDropdowns.length; i++) {
            const dropdown = this._serviceDropdowns[i];
            const model = dropdown.model;
            
            // Clear existing items except "None"
            while (model.get_n_items() > 1) {
                model.remove(1);
            }
            
            // Add all available services
            for (const service of this._availableServices) {
                model.append(`${service.name} (ID: ${service.id})`);
            }
            
            // Restore previous selection if it still exists
            if (selectedServices[i]) {
                const index = this._availableServices.findIndex(s => s.id === selectedServices[i]);
                if (index !== -1) {
                    dropdown.selected = index + 1; // +1 because of "None" option
                } else {
                    dropdown.selected = 0;
                }
            } else {
                dropdown.selected = 0;
            }
        }
    }

    _onServiceSelected() {
        const selectedServices = [];
        
        for (const dropdown of this._serviceDropdowns) {
            const selected = dropdown.selected;
            if (selected > 0 && selected <= this._availableServices.length) {
                const service = this._availableServices[selected - 1];
                selectedServices.push(service.id);
            }
        }
        
        this._settings.set_strv('selected-services', selectedServices);
    }

    _showError(message) {
        // In a real implementation, you might want to show a dialog
        // For now, we'll just log it
        console.error(message);
        
        // Try to show a toast if available (GNOME 42+)
        if (this._window && this._window.add_toast) {
            const toast = new Adw.Toast({
                title: message,
                timeout: 3
            });
            this._window.add_toast(toast);
        }
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
}
