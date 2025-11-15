import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import { normalizeApi, normalizeHeartbeatHistory, normalizeMetrics, normalizeStatusPage } from './parsers.js';
import { _ } from './i18n.js';

const DEFAULT_TIMEOUT_SECONDS = 8;
const DEFAULT_RETRIES = 3;
const RETRY_BACKOFF = 1.6;
const USER_AGENT = 'UptimeKumaIndicator/1.0 (GNOME Shell Extension)';
const HEARTBEAT_LIMIT = 24;
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
        console.error('[kuma-indicator] Failed to decode bytes: ' + error.message);
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

export class MonitorFetcher {
    constructor({ timeoutSeconds = DEFAULT_TIMEOUT_SECONDS, retries = DEFAULT_RETRIES, backoff = RETRY_BACKOFF } = {}) {
        this._timeoutSeconds = timeoutSeconds;
        this._retries = retries;
        this._backoff = backoff;
        this._activeTimeouts = new Set();

        this._session = new Soup.Session({
            user_agent: USER_AGENT,
            timeout: timeoutSeconds,
        });
        this._session.allow_tls = true;
    }

    destroy() {
        // Remove all active timeouts
        for (const timeoutId of this._activeTimeouts) {
            GLib.source_remove(timeoutId);
        }
        this._activeTimeouts.clear();
        
        if (this._session) {
            this._session.abort();
            this._session = null;
        }
    }

    async fetch(config, helpers = {}) {
        const rawMode = config.apiMode || 'status-page';
        const mode = rawMode === 'metrics' ? 'metrics' : (rawMode === 'api-key' ? 'api-key' : 'status-page');
        const log = helpers.log ?? (() => {});

        if (mode === 'status-page')
            return this._fetchStatusPage(config, log);

        if (mode === 'metrics')
            return this._fetchMetrics(config, helpers, log);

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
        const { monitors, heartbeatMap } = normalizeStatusPage(json);
        return { source: 'status-page', monitors, heartbeatMap };
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

    async _fetchMetrics(config, helpers, log) {
        const { baseUrl, metricsEndpoint } = config;
        if (!baseUrl)
            throw new Error(_('Base URL is missing.'));

        const getApiKey = helpers.getApiKey;
        const apiKey = getApiKey ? await getApiKey() : null;
        if (!apiKey)
            throw new Error(_('API token is not available.'));

        const endpoint = metricsEndpoint || 'metrics';
        const url = joinUrl(baseUrl, endpoint);
        log('debug', `Fetching Prometheus metrics from ${url}`);

        const credentials = `:${apiKey}`;
        const encoded = GLib.base64_encode(new TextEncoder().encode(credentials));

        const text = await this._request(url, {
            headers: {
                Accept: 'text/plain',
                Authorization: `Basic ${encoded}`,
            },
        });

        const monitors = normalizeMetrics(text);
        return { source: 'metrics', monitors };
    }

    async populateHistory(monitors, config, helpers = {}) {
        if (!Array.isArray(monitors) || monitors.length === 0)
            return;

        const rawMode = config.apiMode || 'status-page';
        const mode = rawMode === 'metrics' ? 'metrics' : (rawMode === 'api-key' ? 'api-key' : 'status-page');
        const log = helpers.log ?? (() => {});

        const pending = monitors.filter(m => !Array.isArray(m.history) || m.history.length === 0);
        if (pending.length === 0)
            return;

        if (mode === 'api-key') {
            await this._populatePrivateApiHistory(pending, config, helpers, log);
            return;
        }

        log('debug', 'Historical data not available for this API mode.');
    }

    async _populatePrivateApiHistory(monitors, config, helpers, log) {
        const { baseUrl } = config;
        if (!baseUrl)
            return;

        const getApiKey = helpers.getApiKey;
        const apiKey = getApiKey ? await getApiKey() : null;
        if (!apiKey) {
            log('debug', 'Cannot fetch heartbeat history without API token.');
            return;
        }

        const endpoint = config.heartbeatEndpoint || 'api/heartbeat';
        const limit = Math.max(24, config.heartbeatLimit ?? HEARTBEAT_LIMIT);
        const headers = {
            Accept: 'application/json',
            Authorization: apiKey,
        };

        for (const monitor of monitors) {
            const rawId = monitor?.id;
            if (rawId === undefined || rawId === null)
                continue;

            const monitorId = String(rawId);
            const url = joinUrl(baseUrl, `${endpoint}/${encodeURIComponent(monitorId)}?limit=${limit}`);

            try {
                log('debug', `Fetching heartbeat history for monitor ${monitorId}`);
                const json = await this._getJson(url, { headers });
                const history = normalizeHeartbeatHistory(json);
                monitor.history = history;
            } catch (error) {
                log('debug', `Failed to fetch heartbeat history for monitor ${monitorId}: ${error.message}`);
                monitor.history = monitor.history ?? [];
            }
        }
    }

    async _getJson(url, options = {}) {
        const text = await this._request(url, options);
        if (!text)
            return null;

        return JSON.parse(text);
    }

    async _request(url, { headers = {}, method = 'GET', body = null, contentType = null } = {}) {
        let attempt = 0;
        let wait = 400;
        let lastError = null;

        while (attempt < this._retries) {
            const message = Soup.Message.new(method, url);
            message.timeout = this._timeoutSeconds;

            for (const [key, value] of Object.entries(headers))
                message.request_headers.replace(key, value);

            if (body !== null && body !== undefined) {
                let payload = body;
                let mime = contentType;

                if (payload instanceof GLib.Bytes) {
                    message.set_request_body_from_bytes(mime ?? 'application/octet-stream', payload);
                } else {
                    if (typeof payload === 'string') {
                        payload = new TextEncoder().encode(payload);
                        mime = mime ?? 'text/plain';
                    } else if (payload instanceof Uint8Array) {
                        mime = mime ?? 'application/octet-stream';
                    } else {
                        payload = new TextEncoder().encode(JSON.stringify(payload));
                        mime = mime ?? 'application/json';
                    }

                    message.set_request_body_from_bytes(mime, new GLib.Bytes(payload));
                }
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
            if (attempt < this._retries) {
                await new Promise((resolve, reject) => {
                    const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, wait, () => {
                        this._activeTimeouts.delete(timeoutId);
                        resolve();
                        return GLib.SOURCE_REMOVE;
                    });
                    
                    if (timeoutId === 0) {
                        reject(new Error('Failed to create timeout'));
                    } else {
                        this._activeTimeouts.add(timeoutId);
                    }
                });
            }
            wait = Math.min(wait * this._backoff, 4000);
        }

        if (lastError)
            throw lastError;
        throw new Error(_('Unknown network error'));
    }
}
