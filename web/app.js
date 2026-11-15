/* ETH Сигналы — интерфейс, данные Binance, график, ручные линии, уведомления */
(() => {
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SYMBOL = 'ETHUSDT';
const LIMIT = 1000;   // максимум Binance за один запрос
const TFS = [
  { id: '15m', label: '15м', sec: 900 },
  { id: '30m', label: '30м', sec: 1800 },
  { id: '1h', label: '1ч', sec: 3600 },
  { id: '4h', label: '4ч', sec: 14400 },
  { id: '6h', label: '6ч', sec: 21600 },
  { id: '1d', label: '1д', sec: 86400 }
];
const TF = Object.fromEntries(TFS.map(t => [t.id, t]));
const REST_HOSTS = ['https://api.binance.com', 'https://data-api.binance.vision', 'https://api1.binance.com', 'https://api2.binance.com'];
const WS_HOSTS = ['wss://stream.binance.com:9443', 'wss://data-stream.binance.vision', 'wss://stream.binance.com:443'];

// ---------- хранилище ----------
const LS = {
  get(k, def) { try { const v = localStorage.getItem('ethsig.' + k); return v == null ? def : JSON.parse(v); } catch (e) { return def; } },
  set(k, v) { try { localStorage.setItem('ethsig.' + k, JSON.stringify(v)); } catch (e) { /* приватный режим */ } }
};
const UI_DEFAULTS = { sound: true, vibrate: true, keepAwake: false, tf: '1h', liqOpacity: 0.9, flipAtr: 0.5 };
let settings = Object.assign({}, Core.DEFAULTS, UI_DEFAULTS, LS.get('settings', {}));
if (!TF[settings.tf]) settings.tf = '1h';
const validLevel = (l) => l && typeof l.id === 'string' && ['sr', 'support', 'resistance', 'liq'].includes(l.type) && Number.isFinite(l.price) && l.price > 0;
// Тип 'sr' — обычный уровень, роль (поддержка / сопротивление) определяется автоматически по цене.
// Старые линии с ручным выбором 'support' / 'resistance' превращаются в 'sr'.
// price2 — верхняя граница диапазона плотности (price — нижняя). У остальных линий его нет.
const normLevel = (l) => {
  if (l.type === 'support' || l.type === 'resistance') l.type = 'sr';
  if (l.type === 'liq' && Number.isFinite(l.price2) && l.price2 > 0 && l.price2 !== l.price) {
    const lo = Math.min(l.price, l.price2), hi = Math.max(l.price, l.price2);
    l.price = lo; l.price2 = hi;
  } else delete l.price2;
  return l;
};
let levels = (LS.get('levels', []) || []).filter(validLevel).map(normLevel);
let history = LS.get('history', []) || [];
const saveSettings = () => LS.set('settings', settings);
const saveLevels = () => LS.set('levels', levels);

// ---------- состояние ----------
const data = {};              // tf -> {candles, ind}
const sigState = {};          // tf -> состояние дедупликации
const seeded = new Set();     // таймфреймы, по которым первый проход уже сделан молча
const dirty = new Set();
let currentTf = settings.tf;
let lastPrice = null;
let activeSignals = [];
let editMode = false;
let placing = null;           // {cb}
let chartLastTime = 0;
let chartReady = false;

const pad = (n) => String(n).padStart(2, '0');
const round2 = (x) => Math.round(x * 100) / 100;
const fmtP = (x) => (x == null || !Number.isFinite(x)) ? '—' : x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtK = (x) => Number.isFinite(x) ? x.toFixed(1) : '—';
const uid = () => Math.random().toString(36).slice(2, 9);
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
function fmtTime(ts) {
  const d = new Date(ts * 1000);
  const base = pad(d.getDate()) + '.' + pad(d.getMonth() + 1);
  return currentTf === '1d' ? base : base + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function tickFmt(ts, type) {
  const d = new Date(ts * 1000);
  if (type === 0) return String(d.getFullYear());
  if (type === 1) return MONTHS[d.getMonth()];
  if (type === 2) return String(d.getDate());
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}
const fmtStamp = (ms) => { const d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ' ' + pad(d.getDate()) + '.' + pad(d.getMonth() + 1); };

function indexOfTime(arr, t) {
  let lo = 0, hi = arr.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1, v = arr[m].time;
    if (v === t) return m;
    if (v < t) lo = m + 1; else hi = m - 1;
  }
  return -1;
}

// ---------- графики ----------
let priceChart, stochChart, candleSeries, kSeries, dSeries;
const lineObjs = new Map();   // id -> [линии цены]; у диапазона плотности две (верх и низ)
let obLine = null, osLine = null, hiLine = null, loLine = null, band = null, zones = null;

// прозрачная заливка между порогами перепроданности и перекупленности
class BandPrimitive {
  attached(p) { this.series = p.series; this.req = p.requestUpdate; }
  detached() { this.series = null; }
  update() { if (this.req) this.req(); }
  paneViews() {
    const self = this;
    return [{
      zOrder() { return 'bottom'; },
      renderer() {
        return {
          draw() {},
          drawBackground(target) {
            if (!self.series) return;
            const y1 = self.series.priceToCoordinate(settings.overbought), y2 = self.series.priceToCoordinate(settings.oversold);
            if (y1 == null || y2 == null) return;
            target.useMediaCoordinateSpace(({ context, mediaSize }) => {
              context.fillStyle = 'rgba(74,163,255,0.08)';
              context.fillRect(0, Math.min(y1, y2), mediaSize.width, Math.abs(y2 - y1));
            });
          }
        };
      }
    }];
  }
}

// заливка диапазонов плотности на графике цены
class ZonesPrimitive {
  attached(p) { this.series = p.series; this.req = p.requestUpdate; }
  detached() { this.series = null; }
  update() { if (this.req) this.req(); }
  paneViews() {
    const self = this;
    return [{
      zOrder() { return 'bottom'; },
      renderer() {
        return {
          draw() {},
          drawBackground(target) {
            if (!self.series) return;
            const o = Math.min(1, Math.max(0.1, Number(settings.liqOpacity) || 0.9));
            target.useMediaCoordinateSpace(({ context, mediaSize }) => {
              levels.forEach(l => {
                if (l.type !== 'liq' || !(l.price2 > l.price)) return;
                const y1 = self.series.priceToCoordinate(l.price2), y2 = self.series.priceToCoordinate(l.price);
                if (y1 == null || y2 == null) return;
                context.fillStyle = 'rgba(255,221,0,' + (0.2 * o).toFixed(3) + ')';
                context.fillRect(0, Math.min(y1, y2), mediaSize.width, Math.max(1, Math.abs(y2 - y1)));
              });
            });
          }
        };
      }
    }];
  }
}

function chartOptions(showTime) {
  return {
    autoSize: true,
    layout: { background: { type: LightweightCharts.ColorType.Solid, color: '#0e1117' }, textColor: '#9aa4b2', fontSize: 11 },
    grid: { vertLines: { color: '#151b25' }, horzLines: { color: '#151b25' } },
    rightPriceScale: { borderColor: '#232b38', minimumWidth: 74 },
    timeScale: { visible: showTime, borderColor: '#232b38', rightOffset: 6, timeVisible: true, secondsVisible: false, tickMarkFormatter: tickFmt },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    localization: { timeFormatter: fmtTime }
  };
}

function createCharts() {
  priceChart = LightweightCharts.createChart($('#priceChart'), chartOptions(false));
  candleSeries = priceChart.addCandlestickSeries({
    upColor: '#2ecc71', downColor: '#ff5b5b', borderVisible: false, wickUpColor: '#2ecc71', wickDownColor: '#ff5b5b'
  });
  zones = new ZonesPrimitive();
  candleSeries.attachPrimitive(zones);
  stochChart = LightweightCharts.createChart($('#stochChart'), chartOptions(true));
  stochChart.applyOptions({ rightPriceScale: { borderColor: '#232b38', minimumWidth: 74, scaleMargins: { top: 0.1, bottom: 0.1 } } });
  const fixed = () => ({ priceRange: { minValue: 0, maxValue: 100 } });
  kSeries = stochChart.addLineSeries({ color: '#4aa3ff', lineWidth: 2, priceLineVisible: false, autoscaleInfoProvider: fixed });
  dSeries = stochChart.addLineSeries({ color: '#ff9f43', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, autoscaleInfoProvider: fixed });
  band = new BandPrimitive();
  kSeries.attachPrimitive(band);
  drawStochRefs();

  // синхронизация шкал времени
  let syncing = false;
  const link = (from, to) => from.timeScale().subscribeVisibleLogicalRangeChange(r => {
    if (syncing || !r) return;
    syncing = true;
    try { to.timeScale().setVisibleLogicalRange(r); } finally { syncing = false; }
  });
  link(priceChart, stochChart);
  link(stochChart, priceChart);

  // синхронизация перекрестия
  let xhLock = false;
  const xh = (src, dst, dstSeries, valueOf) => src.subscribeCrosshairMove(param => {
    if (xhLock) return;
    const d = data[currentTf];
    if (!d || !d.ind) return;
    xhLock = true;
    try {
      if (!param.time) { dst.clearCrosshairPosition(); updateStochLegend(d.candles.length - 1); return; }
      const i = indexOfTime(d.candles, param.time);
      if (i < 0) return;
      const v = valueOf(d, i);
      if (Number.isFinite(v)) dst.setCrosshairPosition(v, param.time, dstSeries);
      updateStochLegend(i);
    } finally { xhLock = false; }
  });
  xh(priceChart, stochChart, kSeries, (d, i) => d.ind.k[i]);
  xh(stochChart, priceChart, candleSeries, (d, i) => d.candles[i].close);

  // Постановка линии. Встроенный click графика не срабатывает, если палец удержан дольше ~0.25 с
  // (включается режим перекрестия), поэтому тап любой длины ловим сами по pointerup.
  const placeAt = (y) => {
    if (!placing) return;
    const price = candleSeries.coordinateToPrice(y);
    if (price == null || !(price > 0)) return;
    const cb = placing.cb;
    setPlacing(null);
    cb(round2(price));
  };
  priceChart.subscribeClick(param => { if (param.point) placeAt(param.point.y); });
  const pc = $('#priceChart');
  let pdown = null;
  pc.addEventListener('pointerdown', (e) => { pdown = placing && e.isPrimary ? { x: e.clientX, y: e.clientY } : null; }, true);
  pc.addEventListener('pointerup', (e) => {
    const d = pdown; pdown = null;
    if (!placing || !d || !e.isPrimary) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10) return;   // палец сдвинулся — это прокрутка графика, не тап
    placeAt(e.clientY - pc.getBoundingClientRect().top);
  }, true);
  bindDrag();
}

function drawStochRefs() {
  if (obLine) kSeries.removePriceLine(obLine);
  if (osLine) kSeries.removePriceLine(osLine);
  const o = { color: '#5b6577', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '' };
  obLine = kSeries.createPriceLine(Object.assign({ price: settings.overbought }, o));
  osLine = kSeries.createPriceLine(Object.assign({ price: settings.oversold }, o));
  if (!hiLine) {
    const e = { lineWidth: 1, lineStyle: 0, axisLabelVisible: false, title: '' };
    hiLine = kSeries.createPriceLine(Object.assign({ price: 100, color: 'rgba(255,91,91,0.3)' }, e));
    loLine = kSeries.createPriceLine(Object.assign({ price: 0, color: 'rgba(46,204,113,0.3)' }, e));
  }
  if (band) band.update();
}

// Линии 100 (красная) и 0 (зелёная) мигают тем чаще и ярче, чем ближе K к краю
let pulseLast = '';
function pulse() {
  const d = data[currentTf];
  if (!d || !d.ind || !hiLine) return;
  const k = d.ind.k[d.candles.length - 1];
  const ob = settings.overbought, os = settings.oversold;
  const clamp = (x) => Math.min(1, Math.max(0, x));
  const iHi = Number.isFinite(k) ? clamp((k - ob) / (100 - ob)) : 0;
  const iLo = Number.isFinite(k) ? clamp((os - k) / os) : 0;
  const t = performance.now() / 1000;
  const calc = (i) => {
    const base = 0.3;
    if (i <= 0) return { a: base, w: 1 };
    const w = 0.5 + 0.5 * Math.sin(2 * Math.PI * (0.8 + 3 * i) * t);
    return { a: base + (1 - base) * i * w, w: Math.round(1 + 2 * i) };
  };
  const h = calc(iHi), l = calc(iLo);
  const sig = h.a.toFixed(2) + h.w + l.a.toFixed(2) + l.w;
  if (sig === pulseLast) return;
  pulseLast = sig;
  hiLine.applyOptions({ color: 'rgba(255,91,91,' + h.a.toFixed(2) + ')', lineWidth: h.w });
  loLine.applyOptions({ color: 'rgba(46,204,113,' + l.a.toFixed(2) + ')', lineWidth: l.w });
}

const toBar = (c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close });
const pt = (time, v) => Number.isFinite(v) ? { time, value: v } : { time };

function renderChart(resetView) {
  const d = data[currentTf];
  if (!d || !d.candles.length) return;
  candleSeries.setData(d.candles.map(toBar));
  kSeries.setData(d.candles.map((c, i) => pt(c.time, d.ind.k[i])));
  dSeries.setData(d.candles.map((c, i) => pt(c.time, d.ind.d[i])));
  chartLastTime = d.candles[d.candles.length - 1].time;
  if (resetView) {
    const n = d.candles.length;
    priceChart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 130), to: n + 8 });
  }
  updateMarkers();
  updateLegends();
  chartReady = true;
}

function updateChartTail() {
  const d = data[currentTf];
  if (!d || !d.candles.length) return;
  const n = d.candles.length, c = d.candles[n - 1];
  const prevTime = n > 1 ? d.candles[n - 2].time : 0;
  if (!chartReady || (c.time !== chartLastTime && prevTime !== chartLastTime)) { renderChart(false); return; }
  candleSeries.update(toBar(c));
  kSeries.update(pt(c.time, d.ind.k[n - 1]));
  dSeries.update(pt(c.time, d.ind.d[n - 1]));
  chartLastTime = c.time;
  updateLegends();
}

// Стрелки на графике: прошлые сигналы из истории — статичные, а стрелки АКТИВНЫХ сейчас сигналов
// (лонг и шорт) мигают, пока условие держится.
let markerList = [];      // [{time, dir, live}]
let markerSig = '';
let liveKey = '';
function buildMarkers() {
  const d = data[currentTf];
  markerList = [];
  if (!d) return;
  const map = new Map();
  history.filter(h => h.tf === currentTf && h.dir && indexOfTime(d.candles, h.candleTime) >= 0)
    .forEach(h => map.set(h.candleTime + h.dir, { time: h.candleTime, dir: h.dir, live: false }));
  activeSignals.filter(s => s.kind === 'signal' && s.tf === currentTf && indexOfTime(d.candles, s.candleTime) >= 0)
    .forEach(s => map.set(s.candleTime + s.dir, { time: s.candleTime, dir: s.dir, live: true }));
  markerList = Array.from(map.values()).sort((a, b) => a.time - b.time);
}
function applyMarkers(alpha) {
  candleSeries.setMarkers(markerList.map(m => {
    const long = m.dir === 'long', rgb = long ? '46,204,113' : '255,91,91';
    return {
      time: m.time,
      position: long ? 'belowBar' : 'aboveBar',
      color: m.live ? 'rgba(' + rgb + ',' + alpha.toFixed(2) + ')' : 'rgb(' + rgb + ')',
      shape: long ? 'arrowUp' : 'arrowDown',
      text: long ? 'L' : 'S',
      size: m.live ? 1.5 : 1
    };
  }));
}
function updateMarkers() {
  if (!data[currentTf]) return;
  buildMarkers();
  markerSig = '';
  applyMarkers(1);
}
function pulseMarkers() {
  if (document.hidden || !markerList.some(m => m.live)) return;
  const w = 0.5 + 0.5 * Math.sin(2 * Math.PI * 1.4 * performance.now() / 1000);   // ~1.4 вспышки в секунду
  const alpha = Math.round((0.12 + 0.88 * w) * 10) / 10;
  const sig = alpha.toFixed(1);
  if (sig === markerSig) return;
  markerSig = sig;
  applyMarkers(alpha);
}
// перестроить стрелки, только если изменился набор активных сигналов на текущем ТФ
function refreshLiveMarkers() {
  const key = activeSignals.filter(s => s.kind === 'signal' && s.tf === currentTf).map(s => s.candleTime + s.dir + s.levelId).join(',');
  if (key === liveKey) return;
  liveKey = key;
  updateMarkers();
}

function updateLegends() {
  const d = data[currentTf];
  if (!d || !d.ind) return;
  const n = d.candles.length, a = d.ind.atr[n - 1], p = d.candles[n - 1].close;
  $('#legend').innerHTML = 'ETH/USDT · <b>' + TF[currentTf].label + '</b> · ATR <b>' + fmtP(a) + '</b>' +
    (Number.isFinite(a) ? ' (' + (a / p * 100).toFixed(2) + '%)' : '');
  updateStochLegend(n - 1);
}
function updateStochLegend(i) {
  const d = data[currentTf];
  if (!d || !d.ind || i < 0) return;
  const k = d.ind.k[i], dv = d.ind.d[i];
  $('#stochLegend').innerHTML = 'StochRSI ' + settings.rsiLen + ',' + settings.stochLen + ',' + settings.kLen + ',' + settings.dLen +
    ' · K <b style="color:#4aa3ff">' + fmtK(k) + '</b> · D <b style="color:#ff9f43">' + fmtK(dv) + '</b>';
}

// ---------- авто-роль уровня: поддержка или сопротивление ----------
// Цена ниже линии (подходит снизу) — линия сопротивление, красная.
// Цена выше линии (опустилась сверху) — линия поддержка, зелёная. Пробой меняет роль.
// Чтобы цвет и сигналы не дёргались от проколов вокруг линии, роль меняется, только когда цена
// ушла за линию дальше settings.flipAtr × ATR (берётся ATR 1ч); при 0 меняется сразу.
const roles = {};   // id -> {role, price}; price нужен, чтобы после переноса линии роль назначилась заново
const sideRole = (price) => lastPrice == null ? null : (lastPrice >= price ? 'support' : 'resistance');
function roleOf(l) {
  if (l.type === 'support' || l.type === 'resistance') return l.type;
  const r = roles[l.id];
  return r && r.price === l.price ? r.role : sideRole(l.price);
}
function refAtr() {
  for (const id of ['1h', '15m', '30m', '4h', '6h', '1d']) {
    const d = data[id];
    if (d && d.ind) { const a = d.ind.atr[d.candles.length - 1]; if (Number.isFinite(a)) return a; }
  }
  return NaN;
}
// true, если какая-то роль назначена заново или сменилась (нужно перекрасить линии)
function updateRoles() {
  if (lastPrice == null) return false;
  const a = refAtr();
  const band = Number.isFinite(a) ? a * Math.max(0, Number(settings.flipAtr) || 0) : 0;
  let changed = false;
  levels.forEach(l => {
    if (l.type !== 'sr') return;
    const r = roles[l.id];
    let role;
    if (!r || r.price !== l.price) role = sideRole(l.price);
    else if (r.role === 'resistance' && lastPrice > l.price + band) role = 'support';
    else if (r.role === 'support' && lastPrice < l.price - band) role = 'resistance';
    else role = r.role;
    if (!r || r.price !== l.price || r.role !== role) changed = true;
    roles[l.id] = { role, price: l.price };
  });
  return changed;
}
// уровни для Core.evaluate: 'sr' превращается в 'support' или 'resistance'
function effLevels() {
  const out = [];
  levels.forEach(l => {
    if (l.type !== 'sr') { out.push(l); return; }
    const r = roleOf(l);
    if (r) out.push(Object.assign({}, l, { type: r }));
  });
  return out;
}

// ---------- линии уровней ----------
function levelStyle(l) {
  if (l.type === 'liq') {
    const o = Math.min(1, Math.max(0.1, Number(settings.liqOpacity) || 0.9));
    return { color: 'rgba(255,221,0,' + o + ')', labelColor: '#ffdd00', labelText: '#1a1400', lineStyle: 0, lineWidth: 2,
      title: (l.side === 'above' ? 'ЛИКВ ▲' : 'ЛИКВ ▼') + (l.volume ? ' ' + l.volume + 'M' : '') };
  }
  const role = roleOf(l);
  if (role === 'resistance') return { color: 'rgba(255,91,91,0.95)', labelColor: '#ff5b5b', labelText: '#1f0808', lineStyle: 0, lineWidth: 1, title: 'СОПР' };
  if (role === 'support') return { color: 'rgba(46,204,113,0.95)', labelColor: '#2ecc71', labelText: '#06180d', lineStyle: 0, lineWidth: 1, title: 'ПОДД' };
  return { color: 'rgba(255,255,255,0.85)', labelColor: '#d9dee7', labelText: '#10141b', lineStyle: 0, lineWidth: 1, title: 'УРОВЕНЬ' };   // цена ещё не загружена
}
function renderLines() {
  lineObjs.forEach(arr => arr.forEach(h => candleSeries.removePriceLine(h)));
  lineObjs.clear();
  levels.forEach(l => {
    const s = levelStyle(l);
    const z = Core.zoneOf(l);
    const mk = (price, title, width) => candleSeries.createPriceLine({ price, color: s.color, lineWidth: width, lineStyle: s.lineStyle, axisLabelVisible: true, axisLabelColor: s.labelColor, axisLabelTextColor: s.labelText, title });
    // диапазон плотности: две границы тонкими линиями + заливка между ними (ZonesPrimitive)
    lineObjs.set(l.id, z.hi > z.lo ? [mk(z.hi, s.title, 1), mk(z.lo, '', 1)] : [mk(l.price, s.title, s.lineWidth)]);
  });
  $('#lineCount').textContent = levels.length;
  if (zones) zones.update();
}
// перекрасить линии уровней (роль сменилась), не пересоздавая их
function restyleLines() {
  levels.forEach(l => {
    if (l.type !== 'sr') return;
    const hs = lineObjs.get(l.id);
    if (!hs) return;
    const s = levelStyle(l);
    hs.forEach(h => h.applyOptions({ color: s.color, axisLabelColor: s.labelColor, axisLabelTextColor: s.labelText, title: s.title }));
  });
}
function syncLinePrices(l) {
  const hs = lineObjs.get(l.id);
  if (!hs) return;
  const z = Core.zoneOf(l);
  if (hs.length === 2) { hs[0].applyOptions({ price: z.hi }); hs[1].applyOptions({ price: z.lo }); }
  else hs[0].applyOptions({ price: l.price });
  if (zones) zones.update();
}

// перетаскивание линий (режим «Правка»)
let drag = null;
function pointY(e) { const p = e.touches && e.touches.length ? e.touches[0] : (e.changedTouches && e.changedTouches.length ? e.changedTouches[0] : e); return p.clientY; }
// Что под пальцем: {l, part}. part: 'p' — обычная линия; для диапазона плотности
// 'hi' / 'lo' — верхняя / нижняя граница, 'all' — вся зона целиком (тянуть за заливку).
function hitLevel(clientY) {
  const rect = $('#priceChart').getBoundingClientRect();
  const y = clientY - rect.top;
  let best = null, bd = 18;
  for (const l of levels) {
    if (l.type === 'liq' && l.price2 > l.price) {
      const yHi = candleSeries.priceToCoordinate(l.price2), yLo = candleSeries.priceToCoordinate(l.price);
      if (yHi == null || yLo == null) continue;
      const dHi = Math.abs(y - yHi), dLo = Math.abs(y - yLo);
      const inside = y > yHi && y < yLo;
      let part = null, dd = 0;
      if (yLo - yHi >= 30) {                  // зона высокая: края и середина различимы
        if (dHi < 12) { part = 'hi'; dd = dHi; }
        else if (dLo < 12) { part = 'lo'; dd = dLo; }
        else if (inside) { part = 'all'; dd = 8; }
      } else if (inside || Math.min(dHi, dLo) < 12) {   // узкая зона: двигаем целиком
        part = 'all'; dd = inside ? 0 : Math.min(dHi, dLo);
      }
      if (part && dd < bd) { bd = dd; best = { l, part }; }
      continue;
    }
    const ly = candleSeries.priceToCoordinate(l.price);
    if (ly == null) continue;
    const dd = Math.abs(ly - y);
    if (dd < bd) { bd = dd; best = { l, part: 'p' }; }
  }
  return best;
}
function bindDrag() {
  const el = $('#priceChart');
  const down = (e) => {
    if (!editMode || placing) return;
    const hit = hitLevel(pointY(e));
    if (!hit) return;
    e.stopPropagation();
    if (e.cancelable) e.preventDefault();
    const sy = pointY(e);
    drag = { l: hit.l, part: hit.part, moved: false, startY: sy,
      startPrice: candleSeries.coordinateToPrice(sy - el.getBoundingClientRect().top), orig: { price: hit.l.price, price2: hit.l.price2 } };
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', up, true);
    window.addEventListener('touchmove', move, { capture: true, passive: false });
    window.addEventListener('touchend', up, true);
    window.addEventListener('touchcancel', up, true);
  };
  const move = (e) => {
    if (!drag) return;
    e.stopPropagation();
    if (e.cancelable) e.preventDefault();
    const y = pointY(e);
    if (Math.abs(y - drag.startY) > 4) drag.moved = true;
    if (!drag.moved) return;
    const price = candleSeries.coordinateToPrice(y - el.getBoundingClientRect().top);
    if (price == null || price <= 0) return;
    const l = drag.l, p = round2(price);
    if (drag.part === 'hi') l.price2 = Math.max(p, l.price + 0.01);
    else if (drag.part === 'lo') l.price = Math.min(p, l.price2 - 0.01);
    else if (drag.part === 'all') {
      const delta = price - drag.startPrice;
      const w = drag.orig.price2 - drag.orig.price;       // ширина зоны не меняется
      l.price = round2(drag.orig.price + delta);
      l.price2 = round2(l.price + w);
      if (l.price <= 0) { l.price = drag.orig.price; l.price2 = drag.orig.price2; return; }
    } else l.price = p;
    syncLinePrices(l);
    if (updateRoles()) restyleLines();   // цвет меняется прямо во время перетаскивания через цену
  };
  const up = (e) => {
    if (!drag) return;
    e.stopPropagation();
    window.removeEventListener('mousemove', move, true);
    window.removeEventListener('mouseup', up, true);
    window.removeEventListener('touchmove', move, true);
    window.removeEventListener('touchend', up, true);
    window.removeEventListener('touchcancel', up, true);
    const d = drag; drag = null;
    if (d.moved) { saveLevels(); evaluateAll(); renderPanel(); }
    else openLevelModal(d.l);
  };
  el.addEventListener('mousedown', down, true);
  el.addEventListener('touchstart', down, { capture: true, passive: false });
  el.addEventListener('mousemove', (e) => {
    if (!editMode || drag) { el.style.cursor = ''; return; }
    const hit = hitLevel(e.clientY);
    el.style.cursor = hit ? (hit.part === 'all' ? 'grab' : 'ns-resize') : '';
  });
}

function setPlacing(p) {
  placing = p;
  $('#hint').hidden = !p;
}

// ---------- загрузка и поток данных ----------
let restIdx = 0;
async function fetchKlines(tf) {
  let lastErr = new Error('нет ответа');
  for (let i = 0; i < REST_HOSTS.length; i++) {
    const host = REST_HOSTS[(restIdx + i) % REST_HOSTS.length];
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    try {
      const r = await fetch(host + '/api/v3/klines?symbol=' + SYMBOL + '&interval=' + tf + '&limit=' + LIMIT, { cache: 'no-store', signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const a = await r.json();
      if (!Array.isArray(a) || !a.length) throw new Error('пустой ответ');
      restIdx = (restIdx + i) % REST_HOSTS.length;
      const now = Date.now();
      return a.map(k => ({ time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], closed: k[6] < now }));
    } catch (e) { lastErr = e; } finally { clearTimeout(timer); }
  }
  throw lastErr;
}

async function loadTf(tf) {
  const candles = await fetchKlines(tf);
  data[tf] = { candles, ind: Core.compute(candles, settings) };
  if (tf === currentTf) {
    $('#loading').hidden = true;
    renderChart(!chartReady);
  }
  if (tf === '15m' || lastPrice == null) {   // «последняя цена» всегда берётся с самого мелкого ТФ
    lastPrice = data[tf].candles[data[tf].candles.length - 1].close;
    updateHeader();
  }
}

async function loadAll() {
  const errs = await Promise.all(TFS.map(t => loadTf(t.id).then(() => null, e => e)));
  if (!data[currentTf]) {
    const msg = errs.find(Boolean);
    showLoadError(msg && msg.message);
    return false;
  }
  evaluateAll();
  return true;
}

function showLoadError(detail) {
  const el = $('#loading');
  el.hidden = false;
  el.innerHTML = '<div class="err">Не удалось получить данные Binance' + (detail ? ' (' + esc(detail) + ')' : '') +
    '.<br>Проверьте интернет. Если api.binance.com недоступен в вашей сети, включите VPN.</div><button class="btn primary" id="retry">Повторить</button>';
  $('#retry').onclick = () => { el.innerHTML = '<div>Загрузка данных Binance…</div>'; boot(); };
}

let ws = null, wsTry = 0, wsHostIdx = 0, lastMsg = 0, reconTimer = null;
function setConn(state) { $('#conn').className = state; $('#conn').title = { live: 'Онлайн', connecting: 'Подключение…', off: 'Нет соединения' }[state]; }

function connectWS() {
  clearTimeout(reconTimer);
  const streams = TFS.map(t => SYMBOL.toLowerCase() + '@kline_' + t.id).join('/');
  const url = WS_HOSTS[wsHostIdx % WS_HOSTS.length] + '/stream?streams=' + streams;
  setConn('connecting');
  let sock;
  try { sock = new WebSocket(url); } catch (e) { scheduleReconnect(); return; }
  ws = sock;
  sock.onopen = () => { if (ws !== sock) return; wsTry = 0; lastMsg = Date.now(); setConn('live'); };
  sock.onmessage = (ev) => {
    if (ws !== sock) return;
    lastMsg = Date.now();
    try { const m = JSON.parse(ev.data); if (m.data && m.data.k) applyKline(m.data.k); } catch (e) { /* пропускаем мусор */ }
  };
  sock.onerror = () => { try { sock.close(); } catch (e) { /* */ } };
  sock.onclose = () => { if (ws !== sock) return; setConn('off'); scheduleReconnect(); };
}
function scheduleReconnect() {
  clearTimeout(reconTimer);
  wsHostIdx++;
  const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(wsTry++, 5)));
  reconTimer = setTimeout(async () => { await loadAll(); connectWS(); }, delay);
}
function forceReconnect() {
  if (ws) { const s = ws; ws = null; try { s.close(); } catch (e) { /* */ } }
  setConn('off');
  scheduleReconnect();
}

function applyKline(k) {
  const tf = k.i, d = data[tf];
  if (!d || !d.candles.length) return;
  const c = { time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c, closed: !!k.x };
  const arr = d.candles, last = arr[arr.length - 1];
  if (c.time === last.time) arr[arr.length - 1] = c;
  else if (c.time > last.time) {
    last.closed = true;
    arr.push(c);
    if (arr.length > 3000) arr.shift();
    if (c.time > last.time + TF[tf].sec * 1.5) loadTf(tf).then(() => dirty.add(tf), () => { /* догрузим при следующем событии */ });
  } else return;
  if (tf === '15m' || lastPrice == null) lastPrice = c.close;
  dirty.add(tf);
}

function flush() {
  if (!dirty.size) return;
  const tfs = Array.from(dirty); dirty.clear();
  tfs.forEach(tf => { const d = data[tf]; if (d) d.ind = Core.compute(d.candles, settings); });
  if (tfs.includes(currentTf)) updateChartTail();
  updateHeader();
  evaluateAll();
}

let prevShown = null;
function updateHeader() {
  const el = $('#price');
  if (lastPrice == null) return;
  el.textContent = fmtP(lastPrice);
  if (prevShown != null && lastPrice !== prevShown) el.className = lastPrice > prevShown ? 'up' : 'down';
  prevShown = lastPrice;
}

// ---------- сигналы ----------
function evaluateAll() {
  if (updateRoles()) restyleLines();
  const eff = effLevels();
  const all = [];
  const newOnes = [];
  for (const t of TFS) {
    const d = data[t.id];
    if (!d || !d.ind) continue;
    const sigs = Core.evaluate(t.id, d.candles, d.ind, eff, settings);
    const st = sigState[t.id] || (sigState[t.id] = { active: new Set(), firedCandle: new Map(), firedEver: new Set() });
    const fresh = Core.diffSignals(st, sigs);
    all.push.apply(all, sigs);
    if (!seeded.has(t.id)) seeded.add(t.id);   // первый проход — молча, чтобы не сыпать старыми сигналами при открытии
    else newOnes.push.apply(newOnes, fresh);
  }
  if (newOnes.length) notifyFresh(newOnes);
  activeSignals = all;
  refreshLiveMarkers();
  renderBanner();
  renderPanel();
  const n = all.filter(s => s.kind === 'signal').length;
  const b = $('#sigCount'); b.textContent = n; b.className = n ? 'hot' : '';
}

const DIR_NAME = { long: 'ЛОНГ', short: 'ШОРТ' };
function notifyFresh(list) {
  list.forEach(sig => history.unshift({ t: Date.now(), tf: sig.tf, dir: sig.dir, levelType: sig.levelType, levelPrice: sig.levelPrice, price: sig.price, k: sig.k, text: sig.text, candleTime: sig.candleTime }));
  history.length = Math.min(history.length, 200);
  LS.set('history', history);
  const first = list[0];
  const tfs = list.map(s => TF[s.tf].label).join(', ');
  toast('<b>' + DIR_NAME[first.dir] + ' · ' + (list.length > 1 ? tfs : TF[first.tf].label) + '</b><br>' + esc(first.text) +
    (list.length > 1 ? '<br><span class="muted">и ещё сигналов: ' + (list.length - 1) + '</span>' : ''), first.dir);
  if (settings.sound) beep(first.dir);
  if (settings.vibrate && navigator.vibrate) navigator.vibrate([200, 100, 200]);
  if (document.hidden) osNotify(DIR_NAME[first.dir] + ' ETH · ' + tfs, first.text, first.stateKey);
  if (list.some(s => s.tf === currentTf)) updateMarkers();
}

function confluence() {
  const c = { long: new Set(), short: new Set() };
  activeSignals.forEach(s => { if (s.kind === 'signal') c[s.dir].add(s.tf); });
  return c;
}
const tfSort = (a, b) => (a.kind === 'signal' ? 0 : 1) - (b.kind === 'signal' ? 0 : 1) || TF[b.tf].sec - TF[a.tf].sec;

function renderBanner() {
  const el = $('#banner');
  const list = activeSignals.filter(s => s.kind === 'signal' || s.tf === currentTf).sort((a, b) => {
    const cur = (x) => x.tf === currentTf ? 0 : 1;
    return (a.kind === 'signal' ? 0 : 1) - (b.kind === 'signal' ? 0 : 1) || cur(a) - cur(b) || TF[b.tf].sec - TF[a.tf].sec;
  });
  if (!list.length) { el.hidden = true; return; }
  const s = list[0];
  const conf = s.kind === 'signal' ? confluence()[s.dir] : null;
  el.hidden = false;
  el.className = s.kind === 'signal' ? s.dir : 'warn';
  el.innerHTML = '<span class="badge ' + (s.kind === 'signal' ? s.dir : 'warn') + '">' + (s.kind === 'signal' ? DIR_NAME[s.dir] : '!') + ' ' + TF[s.tf].label + '</span><span>' + esc(s.text) +
    (conf && conf.size > 1 ? ' · совпало на ' + conf.size + ' ТФ' : '') + (list.length > 1 ? ' · ещё ' + (list.length - 1) : '') + '</span>';
}

// звук / уведомления / экран
let audioCtx = null;
function unlockAudio() {
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume(); } catch (e) { /* */ }
}
['pointerdown', 'keydown', 'touchstart'].forEach(ev => window.addEventListener(ev, unlockAudio, { passive: true }));
function beep(dir) {
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime;
  (dir === 'long' ? [660, 880, 1100] : [1100, 880, 660]).forEach((f, i) => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain(), s = t0 + i * 0.16;
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, s);
    g.gain.exponentialRampToValueAtTime(0.25, s + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, s + 0.15);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(s); o.stop(s + 0.16);
  });
}
async function osNotify(title, body, tag) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    const opts = { body, icon: 'icon-192.png', badge: 'icon-192.png', tag, vibrate: [200, 100, 200] };
    if (reg && reg.showNotification) reg.showNotification(title, opts); else new Notification(title, opts);
  } catch (e) { /* */ }
}
let wakeLock = null;
async function applyWakeLock() {
  try {
    if (settings.keepAwake && 'wakeLock' in navigator && !document.hidden && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!settings.keepAwake && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { wakeLock = null; }
}

function toast(html, cls) {
  const el = document.createElement('div');
  el.className = 'toast ' + (cls || '');
  el.innerHTML = html;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 9000);
}

// ---------- панель ----------
let tab = null;
const isDesktop = () => matchMedia('(min-width:980px)').matches;
let lastPanelHtml = '';
let panelBusyUntil = 0;   // пока палец на панели, не перерисовываем её, чтобы не потерять тап

function setTab(t) {
  const side = $('#side');
  if (!isDesktop() && tab === t && side.classList.contains('open')) { side.classList.remove('open'); $$('#tabs button').forEach(b => b.classList.remove('on')); return; }
  tab = t;
  side.classList.add('open');
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  renderPanel(true);
}

function renderPanel(force) {
  if (!tab) return;
  if (tab === 'settings' && !force) return;
  if (!force && Date.now() < panelBusyUntil) return;
  const html = tab === 'signals' ? viewSignals() : tab === 'lines' ? viewLines() : viewSettings();
  if (html === lastPanelHtml && !force) return;
  lastPanelHtml = html;
  const panel = $('#panel');
  const top = panel.scrollTop;
  panel.innerHTML = html;
  panel.scrollTop = top;
}

function lvlName(l) {
  if (l.type === 'liq') return l.side === 'above' ? 'ЛИКВ ▲' : 'ЛИКВ ▼';
  const r = roleOf(l);
  return r === 'support' ? 'ПОДД' : r === 'resistance' ? 'СОПР' : 'УРОВЕНЬ';
}
const isZone = (l) => l.type === 'liq' && l.price2 > l.price;
// цена или диапазон текстом; расстояние от цены до уровня (до ближнего края зоны, внутри зоны — 0)
const lvlPriceTxt = (l, short) => {
  const f = (x) => short ? fmtP(x).replace(/\.00$/, '') : fmtP(x);
  return isZone(l) ? f(l.price) + ' – ' + f(l.price2) : f(l.price);
};
const distTo = (l, p) => { const z = Core.zoneOf(l); return p < z.lo ? z.lo - p : p > z.hi ? p - z.hi : 0; };

function viewSignals() {
  const conf = confluence();
  const cur = activeSignals.slice().sort(tfSort);
  let h = '<h3>Сейчас</h3>';
  if (!cur.length) h += '<div class="muted small" style="margin-bottom:8px">Сигналов нет. Добавьте линии на вкладке «Линии» — приложение само следит за всеми таймфреймами.</div>';
  cur.forEach(s => {
    const c = s.kind === 'signal' ? s.dir : 'warn';
    const n = s.kind === 'signal' ? conf[s.dir].size : 0;
    h += '<div class="card ' + c + '"><div class="top"><span class="badge ' + c + '">' + (s.kind === 'signal' ? DIR_NAME[s.dir] : 'ВНИМАНИЕ') + '</span><b>' + TF[s.tf].label + '</b>' +
      (n > 1 ? '<span class="badge">×' + n + ' ТФ</span>' : '') + '<span class="muted small right">K ' + fmtK(s.k) + '</span></div><div class="small">' + esc(s.text) + '</div></div>';
  });
  h += '<h3>Таймфреймы</h3><table><tr><th>ТФ<th>K<th>D<th>Ближайший уровень<th></tr>';
  TFS.forEach(t => {
    const d = data[t.id];
    if (!d || !d.ind) { h += '<tr><td>' + t.label + '<td colspan="4" class="muted">нет данных</tr>'; return; }
    const n = d.candles.length - 1;
    const k = d.ind.k[n], dv = d.ind.d[n], a = d.ind.atr[n], p = d.candles[n].close;
    const kc = k >= settings.overbought ? 'ob' : k <= settings.oversold ? 'os' : '';
    let near = '<span class="muted">—</span>';
    if (levels.length && Number.isFinite(a)) {
      let best = null;
      levels.forEach(l => { const dist = distTo(l, p); if (!best || dist < best.dist) best = { l, dist }; });
      near = lvlName(best.l) + ' ' + lvlPriceTxt(best.l, true).replace(' – ', '–') + ' <span class="muted">· ' + (best.dist === 0 && isZone(best.l) ? 'внутри' :(best.dist / a).toFixed(1) + ' ATR') + '</span>';
    }
    const mine = activeSignals.filter(s => s.tf === t.id);
    const sg = mine.find(s => s.kind === 'signal');
    const mark = sg ? '<span class="badge ' + sg.dir + '">' + (sg.dir === 'long' ? '▲' : '▼') + '</span>' : (mine.length ? '<span class="badge warn">!</span>' : '');
    h += '<tr data-tf="' + t.id + '"' + (t.id === currentTf ? ' class="cur"' : '') + '><td><b>' + t.label + '</b><td class="' + kc + '">' + fmtK(k) + '<td>' + fmtK(dv) + '<td class="small">' + near + '<td>' + mark + '</tr>';
  });
  h += '</table>';
  h += '<h3>История сигналов</h3>';
  const hist = history.filter(x => x.dir).slice(0, 40);
  if (!hist.length) h += '<div class="muted small">Пока пусто. Сигналы сохраняются на этом устройстве.</div>';
  hist.forEach(x => {
    h += '<div class="card ' + x.dir + '"><div class="top"><span class="badge ' + x.dir + '">' + DIR_NAME[x.dir] + '</span><b>' + (TF[x.tf] ? TF[x.tf].label : x.tf) + '</b><span class="muted small right">' + fmtStamp(x.t) + '</span></div>' +
      '<div class="small">' + esc(x.text) + ' · цена ' + fmtP(x.price) + '</div></div>';
  });
  if (hist.length) h += '<button class="btn full" data-act="clearHist" style="margin-top:6px">Очистить историю</button>';
  return h;
}

function viewLines() {
  let h = '<button class="btn primary full" data-act="addLine">＋ Добавить линию</button><h3>Уровни и плотности</h3>';
  if (!levels.length) h += '<div class="muted small">Линий пока нет. Добавьте уровень (поддержка или сопротивление определятся сами по положению цены) или плотность ликвидаций (смотрите на Coinglass, вводите цену вручную).</div>';
  const items = levels.map(l => ({ price: (l.price + (isZone(l) ? l.price2 : l.price)) / 2, l })).concat(lastPrice != null ? [{ price: lastPrice, now: true }] : []).sort((a, b) => b.price - a.price);
  const d = data[currentTf], atrv = d && d.ind ? d.ind.atr[d.candles.length - 1] : NaN;
  items.forEach(it => {
    if (it.now) { h += '<div class="muted small" style="text-align:center;padding:4px 0">── цена ' + fmtP(lastPrice) + ' ──</div>'; return; }
    const l = it.l, col = levelStyle(l).color;
    const dist = lastPrice ? distTo(l, lastPrice) : NaN;
    const z = Core.zoneOf(l);
    const sign = lastPrice && z.lo > lastPrice ? 1 : -1;     // зона выше цены или ниже
    const pct = lastPrice ? sign * dist / lastPrice * 100 : NaN;
    const wTxt = isZone(l) ? 'ширина ' + fmtP(l.price2 - l.price) + (Number.isFinite(atrv) ? ' (' + ((l.price2 - l.price) / atrv).toFixed(1) + ' ATR)' : '') : '';
    h += '<div class="card"><div class="lvl"><span class="dot" style="background:' + col + '"></span><div><div class="p">' + lvlPriceTxt(l) + ' <span class="muted small">' + lvlName(l) + (l.volume ? ' · $' + l.volume + 'M' : '') + '</span></div>' +
      '<div class="muted small">' + (dist === 0 && isZone(l) ? 'цена внутри зоны' : (Number.isFinite(pct) ? (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%' : '') + (Number.isFinite(atrv) && lastPrice ? ' · ' + (dist / atrv).toFixed(1) + ' ATR' : '')) + (wTxt ? ' · ' + wTxt : '') + '</div></div>' +
      '<span class="right"></span><button class="btn ico" data-edit="' + l.id + '">Изм.</button><button class="btn ico danger" data-del="' + l.id + '">✕</button></div></div>';
  });
  return h;
}

function numField(key, label, step) {
  return '<label class="f">' + label + '<input type="number" inputmode="decimal" step="' + (step || 1) + '" data-set="' + key + '" value="' + settings[key] + '"></label>';
}
function swField(key, label) {
  return '<div class="sw"><span>' + label + '</span><input type="checkbox" data-set="' + key + '"' + (settings[key] ? ' checked' : '') + '></div>';
}
function viewSettings() {
  const perm = ('Notification' in window) ? Notification.permission : 'unsupported';
  return '<h3>StochRSI</h3><div class="grid2">' + numField('rsiLen', 'Период RSI') + numField('stochLen', 'Период Stoch') + numField('kLen', 'Сглаживание K') + numField('dLen', 'Сглаживание D') +
    numField('overbought', 'Перекупленность') + numField('oversold', 'Перепроданность') + '</div>' +
    '<h3>Сигналы</h3><div class="grid2">' + numField('proxAtr', 'Близость к уровню, ATR', 0.05) + numField('depthAtr', 'Глубина выноса плотности, ATR', 0.1) +
    numField('guardAtr', 'Плотность за уровнем гасит сигнал, ATR', 0.1) + numField('sweepWindow', 'Окно выноса, свечей') +
    numField('flipAtr', 'Смена роли уровня после пробоя, ATR (1ч); 0 — сразу', 0.05) + '</div>' +
    '<h3>Вид</h3>' + numField('liqOpacity', 'Прозрачность линии плотности (0.1–1)', 0.05) +
    '<label class="f">Когда проверять условия<select data-set="evalMode"><option value="live"' + (settings.evalMode === 'live' ? ' selected' : '') + '>По текущей цене (быстро)</option><option value="close"' + (settings.evalMode === 'close' ? ' selected' : '') + '>По закрытию свечи (надёжнее)</option></select></label>' +
    '<h3>Оповещения</h3>' + swField('sound', 'Звук') + swField('vibrate', 'Вибрация (Android)') + swField('keepAwake', 'Не гасить экран') +
    '<div class="sw"><span>Системные уведомления<br><span class="muted small">' + (perm === 'granted' ? 'включены' : perm === 'denied' ? 'запрещены в браузере' : perm === 'unsupported' ? 'не поддерживаются' : 'выключены') + '</span></span>' +
    (perm === 'default' ? '<button class="btn" data-act="notif">Включить</button>' : '') + '</div>' +
    '<div class="muted small" style="margin:6px 0">Сигналы приходят, пока приложение открыто. Для работы в фоне нужен сервер (следующий этап, Telegram).</div>' +
    '<h3>Резервная копия линий</h3><textarea id="ioBox" placeholder="Здесь появится JSON. Вставьте сюда копию и нажмите «Импорт»."></textarea>' +
    '<div class="row" style="margin-top:8px"><button class="btn" data-act="export">Экспорт</button><button class="btn" data-act="import">Импорт</button></div>' +
    '<button class="btn full danger" data-act="resetSettings" style="margin-top:14px">Сбросить настройки</button>';
}

const RULES = {
  rsiLen: [2, 100, 1], stochLen: [2, 100, 1], kLen: [1, 20, 1], dLen: [1, 20, 1], overbought: [50, 99, 0], oversold: [1, 50, 0],
  liqOpacity: [0.1, 1, 0], proxAtr: [0.05, 5, 0], depthAtr: [0.1, 5, 0], guardAtr: [0, 10, 0], sweepWindow: [1, 30, 1], flipAtr: [0, 5, 0]
};
const RECOMPUTE = new Set(['rsiLen', 'stochLen', 'kLen', 'dLen']);

function onSetting(el) {
  const k = el.dataset.set;
  let v;
  if (el.type === 'checkbox') v = el.checked;
  else if (el.tagName === 'SELECT') v = el.value;
  else {
    v = parseFloat(String(el.value).replace(',', '.'));
    const r = RULES[k];
    if (!Number.isFinite(v)) v = (k in Core.DEFAULTS) ? Core.DEFAULTS[k] : UI_DEFAULTS[k];
    if (r) { v = Math.min(r[1], Math.max(r[0], v)); if (r[2]) v = Math.round(v); }
  }
  settings[k] = v;
  saveSettings();
  if (RECOMPUTE.has(k)) { TFS.forEach(t => { const d = data[t.id]; if (d) d.ind = Core.compute(d.candles, settings); }); renderChart(false); }
  if (k === 'overbought' || k === 'oversold') drawStochRefs();
  if (k === 'keepAwake') applyWakeLock();
  if (k === 'liqOpacity') renderLines();
  evaluateAll();
  renderPanel(true);
}

function onAct(act) {
  if (act === 'addLine') openLevelModal(null);
  else if (act === 'clearHist') { if (confirm('Очистить историю сигналов?')) { history = []; LS.set('history', history); updateMarkers(); renderPanel(true); } }
  else if (act === 'notif') {
    Notification.requestPermission().then(() => renderPanel(true));
  }
  else if (act === 'export') {
    $('#ioBox').value = JSON.stringify({ v: 1, levels }, null, 1);
  } else if (act === 'import') {
    try {
      const o = JSON.parse($('#ioBox').value);
      const arr = (o.levels || []).filter(validLevel).map(normLevel);
      if (!arr.length && !confirm('В копии нет линий. Удалить все текущие линии?')) return;
      levels = arr; saveLevels(); renderLines(); evaluateAll(); renderPanel(true);
      toast('Импортировано линий: ' + arr.length);
    } catch (e) { toast('Не удалось прочитать JSON'); }
  } else if (act === 'resetSettings') {
    if (!confirm('Сбросить все настройки (линии останутся)?')) return;
    settings = Object.assign({}, Core.DEFAULTS, UI_DEFAULTS, { tf: currentTf });
    saveSettings();
    TFS.forEach(t => { const d = data[t.id]; if (d) d.ind = Core.compute(d.candles, settings); });
    renderChart(false); drawStochRefs(); evaluateAll(); renderPanel(true);
  }
}

// ---------- окно добавления / правки линии ----------
const num = (v) => parseFloat(String(v).replace(',', '.'));
let ms = null;
let modalShownAt = 0;
function openLevelModal(l) {
  ms = l ? { id: l.id, type: l.type, price: l.price, price2: l.price2 || '',
             side: l.side || (lastPrice && (l.price + (l.price2 || l.price)) / 2 < lastPrice ? 'below' : 'above'), volume: l.volume || '', sideTouched: true }
         : { id: null, type: 'sr', price: lastPrice ? round2(lastPrice) : '', price2: '', side: 'above', volume: '', sideTouched: false };
  drawModal();
}
function roleHintHtml(price) {
  const base = 'Роль назначается автоматически: линия выше цены — сопротивление, ниже — поддержка. ';
  const p = num(price);
  if (!(p > 0) || lastPrice == null) return base;
  return base + 'Сейчас: ' + (lastPrice >= p ? '<b style="color:var(--up)">поддержка</b> (цена выше линии)' : '<b style="color:var(--down)">сопротивление</b> (цена ниже линии)') + '.';
}
// ширина диапазона плотности по полям «От» и «До» (0, если задана одна цена)
function zoneWidth() {
  const a = num(ms.price), b = num(ms.price2);
  return a > 0 && b > 0 ? Math.abs(b - a) : 0;
}
function autoSide() {
  if (ms.sideTouched || !lastPrice) return;
  const a = num(ms.price), b = num(ms.price2);
  if (!(a > 0)) return;
  const lo = b > 0 ? Math.min(a, b) : a, hi = b > 0 ? Math.max(a, b) : a;
  ms.side = lo > lastPrice ? 'above' : hi < lastPrice ? 'below' : ((lo + hi) / 2 > lastPrice ? 'above' : 'below');
}
function drawModal() {
  autoSide();
  const m = ms, liq = m.type === 'liq', w = zoneWidth();
  const priceBlock = liq
    ? '<div class="grid2"><label class="f">От (низ диапазона)<input id="mPrice" type="number" inputmode="decimal" step="0.01" value="' + m.price + '"></label>' +
      '<label class="f">До (верх диапазона)<input id="mPrice2" type="number" inputmode="decimal" step="0.01" placeholder="можно пусто" value="' + m.price2 + '"></label></div>' +
      '<label class="f">Ширина диапазона, $<input id="mWidth" type="number" inputmode="decimal" step="0.01" placeholder="0 — одна линия" value="' + (w > 0 ? round2(w) : '') + '"></label>' +
      '<div class="row" style="margin-top:8px"><button class="btn" id="mPick">Низ на графике</button><button class="btn" id="mPick2">Верх на графике</button></div>' +
      '<div class="muted small" style="margin-top:6px">Ширина считается из «От» и «До». Если ввести ширину, «До» = «От» + ширина. Пустое «До» — плотность одной линией.</div>'
    : '<div class="row" style="align-items:flex-end"><label class="f">Цена<input id="mPrice" type="number" inputmode="decimal" step="0.01" value="' + m.price + '"></label><button class="btn" id="mPick" style="flex:none;margin-top:10px">На графике</button></div>' +
      '<div class="muted small" id="mRole" style="margin-top:8px">' + roleHintHtml(m.price) + '</div>';
  $('#modalBody').innerHTML =
    '<h2>' + (m.id ? 'Изменить линию' : 'Новая линия') + '</h2>' +
    '<div class="seg" id="mType"><button data-v="sr" class="' + (liq ? '' : 'on') + '">Уровень</button><button data-v="liq" class="liq' + (liq ? ' on' : '') + '">Плотность</button></div>' +
    priceBlock +
    (liq ? '<label class="f">Где плотность относительно цены</label><div class="seg" id="mSide"><button data-v="above" class="' + (m.side === 'above' ? 'on liq' : '') + '">Выше (шорты)</button><button data-v="below" class="' + (m.side === 'below' ? 'on liq' : '') + '">Ниже (лонги)</button></div>' +
      '<label class="f">Объём, млн $ (по желанию)<input id="mVol" type="number" inputmode="decimal" step="0.1" value="' + m.volume + '"></label>' : '') +
    '<div class="row" style="margin-top:14px">' + (m.id ? '<button class="btn danger" id="mDel">Удалить</button>' : '') + '<button class="btn" id="mCancel">Отмена</button><button class="btn primary" id="mSave">Сохранить</button></div>';
  $('#modal').hidden = false;
}
function readModal() {
  const p = $('#mPrice'), p2 = $('#mPrice2'), v = $('#mVol');
  if (p) ms.price = p.value;
  if (p2) ms.price2 = p2.value;
  if (v) ms.volume = v.value;
}
function closeModal() { $('#modal').hidden = true; ms = null; }

// обновляем кнопки стороны на месте, не перерисовывая окно, чтобы не терять фокус в полях
function refreshSide() {
  autoSide();
  $$('#mSide button').forEach(b => { const on = b.dataset.v === ms.side; b.classList.toggle('on', on); b.classList.toggle('liq', on); });
}

function bindModal() {
  $('#modal').addEventListener('click', (e) => {
    // сразу после показа окна игнорируем клики: «хвост» тапа по графику иногда прилетает уже в окно
    if (Date.now() - modalShownAt < 450) return;
    if (e.target.id === 'modal') { closeModal(); return; }
    const b = e.target.closest('button');
    if (!b || !ms) return;
    if (b.parentElement.id === 'mType') { readModal(); ms.type = b.dataset.v; drawModal(); }
    else if (b.parentElement.id === 'mSide') { readModal(); ms.side = b.dataset.v; ms.sideTouched = true; drawModal(); }
    else if (b.id === 'mCancel') closeModal();
    else if (b.id === 'mDel') { levels = levels.filter(x => x.id !== ms.id); afterLevelsChange(); closeModal(); }
    else if (b.id === 'mPick' || b.id === 'mPick2') {
      readModal();
      const saved = ms, field = b.id === 'mPick2' ? 'price2' : 'price';
      $('#modal').hidden = true;
      setPlacing({ cb: (price) => { ms = saved; ms[field] = price; modalShownAt = Date.now(); drawModal(); } });
    } else if (b.id === 'mSave') {
      readModal();
      const liq = ms.type === 'liq';
      const a = num(ms.price), c = liq ? num(ms.price2) : NaN;
      const vals = [a, c].filter(x => x > 0);
      if (liq ? !vals.length : !(a > 0)) { $('#mPrice').style.borderColor = '#ff5b5b'; return; }
      const lo = liq ? Math.min.apply(null, vals) : a, hi = liq ? Math.max.apply(null, vals) : a;
      const obj = { id: ms.id || uid(), type: ms.type, price: round2(lo) };
      if (liq) {
        obj.side = ms.side;
        if (round2(hi) > round2(lo)) obj.price2 = round2(hi);   // диапазон; иначе плотность — одна линия
        const vol = num(ms.volume);
        if (vol > 0) obj.volume = vol;
      }
      levels = ms.id ? levels.map(x => x.id === ms.id ? obj : x) : levels.concat(obj);
      afterLevelsChange();
      closeModal();
    }
  });
  $('#modal').addEventListener('input', (e) => {
    if (!ms) return;
    const id = e.target.id;
    if (ms.type === 'sr') {
      if (id === 'mPrice') { const hint = $('#mRole'); if (hint) hint.innerHTML = roleHintHtml(e.target.value); }
      return;
    }
    if (ms.type !== 'liq') return;
    if (id === 'mPrice' || id === 'mPrice2') {
      ms[id === 'mPrice' ? 'price' : 'price2'] = e.target.value;
      const w = zoneWidth(), wi = $('#mWidth');
      if (wi) wi.value = w > 0 ? round2(w) : '';
      refreshSide();
    } else if (id === 'mWidth') {
      const lo = num(ms.price), w = num(e.target.value);
      const p2 = $('#mPrice2');
      if (lo > 0 && w > 0) { ms.price2 = round2(lo + w); if (p2) p2.value = ms.price2; }
      else if (!(w > 0)) { ms.price2 = ''; if (p2) p2.value = ''; }
      refreshSide();
    }
  });
}
function afterLevelsChange() {
  saveLevels();
  renderLines();
  evaluateAll();
  renderPanel(true);
}

// ---------- интерфейс ----------
function buildTfBar() {
  $('#tfbar').innerHTML = TFS.map(t => '<button data-tf="' + t.id + '"' + (t.id === currentTf ? ' class="on"' : '') + '>' + t.label + '</button>').join('');
}
function setTf(id) {
  if (!TF[id] || id === currentTf) return;
  currentTf = id;
  settings.tf = id; saveSettings();
  $$('#tfbar button').forEach(b => b.classList.toggle('on', b.dataset.tf === id));
  chartReady = false;
  if (data[id]) { renderChart(true); } else { $('#loading').hidden = false; }
  renderBanner();
  renderPanel(true);
}

function bindUI() {
  $('#tfbar').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setTf(b.dataset.tf); });
  $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setTab(b.dataset.tab); });
  $('#banner').addEventListener('click', () => setTab('signals'));
  $('#hintCancel').addEventListener('click', () => { const p = placing; setPlacing(null); if (p && ms) drawModal(); });
  $('#btnAdd').addEventListener('click', () => openLevelModal(null));
  $('#btnEdit').addEventListener('click', (e) => {
    editMode = !editMode;
    e.currentTarget.classList.toggle('on', editMode);
    if (editMode) toast('Режим правки: перетащите линию, тап по линии — изменить или удалить');
  });
  const panel = $('#panel');
  panel.addEventListener('pointerdown', () => { panelBusyUntil = Date.now() + 900; }, { passive: true });
  panel.addEventListener('click', (e) => {
    const t = e.target;
    const row = t.closest('tr[data-tf]');
    if (row) { setTf(row.dataset.tf); return; }
    const ed = t.closest('[data-edit]');
    if (ed) { openLevelModal(levels.find(l => l.id === ed.dataset.edit)); return; }
    const del = t.closest('[data-del]');
    if (del) { if (confirm('Удалить линию?')) { levels = levels.filter(l => l.id !== del.dataset.del); afterLevelsChange(); } return; }
    const act = t.closest('[data-act]');
    if (act) onAct(act.dataset.act);
  });
  panel.addEventListener('change', (e) => { if (e.target.dataset && e.target.dataset.set) onSetting(e.target); });
  bindModal();

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    applyWakeLock();
    if (!ws || ws.readyState !== 1 || Date.now() - lastMsg > 20000) forceReconnect();
  });
  setInterval(() => { if (ws && ws.readyState === 1 && Date.now() - lastMsg > 45000) forceReconnect(); }, 15000);
  setInterval(flush, 300);
  setInterval(pulse, 90);
  setInterval(pulseMarkers, 90);
  matchMedia('(min-width:980px)').addEventListener('change', () => { if (isDesktop() && !tab) setTab('signals'); });
}

async function boot() {
  const ok = await loadAll();
  if (ok) { connectWS(); applyWakeLock(); }
}

function start() {
  buildTfBar();
  createCharts();
  renderLines();
  bindUI();
  if (isDesktop()) setTab('signals');
  boot();
  if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* офлайн-режим недоступен */ });
  }
}
start();

// для отладки и тестов
window.__eth = { data, get levels() { return levels; }, get activeSignals() { return activeSignals; }, applyKline, flush, evaluateAll, roleOf, lineObjs };
})();
