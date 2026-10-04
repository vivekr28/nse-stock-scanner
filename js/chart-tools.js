// ═══════════════════════════════════════════════════════════════════════════════
// CHART TOOLS — one-shot Measure and Trend Line drawing tools for a Lightweight Charts
// candlestick series. Click a tool button to arm it, click twice on the chart (start,
// end) to draw, and the tool disarms itself: pick it again for the next drawing.
//
// Drawings are a series primitive anchored to (logical bar index, price), so they follow
// the chart through pan / zoom / price-scale changes. Esc or re-clicking the armed button
// cancels. With no tool armed, click a drawing to select it (Delete / Backspace or the Delete button removes
// it; click empty space or press Esc to deselect). A drawing lives in the pane where its first click lands (price pane or indicator pane)
// and both points must be in that pane; each pane's drawings are anchored to that pane's series.
// ═══════════════════════════════════════════════════════════════════════════════

const CT_TREND_COLOR = '#ffd43b';

class ChartToolsPrimitive {
  constructor(tools, entry) {
    this._tools = tools;
    this._entry = entry; // { series, unit } - drawings are filtered to this series
    const self = this;
    this._view = {
      zOrder() { return 'top'; },
      renderer() { return { draw(target) { target.useMediaCoordinateSpace(scope => self._draw(scope.context)); } }; },
    };
  }
  attached(p) { this._chart = p.chart; this._series = p.series; this.requestUpdate = p.requestUpdate; }
  detached() { this._chart = this._series = this.requestUpdate = null; }
  updateAllViews() {}
  paneViews() { return [this._view]; }

  _xy(l, price) {
    const x = this._chart.timeScale().logicalToCoordinate(l);
    const y = this._series.priceToCoordinate(price);
    return (x == null || y == null) ? null : { x, y };
  }

  _draw(ctx) {
    if (!this._chart) return;
    const t = this._tools;
    const items = t.drawings.filter(d => d.entry === this._entry);
    if (t.pending && t.preview && t.pending.entry === this._entry) {
      items.push({ kind: t.armed, a: t.pending, b: t.preview, preview: true, entry: this._entry });
    }
    for (const d of items) {
      const A = this._xy(d.a.l, d.a.p), B = this._xy(d.b.l, d.b.p);
      if (!A || !B) continue;
      ctx.save();
      if (d.kind === 'trend') this._drawTrend(ctx, A, B, d);
      else this._drawMeasure(ctx, A, B, d);
      if (d === t.selected) this._drawHandles(ctx, A, B);
      ctx.restore();
    }
  }

  _drawHandles(ctx, A, B) {
    ctx.fillStyle = '#0f172a'; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.setLineDash([]);
    for (const P of [A, B]) { ctx.beginPath(); ctx.rect(P.x - 4, P.y - 4, 8, 8); ctx.fill(); ctx.stroke(); }
  }

  _drawTrend(ctx, A, B, d) {
    ctx.strokeStyle = CT_TREND_COLOR; ctx.fillStyle = CT_TREND_COLOR; ctx.lineWidth = d === this._tools.selected ? 3 : 2;
    if (d.preview) ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
    ctx.setLineDash([]);
    for (const P of [A, B]) { ctx.beginPath(); ctx.arc(P.x, P.y, 3.5, 0, Math.PI * 2); ctx.fill(); }
  }

  _drawMeasure(ctx, A, B, d) {
    const delta = d.b.p - d.a.p;
    const up = delta >= 0;
    const color = up ? '5,223,114' : '248,113,113';
    const x = Math.min(A.x, B.x), y = Math.min(A.y, B.y), w = Math.abs(B.x - A.x), h = Math.abs(B.y - A.y);
    ctx.fillStyle = `rgba(${color},0.14)`; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = `rgb(${color})`; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w, h);

    const bars = Math.abs(Math.round(d.b.l) - Math.round(d.a.l));
    const pct = d.a.p ? (delta / d.a.p) * 100 : NaN;
    const sign = up ? '+' : '';
    const dStr = delta.toLocaleString('en-IN', { maximumFractionDigits: 2 });
    const barStr = `${bars} ${bars === 1 ? 'bar' : 'bars'}`;
    // A series already in % (the indicator pane) is measured in points ('pts' / 'pp'), not as a % of a %.
    const text = this._entry.unit
      ? `${sign}${dStr} ${this._entry.unit} · ${barStr}`
      : `${sign}${pct.toFixed(2)}% (${sign}${dStr}) · ${barStr}`;
    ctx.font = '11px -apple-system, Segoe UI, sans-serif';
    const tw = ctx.measureText(text).width;
    const bw = tw + 14, bh = 22;
    let bx = x + w + 8, by = Math.max(2, y - 2);
    if (bx + bw > ctx.canvas.clientWidth && ctx.canvas.clientWidth) bx = Math.max(2, x - bw - 8);
    ctx.fillStyle = 'rgba(15,23,42,0.92)'; ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = '#334155'; ctx.strokeRect(bx + 0.5, by + 0.5, bw, bh);
    ctx.fillStyle = `rgb(${color})`; ctx.textBaseline = 'middle';
    ctx.fillText(text, bx + 7, by + bh / 2);
  }
}

class ChartTools {
  // panes: [{ series, unit? }] - one entry per pane that accepts drawings (unit 'pts' for a series already in %)
  // buttons: { measure, trend, clear, remove } DOM elements (any may be omitted)
  // hooks: { onChange(tools) } - called whenever the armed / pending / selected state changes, for a caller that
  //   drives several charts from one shared toolbar (the Industry / Stock Charts popup) instead of passing buttons
  constructor(chart, panes, container, buttons, hooks) {
    this.chart = chart; this.container = container; this.buttons = buttons || {}; this.hooks = hooks || {};
    this.entries = panes.map(p => ({ series: p.series, unit: p.unit || null }));
    this.drawings = []; this.selected = null; this.armed = null; this.pending = null; this.preview = null;
    this.entries.forEach(e => { e.primitive = new ChartToolsPrimitive(this, e); e.series.attachPrimitive(e.primitive); });

    this._btnHandlers = [];
    const bind = (btn, fn) => { if (btn) { btn.addEventListener('click', fn); this._btnHandlers.push([btn, fn]); } };
    bind(this.buttons.measure, () => this.arm('measure'));
    bind(this.buttons.trend, () => this.arm('trend'));
    bind(this.buttons.clear, () => this.clear());
    bind(this.buttons.remove, () => this.removeSelected());
    this._onKey = e => {
      if (e.key === 'Escape') { this.disarm(); this._select(null); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) {
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        this.removeSelected();
      }
    };
    document.addEventListener('keydown', this._onKey);
    this._syncButtons();

    this._clickHandler = param => this._onClick(param);
    this._moveHandler = param => this._onMove(param);
    chart.subscribeClick(this._clickHandler);
    chart.subscribeCrosshairMove(this._moveHandler);
  }

  // For a chart that is rebuilt or disposed while the page lives on: drops the document key listener
  // and the chart subscriptions, and detaches the drawing layer, so nothing keeps reacting to a dead chart.
  destroy() {
    document.removeEventListener('keydown', this._onKey);
    this._btnHandlers.forEach(([btn, fn]) => { if (btn.removeEventListener) btn.removeEventListener('click', fn); });
    try { this.chart.unsubscribeClick(this._clickHandler); } catch (e) {}
    try { this.chart.unsubscribeCrosshairMove(this._moveHandler); } catch (e) {}
    this.entries.forEach(e => { try { e.series.detachPrimitive(e.primitive); } catch (err) {} });
    this.drawings = []; this.selected = this.armed = this.pending = this.preview = null;
    this.container.style.cursor = '';
    this.hooks = {};
    const b = this.buttons;
    if (b.measure) b.measure.classList.toggle('active', false);
    if (b.trend) b.trend.classList.toggle('active', false);
    if (b.remove) b.remove.disabled = true;
  }

  _refresh() { this.entries.forEach(e => { if (e.primitive.requestUpdate) e.primitive.requestUpdate(); }); }

  _syncButtons() {
    if (this.buttons.measure) this.buttons.measure.classList.toggle('active', this.armed === 'measure');
    if (this.buttons.trend) this.buttons.trend.classList.toggle('active', this.armed === 'trend');
    this.container.style.cursor = this.armed ? 'crosshair' : '';
    if (this.buttons.remove) this.buttons.remove.disabled = !this.selected;
    if (this.hooks.onChange) this.hooks.onChange(this);
  }

  _select(d) {
    if (this.selected === d) return;
    this.selected = d;
    this._syncButtons(); this._refresh();
  }

  removeSelected() {
    if (!this.selected) return;
    this.drawings = this.drawings.filter(d => d !== this.selected);
    this._select(null);
  }

  arm(kind) {
    if (this.armed === kind) { this.disarm(); return; } // click the armed button again to cancel
    this.armed = kind; this.pending = null; this.preview = null; this.selected = null;
    this._syncButtons(); this._refresh();
  }

  disarm() {
    this.armed = null; this.pending = null; this.preview = null;
    this._syncButtons(); this._refresh();
  }

  // Remove drawings: all of them, or only those in one pane (index = position in the `panes` list).
  clear(paneIndex) {
    this.drawings = paneIndex == null ? [] : this.drawings.filter(d => d.entry !== this.entries[paneIndex]);
    if (this.selected && !this.drawings.includes(this.selected)) this.selected = null;
    this.disarm();
  }

  // The tool entry for the pane under the pointer, with the point converted to (bar index, price) in that pane.
  _pointOf(param, onlyEntry) {
    if (!param.point || param.logical == null || param.paneIndex == null) return null;
    const entry = this.entries.find(e => e.series.getPane().paneIndex() === param.paneIndex);
    if (!entry || (onlyEntry && entry !== onlyEntry)) return null;
    const p = entry.series.coordinateToPrice(param.point.y);
    return p == null ? null : { l: param.logical, p, entry };
  }

  // Pixel distance from (x, y) to a drawing in its pane, or Infinity when it is not on screen.
  _distanceTo(d, x, y) {
    const A = d.entry.primitive._xy(d.a.l, d.a.p), B = d.entry.primitive._xy(d.b.l, d.b.p);
    if (!A || !B) return Infinity;
    if (d.kind === 'measure') {
      const inX = x >= Math.min(A.x, B.x) && x <= Math.max(A.x, B.x);
      const inY = y >= Math.min(A.y, B.y) && y <= Math.max(A.y, B.y);
      return (inX && inY) ? 0 : Infinity;
    }
    const dx = B.x - A.x, dy = B.y - A.y, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((x - A.x) * dx + (y - A.y) * dy) / len2)) : 0;
    return Math.hypot(x - (A.x + t * dx), y - (A.y + t * dy));
  }

  _pick(param) {
    if (!param.point || param.paneIndex == null) return null;
    let best = null, bestDist = 8; // px tolerance for lines; measure boxes match anywhere inside
    for (let i = this.drawings.length - 1; i >= 0; i--) {
      const d = this.drawings[i];
      if (d.entry.series.getPane().paneIndex() !== param.paneIndex) continue;
      const dist = this._distanceTo(d, param.point.x, param.point.y);
      if (dist < bestDist || (dist === 0 && !best)) { best = d; bestDist = dist; }
    }
    return best;
  }

  _onClick(param) {
    if (!this.armed) { this._select(this._pick(param)); return; }
    const pt = this._pointOf(param, this.pending && this.pending.entry);
    if (!pt) return;
    if (!this.pending) { this.pending = pt; this.preview = pt; this._syncButtons(); this._refresh(); return; }
    // one measurement at a time (per pane)
    if (this.armed === 'measure') this.drawings = this.drawings.filter(d => !(d.kind === 'measure' && d.entry === pt.entry));
    this.drawings.push({ kind: this.armed, a: this.pending, b: pt, entry: pt.entry });
    this.disarm(); // one-shot
  }

  _onMove(param) {
    if (!this.armed || !this.pending) return;
    const pt = this._pointOf(param, this.pending.entry);
    if (!pt) return;
    this.preview = pt; this._refresh();
  }
}
