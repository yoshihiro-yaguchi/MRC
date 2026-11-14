// WorldPop 2020 density overlay. Geographic cells are indexed once, while
// view-specific heat pixels are cached so pointer movement never reprocesses
// the national census.
const GRID = 512, CIRCUMFERENCE = 40075016.686;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const project = ({ lat, lng }) => {
  const sin = Math.sin(clamp(lat, -85.05112878, 85.05112878) * Math.PI / 180);
  return { x: (lng + 180) / 360, y: .5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI) };
};

export function populationColor(value) {
  const colors = [[76,153,197], [112,192,194], [166,217,128], [254,212,99], [238,103,89]];
  const position = clamp(Math.log10(Math.max(1, Number(value) || 0)), 0, 4);
  const index = Math.min(3, Math.floor(position)), t = position - index;
  return colors[index].map((channel, i) => Math.round(channel + (colors[index + 1][i] - channel) * t));
}

export class PopulationLayer {
  constructor() { this.buckets = new Map(); this.count = 0; this.epoch = 0; this.cacheKey = ''; this.canvas = null; }

  setData(cells = []) {
    this.buckets.clear(); this.count = 0;
    this.x = new Float64Array(cells.length); this.y = new Float64Array(cells.length); this.population = new Float32Array(cells.length);
    for (const cell of cells) {
      if (!Number.isFinite(cell?.lat) || !Number.isFinite(cell?.lng) || !Number.isFinite(cell?.population) || cell.population <= 0 || Math.abs(cell.lat) > 85.05112878 || Math.abs(cell.lng) > 180) continue;
      const p = project(cell), index = this.count++;
      this.x[index] = p.x; this.y[index] = p.y; this.population[index] = cell.population;
      const key = `${Math.floor(p.x * GRID)}:${Math.floor(p.y * GRID)}`;
      if (!this.buckets.has(key)) this.buckets.set(key, []);
      this.buckets.get(key).push(index);
    }
    this.epoch++; this.cacheKey = '';
  }

  // The result is bounded by the visible geographic window and aggregates
  // neighbouring 1km census cells into screen bins at small map scales.
  rasterize(view, width, height) {
    if (!this.count || width <= 0 || height <= 0) return { bins: [], examined: 0, count: this.count };
    const center = project(view), size = 256 * 2 ** view.zoom;
    const mpp = CIRCUMFERENCE * Math.cos(view.lat * Math.PI / 180) / size;
    const radius = Math.max(16, Math.min(700 / mpp, Math.max(width, height) * 2));
    const margin = Math.max(24, radius), left = center.x - (width / 2 + margin) / size, right = center.x + (width / 2 + margin) / size;
    const top = center.y - (height / 2 + margin) / size, bottom = center.y + (height / 2 + margin) / size;
    const minX = clamp(Math.floor(left * GRID), 0, GRID - 1), maxX = clamp(Math.floor(right * GRID), 0, GRID - 1);
    const minY = clamp(Math.floor(top * GRID), 0, GRID - 1), maxY = clamp(Math.floor(bottom * GRID), 0, GRID - 1);
    const binSize = 14, bins = new Map(); let examined = 0;
    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) {
      for (const index of this.buckets.get(`${x}:${y}`) || []) {
        examined++;
        if (this.x[index] < left || this.x[index] > right || this.y[index] < top || this.y[index] > bottom) continue;
        const px = (this.x[index] - center.x) * size + width / 2, py = (this.y[index] - center.y) * size + height / 2;
        const key = `${Math.floor(px / binSize)}:${Math.floor(py / binSize)}`;
        let bin = bins.get(key);
        if (!bin) { bin = { x: 0, y: 0, total: 0, peak: 0, cells: 0 }; bins.set(key, bin); }
        bin.x += px; bin.y += py; bin.total += this.population[index]; bin.peak = Math.max(bin.peak, this.population[index]); bin.cells++;
      }
    }
    return { bins: [...bins.values()].map(bin => ({ x: bin.x / bin.cells, y: bin.y / bin.cells, population: Math.max(bin.total / bin.cells, bin.peak * .45), total: bin.total, cells: bin.cells, radius })), examined, count: this.count };
  }

  render(ctx, view, width, height) {
    if (!this.count || typeof document === 'undefined') return;
    const key = `${this.epoch}:${view.lat.toFixed(7)}:${view.lng.toFixed(7)}:${view.zoom.toFixed(4)}:${Math.round(width)}:${Math.round(height)}`;
    if (key !== this.cacheKey) {
      if (!this.canvas) this.canvas = document.createElement('canvas');
      this.canvas.width = Math.max(1, Math.ceil(width)); this.canvas.height = Math.max(1, Math.ceil(height));
      const surface = this.canvas.getContext('2d'), result = this.rasterize(view, width, height);
      for (const bin of result.bins) {
        const rgb = populationColor(bin.population), opacity = .22 + .42 * clamp(Math.log10(Math.max(1, bin.population)) / 4, 0, 1);
        const gradient = surface.createRadialGradient(bin.x, bin.y, 0, bin.x, bin.y, bin.radius);
        gradient.addColorStop(0, `rgba(${rgb.join(',')},${opacity})`);
        gradient.addColorStop(.5, `rgba(${rgb.join(',')},${opacity * .72})`);
        gradient.addColorStop(1, `rgba(${rgb.join(',')},0)`);
        surface.fillStyle = gradient; surface.fillRect(bin.x - bin.radius, bin.y - bin.radius, bin.radius * 2, bin.radius * 2);
      }
      this.lastRaster = result; this.cacheKey = key;
    }
    ctx.save(); ctx.globalAlpha = .72; ctx.drawImage(this.canvas, 0, 0, width, height); ctx.restore();
  }
}
