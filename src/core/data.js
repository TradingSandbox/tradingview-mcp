/**
 * Core data access logic.
 */
import { evaluate, evaluateAsync, KNOWN_PATHS, safeString } from '../connection.js';
import { resolveRow, getCurrentSymbol } from './_scanner.js';
import * as backtest from './backtest.js';

const MAX_OHLCV_BARS = 500;
const CHART_API = KNOWN_PATHS.chartApi;
const BARS_PATH = KNOWN_PATHS.mainSeriesBars;

function buildGraphicsJS(collectionName, mapKey, filter) {
  return `
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var model = chart.model();
      var sources = model.model().dataSources();
      var results = [];
      var filter = ${safeString(filter || '')};
      for (var si = 0; si < sources.length; si++) {
        var s = sources[si];
        if (!s.metaInfo) continue;
        try {
          var meta = s.metaInfo();
          var name = meta.description || meta.shortDescription || '';
          if (!name) continue;
          if (filter && name.indexOf(filter) === -1) continue;
          var g = s._graphics;
          if (!g || !g._primitivesCollection) continue;
          var pc = g._primitivesCollection;
          var items = [];
          try {
            var outer = pc.${collectionName};
            if (outer) {
              var inner = outer.get('${mapKey}');
              if (inner) {
                var coll = inner.get(false);
                if (coll && coll._primitivesDataById && coll._primitivesDataById.size > 0) {
                  coll._primitivesDataById.forEach(function(v, id) { items.push({id: id, raw: v}); });
                }
              }
            }
          } catch(e) {}
          if (items.length === 0 && '${collectionName}' === 'dwgtablecells') {
            try {
              var tcOuter = pc.dwgtablecells;
              if (tcOuter) {
                var tcColl = tcOuter.get('tableCells');
                if (tcColl && tcColl._primitivesDataById && tcColl._primitivesDataById.size > 0) {
                  tcColl._primitivesDataById.forEach(function(v, id) { items.push({id: id, raw: v}); });
                }
              }
            } catch(e) {}
          }
          if (items.length > 0) results.push({name: name, count: items.length, items: items});
        } catch(e) {}
      }
      return results;
    })()
  `;
}

/** Normalize a user timeframe to a TradingView session resolution ("15", "60", "D", "W", "M"). */
export function normalizeResolution(tf) {
  if (tf === undefined || tf === null || tf === '') return null;
  const t = String(tf).trim().toUpperCase();
  if (/^\d+$/.test(t)) return t;                       // minutes: "1", "15", "240"
  if (/^\d+[SDWM]$/.test(t)) return t === '1D' ? 'D' : t === '1W' ? 'W' : t === '1M' ? 'M' : t;
  if (['D', 'W', 'M', 'DAY', 'WEEK', 'MONTH', 'DAILY', 'WEEKLY', 'MONTHLY'].includes(t)) return t[0];
  throw new Error(`Invalid timeframe "${tf}". Use minutes ("1", "15", "60", "240") or "D", "W", "M".`);
}

/** Shape a bar array into the compact summary used by summary=true. */
export function buildOhlcvSummary(bars) {
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const volumes = bars.map(b => b.volume);
  const first = bars[0];
  const last = bars[bars.length - 1];
  return {
    bar_count: bars.length,
    period: { from: first.time, to: last.time },
    open: first.open, close: last.close,
    high: Math.max(...highs), low: Math.min(...lows),
    range: Math.round((Math.max(...highs) - Math.min(...lows)) * 100) / 100,
    change: Math.round((last.close - first.open) * 100) / 100,
    change_pct: Math.round(((last.close - first.open) / first.open) * 10000) / 100 + '%',
    avg_volume: Math.round(volumes.reduce((a, b) => a + b, 0) / volumes.length),
    last_5_bars: bars.slice(-5),
  };
}

// Fetch bars for any symbol/timeframe WITHOUT touching the visible chart: a
// throwaway chart-session on the shared websocket transport (resolve_symbol →
// create_series → collect data_update plots → series_completed → destroy).
async function getOhlcvHeadless({ symbol, resolution, limit, timeout_ms }) {
  const result = await evaluateAsync(`
    (function() {
      return new Promise(function(resolve) {
        var done = false;
        var barsByTime = {};
        var info = null;
        var session = null;
        function finish(r) {
          if (done) return;
          done = true;
          clearTimeout(tm);
          try { if (session) session.destroy(); } catch (e) {}
          resolve(r);
        }
        var tm = setTimeout(function() {
          var bars = Object.keys(barsByTime).sort(function(a, b){ return a - b; }).map(function(k){ return barsByTime[k]; });
          finish(bars.length ? { bars: bars, symbol_info: info, note: 'timed out waiting for series_completed; returning received bars' }
                             : { error: 'Timed out waiting for data. Check the symbol is exchange-qualified (e.g. "NASDAQ:AAPL").' });
        }, ${timeout_ms});
        try {
          var live = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().model().chartApi();
          var Session = live.constructor;
          session = new Session(live._getChartApi(), true);
          session.connect(function(msg) {
            if (msg.method === 'critical_error') finish({ error: 'Chart session critical error: ' + JSON.stringify(msg.params).slice(0, 200) });
          });
          session.resolveSymbol('sym_1', ${safeString(symbol)}, function(r) {
            if (r.method === 'symbol_error') return finish({ error: 'Cannot resolve symbol ' + ${safeString(symbol)} + '. Use an exchange-qualified name like "NASDAQ:AAPL" or "NSE:RELIANCE".' });
            try {
              var p = r.params && r.params[1];
              if (p) info = { symbol: p.pro_name || p.name, description: p.description, exchange: p.exchange, type: p.type, currency: p.currency_code, timezone: p.timezone, session: p.session };
            } catch (e) {}
            session.createSeries('sds_1', 's1', 'sym_1', ${safeString(resolution)}, ${limit}, null, function(dm) {
              if (dm.method === 'data_update' && dm.params && dm.params.plots) {
                var plots = dm.params.plots;
                for (var i = 0; i < plots.length; i++) {
                  var v = plots[i].value;
                  if (v && v.length >= 5) barsByTime[v[0]] = { time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0 };
                }
              } else if (dm.method === 'series_completed') {
                var bars = Object.keys(barsByTime).sort(function(a, b){ return a - b; }).map(function(k){ return barsByTime[k]; });
                finish({ bars: bars, symbol_info: info });
              } else if (dm.method === 'series_error') {
                finish({ error: 'No data for ' + ${safeString(symbol)} + ' at this timeframe (series_error).' });
              }
            });
          });
        } catch (e) { finish({ error: e.message }); }
      });
    })()
  `);
  if (!result) throw new Error('Headless OHLCV fetch returned nothing. Is a TradingView chart tab connected?');
  if (result.error) throw new Error(result.error);
  return result;
}

/**
 * Fetch OHLCV bars for ANY symbol at ANY timeframe through a throwaway
 * headless chart session — the visible chart is never touched.
 */
export async function getSymbolOhlcv({ symbol, timeframe, count, summary, timeout_ms } = {}) {
  const limit = Math.min(count || 100, MAX_OHLCV_BARS);
  const sym = symbol || await getCurrentSymbol();
  if (!sym) throw new Error('No symbol given and the current chart symbol could not be determined.');
  const res = normalizeResolution(timeframe) || 'D';
  const data = await getOhlcvHeadless({ symbol: sym, resolution: res, limit, timeout_ms: timeout_ms || 15000 });
  if (!data.bars || data.bars.length === 0) throw new Error(`No bars returned for ${sym} @ ${res}.`);
  const base = { success: true, symbol: sym, timeframe: res, source: 'headless_session', ...(data.note ? { note: data.note } : {}) };
  if (summary) return { ...base, ...buildOhlcvSummary(data.bars), symbol_info: data.symbol_info };
  return { ...base, bar_count: data.bars.length, symbol_info: data.symbol_info, bars: data.bars };
}

export async function getOhlcv({ count, summary } = {}) {
  const limit = Math.min(count || 100, MAX_OHLCV_BARS);
  let data;
  try {
    data = await evaluate(`
      (function() {
        var bars = ${BARS_PATH};
        if (!bars || typeof bars.lastIndex !== 'function') return null;
        var result = [];
        var end = bars.lastIndex();
        var start = Math.max(bars.firstIndex(), end - ${limit} + 1);
        for (var i = start; i <= end; i++) {
          var v = bars.valueAt(i);
          if (v) result.push({time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0});
        }
        return {bars: result, total_bars: bars.size(), source: 'direct_bars'};
      })()
    `);
  } catch { data = null; }

  if (!data || !data.bars || data.bars.length === 0) {
    throw new Error('Could not extract OHLCV data. The chart may still be loading.');
  }

  if (summary) {
    return { success: true, ...buildOhlcvSummary(data.bars) };
  }

  return { success: true, bar_count: data.bars.length, total_available: data.total_bars, source: data.source, bars: data.bars };
}

export async function getIndicator({ entity_id }) {
  const data = await evaluate(`
    (function() {
      var api = ${CHART_API};
      var study = api.getStudyById(${safeString(entity_id)});
      if (!study) return { error: 'Study not found: ' + ${safeString(entity_id)} };
      var result = { name: null, inputs: null, visible: null };
      try { result.visible = study.isVisible(); } catch(e) {}
      try { result.inputs = study.getInputValues(); } catch(e) { result.inputs_error = e.message; }
      return result;
    })()
  `);

  if (data?.error) throw new Error(data.error);

  let inputs = data?.inputs;
  if (Array.isArray(inputs)) {
    inputs = inputs.filter(inp => {
      if (inp.id === 'text' && typeof inp.value === 'string' && inp.value.length > 200) return false;
      if (typeof inp.value === 'string' && inp.value.length > 500) return false;
      return true;
    });
  }
  return { success: true, entity_id, visible: data?.visible, inputs };
}

// Strategy Tester data — implemented in ./backtest.js (correct isTVScriptStrategy
// detection + deep-backtest awareness). Re-exported here for the CLI and batch tools.
export async function getStrategyResults(opts = {}) {
  return backtest.getStrategyResults(opts);
}

export async function getTrades(opts = {}) {
  return backtest.getTrades(opts);
}

export async function getEquity(opts = {}) {
  return backtest.getEquity(opts);
}

export async function getQuote({ symbol } = {}) {
  // The chart's main series only holds ONE symbol. Reading its bars for a
  // DIFFERENT symbol would silently return the chart symbol's price (the
  // "all returning the same stub" bug). So: serve the current chart symbol
  // from the live chart bars (tick-level), and any OTHER symbol from the
  // scanner (a ~per-minute snapshot, but actually that symbol's data).
  const currentSym = await getCurrentSymbol();
  const wantScanner = symbol && symbol !== currentSym;

  if (!wantScanner) {
    const data = await evaluate(`
      (function() {
        var api = ${CHART_API};
        var sym = ${safeString(symbol || '')};
        if (!sym) { try { sym = api.symbol(); } catch(e) {} }
        if (!sym) { try { sym = api.symbolExt().symbol; } catch(e) {} }
        var ext = {};
        try { ext = api.symbolExt() || {}; } catch(e) {}
        var bars = ${BARS_PATH};
        var quote = { symbol: sym };
        if (bars && typeof bars.lastIndex === 'function') {
          var last = bars.valueAt(bars.lastIndex());
          if (last) { quote.time = last[0]; quote.open = last[1]; quote.high = last[2]; quote.low = last[3]; quote.close = last[4]; quote.last = last[4]; quote.volume = last[5] || 0; }
        }
        try {
          var bidEl = document.querySelector('[class*="bid"] [class*="price"], [class*="dom-"] [class*="bid"]');
          var askEl = document.querySelector('[class*="ask"] [class*="price"], [class*="dom-"] [class*="ask"]');
          if (bidEl) quote.bid = parseFloat(bidEl.textContent.replace(/[^0-9.\\-]/g, ''));
          if (askEl) quote.ask = parseFloat(askEl.textContent.replace(/[^0-9.\\-]/g, ''));
        } catch(e) {}
        try {
          var hdr = document.querySelector('[class*="headerRow"] [class*="last-"]');
          if (hdr) { var hdrPrice = parseFloat(hdr.textContent.replace(/[^0-9.\\-]/g, '')); if (!isNaN(hdrPrice)) quote.header_price = hdrPrice; }
        } catch(e) {}
        if (ext.description) quote.description = ext.description;
        if (ext.exchange) quote.exchange = ext.exchange;
        if (ext.type) quote.type = ext.type;
        return quote;
      })()
    `);
    if (!data || (!data.last && !data.close)) throw new Error('Could not retrieve quote. The chart may still be loading.');
    return { success: true, source: 'chart', ...data };
  }

  // Off-chart symbol → scanner. The "global" market is a universal superset
  // (US/intl stocks, crypto, forex, futures incl. MCX commodities). resolveRow
  // also handles an exchange-prefix mismatch by retrying on the bare ticker.
  const cols = ['close', 'open', 'high', 'low', 'volume', 'change', 'description', 'exchange', 'type'];
  const resolved = await resolveRow('global', symbol, cols);
  if (!resolved) {
    throw new Error(`No quote found for "${symbol}" on TradingView's scanner. Check it is exchange-qualified (e.g. "MCX:GOLD1!", "NASDAQ:AAPL", "NSE:RELIANCE").`);
  }
  const d = resolved.map;
  const changePct = Number.isFinite(Number(d.change)) ? Math.round(Number(d.change) * 100) / 100 : null;
  return {
    success: true,
    source: 'scanner',
    note: 'Snapshot from TradingView scanner (~per-minute, may lag realtime). Load the symbol on the chart for tick-level data.',
    symbol: resolved.symbol,
    ...(resolved.symbol !== symbol && { requested_symbol: symbol }),
    open: d.open ?? null,
    high: d.high ?? null,
    low: d.low ?? null,
    close: d.close ?? null,
    last: d.close ?? null,
    volume: d.volume ?? 0,
    change_pct: changePct,
    description: d.description ?? undefined,
    exchange: d.exchange ?? undefined,
    type: d.type ?? undefined,
  };
}

export async function getDepth() {
  const data = await evaluate(`
    (function() {
      var domPanel = document.querySelector('[class*="depth"]')
        || document.querySelector('[class*="orderBook"]')
        || document.querySelector('[class*="dom-"]')
        || document.querySelector('[class*="DOM"]')
        || document.querySelector('[data-name="dom"]');
      if (!domPanel) return { found: false, error: 'DOM / Depth of Market panel not found.' };
      var bids = [], asks = [];
      var rows = domPanel.querySelectorAll('[class*="row"], tr');
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var priceEl = row.querySelector('[class*="price"]');
        var sizeEl = row.querySelector('[class*="size"], [class*="volume"], [class*="qty"]');
        if (!priceEl) continue;
        var price = parseFloat(priceEl.textContent.replace(/[^0-9.\\-]/g, ''));
        var size = sizeEl ? parseFloat(sizeEl.textContent.replace(/[^0-9.\\-]/g, '')) : 0;
        if (isNaN(price)) continue;
        var rowClass = row.className || '';
        var rowHTML = row.innerHTML || '';
        if (/bid|buy/i.test(rowClass) || /bid|buy/i.test(rowHTML)) bids.push({ price, size });
        else if (/ask|sell/i.test(rowClass) || /ask|sell/i.test(rowHTML)) asks.push({ price, size });
        else if (i < rows.length / 2) asks.push({ price, size });
        else bids.push({ price, size });
      }
      if (bids.length === 0 && asks.length === 0) {
        var cells = domPanel.querySelectorAll('[class*="cell"], td');
        var prices = [];
        cells.forEach(function(c) { var val = parseFloat(c.textContent.replace(/[^0-9.\\-]/g, '')); if (!isNaN(val) && val > 0) prices.push(val); });
        if (prices.length > 0) return { found: true, raw_values: prices.slice(0, 50), bids: [], asks: [], note: 'Could not classify bid/ask levels.' };
      }
      bids.sort(function(a, b) { return b.price - a.price; });
      asks.sort(function(a, b) { return a.price - b.price; });
      var spread = null;
      if (asks.length > 0 && bids.length > 0) spread = +(asks[0].price - bids[0].price).toFixed(6);
      return { found: true, bids: bids, asks: asks, spread: spread };
    })()
  `);

  if (!data || !data.found) throw new Error(data?.error || 'DOM panel not found.');
  return { success: true, bid_levels: data.bids?.length || 0, ask_levels: data.asks?.length || 0, spread: data.spread, bids: data.bids || [], asks: data.asks || [], raw_values: data.raw_values, note: data.note };
}

export async function getStudyValues() {
  const data = await evaluate(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var model = chart.model();
      var sources = model.model().dataSources();
      var results = [];
      for (var si = 0; si < sources.length; si++) {
        var s = sources[si];
        if (!s.metaInfo) continue;
        try {
          var meta = s.metaInfo();
          var name = meta.description || meta.shortDescription || '';
          if (!name) continue;
          var values = {};
          try {
            var dwv = s.dataWindowView();
            if (dwv) {
              var items = dwv.items();
              if (items) {
                for (var i = 0; i < items.length; i++) {
                  var item = items[i];
                  if (item._value && item._value !== '∅' && item._title) values[item._title] = item._value;
                }
              }
            }
          } catch(e) {}
          if (Object.keys(values).length > 0) results.push({ name: name, values: values });
        } catch(e) {}
      }
      return results;
    })()
  `);
  return { success: true, study_count: data?.length || 0, studies: data || [] };
}

export async function getPineLines({ study_filter, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwglines', 'lines', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const studies = raw.map(s => {
    const hLevels = [];
    const seen = {};
    const allLines = [];
    for (const item of s.items) {
      const v = item.raw;
      const y1 = v.y1 != null ? Math.round(v.y1 * 100) / 100 : null;
      const y2 = v.y2 != null ? Math.round(v.y2 * 100) / 100 : null;
      if (verbose) allLines.push({ id: item.id, y1, y2, x1: v.x1, x2: v.x2, horizontal: v.y1 === v.y2, style: v.st, width: v.w, color: v.ci });
      if (y1 != null && v.y1 === v.y2 && !seen[y1]) { hLevels.push(y1); seen[y1] = true; }
    }
    hLevels.sort((a, b) => b - a);
    const result = { name: s.name, total_lines: s.count, horizontal_levels: hLevels };
    if (verbose) result.all_lines = allLines;
    return result;
  });
  return { success: true, study_count: studies.length, studies };
}

export async function getPineLabels({ study_filter, max_labels, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwglabels', 'labels', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const limit = max_labels || 50;
  const studies = raw.map(s => {
    let labels = s.items.map(item => {
      const v = item.raw;
      const text = v.t || '';
      const price = v.y != null ? Math.round(v.y * 100) / 100 : null;
      if (verbose) return { id: item.id, text, price, x: v.x, yloc: v.yl, size: v.sz, textColor: v.tci, color: v.ci };
      return { text, price };
    }).filter(l => l.text || l.price != null);
    if (labels.length > limit) labels = labels.slice(-limit);
    return { name: s.name, total_labels: s.count, showing: labels.length, labels };
  });
  return { success: true, study_count: studies.length, studies };
}

export async function getPineTables({ study_filter } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwgtablecells', 'tableCells', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const studies = raw.map(s => {
    const tables = {};
    for (const item of s.items) {
      const v = item.raw;
      const tid = v.tid || 0;
      if (!tables[tid]) tables[tid] = {};
      if (!tables[tid][v.row]) tables[tid][v.row] = {};
      tables[tid][v.row][v.col] = v.t || '';
    }
    const tableList = Object.entries(tables).map(([tid, rows]) => {
      const rowNums = Object.keys(rows).map(Number).sort((a, b) => a - b);
      const formatted = rowNums.map(rn => {
        const cols = rows[rn];
        const colNums = Object.keys(cols).map(Number).sort((a, b) => a - b);
        return colNums.map(cn => cols[cn]).filter(Boolean).join(' | ');
      }).filter(Boolean);
      return { rows: formatted };
    });
    return { name: s.name, tables: tableList };
  });
  return { success: true, study_count: studies.length, studies };
}

export async function getPineBoxes({ study_filter, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwgboxes', 'boxes', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const studies = raw.map(s => {
    const zones = [];
    const seen = {};
    const allBoxes = [];
    for (const item of s.items) {
      const v = item.raw;
      const high = v.y1 != null && v.y2 != null ? Math.round(Math.max(v.y1, v.y2) * 100) / 100 : null;
      const low = v.y1 != null && v.y2 != null ? Math.round(Math.min(v.y1, v.y2) * 100) / 100 : null;
      if (verbose) allBoxes.push({ id: item.id, high, low, x1: v.x1, x2: v.x2, borderColor: v.c, bgColor: v.bc });
      if (high != null && low != null) { const key = high + ':' + low; if (!seen[key]) { zones.push({ high, low }); seen[key] = true; } }
    }
    zones.sort((a, b) => b.high - a.high);
    const result = { name: s.name, total_boxes: s.count, zones };
    if (verbose) result.all_boxes = allBoxes;
    return result;
  });
  return { success: true, study_count: studies.length, studies };
}
