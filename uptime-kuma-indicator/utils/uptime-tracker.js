import GLib from 'gi://GLib';

const WINDOW_SECONDS = 24 * 60 * 60;
const MIN_SAMPLE_INTERVAL_SECONDS = 60;
const MIN_SAMPLES = 2;
const FLUSH_INTERVAL_SECONDS = 300;

function nowSeconds() {
    return Math.floor(GLib.get_real_time() / 1_000_000);
}

export class UptimeTracker {
    constructor(filePath) {
        this._filePath = filePath;
        this._samples = new Map();
        this._dirty = false;
        this._lastFlush = 0;
        this._load();
    }

    destroy() {
        this._flush(true);
    }

    record(monitors) {
        if (!Array.isArray(monitors) || monitors.length === 0)
            return;

        const now = nowSeconds();
        const cutoff = now - WINDOW_SECONDS;

        for (const monitor of monitors) {
            if (!monitor || monitor.id === undefined || monitor.id === null)
                continue;

            const id = String(monitor.id);
            let samples = this._samples.get(id);
            if (!samples) {
                samples = [];
                this._samples.set(id, samples);
            }

            const flag = monitor.status === 'up' ? 1 : 0;
            const last = samples.length > 0 ? samples[samples.length - 1] : null;
            if (last && now - last[0] < MIN_SAMPLE_INTERVAL_SECONDS) {
                if (last[1] !== flag) {
                    last[1] = flag;
                    this._dirty = true;
                }
            } else {
                samples.push([now, flag]);
                this._dirty = true;
            }

            while (samples.length > 0 && samples[0][0] < cutoff)
                samples.shift();
        }

        this._flush(false);
    }

    uptimePercent(id) {
        const samples = this._samples.get(String(id));
        if (!samples || samples.length < MIN_SAMPLES)
            return null;

        let up = 0;
        for (const sample of samples) {
            if (sample[1])
                up++;
        }

        return (up / samples.length) * 100;
    }

    sampleCount(id) {
        const samples = this._samples.get(String(id));
        return samples ? samples.length : 0;
    }

    _load() {
        if (!this._filePath)
            return;

        try {
            const [ok, contents] = GLib.file_get_contents(this._filePath);
            if (!ok || !contents)
                return;

            const data = JSON.parse(new TextDecoder().decode(contents));
            const cutoff = nowSeconds() - WINDOW_SECONDS;

            for (const [id, samples] of Object.entries(data?.samples ?? {})) {
                if (!Array.isArray(samples))
                    continue;

                const filtered = samples.filter(sample =>
                    Array.isArray(sample) && Number.isFinite(sample[0]) && sample[0] >= cutoff);
                if (filtered.length > 0)
                    this._samples.set(id, filtered);
            }
        } catch (error) {
            this._samples.clear();
        }
    }

    _flush(force) {
        if (!this._dirty || !this._filePath)
            return;

        const now = nowSeconds();
        if (!force && now - this._lastFlush < FLUSH_INTERVAL_SECONDS)
            return;

        this._dirty = false;
        this._lastFlush = now;

        try {
            const dir = GLib.path_get_dirname(this._filePath);
            GLib.mkdir_with_parents(dir, 0o755);

            const samples = {};
            for (const [id, list] of this._samples.entries())
                samples[id] = list;

            GLib.file_set_contents(this._filePath, JSON.stringify({ samples }));
        } catch (error) {
        }
    }
}
