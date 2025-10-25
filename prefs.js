'use strict';

const { Adw, Gtk } = imports.gi;
const ExtensionUtils = imports.misc.extensionUtils;
const Gettext = imports.gettext;

const Me = ExtensionUtils.getCurrentExtension();
const _ = Gettext.domain(Me.metadata['gettext-domain'] || 'uptime-kuma').gettext;

function init() {}

function fillPreferencesWindow(window) {
    const settings = ExtensionUtils.getSettings();

    window.set_title(_('Uptime Kuma Status Settings'));

    const page = new Adw.PreferencesPage();
    window.add(page);

    const generalGroup = new Adw.PreferencesGroup({ title: _('General') });
    page.add(generalGroup);

    const serverRow = new Adw.EntryRow({ title: _('Server URL'), subtitle: _('Base URL of your Uptime Kuma instance') });
    serverRow.text = settings.get_string('server-url');
    serverRow.connect('notify::text', row => {
        settings.set_string('server-url', row.text.trim());
    });
    generalGroup.add(serverRow);

    const slugRow = new Adw.EntryRow({ title: _('Status Page Slug'), subtitle: _('Optional public status page slug to use') });
    slugRow.text = settings.get_string('status-page-slug');
    slugRow.connect('notify::text', row => {
        settings.set_string('status-page-slug', row.text.trim());
    });
    generalGroup.add(slugRow);

    const monitorRow = new Adw.EntryRow({
        title: _('Monitor IDs'),
        subtitle: _('Comma separated list of monitor IDs to display (leave empty for all)')
    });
    monitorRow.text = settings.get_string('monitor-ids');
    monitorRow.connect('notify::text', row => {
        settings.set_string('monitor-ids', row.text);
    });
    generalGroup.add(monitorRow);

    const refreshGroup = new Adw.PreferencesGroup({ title: _('Refresh Interval') });
    page.add(refreshGroup);

    const refreshRow = new Adw.ActionRow({
        title: _('Update every'),
        subtitle: _('Seconds between refreshes')
    });
    const adjustment = new Gtk.Adjustment({
        lower: 10,
        upper: 3600,
        step_increment: 5,
        page_increment: 30,
        value: settings.get_int('refresh-interval'),
    });
    const spinButton = new Gtk.SpinButton({ adjustment, numeric: true });
    spinButton.set_valign(Gtk.Align.CENTER);
    spinButton.set_width_chars(4);
    spinButton.connect('value-changed', widget => {
        settings.set_int('refresh-interval', widget.get_value_as_int());
    });
    refreshRow.add_suffix(spinButton);
    refreshRow.set_activatable_widget(spinButton);
    refreshGroup.add(refreshRow);
}
