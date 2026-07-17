/**
 * Core strategy backtesting logic.
 *
 * Strategy detection: a data source whose metaInfo().isTVScriptStrategy is true.
 * (The old heuristic — is_price_study === false && (reportData || performance) —
 * matched Volume (every study has .performance) and MISSED overlay strategies,
 * which have is_price_study === true.)
 *
 * Report path: strategySource.reportData() → { currency, settings, buyHold,
 * buyHoldPercent, filledOrders, performance, trades, marginUsage, firstTradeIndex }.
 * performance has all/long/short buckets + top-level ratios (sharpe, sortino, DD).
 * Percent-ish fields are FRACTIONS (0.036 = 3.6%) — we convert to percent.
 *
 * Deep backtesting (custom date range beyond loaded chart bars) goes through
 * window.TradingViewApi.backtestingStrategyApi() → BacktestingStrategyFacade:
 *   setReportDataSource(true) + requestDeepBacktestingData(fromMs, toMs)
 * The result arrives over a dedicated websocket and is exposed as a WatchedValue
 * at facade.activeStrategyReportData. While deep mode is active we read reports
 * from the facade instead of the chart study (flag kept at window.__tvmcpDeep).
 *
 * Strategy properties (initial capital, commission, slippage, …) are ordinary
 * study inputs tagged groupId === 'strategy_props', addressable by a stable
 * per-property `internalID` (initial_capital, commission_value, …) that maps to
 * a script-specific input id (in_18, …).
 */
import { evaluate as _evaluate, evaluateAsync as _evaluateAsync } from '../connection.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

// Status types observed on study.status().type
export const STUDY_STATUS = { LOADING: 1, COMPLETED: 2, ERROR: 3 };

export const MAX_TRADES_LIMIT = 500;
export const DEFAULT_TRADES = 20;
export const OPTIMIZE_MAX_COMBOS = 100;
export const OPTIMIZE_DEFAULT_COMBOS = 30;

export const RANGE_PRESETS = { last_7d: 7, last_30d: 30, last_90d: 90, last_365d: 365 };

// Settable strategy properties: internalID → expected type
export const STRATEGY_PROPERTY_IDS = {
  initial_capital: 'float',
  currency: 'text',
  commission_type: 'text',            // percent | cash_per_contract | cash_per_order
  commission_value: 'float',
  slippage: 'integer',
  default_qty_type: 'text',           // fixed | cash_per_order | percent_of_equity
  default_qty_value: 'float',
  pyramiding: 'integer',
  process_orders_on_close: 'bool',
  calc_on_every_tick: 'bool',
  calc_on_order_fills: 'bool',
  calc_on_every_history_tick: 'bool',
  backtest_fill_limits_assumption: 'integer',
  close_entries_rule: 'text',         // FIFO | ANY
  margin_long: 'float',
  margin_short: 'float',
  risk_free_rate: 'float',
  use_bar_magnifier: 'bool',
  fill_orders_on_standard_ohlc: 'bool',
};

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    evaluateAsync: deps?.evaluateAsync || _evaluateAsync,
  };
}

// ── Page-side snippet builders ───────────────────────────────────────────

/**
 * Find the strategy source (+ facade study handle). Defines __chartApi, __strat,
 * and __stratNames (every live strategy's shortDescription, for diagnostics).
 *
 * Two filters beyond isTVScriptStrategy:
 * - Cross-check against getAllStudies(): the data-source model can retain a
 *   strategy that was removed from the chart, and reading that ghost reports a
 *   strategy the chart is no longer running.
 * - Optional title match (metaInfo().shortDescription): callers verifying a
 *   specific script must not be answered with whichever strategy happens to be
 *   first in the model.
 */
function findStrategySnippet(entityId, title) {
  const conds = [];
  if (entityId) conds.push(`s.id() === ${JSON.stringify(entityId)}`);
  if (title) conds.push(`(mi.shortDescription || '') === ${JSON.stringify(title)}`);
  const extra = conds.length ? `${conds.join(' && ')} && ` : '';
  return `
    var __chartApi = ${CHART_API};
    var __chart = __chartApi._chartWidget;
    var __live = null;
    try {
      __live = {};
      __chartApi.getAllStudies().forEach(function(st) { if (st && st.id) __live[st.id] = true; });
    } catch (e) { __live = null; }
    var __stratNames = [];
    var __strats = __chart.model().model().dataSources().filter(function(s) {
      var mi = s.metaInfo && s.metaInfo();
      if (!(mi && mi.isTVScriptStrategy)) return false;
      if (__live && !__live[s.id()]) return false;
      __stratNames.push(mi.shortDescription || '');
      return ${extra}true;
    });
    var __strat = __strats[0] || null;
  `;
}

/** Read the active report — deep facade when deep mode is on, else the chart study. Defines __report, __reportSource. */
const READ_REPORT_SNIPPET = `
    var __report = null, __reportSource = 'chart';
    if (window.__tvmcpDeep && window.__tvmcpDeep.active && window.__tvmcpDeep.facade) {
      try {
        var __drd = window.__tvmcpDeep.facade.activeStrategyReportData.value();
        if (__drd) { __report = __drd; __reportSource = 'deep_backtest'; }
      } catch (e) {}
    }
    if (!__report && __strat) {
      var __rd = __strat.reportData();
      if (__rd && typeof __rd.value === 'function') __rd = __rd.value();
      __report = __rd || null;
    }
  `;

const NO_STRATEGY_ERROR = 'No strategy found on chart. Add a strategy (Pine script with strategy() declaration) first.';

// ── Shared shaping helpers (exported for tests) ──────────────────────────

/** Convert a report trade ({e,x,q,tp,cp,rn,dd,v}) to friendly fields. Times are ms. */
export function mapTrade(t, index) {
  const point = (p) => p ? { name: p.c, price: p.p, time: p.tm, bar: p.b } : null;
  const pct = (m) => m && typeof m.p === 'number' ? +(m.p * 100).toFixed(4) : null;
  const val = (m) => m && typeof m.v === 'number' ? m.v : null;
  return {
    index,
    side: t.e && typeof t.e.tp === 'string' && t.e.tp.charAt(0) === 's' ? 'short' : 'long',
    entry: point(t.e),
    exit: point(t.x),
    open: !t.x,
    qty: t.q,
    profit: val(t.tp), profit_pct: pct(t.tp),
    cum_profit: val(t.cp), cum_profit_pct: pct(t.cp),
    runup: val(t.rn), runup_pct: pct(t.rn),
    drawdown: val(t.dd), drawdown_pct: pct(t.dd),
  };
}

/** Aggregate stats over mapped trades. */
export function summarizeTrades(trades) {
  const closed = trades.filter((t) => !t.open && typeof t.profit === 'number');
  const wins = closed.filter((t) => t.profit > 0);
  const losses = closed.filter((t) => t.profit < 0);
  const side = (s) => {
    const st = closed.filter((t) => t.side === s);
    return { count: st.length, wins: st.filter((t) => t.profit > 0).length, net_profit: +st.reduce((a, t) => a + t.profit, 0).toFixed(2) };
  };
  const sum = (arr) => arr.reduce((a, t) => a + t.profit, 0);
  return {
    total: trades.length,
    open: trades.length - closed.length,
    wins: wins.length,
    losses: losses.length,
    win_rate_pct: closed.length ? +((wins.length / closed.length) * 100).toFixed(2) : null,
    net_profit: +sum(closed).toFixed(2),
    gross_profit: +sum(wins).toFixed(2),
    gross_loss: +sum(losses).toFixed(2),
    avg_profit: closed.length ? +(sum(closed) / closed.length).toFixed(2) : null,
    best_trade: wins.length ? Math.max(...wins.map((t) => t.profit)) : null,
    worst_trade: losses.length ? Math.min(...losses.map((t) => t.profit)) : null,
    long: side('long'),
    short: side('short'),
    first_entry: trades.length && trades[0].entry ? trades[0].entry.time : null,
    last_exit: closed.length && closed[closed.length - 1].exit ? closed[closed.length - 1].exit.time : null,
  };
}

/** Uniformly downsample an array to max_points, always keeping first and last. */
export function downsample(points, maxPoints) {
  if (!maxPoints || points.length <= maxPoints) return points;
  const out = [];
  const step = (points.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) out.push(points[Math.round(i * step)]);
  return out;
}

/** Convert fraction-percent metric fields to percentages for readability. */
export function shapeMetrics(perf) {
  if (!perf || typeof perf !== 'object') return {};
  const shapeBucket = (b) => {
    if (!b || typeof b !== 'object') return b;
    const out = {};
    for (const [k, v] of Object.entries(b)) {
      if (v === null || v === undefined || typeof v === 'function' || typeof v === 'object') continue;
      out[k] = (typeof v === 'number' && (/Percent$/.test(k) || k === 'percentProfitable')) ? +(v * 100).toFixed(4) : v;
    }
    return out;
  };
  const out = { all: shapeBucket(perf.all), long: shapeBucket(perf.long), short: shapeBucket(perf.short) };
  for (const [k, v] of Object.entries(perf)) {
    if (['all', 'long', 'short'].includes(k) || v === null || v === undefined || typeof v === 'object' || typeof v === 'function') continue;
    out[k] = (typeof v === 'number' && /Percent$/.test(k)) ? +(v * 100).toFixed(4) : v;
  }
  return out;
}

/** Cartesian product of a {key: values[]} grid. */
export function gridCombos(grid) {
  const keys = Object.keys(grid);
  let combos = [{}];
  for (const key of keys) {
    const values = grid[key];
    const next = [];
    for (const combo of combos) for (const v of values) next.push({ ...combo, [key]: v });
    combos = next;
  }
  return combos;
}

// ── Report / trades / equity ─────────────────────────────────────────────

export async function getStrategyResults({ entity_id, title, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const raw = await evaluate(`
    (function() {
      try {
        ${findStrategySnippet(entity_id, title)}
        if (!__strat) return { error: ${JSON.stringify(NO_STRATEGY_ERROR)}, available_strategies: __stratNames };
        ${READ_REPORT_SNIPPET}
        if (!__report) {
          var st = null;
          try { st = __strat.status(); if (st && typeof st.value === 'function') st = st.value(); } catch (e) {}
          return { error: 'Strategy has no report yet' + (st && st.errorDescription ? ' (status: ' + (st.errorDescription.error || 'error') + ')' : ''), status: st ? st.type : null };
        }
        return {
          entity_id: __strat.id(),
          name: __strat.metaInfo().shortDescription,
          source: __reportSource,
          currency: __report.currency,
          date_range: __report.settings ? __report.settings.dateRange : null,
          performance: __report.performance,
          trade_count: __report.trades ? __report.trades.length : 0,
        };
      } catch (e) { return { error: e.message }; }
    })()
  `);
  if (raw?.error) {
    const names = Array.isArray(raw.available_strategies) ? raw.available_strategies.filter(Boolean) : [];
    throw new Error(names.length ? `${raw.error} Strategies on chart: ${names.join(', ')}.` : raw.error);
  }
  const metrics = shapeMetrics(raw.performance);
  return {
    success: true,
    entity_id: raw.entity_id,
    strategy: raw.name,
    source: raw.source,
    currency: raw.currency,
    date_range: raw.date_range,
    trade_count: raw.trade_count,
    metrics,
    note: 'Percent fields converted to percentages (3.6 = 3.6%). date_range times are unix ms.',
  };
}

export async function getTrades({ entity_id, max_trades, offset, summary, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const raw = await evaluate(`
    (function() {
      try {
        ${findStrategySnippet(entity_id)}
        if (!__strat) return { error: ${JSON.stringify(NO_STRATEGY_ERROR)} };
        ${READ_REPORT_SNIPPET}
        if (!__report || !Array.isArray(__report.trades)) return { error: 'Strategy has no trade data yet.' };
        return { source: __reportSource, trades: __report.trades };
      } catch (e) { return { error: e.message }; }
    })()
  `);
  if (raw?.error) throw new Error(raw.error);

  const all = (raw.trades || []).map(mapTrade);
  if (summary) {
    return { success: true, source: raw.source, summary: summarizeTrades(all) };
  }
  const limit = Math.min(max_trades || DEFAULT_TRADES, MAX_TRADES_LIMIT);
  const off = Math.max(0, offset || 0);
  // offset counts back from the most recent trade; window returned in chronological order
  const end = Math.max(0, all.length - off);
  const start = Math.max(0, end - limit);
  return {
    success: true,
    source: raw.source,
    total_trades: all.length,
    returned: end - start,
    window: { from_index: start, to_index: end - 1 },
    note: 'Most recent trades unless offset is set (offset counts back from the latest trade). Times are unix ms. Pass summary=true for aggregate stats.',
    trades: all.slice(start, end),
  };
}

export async function getEquity({ entity_id, max_points, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const raw = await evaluate(`
    (function() {
      try {
        ${findStrategySnippet(entity_id)}
        if (!__strat) return { error: ${JSON.stringify(NO_STRATEGY_ERROR)} };
        ${READ_REPORT_SNIPPET}
        if (!__report || !Array.isArray(__report.trades)) return { error: 'Strategy has no report data yet.' };
        var cap = null;
        try {
          var inputs = __chartApi.getStudyById(__strat.id()).getInputValues();
          var metaInputs = __strat.metaInfo().inputs || [];
          for (var i = 0; i < metaInputs.length; i++) {
            if (metaInputs[i].internalID === 'initial_capital') {
              for (var j = 0; j < inputs.length; j++) if (inputs[j].id === metaInputs[i].id) cap = inputs[j].value;
            }
          }
        } catch (e) {}
        return { source: __reportSource, trades: __report.trades, buyHold: __report.buyHold || null, initialCapital: cap };
      } catch (e) { return { error: e.message }; }
    })()
  `);
  if (raw?.error) throw new Error(raw.error);

  const cap = typeof raw.initialCapital === 'number' ? raw.initialCapital : 0;
  const buyHold = Array.isArray(raw.buyHold) ? raw.buyHold : [];
  // Equity after each closed trade: initial capital + cumulative profit.
  // buyHold[i] aligns to the state after trade i-1 (index 0 = initial).
  const points = [];
  points.push({ time: null, trade_index: null, equity: cap || (buyHold.length ? buyHold[0] : null), buy_hold: buyHold.length ? buyHold[0] : null });
  (raw.trades || []).forEach((t, i) => {
    if (!t.x || !t.cp) return;
    points.push({
      time: t.x.tm,
      trade_index: i,
      equity: cap ? +(cap + t.cp.v).toFixed(2) : +t.cp.v.toFixed(2),
      buy_hold: buyHold.length > i + 1 ? buyHold[i + 1] : null,
    });
  });
  const closed = points.slice(1);
  const peakDD = closed.reduce((acc, p) => {
    acc.peak = Math.max(acc.peak, p.equity);
    acc.maxDD = Math.max(acc.maxDD, acc.peak - p.equity);
    return acc;
  }, { peak: points[0].equity || 0, maxDD: 0 });
  const sampled = downsample(points, max_points || 100);
  return {
    success: true,
    source: raw.source,
    initial_capital: cap || null,
    final_equity: closed.length ? closed[closed.length - 1].equity : null,
    max_drawdown: closed.length ? +peakDD.maxDD.toFixed(2) : null,
    total_points: points.length,
    returned_points: sampled.length,
    note: cap ? 'Equity = initial capital + cumulative closed-trade profit, one point per closed trade. Times are unix ms.'
      : 'Initial capital unavailable; equity column shows cumulative closed-trade profit only.',
    points: sampled,
  };
}

// ── Strategy properties ──────────────────────────────────────────────────

export async function getProperties({ entity_id, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const raw = await evaluate(`
    (function() {
      try {
        ${findStrategySnippet(entity_id)}
        if (!__strat) return { error: ${JSON.stringify(NO_STRATEGY_ERROR)} };
        var metaInputs = __strat.metaInfo().inputs || [];
        var values = {};
        __chartApi.getStudyById(__strat.id()).getInputValues().forEach(function(v) { values[v.id] = v.value; });
        var props = {};
        metaInputs.forEach(function(inp) {
          if (inp.groupId === 'strategy_props' && inp.internalID && inp.internalID.charAt(0) !== '_' && !inp.isHidden) {
            props[inp.internalID] = { value: values[inp.id], type: inp.type, options: inp.options || undefined };
          }
        });
        return { entity_id: __strat.id(), name: __strat.metaInfo().shortDescription, properties: props };
      } catch (e) { return { error: e.message }; }
    })()
  `);
  if (raw?.error) throw new Error(raw.error);
  return { success: true, entity_id: raw.entity_id, strategy: raw.name, properties: raw.properties };
}

/**
 * Wait-for-recalc page snippet: subscribes to reportChanged, watches status,
 * applies `applyExpr`, resolves { event: 'report_changed'|'completed'|'error'|'timeout' }.
 */
function waitRecalcSnippet(applyExpr, timeoutMs) {
  return `(new Promise(function(resolve) {
      var done = false, sawLoading = false;
      function finish(r) {
        if (done) return; done = true;
        try { __strat.reportChanged().unsubscribe(null, onRep); } catch (e) {}
        clearInterval(iv); clearTimeout(tm);
        setTimeout(function() { resolve(r); }, 150);
      }
      function onRep() { finish({ event: 'report_changed' }); }
      try { __strat.reportChanged().subscribe(null, onRep); } catch (e) {}
      var iv = setInterval(function() {
        var st = null;
        try { st = __strat.status(); if (st && typeof st.value === 'function') st = st.value(); } catch (e) {}
        if (!st) return;
        if (st.type === ${STUDY_STATUS.LOADING}) sawLoading = true;
        else if (st.type === ${STUDY_STATUS.ERROR}) finish({ event: 'error', error: (st.errorDescription && st.errorDescription.error) || 'strategy error' });
        else if (sawLoading && st.type === ${STUDY_STATUS.COMPLETED}) finish({ event: 'completed' });
      }, 250);
      var tm = setTimeout(function() { finish({ event: 'timeout' }); }, ${timeoutMs});
      ${applyExpr}
    }))`;
}

export async function setProperties({ entity_id, properties: propsRaw, timeout_ms, _deps } = {}) {
  const { evaluateAsync } = _resolve(_deps);
  const properties = propsRaw ? (typeof propsRaw === 'string' ? JSON.parse(propsRaw) : propsRaw) : undefined;
  if (!properties || typeof properties !== 'object' || Object.keys(properties).length === 0) {
    throw new Error(`properties must be a non-empty object, e.g. { initial_capital: 100000, commission_value: 0.05 }. Settable: ${Object.keys(STRATEGY_PROPERTY_IDS).join(', ')}`);
  }
  const unknown = Object.keys(properties).filter((k) => !(k in STRATEGY_PROPERTY_IDS));
  if (unknown.length) throw new Error(`Unknown strategy properties: ${unknown.join(', ')}. Settable: ${Object.keys(STRATEGY_PROPERTY_IDS).join(', ')}`);

  const result = await evaluateAsync(`
    (function() {
      try {
        ${findStrategySnippet(entity_id)}
        if (!__strat) return Promise.resolve({ error: ${JSON.stringify(NO_STRATEGY_ERROR)} });
        var overrides = ${JSON.stringify(properties)};
        var metaInputs = __strat.metaInfo().inputs || [];
        var idByInternal = {};
        metaInputs.forEach(function(inp) { if (inp.internalID) idByInternal[inp.internalID] = inp.id; });
        var missing = Object.keys(overrides).filter(function(k) { return !idByInternal[k]; });
        if (missing.length) return Promise.resolve({ error: 'Strategy does not expose: ' + missing.join(', ') });
        var facade = __chartApi.getStudyById(__strat.id());
        var inputs = facade.getInputValues();
        var applied = {};
        Object.keys(overrides).forEach(function(k) {
          var id = idByInternal[k];
          for (var i = 0; i < inputs.length; i++) if (inputs[i].id === id) { inputs[i].value = overrides[k]; applied[k] = overrides[k]; }
        });
        return ${waitRecalcSnippet('facade.setInputValues(inputs);', '__TIMEOUT__')}.then(function(w) {
          return { applied: applied, wait: w };
        });
      } catch (e) { return Promise.resolve({ error: e.message }); }
    })()
  `.replace('__TIMEOUT__', String(timeout_ms || 30000)));

  if (result?.error) throw new Error(result.error);
  if (result?.wait?.event === 'error') throw new Error(`Properties applied but recalculation failed: ${result.wait.error}`);
  return {
    success: true,
    applied: result.applied,
    recalculated: result?.wait?.event !== 'timeout',
    ...(result?.wait?.event === 'timeout' ? { warning: 'Recalculation did not signal completion within the timeout — results may still be updating.' } : {}),
  };
}

// ── Backtest date range (deep backtesting) ───────────────────────────────

function parseDateMs(v, name) {
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000; // accept unix s or ms
  const ts = new Date(v).getTime();
  if (isNaN(ts)) throw new Error(`Invalid ${name}: "${v}". Use ISO format (YYYY-MM-DD) or a unix timestamp.`);
  return ts;
}

export function resolveOptimizeRange({ range_preset, range_from, range_to, now_ms = Date.now() } = {}) {
  if (!range_preset && !range_from && !range_to) return null;
  if (range_preset && (range_from || range_to)) {
    throw new Error('Pass range_preset or range_from+range_to, not both.');
  }
  let fromMs, toMs;
  if (range_preset) {
    if (range_preset === 'entire_history') {
      fromMs = Date.UTC(1990, 0, 1);
      toMs = now_ms;
    } else if (RANGE_PRESETS[range_preset]) {
      toMs = now_ms;
      fromMs = toMs - RANGE_PRESETS[range_preset] * 86400e3;
    } else {
      throw new Error(`Unknown range_preset "${range_preset}". Valid: ${Object.keys(RANGE_PRESETS).join(', ')}, entire_history`);
    }
  } else {
    if (!range_from || !range_to) throw new Error('Pass both range_from and range_to.');
    fromMs = parseDateMs(range_from, 'range_from');
    toMs = parseDateMs(range_to, 'range_to');
    if (fromMs >= toMs) throw new Error('range_from must be earlier than range_to.');
  }
  return { fromMs, toMs };
}

export async function setBacktestRange({ action, from, to, preset, timeout_ms, _deps } = {}) {
  const { evaluate, evaluateAsync } = _resolve(_deps);

  if (action === 'reset') {
    const res = await evaluateAsync(`
      (function() {
        if (!window.__tvmcpDeep || !window.__tvmcpDeep.facade) return Promise.resolve({ was_active: false });
        var f = window.__tvmcpDeep.facade;
        try { f.setReportDataSource(false); f.resetDeepBacktestingReportData(); } catch (e) { return Promise.resolve({ error: e.message }); }
        window.__tvmcpDeep.active = false;
        return Promise.resolve({ was_active: true });
      })()
    `);
    if (res?.error) throw new Error(res.error);
    return { success: true, action: 'reset', was_active: !!res.was_active, note: 'Strategy report tools now read the standard chart backtest again.' };
  }

  let fromMs, toMs;
  if (preset) {
    if (preset === 'entire_history') {
      fromMs = Date.UTC(1990, 0, 1);
      toMs = Date.now();
    } else if (RANGE_PRESETS[preset]) {
      toMs = Date.now();
      fromMs = toMs - RANGE_PRESETS[preset] * 86400e3;
    } else {
      throw new Error(`Unknown preset "${preset}". Valid: ${Object.keys(RANGE_PRESETS).join(', ')}, entire_history`);
    }
  } else {
    if (!from || !to) throw new Error('Pass from and to (ISO dates or unix timestamps), or a preset (last_7d, last_30d, last_90d, last_365d, entire_history), or action="reset".');
    fromMs = parseDateMs(from, 'from');
    toMs = parseDateMs(to, 'to');
    if (fromMs >= toMs) throw new Error('from must be earlier than to.');
  }

  // Sanity: a strategy must be on the chart
  const check = await evaluate(`
    (function() {
      ${findStrategySnippet(undefined)}
      return { has_strategy: !!__strat };
    })()
  `);
  if (!check?.has_strategy) throw new Error(NO_STRATEGY_ERROR);

  const result = await evaluateAsync(`
    (function() {
      return window.TradingViewApi.backtestingStrategyApi().then(function(facade) {
        window.__tvmcpDeep = { active: true, facade: facade };
        facade.setReportDataSource(true);
        facade.requestDeepBacktestingData(${fromMs}, ${toMs});
        return new Promise(function(resolve) {
          var t0 = Date.now();
          var iv = setInterval(function() {
            var st = null;
            try { st = facade.activeStrategyStatus.value(); } catch (e) {}
            var type = st && st.type;
            if (type === ${STUDY_STATUS.COMPLETED}) {
              clearInterval(iv);
              var rd = null;
              try { rd = facade.activeStrategyReportData.value(); } catch (e) {}
              resolve({
                completed: true,
                trade_count: rd && rd.trades ? rd.trades.length : null,
                date_range: rd && rd.settings ? rd.settings.dateRange : null,
                net_profit: rd && rd.performance && rd.performance.all ? rd.performance.all.netProfit : null,
              });
            } else if (type === ${STUDY_STATUS.ERROR}) {
              clearInterval(iv);
              window.__tvmcpDeep.active = false;
              try { facade.setReportDataSource(false); } catch (e) {}
              resolve({ completed: false, error: (st.errorDescription && st.errorDescription.error) || 'deep backtest error' });
            } else if (Date.now() - t0 > ${timeout_ms || 60000}) {
              clearInterval(iv);
              resolve({ completed: false, error: 'Timed out waiting for the deep backtest report.' });
            }
          }, 400);
        });
      }).catch(function(e) { return { completed: false, error: e.message }; });
    })()
  `);

  if (!result?.completed) throw new Error(result?.error || 'Deep backtest failed.');
  return {
    success: true,
    requested_range: { from: fromMs, to: toMs },
    actual_range: result.date_range,
    trade_count: result.trade_count,
    net_profit: result.net_profit,
    note: 'Deep backtest active: data_get_strategy_results / data_get_trades / data_get_equity now read this report. Use action="reset" to return to the standard chart backtest. Times are unix ms.',
  };
}

// ── Parameter sweep ──────────────────────────────────────────────────────

function shapeOptimizerDiagnostics(raw, initialCapital) {
  const rawTrades = Array.isArray(raw?.trades) ? raw.trades : [];
  const trades = rawTrades.map(mapTrade);
  const cap = typeof initialCapital === 'number' ? initialCapital : 0;
  const buyHold = Array.isArray(raw?.buyHold) ? raw.buyHold : [];
  const points = [{ time: null, trade_index: null, equity: cap || (buyHold[0] ?? null), buy_hold: buyHold[0] ?? null }];
  rawTrades.forEach((trade, index) => {
    if (!trade.x || !trade.cp) return;
    points.push({
      time: trade.x.tm,
      trade_index: index,
      equity: cap ? +(cap + trade.cp.v).toFixed(2) : +trade.cp.v.toFixed(2),
      buy_hold: buyHold[index + 1] ?? null,
    });
  });
  return {
    trade_summary: summarizeTrades(trades),
    recent_trades: trades.slice(-50),
    equity: {
      initial_capital: cap || null,
      final_equity: points.length > 1 ? points.at(-1).equity : null,
      total_points: points.length,
      points: downsample(points, 100),
    },
  };
}

export async function optimize({ entity_id, grid: gridRaw, metric, max_combinations, timeout_ms, range_preset, range_from, range_to, diagnostics, retain_inputs, _deps } = {}) {
  const { evaluate, evaluateAsync } = _resolve(_deps);
  const grid = gridRaw ? (typeof gridRaw === 'string' ? JSON.parse(gridRaw) : gridRaw) : undefined;
  if (!grid || typeof grid !== 'object' || Object.keys(grid).length === 0) {
    throw new Error('grid must be a non-empty object mapping input name/id to an array of values, e.g. { "Swing length": [30, 50, 70], "in_6": [1.5, 2, 2.5] }');
  }
  for (const [k, v] of Object.entries(grid)) {
    if (!Array.isArray(v) || v.length === 0) throw new Error(`grid["${k}"] must be a non-empty array of values.`);
  }

  const rankMetric = metric || 'netProfit';
  const cap = Math.min(max_combinations || OPTIMIZE_DEFAULT_COMBOS, OPTIMIZE_MAX_COMBOS);
  const perRunTimeout = timeout_ms || 45000;
  const range = resolveOptimizeRange({ range_preset, range_from, range_to });

  // Resolve the strategy's inputs, matching grid keys by id, internalID, or name.
  const meta = await evaluate(`
    (function() {
      try {
        ${findStrategySnippet(entity_id)}
        if (!__strat) return { error: ${JSON.stringify(NO_STRATEGY_ERROR)} };
        var values = {};
        __chartApi.getStudyById(__strat.id()).getInputValues().forEach(function(v) { values[v.id] = v.value; });
        return {
          entity_id: __strat.id(),
          name: __strat.metaInfo().shortDescription,
          inputs: (__strat.metaInfo().inputs || []).map(function(inp) {
            return { id: inp.id, name: inp.name, internalID: inp.internalID, type: inp.type, current: values[inp.id] };
          }),
        };
      } catch (e) { return { error: e.message }; }
    })()
  `);
  if (meta?.error) throw new Error(meta.error);

  const resolveKey = (key) => {
    const lk = String(key).toLowerCase();
    const hit = meta.inputs.find((i) => i.id === key || i.internalID === key || (i.name && i.name.toLowerCase() === lk));
    if (!hit) throw new Error(`No strategy input matches "${key}". Available: ${meta.inputs.filter((i) => /^in_\d+$/.test(i.id)).map((i) => `${i.id} ("${i.name}")`).join(', ')}`);
    return hit;
  };
  const resolvedGrid = {};
  const originals = {};
  for (const [key, values] of Object.entries(grid)) {
    const input = resolveKey(key);
    resolvedGrid[input.id] = { label: input.name || input.id, values };
    originals[input.id] = input.current;
  }

  const combos = gridCombos(Object.fromEntries(Object.entries(resolvedGrid).map(([id, g]) => [id, g.values])));
  if (combos.length > cap) {
    throw new Error(`Grid has ${combos.length} combinations — over the cap of ${cap}. Reduce the grid or raise max_combinations (hard cap ${OPTIMIZE_MAX_COMBOS}).`);
  }
  if ((diagnostics || retain_inputs) && combos.length !== 1) {
    throw new Error('diagnostics and retain_inputs require exactly one parameter combination.');
  }
  const initialCapital = meta.inputs.find((input) => input.internalID === 'initial_capital')?.current;

  const runCombo = async (overrides, applyRange = true, captureDiagnostics = false) => evaluateAsync(`
    (function() {
      try {
        ${findStrategySnippet(entity_id)}
        if (!__strat) return Promise.resolve({ error: ${JSON.stringify(NO_STRATEGY_ERROR)} });
        var facade = __chartApi.getStudyById(__strat.id());
        var inputs = facade.getInputValues();
        var overrides = ${JSON.stringify(overrides)};
        for (var i = 0; i < inputs.length; i++) {
          if (overrides.hasOwnProperty(inputs[i].id)) inputs[i].value = overrides[inputs[i].id];
        }
        return ${waitRecalcSnippet('facade.setInputValues(inputs);', String(perRunTimeout))}.then(function(w) {
          if (w.event === 'error') return { error: w.error || 'strategy error' };
          if (w.event === 'timeout') return { error: 'recalculation timed out' };
          ${range ? `
          if (${applyRange ? 'true' : 'false'}) {
            return window.TradingViewApi.backtestingStrategyApi().then(function(deep) {
              window.__tvmcpDeep = { active: true, facade: deep };
              deep.setReportDataSource(true);
              deep.requestDeepBacktestingData(${range.fromMs}, ${range.toMs});
              return new Promise(function(resolve) {
                var t0 = Date.now();
                var iv = setInterval(function() {
                  var st = null;
                  try { st = deep.activeStrategyStatus.value(); } catch (e) {}
                  if (st && st.type === ${STUDY_STATUS.COMPLETED}) {
                    clearInterval(iv);
                    var rd = null;
                    try { rd = deep.activeStrategyReportData.value(); } catch (e) {}
                    if (!rd || !rd.performance || !rd.performance.all) return resolve({ error: 'no deep report after recalculation' });
                    var a = rd.performance.all;
                    return resolve({ metrics: {
                      netProfit: a.netProfit,
                      netProfitPercent: a.netProfitPercent,
                      totalTrades: a.totalTrades,
                      percentProfitable: a.percentProfitable,
                      profitFactor: a.profitFactor,
                      maxStrategyDrawDown: rd.performance.maxStrategyDrawDown,
                      maxStrategyDrawDownPercent: rd.performance.maxStrategyDrawDownPercent,
                      sharpeRatio: rd.performance.sharpeRatio,
                      sortinoRatio: rd.performance.sortinoRatio,
                      avgTrade: a.avgTrade,
                    }, diagnostics: ${captureDiagnostics ? '{ trades: rd.trades || [], buyHold: rd.buyHold || [] }' : 'undefined'} });
                  }
                  if (st && st.type === ${STUDY_STATUS.ERROR}) {
                    clearInterval(iv);
                    return resolve({ error: (st.errorDescription && st.errorDescription.error) || 'deep backtest error' });
                  }
                  if (Date.now() - t0 > ${perRunTimeout}) {
                    clearInterval(iv);
                    return resolve({ error: 'deep backtest recalculation timed out' });
                  }
                }, 400);
              });
            }).catch(function(e) { return { error: e.message }; });
          }
          ` : ''}
          var rd = __strat.reportData();
          if (rd && typeof rd.value === 'function') rd = rd.value();
          if (!rd || !rd.performance || !rd.performance.all) return { error: 'no report after recalculation' };
          var a = rd.performance.all;
          return { metrics: {
            netProfit: a.netProfit,
            netProfitPercent: a.netProfitPercent,
            totalTrades: a.totalTrades,
            percentProfitable: a.percentProfitable,
            profitFactor: a.profitFactor,
            maxStrategyDrawDown: rd.performance.maxStrategyDrawDown,
            maxStrategyDrawDownPercent: rd.performance.maxStrategyDrawDownPercent,
            sharpeRatio: rd.performance.sharpeRatio,
            sortinoRatio: rd.performance.sortinoRatio,
            avgTrade: a.avgTrade,
          }, diagnostics: ${captureDiagnostics ? '{ trades: rd.trades || [], buyHold: rd.buyHold || [] }' : 'undefined'} };
        });
      } catch (e) { return Promise.resolve({ error: e.message }); }
    })()
  `);

  const results = [];
  let restored = false;
  try {
    for (const combo of combos) {
      const labeled = Object.fromEntries(Object.entries(combo).map(([id, v]) => [resolvedGrid[id].label, v]));
      const run = await runCombo(combo, true, !!diagnostics);
      if (run?.error) {
        results.push({ inputs: labeled, error: run.error });
      } else {
        const m = run.metrics;
        results.push({
          inputs: labeled,
          metrics: {
            ...m,
            netProfitPercent: typeof m.netProfitPercent === 'number' ? +(m.netProfitPercent * 100).toFixed(4) : m.netProfitPercent,
            percentProfitable: typeof m.percentProfitable === 'number' ? +(m.percentProfitable * 100).toFixed(4) : m.percentProfitable,
            maxStrategyDrawDownPercent: typeof m.maxStrategyDrawDownPercent === 'number' ? +(m.maxStrategyDrawDownPercent * 100).toFixed(4) : m.maxStrategyDrawDownPercent,
          },
          ...(run.diagnostics ? { diagnostics: shapeOptimizerDiagnostics(run.diagnostics, initialCapital) } : {}),
        });
      }
    }
  } finally {
    // Always restore original inputs unless the singleton caller explicitly owns restoration.
    if (!retain_inputs) {
      try {
        await runCombo(originals, false);
        restored = true;
      } catch { /* reported below */ }
    }
    if (range) {
      try {
        await evaluateAsync(`
          (function() {
            if (!window.__tvmcpDeep || !window.__tvmcpDeep.facade) return Promise.resolve({ reset: false });
            var f = window.__tvmcpDeep.facade;
            try { f.setReportDataSource(false); f.resetDeepBacktestingReportData(); } catch (e) {}
            window.__tvmcpDeep.active = false;
            return Promise.resolve({ reset: true });
          })()
        `);
      } catch { /* best effort */ }
    }
  }

  const ok = results.filter((r) => r.metrics);
  const lowerIsBetter = /drawdown/i.test(rankMetric);
  ok.sort((a, b) => {
    const av = a.metrics[rankMetric], bv = b.metrics[rankMetric];
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    return lowerIsBetter ? av - bv : bv - av;
  });

  return {
    success: true,
    strategy: meta.name,
    combinations_tested: results.length,
    failed: results.length - ok.length,
    ranked_by: rankMetric + (lowerIsBetter ? ' (ascending)' : ' (descending)'),
    best: ok[0] || null,
    results: ok.concat(results.filter((r) => r.error)),
    inputs_restored: restored,
    inputs_retained: !!retain_inputs,
    backtest_range: range ? { from: range.fromMs, to: range.toMs, mode: 'deep' } : { mode: 'standard_chart' },
    ...(!restored && !retain_inputs ? { warning: 'Failed to restore original input values — check the strategy settings.' } : {}),
    note: retain_inputs ? 'Percent metrics converted to percentages. Evaluated inputs remain active; caller must restore them.' : 'Percent metrics converted to percentages. Original inputs were restored after the sweep.',
  };
}
