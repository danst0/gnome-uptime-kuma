import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { _ } from './utils/i18n.js';
import { normalizeMetrics } from './utils/parsers.js';

export default class UptimeKumaPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const builder = new PreferencesBuilder(settings, window, this.metadata);
        if (!Adw && builder.widget)
            window.add(builder.widget);
    }
}

class PreferencesBuilder {
    constructor(settings, window, metadata) {
        this._settings = settings;
        this._window = window;
        this._metadata = metadata;

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
            this._buildEntry(_('Metrics endpoint'), 'metrics-endpoint'),
        ];
        entries.forEach(widget => vbox.append(widget));

        this.widget = vbox;
    }

    _buildConnectionGroup(page) {
        const group = new Adw.PreferencesGroup({ title: _('Connection'), description: _('Configure how to contact your Uptime Kuma Prometheus metrics endpoint.') });

        const baseUrlRow = new Adw.EntryRow({ title: _('Base URL'), text: this._settings.get_string('base-url') });
        baseUrlRow.set_show_apply_button(false);
        baseUrlRow.connect('notify::text', row => this._settings.set_string('base-url', row.text.trim()));
        group.add(baseUrlRow);

        const metricsEndpointRow = new Adw.EntryRow({ title: _('Metrics endpoint'), text: this._settings.get_string('metrics-endpoint') });
        metricsEndpointRow.set_show_apply_button(false);
        metricsEndpointRow.subtitle = _('Relative path, default: metrics');
        metricsEndpointRow.connect('notify::text', row => this._settings.set_string('metrics-endpoint', row.text.trim()));
        group.add(metricsEndpointRow);

        // API Token Entry Row with visibility toggle
        const tokenRow = new Adw.PasswordEntryRow({ 
            title: _('API token'),
            text: this._settings.get_string('api-key'),
            show_apply_button: false
        });
        tokenRow.connect('notify::text', row => {
            this._settings.set_string('api-key', row.text.trim());
        });
        
        group.add(tokenRow);

        page.add(group);

        // Ensure metrics mode is set
        this._settings.set_string('api-mode', 'metrics');
    }

    _buildServiceSelectionGroup(page) {
        this._serviceGroup = new Adw.PreferencesGroup({ 
            title: _('Service Selection'), 
            description: _('Select up to 10 specific services to monitor. Leave empty to monitor all services.') 
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
        this._serviceGroup.add(fetchRow);

        // Build service rows from saved selection
        this._rebuildServiceRows();

        // Add button for adding new services
        const addRow = new Adw.ActionRow({ 
            title: _('Add Service'),
            subtitle: _('Add another service to monitor')
        });
        const addButton = new Gtk.Button({ 
            icon_name: 'list-add-symbolic',
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.END,
            tooltip_text: _('Add service')
        });
        addButton.connect('clicked', () => this._addServiceRow());
        addRow.add_suffix(addButton);
        addRow.activatable_widget = addButton;
        this._addServiceRowWidget = addRow;
        this._serviceGroup.add(addRow);

        page.add(this._serviceGroup);
    }

    _rebuildServiceRows() {
        // Remove all existing service rows (keep fetch button and add button)
        this._serviceDropdowns = [];
        this._serviceRows = [];
        
        const selectedServices = this._settings.get_strv('selected-services');
        
        // If no services selected, start with one empty row
        if (selectedServices.length === 0) {
            this._createServiceRow(null, 0);
        } else {
            // Create a row for each selected service
            selectedServices.forEach((serviceId, index) => {
                this._createServiceRow(serviceId, index);
            });
        }
        
        this._updateAddButtonVisibility();
    }

    _createServiceRow(serviceId, index) {
        const serviceRow = new Adw.ActionRow({ 
            title: `${_('Service')} ${index + 1}`,
            subtitle: _('Select a service to monitor')
        });
        
        const dropdown = new Gtk.DropDown({
            valign: Gtk.Align.CENTER,
            model: new Gtk.StringList()
        });
        
        // Add "None" option
        dropdown.model.append(_('(None)'));
        dropdown.selected = 0;
        
        // If there's a saved selection or available services, populate
        if (serviceId && this._availableServices.length > 0) {
            const service = this._availableServices.find(s => s.id === serviceId);
            if (service) {
                // Rebuild full list
                for (const svc of this._availableServices) {
                    dropdown.model.append(`${svc.name} (ID: ${svc.id})`);
                }
                const idx = this._availableServices.findIndex(s => s.id === serviceId);
                if (idx !== -1) {
                    dropdown.selected = idx + 1;
                }
            }
        } else if (this._availableServices.length > 0) {
            // Populate with available services
            for (const svc of this._availableServices) {
                dropdown.model.append(`${svc.name} (ID: ${svc.id})`);
            }
        }
        
        dropdown.connect('notify::selected', () => this._onServiceSelected());
        
        // Delete button
        const deleteButton = new Gtk.Button({ 
            icon_name: 'user-trash-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Remove service'),
            css_classes: ['flat', 'circular']
        });
        deleteButton.connect('clicked', () => this._removeServiceRow(serviceRow));
        
        serviceRow.add_suffix(dropdown);
        serviceRow.add_suffix(deleteButton);
        serviceRow.activatable_widget = dropdown;
        
        this._serviceDropdowns.push(dropdown);
        this._serviceRows.push(serviceRow);
        
        // Insert before the add button row
        const addRowIndex = this._findRowIndex(this._addServiceRowWidget);
        if (addRowIndex > 0) {
            this._serviceGroup.remove(this._addServiceRowWidget);
            this._serviceGroup.add(serviceRow);
            this._serviceGroup.add(this._addServiceRowWidget);
        } else {
            this._serviceGroup.add(serviceRow);
        }
        
        return serviceRow;
    }

    _findRowIndex(row) {
        // Helper to find row position in group
        let index = 0;
        let child = this._serviceGroup.get_first_child();
        while (child) {
            if (child === row) return index;
            index++;
            child = child.get_next_sibling();
        }
        return -1;
    }

    _addServiceRow() {
        const currentCount = this._serviceDropdowns.length;
        if (currentCount >= 10) {
            this._showError(_('Maximum of 10 services reached'));
            return;
        }
        
        this._createServiceRow(null, currentCount);
        this._updateAddButtonVisibility();
        this._onServiceSelected();
    }

    _removeServiceRow(row) {
        const index = this._serviceRows.indexOf(row);
        if (index === -1) return;
        
        this._serviceRows.splice(index, 1);
        this._serviceDropdowns.splice(index, 1);
        this._serviceGroup.remove(row);
        
        // Renumber remaining services
        this._serviceRows.forEach((r, i) => {
            r.title = `${_('Service')} ${i + 1}`;
        });
        
        this._updateAddButtonVisibility();
        this._onServiceSelected();
    }

    _updateAddButtonVisibility() {
        const currentCount = this._serviceDropdowns.length;
        this._addServiceRowWidget.set_visible(currentCount < 10);
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
            } else if (apiMode === 'metrics') {
                const apiKey = this._settings.get_string('api-key');
                if (!apiKey) {
                    this._showError(_('Please configure API token first.'));
                    return;
                }

                const metricsEndpoint = this._settings.get_string('metrics-endpoint') || 'metrics';
                services = await this._fetchFromMetrics(baseUrl, metricsEndpoint, apiKey);
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

    async _fetchFromMetrics(baseUrl, metricsEndpoint, apiKey) {
        const url = this._joinUrl(baseUrl, metricsEndpoint);
        const authHeader = this._encodeBasicAuth('', apiKey);
        const text = await this._getText(url, {
            'Accept': 'text/plain',
            'Authorization': authHeader,
        });

        const monitors = normalizeMetrics(text) ?? [];
        const unique = new Map();

        for (const monitor of monitors) {
            if (!monitor || !monitor.id || !monitor.name)
                continue;
            unique.set(String(monitor.id), monitor.name);
        }

        return Array.from(unique.entries()).map(([id, name]) => ({ id, name }));
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

    async _getText(url, headers = {}) {
        return new Promise((resolve, reject) => {
            const session = new Soup.Session({ timeout: 10 });
            const message = Soup.Message.new('GET', url);

            if (!headers.Accept)
                message.request_headers.replace('Accept', 'text/plain');
            for (const [key, value] of Object.entries(headers))
                message.request_headers.replace(key, value);

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
                    resolve(text);
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
            const currentSelection = dropdown.selected;
            let selectedServiceId = null;
            
            // Get currently selected service ID before clearing
            if (currentSelection > 0 && currentSelection <= this._availableServices.length) {
                selectedServiceId = this._availableServices[currentSelection - 1].id;
            } else if (selectedServices[i]) {
                selectedServiceId = selectedServices[i];
            }
            
            // Clear existing items except "None"
            while (model.get_n_items() > 1) {
                model.remove(1);
            }
            
            // Add all available services
            for (const service of this._availableServices) {
                model.append(`${service.name} (ID: ${service.id})`);
            }
            
            // Restore previous selection if it still exists
            if (selectedServiceId) {
                const index = this._availableServices.findIndex(s => s.id === selectedServiceId);
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

    _encodeBasicAuth(username, password) {
        const user = username ?? '';
        const pass = password ?? '';
        const credentials = `${user}:${pass}`;
        const encoded = GLib.base64_encode(new TextEncoder().encode(credentials));
        return `Basic ${encoded}`;
    }

    _buildBehaviourGroup(page) {
        const group = new Adw.PreferencesGroup({ title: _('Behaviour') });

        const refreshRow = new Adw.SpinRow({ title: _('Refresh interval (seconds)'), subtitle: _('Minimum 10 seconds.'), adjustment: new Gtk.Adjustment({ lower: 10, upper: 3600, step_increment: 1, page_increment: 10, value: this._settings.get_int('refresh-seconds') }) });
        refreshRow.connect('notify::value', row => this._settings.set_int('refresh-seconds', Math.max(10, Math.round(row.value))));
        group.add(refreshRow);

        const latencyRow = new Adw.SwitchRow({ title: _('Show latency'), subtitle: _('Displays ping measurements when available.'), active: this._settings.get_boolean('show-latency') });
        latencyRow.connect('notify::active', row => this._settings.set_boolean('show-latency', row.active));
        group.add(latencyRow);

        const showTextRow = new Adw.SwitchRow({ title: _('Show text in panel'), subtitle: _('Display status summary next to the indicator dot.'), active: this._settings.get_boolean('show-text') });
        showTextRow.connect('notify::active', row => this._settings.set_boolean('show-text', row.active));
        group.add(showTextRow);

    const sparklineRow = new Adw.SwitchRow({ title: _('Show history sparkline'), subtitle: _('Display a 24-hour status bar next to each monitor.'), active: this._settings.get_boolean('show-sparkline') });
    sparklineRow.connect('notify::active', row => this._settings.set_boolean('show-sparkline', row.active));
    group.add(sparklineRow);

        const notificationsRow = new Adw.SwitchRow({ title: _('Enable notifications'), subtitle: _('Show desktop notifications when a service goes offline.'), active: this._settings.get_boolean('enable-notifications') });
        
        const notifyRecoveryRow = new Adw.SwitchRow({ title: _('Notify on recovery'), subtitle: _('Show desktop notifications when a service comes back online.'), active: this._settings.get_boolean('notify-on-recovery') });
        notifyRecoveryRow.connect('notify::active', row => this._settings.set_boolean('notify-on-recovery', row.active));
        
        // Set initial sensitivity based on notifications state
        notifyRecoveryRow.sensitive = this._settings.get_boolean('enable-notifications');
        
        notificationsRow.connect('notify::active', row => {
            this._settings.set_boolean('enable-notifications', row.active);
            // Enable/disable notify on recovery based on notifications state
            notifyRecoveryRow.sensitive = row.active;
        });
        
        group.add(notificationsRow);
        group.add(notifyRecoveryRow);

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
        
        // Version
        const version = this._metadata['version-name'] || this._metadata.version || '1.0';
        const versionRow = new Adw.ActionRow({ 
            title: _('Version'), 
            subtitle: version 
        });
        versionRow.set_sensitive(false);
        group.add(versionRow);
        
        // Author
        const authorRow = new Adw.ActionRow({ 
            title: _('Author'), 
            subtitle: 'Daniel Dumke' 
        });
        authorRow.set_sensitive(false);
        group.add(authorRow);
        
        // GitHub
        const githubRow = new Adw.ActionRow({ 
            title: _('GitHub'), 
            subtitle: this._metadata.url || 'https://github.com/danst0/gnome-uptime-kuma',
            activatable: true
        });
        const linkButton = new Gtk.Button({ 
            icon_name: 'adw-external-link-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Open on GitHub')
        });
        linkButton.connect('clicked', () => {
            const url = this._metadata.url || 'https://github.com/danst0/gnome-uptime-kuma';
            Gtk.show_uri(this._window, url, null);
        });
        githubRow.add_suffix(linkButton);
        githubRow.activatable_widget = linkButton;
        group.add(githubRow);

        // Documentation
        const docsRow = new Adw.ActionRow({ 
            title: _('Documentation'), 
            subtitle: _('Check the README for configuration examples.') 
        });
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

    _updateOpenItemSensitivity() {
        // Removed - no longer needed
    }
}
