import GLib from 'gi://GLib';
import Gettext from 'gettext';

const domain = 'uptime-kuma-indicator';

let gettextFn = text => text;
let ngettextFn = (singular, plural, count) => (count === 1 ? singular : plural);

try {
    Gettext.bindtextdomain(domain, GLib.build_filenamev([GLib.get_user_data_dir(), 'locale']));
    Gettext.textdomain(domain);
    gettextFn = Gettext.gettext;
    ngettextFn = Gettext.ngettext;
} catch (error) {
    log('[kuma-indicator] Gettext initialization failed: ' + error.message);
}

export const _ = gettextFn;
export const ngettext = ngettextFn;
