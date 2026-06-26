/**
 * Core technical-analysis logic — reads indicator readings (oscillators, moving
 * averages, volatility) and TradingView's own buy/sell ratings for a single
 * symbol from the public scanner (scanner.tradingview.com/<market>/scan), via
 * the shared single-symbol helpers in _scanner.js.
 *
 * Freshness: scanner technicals are PERIODIC SNAPSHOTS (refreshed roughly per
 * minute during market hours), not tick-by-tick, and are subject to your data
 * subscription's exchange delay. For tick-accurate readings of an indicator
 * that's on the chart, use data_get_study_values instead. Verified live
 * 2026-06-26 against NASDAQ:AAPL.
 *
 * Timeframe: columns default to the DAILY bar. Other resolutions use a TV
 * suffix — intraday minutes "|60"/"|15", weekly "|1W", monthly "|1M". Daily has
 * no suffix. (Verified |60, |15, |1W live.)
 */
import { exchangeToMarket } from './screener_query.js';
import { resolveRow, getCurrentSymbol } from './_scanner.js';

// Base column names (no timeframe suffix). A suffix is appended per-request.
const TA_COLUMNS = [
  'close',
  // TradingView composite ratings, each in [-1, 1]
  'Recommend.All', 'Recommend.MA', 'Recommend.Other',
  // oscillators
  'RSI', 'RSI7', 'Stoch.K', 'Stoch.D', 'MACD.macd', 'MACD.signal', 'MACD.hist',
  'CCI20', 'AO', 'Mom', 'ADX',
  // moving averages
  'SMA20', 'SMA50', 'SMA200', 'EMA20', 'EMA50', 'EMA200', 'VWAP',
  // volatility
  'ATR', 'BB.upper', 'BB.lower',
];

/** Round to `dp` decimals; pass through null / non-finite as null. */
function round(v, dp = 2) {
  if (v == null || !Number.isFinite(Number(v))) return null;
  const f = 10 ** dp;
  return Math.round(Number(v) * f) / f;
}

/**
 * Map a TradingView recommendation score in [-1, 1] to its signal label,
 * using TV's own thresholds. Returns { score, signal } (score null-safe).
 */
function rating(score) {
  if (score == null || !Number.isFinite(Number(score))) return { score: null, signal: null };
  const s = Number(score);
  let signal;
  if (s >= 0.5) signal = 'Strong Buy';
  else if (s >= 0.1) signal = 'Buy';
  else if (s > -0.1) signal = 'Neutral';
  else if (s > -0.5) signal = 'Sell';
  else signal = 'Strong Sell';
  return { score: round(s, 3), signal };
}

/**
 * Normalise a timeframe token to a scanner column suffix + display label.
 * Follows TradingView resolution conventions: bare numbers are MINUTES ("1",
 * "60"); "D"/"W"/"M" are day/week/month. Returns null for unrecognised input.
 */
function timeframe(tf) {
  if (tf == null || tf === '') return { suffix: '', label: '1D' };
  const t = String(tf).trim().toUpperCase();
  const table = {
    '1': { suffix: '|1', label: '1m' },
    '5': { suffix: '|5', label: '5m' },
    '15': { suffix: '|15', label: '15m' },
    '30': { suffix: '|30', label: '30m' },
    '60': { suffix: '|60', label: '1h' }, '1H': { suffix: '|60', label: '1h' },
    '120': { suffix: '|120', label: '2h' }, '2H': { suffix: '|120', label: '2h' },
    '240': { suffix: '|240', label: '4h' }, '4H': { suffix: '|240', label: '4h' },
    '': { suffix: '', label: '1D' }, 'D': { suffix: '', label: '1D' }, '1D': { suffix: '', label: '1D' },
    'W': { suffix: '|1W', label: '1W' }, '1W': { suffix: '|1W', label: '1W' },
    'M': { suffix: '|1M', label: '1M' }, '1M': { suffix: '|1M', label: '1M' },
  };
  if (t in table) return table[t];
  if (/^\d+$/.test(t)) return { suffix: `|${t}`, label: `${t}m` };
  return null;
}

/**
 * Technical snapshot for one symbol, bucketed into rating / oscillators /
 * moving_averages / volatility. Auto-detects the symbol from the current chart
 * when not given. Snapshot data — see module note on freshness.
 *
 * @param {object} [opts]
 * @param {string} [opts.symbol]    Exchange-qualified symbol (e.g. "NASDAQ:AAPL").
 * @param {string} [opts.timeframe] Resolution: "1","5","15","60","240","D","W","M" (default daily).
 * @returns {Promise<{success, symbol, timeframe, ...}>}
 */
export async function technicals({ symbol, timeframe: tf } = {}) {
  const sym = symbol || await getCurrentSymbol();
  if (!sym) {
    return { success: false, error: 'No symbol given and no active chart symbol detected.' };
  }
  if (!String(sym).includes(':')) {
    return { success: false, error: `Symbol must be exchange-qualified (e.g. "NASDAQ:AAPL"); got "${sym}".` };
  }

  const tfSpec = timeframe(tf);
  if (!tfSpec) {
    return { success: false, error: `Unrecognised timeframe "${tf}". Use minutes ("1","5","15","60","240"), "D", "W" or "M".` };
  }

  // Append the timeframe suffix to every column ("RSI" → "RSI|60").
  const columns = TA_COLUMNS.map((c) => `${c}${tfSpec.suffix}`);
  const resolved = await resolveRow(exchangeToMarket(sym), sym, columns);
  if (!resolved) {
    return { success: false, symbol: sym, error: 'Scanner returned no row for this symbol — check it is exchange-qualified and tradable.' };
  }

  // Read values back by base name (strip the suffix we appended).
  const m = {};
  TA_COLUMNS.forEach((base) => { m[base] = resolved.map[`${base}${tfSpec.suffix}`]; });
  const resolvedSymbol = resolved.symbol;

  return {
    success: true,
    symbol: resolvedSymbol,
    ...(resolvedSymbol !== sym && { requested_symbol: sym }),
    timeframe: tfSpec.label,
    price: round(m.close),
    rating: {
      overall: rating(m['Recommend.All']),
      moving_averages: rating(m['Recommend.MA']),
      oscillators: rating(m['Recommend.Other']),
    },
    oscillators: {
      rsi: round(m.RSI),
      rsi7: round(m.RSI7),
      stoch_k: round(m['Stoch.K']),
      stoch_d: round(m['Stoch.D']),
      macd: round(m['MACD.macd'], 4),
      macd_signal: round(m['MACD.signal'], 4),
      macd_hist: round(m['MACD.hist'], 4),
      cci: round(m.CCI20),
      ao: round(m.AO, 4),
      momentum: round(m.Mom, 4),
      adx: round(m.ADX),
    },
    moving_averages: {
      sma20: round(m.SMA20),
      sma50: round(m.SMA50),
      sma200: round(m.SMA200),
      ema20: round(m.EMA20),
      ema50: round(m.EMA50),
      ema200: round(m.EMA200),
      vwap: round(m.VWAP),
    },
    volatility: {
      atr: round(m.ATR),
      bb_upper: round(m['BB.upper']),
      bb_lower: round(m['BB.lower']),
    },
  };
}
