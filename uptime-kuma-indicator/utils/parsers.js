'use strict';

const { GLib } = imports.gi;
const Gettext = imports.gettext;

const _ = Gettext.gettext;
const ngettext = Gettext.ngettext;

const STATUS_PRIORITY = ['down', 'degraded', 'maintenance', 'unknown', 'up'];

function _normalizeStatus(value) {
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

function _parseLatency(value) {
    if (value === null || value === undefined)
        return null;

    if (typeof value === 'number')
        return Math.round(value);

    const parsed = Number.parseFloat(value);
    if (Number.isNaN(parsed))
        return null;

    return Math.round(parsed);
}

function _parseTimestamp(value) {
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
                return _parseTimestamp(parsed);
        }
    }

    return null;
}

function _normalizeMonitor(monitor) {
    const status = _normalizeStatus(monitor.status ?? monitor.statusClass);
    const latencyMs = _parseLatency(monitor.ping ?? monitor.latency ?? monitor.responseTime);
    const lastCheck = _parseTimestamp(monitor.lastCheck ?? monitor.lastHeartbeat ?? monitor.lastUpdated);
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

function normalizeStatusPage(payload) {
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
        monitors.push(_normalizeMonitor(item));
    }

    return monitors;
}

function normalizeApi(payload) {
    if (!payload)
        return [];

    const entries = payload.monitors ?? payload.data ?? payload.result ?? [];
    if (!entries)
        return [];

    return entries.map(entry => _normalizeMonitor(entry));
}

function aggregateMonitors(monitors) {
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

function mockMonitors() {
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

var normalizeStatusPage = normalizeStatusPage;
var normalizeApi = normalizeApi;
var aggregateMonitors = aggregateMonitors;
var mockMonitors = mockMonitors;
