import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import { normalizeApi, normalizeStatusPage } from './parsers.js';
import { _ } from './i18n.js';

const DEFAULT_TIMEOUT_SECONDS = 8;
const DEFAULT_RETRIES = 3;
const RETRY_BACKOFF = 1.6;
const USER_AGENT = 'UptimeKumaIndicator/1.0 (GNOME Shell Extension)';
const BADGE_PERCENTAGE_PATTERN = />\s*(\d+(?:[.,]\d+)?)\s*%/;

function bytesToString(bytes) {
    if (!bytes)
        return '';
    
    try {
        if (bytes instanceof GLib.Bytes) {
            const data = bytes.get_data();
            return new TextDecoder().decode(data);
        }
        return new TextDecoder().decode(bytes);
    } catch (error) {
        log('[kuma-indicator] Failed to decode bytes: ' + error.message);
        return '';
    }
}

function joinUrl(base, path) {
    if (!base)
        return path;
    if (!path)
        return base;
    if (path.startsWith('http://') || path.startsWith('https://'))
        return path;
    const cleanedBase = base.endsWith('/') ? base.slice(0, -1) : base;
    const cleanedPath = path.startsWith('/') ? path.slice(1) : path;
    return `${cleanedBase}/${cleanedPath}`;
}

function parseBadgePercentage(svg) {
    if (typeof svg !== 'string' || svg.length === 0)
        return null;

    const match = BADGE_PERCENTAGE_PATTERN.exec(svg);
    if (!match)
        return null;

    const normalized = match[1].replace(',', '.');
    const value = Number.parseFloat(normalized);
    if (!Number.isFinite(value))
        return null;

    return value;
}

function sleepAsync(milliseconds) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

export class MonitorFetcher {
    constructor({ timeoutSeconds = DEFAULT_TIMEOUT_SECONDS, retries = DEFAULT_RETRIES, backoff = RETRY_BACKOFF } = {}) {
        this._timeoutSeconds = timeoutSeconds;
        this._retries = retries;
        this._backoff = backoff;

        this._session = new Soup.Session({
            user_agent: USER_AGENT,
            timeout: timeoutSeconds,
        });
        this._session.allow_tls = true;
    }

    async fetch(config, helpers = {}) {
        const mode = config.apiMode === 'api-key' ? 'api-key' : 'status-page';
        const log = helpers.log ?? (() => {});

        if (mode === 'status-page')
            return this._fetchStatusPage(config, log);

        return this._fetchPrivateApi(config, helpers, log);
    }

    async fetchUptimeBadge(monitorId, config, helpers = {}) {
        if (monitorId === undefined || monitorId === null)
            return null;

        const { baseUrl } = config;
        if (!baseUrl)
            throw new Error(_('Base URL is missing.'));

        const log = helpers.log ?? (() => {});
        const encodedId = encodeURIComponent(String(monitorId));
        const endpoint = `api/badge/${encodedId}/uptime/24h`;
        const url = joinUrl(baseUrl, endpoint);
        log('debug', `Fetching uptime badge from ${url}`);

        const svg = await this._request(url, {
            headers: {
                Accept: 'image/svg+xml,*/*;q=0.8',
            },
        });

        return parseBadgePercentage(svg);
    }

    async _fetchStatusPage(config, log) {
        const { baseUrl, statusPageJsonUrl, statusPageSlug, statusPageEndpoint } = config;

        if (!baseUrl)
            throw new Error(_('Base URL is missing.'));

        let endpoint = statusPageJsonUrl || '';
        if (!endpoint) {
            const template = statusPageEndpoint || 'status/{{slug}}/status.json';
            const slug = encodeURIComponent(statusPageSlug || 'default');
            endpoint = template.includes('{{slug}}') ? template.replace('{{slug}}', slug) : `${template}/${slug}`;
        }

        const url = joinUrl(baseUrl, endpoint);
        log('debug', `Fetching status page from ${url}`);

        const json = await this._getJson(url, { headers: { Accept: 'application/json' } });
        const monitors = normalizeStatusPage(json);
        return { source: 'status-page', monitors };
    }

    async _fetchPrivateApi(config, helpers, log) {
        const { baseUrl, apiEndpoint } = config;
        if (!baseUrl)
            throw new Error(_('Base URL is missing.'));

        const getApiKey = helpers.getApiKey;
        const apiKey = getApiKey ? await getApiKey() : null;
        if (!apiKey)
            throw new Error(_('API token is not available.'));

        const endpoint = apiEndpoint || 'api/monitor';
        const url = joinUrl(baseUrl, endpoint);
        log('debug', `Fetching private API from ${url}`);

        const json = await this._getJson(url, {
            headers: {
                Accept: 'application/json',
                Authorization: apiKey,
            },
        });
        const monitors = normalizeApi(json);
        return { source: 'api', monitors };
    }

    async _getJson(url, options = {}) {
        const text = await this._request(url, options);
        if (!text)
            return null;

        return JSON.parse(text);
    }

    async _request(url, { headers = {}, method = 'GET', body = null } = {}) {
        let attempt = 0;
        let wait = 400;
        let lastError = null;

        while (attempt < this._retries) {
            const message = Soup.Message.new(method, url);
            message.timeout = this._timeoutSeconds;

            for (const [key, value] of Object.entries(headers))
                message.request_headers.replace(key, value);

            if (body) {
                let payload = body;
                let mime = 'application/json';

                if (typeof payload === 'string') {
                    payload = new TextEncoder().encode(payload);
                    mime = 'text/plain';
                } else if (payload instanceof Uint8Array) {
                    mime = 'application/octet-stream';
                } else if (!(payload instanceof GLib.Bytes)) {
                    payload = new TextEncoder().encode(JSON.stringify(payload));
                }

                const bytes = payload instanceof GLib.Bytes ? payload : new GLib.Bytes(payload);
                message.set_request_body_from_bytes(mime, bytes);
            }

            try {
                const bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
                const status = message.get_status();

                if (status >= 200 && status < 300)
                    return bytesToString(bytes);

                lastError = new Error(`HTTP ${status}`);
            } catch (error) {
                lastError = error;
            }

            attempt++;
            if (attempt < this._retries)
                await sleepAsync(wait);
            wait = Math.min(wait * this._backoff, 4000);
        }

        if (lastError)
            throw lastError;
        throw new Error(_('Unknown network error'));
    }
}
