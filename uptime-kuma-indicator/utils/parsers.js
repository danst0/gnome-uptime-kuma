import GLib from 'gi://GLib';
import { _ } from './i18n.js';

const STATUS_PRIORITY = ['down', 'degraded', 'maintenance', 'unknown', 'up'];

function normalizeStatus(value) {
    if (value === null || value === undefined)
        return 'unknown';

    if (typeof value === 'number') {
        switch (value) {
        case 0:
            return 'down';
        case 1:
            return 'up';
        case 2:
            return 'degraded';
        case 3:
            return 'maintenance';
        default:
            return 'unknown';
        }
    }

    const normalized = String(value).toLowerCase();
    if (['up', 'online', 'operational', 'ok'].includes(normalized))
        return 'up';
    if (['degraded', 'warning', 'partial'].includes(normalized))
        return 'degraded';
    if (['down', 'offline', 'critical', 'error', 'fail'].includes(normalized))
        return 'down';
    if (['maintenance', 'maintenance_mode'].includes(normalized))
        return 'maintenance';

    return 'unknown';
}

function parseLatency(value) {
    if (value === null || value === undefined)
        return null;

    if (typeof value === 'number')
        return Math.round(value);

    const parsed = Number.parseFloat(value);
    if (Number.isNaN(parsed))
        return null;

    return Math.round(parsed);
}

function parseTimestamp(value) {
    if (!value)
        return null;

    if (value instanceof GLib.DateTime)
        return value;

    if (typeof value === 'number') {
        if (value > 10_000_000_000)
            return GLib.DateTime.new_from_unix_utc(Math.floor(value / 1000));
        return GLib.DateTime.new_from_unix_utc(Math.floor(value));
    }

    if (typeof value === 'string') {
        try {
            return GLib.DateTime.new_from_iso8601(value, null);
        } catch (error) {
            const parsed = Number.parseInt(value, 10);
            if (!Number.isNaN(parsed))
                return parseTimestamp(parsed);
        }
    }

    return null;
}

function normalizeMonitor(monitor) {
    const status = normalizeStatus(monitor.status ?? monitor.statusClass);
    const latencyMs = parseLatency(monitor.ping ?? monitor.latency ?? monitor.responseTime);
    const lastCheck = parseTimestamp(monitor.lastCheck ?? monitor.lastHeartbeat ?? monitor.lastUpdated);
    const id = (monitor.id !== undefined && monitor.id !== null) ? String(monitor.id) : (monitor.slug ?? monitor.name ?? GLib.uuid_string_random());

    return {
        id,
        name: monitor.name ?? monitor.title ?? _('Unnamed monitor'),
        status,
        latencyMs,
        lastCheck,
        message: monitor.message ?? monitor.msg ?? monitor.lastMessage ?? null,
    };
}

export function normalizeStatusPage(payload) {
    const monitors = [];

    if (!payload)
        return monitors;

    const list = payload.monitors ?? payload.data ?? [];
    const entries = Array.isArray(list) ? list : (list.monitors ?? Object.values(list));

    if (!entries)
        return monitors;

    for (const item of entries) {
        if (!item)
            continue;
        monitors.push(normalizeMonitor(item));
    }

    return monitors;
}

export function normalizeApi(payload) {
    if (!payload)
        return [];

    const entries = payload.monitors ?? payload.data ?? payload.result ?? [];
    if (!entries)
        return [];

    return entries.map(entry => normalizeMonitor(entry));
}

function parsePrometheusLabels(labelString) {
    const labels = {};
    const regex = /([A-Za-z_][A-Za-z0-9_]*)="([^"\\]*(?:\\.[^"\\]*)*)"/g;
    let match;
    while ((match = regex.exec(labelString)) !== null)
        labels[match[1]] = match[2].replace(/\\(.)/g, '$1');

    return labels;
}

function parsePrometheusLine(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#'))
        return null;

    const match = /^([A-Za-z_][\w:]*)\{([^}]*)\}\s+([^\s]+)$/.exec(trimmed);
    if (!match)
        return null;

    const [, metric, labelString, valueString] = match;
    const value = Number(valueString);
    if (!Number.isFinite(value))
        return null;

    const labels = parsePrometheusLabels(labelString);
    return { metric, labels, value };
}

export function normalizeMetrics(text) {
    if (!text)
        return [];

    const monitors = new Map();

    for (const line of text.split('\n')) {
        const entry = parsePrometheusLine(line);
        if (!entry)
            continue;

        const { metric, labels, value } = entry;
        if (!labels.monitor_name)
            continue;

        const key = `${labels.monitor_name}::${labels.monitor_url ?? ''}`;
        const monitor = monitors.get(key) ?? {
            id: labels.monitor_id ?? labels.monitor_name,
            name: labels.monitor_name,
            status: 'unknown',
            latencyMs: null,
            lastCheck: null,
            message: null,
            type: labels.monitor_type ?? null,
        };

        switch (metric) {
        case 'monitor_status':
            monitor.status = normalizeStatus(value);
            break;
        case 'monitor_response_time':
            if (Number.isFinite(value) && value >= 0)
                monitor.latencyMs = Math.round(value);
            break;
        case 'monitor_cert_days_remaining':
            monitor._certDaysRemaining = value;
            break;
        case 'monitor_cert_is_valid':
            monitor._certValid = value === 1;
            break;
        default:
            break;
        }

        monitor.type = labels.monitor_type ?? monitor.type ?? null;
        monitors.set(key, monitor);
    }

    const result = [];
    for (const monitor of monitors.values()) {
        if (monitor._certValid === false) {
            monitor.message = _('Certificate invalid');
            if (monitor.status === 'up')
                monitor.status = 'degraded';
        } else if (typeof monitor._certDaysRemaining === 'number' && monitor._certDaysRemaining < 0) {
            const expiredDays = Math.abs(Math.round(monitor._certDaysRemaining));
            monitor.message = _('Certificate expired %d days ago').format(expiredDays);
            if (monitor.status === 'up')
                monitor.status = 'degraded';
        }

        delete monitor._certValid;
        delete monitor._certDaysRemaining;
        result.push(monitor);
    }

    return result;
}

export function aggregateMonitors(monitors) {
    const summary = {
        up: 0,
        down: 0,
        degraded: 0,
        unknown: 0,
        total: 0,
        status: 'unknown',
    };

    if (!Array.isArray(monitors))
        return summary;

    let worstStatus = 'up';

    for (const monitor of monitors) {
        const status = monitor.status ?? 'unknown';
        if (status === 'down')
            summary.down++;
        else if (status === 'degraded' || status === 'maintenance')
            summary.degraded++;
        else if (status === 'up')
            summary.up++;
        else
            summary.unknown++;

        const currentWorstIndex = STATUS_PRIORITY.indexOf(worstStatus);
        const candidateIndex = STATUS_PRIORITY.indexOf(status);
        if (candidateIndex !== -1 && (currentWorstIndex === -1 || candidateIndex < currentWorstIndex))
            worstStatus = status;

        summary.total++;
    }

    summary.status = worstStatus === 'maintenance' ? 'degraded' : worstStatus;
    if (summary.total === 0)
        summary.status = 'unknown';

    return summary;
}

export function mockMonitors() {
    const now = GLib.DateTime.new_now_utc();

    const create = (overrides = {}) => {
        const deltaSeconds = overrides.delta !== undefined ? overrides.delta : 60;
        return {
            id: overrides.id ?? GLib.uuid_string_random(),
            name: overrides.name,
            status: overrides.status,
            latencyMs: overrides.latencyMs ?? null,
            lastCheck: overrides.lastCheck ?? now.add_seconds(-deltaSeconds),
            message: overrides.message ?? null,
        };
    };

    return [
        create({ name: _('Frontend'), status: 'up', latencyMs: 185, delta: 45 }),
        create({ name: _('API Gateway'), status: 'degraded', latencyMs: 420, delta: 120, message: _('Slight latency increase detected') }),
        create({ name: _('Database'), status: 'down', delta: 15, message: _('No heartbeat received') }),
        create({ name: _('Background Jobs'), status: 'up', latencyMs: 98, delta: 360 }),
        create({ name: _('External Ping'), status: 'unknown', delta: 720 }),
    ];
}
