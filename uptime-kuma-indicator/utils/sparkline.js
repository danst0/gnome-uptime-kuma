import Cairo from 'cairo';
import GObject from 'gi://GObject';
import St from 'gi://St';

const STATUS_COLOR_MAP = {
    up: [0x33 / 255, 0xd1 / 255, 0x7a / 255, 1.0],
    degraded: [0xf6 / 255, 0xd3 / 255, 0x2d / 255, 1.0],
    maintenance: [0xf6 / 255, 0xd3 / 255, 0x2d / 255, 1.0],
    down: [0xe0 / 255, 0x1b / 255, 0x24 / 255, 1.0],
    unknown: [0xc0 / 255, 0xbf / 255, 0xbc / 255, 0.5],
};

const DEFAULT_WIDTH = 96;
const DEFAULT_HEIGHT = 20;
const COMPACT_WIDTH = 72;
const MAX_SAMPLES = 24;
const TARGET_BARS = 24;

function sanitizeSamples(samples) {
    if (!Array.isArray(samples) || samples.length === 0)
        return [];

    return samples
        .filter(sample => sample)
        .map(sample => ({
            status: typeof sample.status === 'string' ? sample.status : 'unknown',
            timestamp: typeof sample.timestamp === 'number' ? sample.timestamp : 0,
        }))
        .sort((a, b) => a.timestamp - b.timestamp);
}

function drawRoundedRect(cr, x, y, width, height, radius) {
    const r = Math.max(0, Math.min(radius, Math.min(width, height) / 2));
    const right = x + width;
    const bottom = y + height;

    cr.newPath();
    cr.moveTo(x + r, y);
    cr.arc(right - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(right - r, bottom - r, r, 0, Math.PI / 2);
    cr.arc(x + r, bottom - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
    cr.closePath();
    cr.fill();
}

export const Sparkline = GObject.registerClass(
class Sparkline extends St.DrawingArea {
    _init({ width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT, compactWidth = COMPACT_WIDTH, maxSamples = MAX_SAMPLES, targetBars = TARGET_BARS, style_class = 'kuma-sparkline' } = {}) {
        super._init({
            reactive: false,
            style_class,
        });

        this._defaultWidth = width;
        this._defaultHeight = height;
        this._compactWidth = compactWidth;
        this._maxSamples = maxSamples;
        this._targetBars = targetBars;
        this._samples = [];

        this.set_width(this._defaultWidth);
        this.set_height(this._defaultHeight);

        this.connect('repaint', this._onRepaint.bind(this));
    }

    setSamples(samples) {
        const normalized = sanitizeSamples(samples);
        
        // Always downsample or pad to exactly _targetBars
        if (normalized.length === 0) {
            this._samples = Array(this._targetBars).fill(null).map(() => ({ status: 'unknown', timestamp: 0 }));
        } else if (normalized.length > this._targetBars) {
            // Downsample: take evenly distributed samples
            const step = normalized.length / this._targetBars;
            this._samples = [];
            for (let i = 0; i < this._targetBars; i++) {
                const index = Math.floor(i * step);
                this._samples.push(normalized[index]);
            }
        } else if (normalized.length < this._targetBars) {
            // Pad with unknown status at the beginning
            const padding = Array(this._targetBars - normalized.length).fill(null).map(() => ({ status: 'unknown', timestamp: 0 }));
            this._samples = [...padding, ...normalized];
        } else {
            this._samples = normalized;
        }

        this.queue_repaint();
    }

    setMode(mode) {
        const width = mode === 'compact' ? this._compactWidth : this._defaultWidth;
        this.set_width(width);
    }

    clear() {
        if (this._samples.length === 0)
            return;

        this._samples = [];
        this.queue_repaint();
    }

    _onRepaint(area) {
        /** @type {Cairo.Context} */
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        if (width <= 0 || height <= 0)
            return;

        // Transparent background (no background fill)
        cr.save();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.restore();

        cr.setOperator(Cairo.Operator.OVER);

        if (!this._samples || this._samples.length === 0) {
            return;
        }

        const count = this._samples.length;
        const totalWidth = Math.max(1, width);
        const barWidth = Math.max(2, Math.floor(totalWidth / count));
        const gap = Math.max(1, Math.floor(barWidth * 0.2));
        const drawWidth = Math.max(2, barWidth - gap);
        const top = 2;
        const bottom = Math.max(top + 4, height - 2);
        const rectHeight = bottom - top;
        const radius = Math.min(2, Math.floor(drawWidth / 2));

        let x = 0;
        for (let i = 0; i < count; i++) {
            const sample = this._samples[i];
            const color = STATUS_COLOR_MAP[sample.status] ?? STATUS_COLOR_MAP.unknown;
            cr.setSourceRGBA(color[0], color[1], color[2], color[3]);
            const left = Math.floor(x + gap / 2);
            drawRoundedRect(cr, left, top, drawWidth, rectHeight, radius);

            x += barWidth;
        }
    }
});
