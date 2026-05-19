/**
 * Core screener query logic — talks directly to TradingView's public scanner
 * REST endpoint (https://scanner.tradingview.com/<market>/scan) by running
 * fetch() inside the page context via CDP. This bypasses the UI dialog
 * entirely, so it works even when the floating Screener won't open.
 *
 * Why fetch() in-page (not from Node): the page already carries TradingView
 * auth cookies, and Electron's CSP is friendlier to same-org requests
 * originating from the loaded page than to external HTTP from the MCP server.
 *
 * Why Content-Type: text/plain: scanner.tradingview.com doesn't handle CORS
 * preflight (OPTIONS). Using "text/plain" keeps the request "simple" per the
 * Fetch spec and skips preflight. Body is still JSON — TV's server doesn't
 * care about the declared content type.
 */
import { evaluate, evaluateAsync, safeString } from '../connection.js';

const SCANNER_BASE = 'https://scanner.tradingview.com';

// Curated market slugs. The endpoint accepts more (every TV-supported
// market has one), but these are the ones we've verified or that users will
// realistically ask for. Pass-through for anything else — server returns
// 404 for invalid slugs, which surfaces as a clean error.
export const KNOWN_MARKETS = [
  'america', 'india', 'crypto', 'forex', 'coin',
  'uk', 'germany', 'france', 'japan', 'china',
  'hongkong', 'korea', 'taiwan', 'australia', 'canada',
  'brazil', 'russia', 'turkey', 'singapore', 'switzerland',
  'options', 'futures', 'bonds', 'cfd', 'economics2',
];

// Default columns when caller doesn't specify. Matches what the UI dialog
// shows by default for stock screeners.
const DEFAULT_COLUMNS = [
  'name', 'close', 'change', 'volume', 'market_cap_basic', 'sector',
];

// Hard cap to match the rest of this repo's conventions.
const MAX_RANGE = 500;

/**
 * Map a TradingView symbol's exchange prefix to a scanner market slug.
 * Falls back to "america" — the largest universe — if nothing matches.
 */
function exchangeToMarket(symbol) {
  if (!symbol) return 'america';
  const exch = String(symbol).split(':')[0]?.toUpperCase() || '';
  const map = {
    'NSE': 'india', 'BSE': 'india',
    'NASDAQ': 'america', 'NYSE': 'america', 'AMEX': 'america', 'OTC': 'america',
    'BINANCE': 'crypto', 'COINBASE': 'crypto', 'KUCOIN': 'crypto', 'BYBIT': 'crypto', 'OKX': 'crypto',
    'FX_IDC': 'forex', 'OANDA': 'forex', 'FOREXCOM': 'forex',
    'LSE': 'uk', 'LSIN': 'uk',
    'FWB': 'germany', 'XETR': 'germany',
    'EURONEXT': 'france',
    'TSE': 'japan', 'TSX': 'canada',
    'HKEX': 'hongkong', 'SSE': 'china', 'SZSE': 'china',
    'KRX': 'korea', 'TWSE': 'taiwan',
    'ASX': 'australia',
    'BMFBOVESPA': 'brazil', 'MOEX': 'russia', 'BIST': 'turkey', 'SGX': 'singapore', 'SIX': 'switzerland',
  };
  return map[exch] || 'america';
}

/**
 * Get the current chart symbol from the live TradingView page. Used for
 * market auto-detection when the caller doesn't specify one.
 */
async function getCurrentSymbol() {
  try {
    return await evaluate(`window.TradingViewApi._activeChartWidgetWV.value().symbol()`);
  } catch {
    return null;
  }
}

/**
 * Run a screener query.
 *
 * @param {object} opts
 * @param {string} [opts.market]    Market slug (america, india, crypto, ...).
 *                                  Defaults to the current chart's exchange.
 * @param {string[]} [opts.columns] Column fields to fetch. Defaults to
 *                                  name/close/change/volume/mkt_cap/sector.
 * @param {Array} [opts.filter]     Filter clauses: [{left, operation, right}].
 *                                  AND'd together. See FILTER_OPERATIONS.
 * @param {object} [opts.sort]      {sortBy, sortOrder: 'asc'|'desc'}.
 * @param {number[]} [opts.range]   [start, end]. Capped at 500 rows.
 * @returns {Promise<{success, market, total, count, columns, rows}>}
 */
export async function query(opts = {}) {
  const {
    market: marketArg,
    columns = DEFAULT_COLUMNS,
    filter = [],
    sort = null,
    range = [0, 100],
  } = opts;

  // Auto-detect market from current chart if not specified.
  let market = marketArg;
  if (!market) {
    const sym = await getCurrentSymbol();
    market = exchangeToMarket(sym);
  }

  // Range validation: clamp to [0, MAX_RANGE] window.
  let [start, end] = Array.isArray(range) ? range : [0, 100];
  start = Math.max(0, Number(start) || 0);
  end = Math.min(start + MAX_RANGE, Math.max(start, Number(end) || start + 100));

  const body = {
    columns: Array.isArray(columns) && columns.length ? columns : DEFAULT_COLUMNS,
    range: [start, end],
  };
  if (Array.isArray(filter) && filter.length) body.filter = filter;
  if (sort && sort.sortBy) {
    body.sort = {
      sortBy: String(sort.sortBy),
      sortOrder: sort.sortOrder === 'asc' ? 'asc' : 'desc',
    };
  }

  // Build the in-page fetch expression. JSON.stringify gives us a safe
  // JS string literal we can embed (no manual escaping needed).
  const url = `${SCANNER_BASE}/${encodeURIComponent(market)}/scan`;
  const expr = `
    (async function() {
      try {
        const r = await fetch(${safeString(url)}, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: ${safeString(JSON.stringify(body))}
        });
        const text = await r.text();
        let json = null;
        try { json = JSON.parse(text); } catch (e) {}
        return {
          ok: r.ok,
          status: r.status,
          contentType: r.headers.get("content-type"),
          body: json,
          textPreview: json ? null : text.slice(0, 400)
        };
      } catch (e) {
        return { ok: false, fetchError: e.message };
      }
    })()
  `;

  const result = await evaluateAsync(expr);

  if (!result) {
    return { success: false, error: 'No response from scanner endpoint', market, body };
  }
  if (result.fetchError) {
    return { success: false, error: `Fetch failed: ${result.fetchError}`, market, body };
  }
  if (!result.ok) {
    return {
      success: false,
      error: `Scanner returned HTTP ${result.status}`,
      preview: result.textPreview,
      market,
      body,
    };
  }
  if (!result.body || !Array.isArray(result.body.data)) {
    return {
      success: false,
      error: 'Scanner response missing data array',
      raw: result.body,
      market,
      body,
    };
  }

  // Map positional values to {column: value} objects so consumers don't
  // have to remember which index is which.
  const cols = body.columns;
  const rows = result.body.data.map(row => {
    const obj = { symbol: row.s };
    for (let i = 0; i < cols.length; i++) {
      obj[cols[i]] = row.d?.[i] ?? null;
    }
    return obj;
  });

  return {
    success: true,
    market,
    total: result.body.totalCount ?? rows.length,
    count: rows.length,
    columns: ['symbol', ...cols],
    rows,
  };
}

// -----------------------------------------------------------------------------
// Fields catalog & filter operators — for the LLM (or human) to discover what
// it can query without trial-and-error. Curated, not exhaustive: there are
// thousands of fields on TV's scanner; these are the ones that show up in the
// default UI and that most users actually want.
// -----------------------------------------------------------------------------

export const FILTER_OPERATIONS = {
  greater: 'Numeric: left > right',
  egreater: 'Numeric: left >= right',
  less: 'Numeric: left < right',
  eless: 'Numeric: left <= right',
  equal: 'Equality (number or string)',
  nequal: 'Inequality',
  in_range: 'Numeric range: right is [min, max]',
  not_in_range: 'Inverse of in_range',
  match: 'String contains (case-insensitive)',
  nmatch: 'String does not contain',
  empty: 'Field is null/missing',
  nempty: 'Field has a value',
  crosses: 'Streaming-only: left crossed right since last bar',
  crosses_above: 'Streaming-only: left crossed above right',
  crosses_below: 'Streaming-only: left crossed below right',
  above: 'Streaming-only: left currently above right',
  below: 'Streaming-only: left currently below right',
  in_day_range: 'Within today\'s [min, max] range',
};

export const FIELDS_CATALOG = {
  // Identifiers
  name:               'Ticker symbol (e.g., "AAPL")',
  description:        'Company / instrument name',
  type:               'Instrument type: stock, etf, fund, dr, structured, ...',
  subtype:            'Subtype: common, preferred, etf, etn, ...',
  exchange:           'Exchange code (NASDAQ, NSE, BSE, ...)',

  // Price & change
  close:              'Last traded price',
  open:               'Today\'s open',
  high:               'Today\'s high',
  low:                'Today\'s low',
  change:             'Percent change vs previous close',
  change_abs:         'Absolute change vs previous close',
  gap:                'Today\'s gap percent vs prev close',

  // Volume / liquidity
  volume:             'Today\'s volume (shares/contracts)',
  'relative_volume_10d_calc': 'Today\'s volume / 10-day average',
  average_volume_10d_calc:    '10-day average volume',
  average_volume_30d_calc:    '30-day average volume',
  Value_Traded:       'Today\'s turnover (price × volume)',

  // Fundamentals — equities
  market_cap_basic:           'Market cap (USD-equivalent)',
  number_of_employees:        'Employee count',
  price_earnings_ttm:         'P/E ratio (trailing 12 months)',
  price_book_fq:              'P/B ratio (current quarter)',
  price_sales_current:        'P/S ratio',
  dividend_yield_recent:      'Dividend yield, recent annualized',
  earnings_per_share_basic_ttm:'EPS (trailing)',
  earnings_release_next_trading_date_fq:'Next earnings date (unix)',
  sector:                     'Sector (Finance, Technology, ...)',
  industry:                   'Industry sub-classification',

  // Performance / momentum
  Perf_W:             '1-week return %',
  Perf_1M:            '1-month return %',
  Perf_3M:            '3-month return %',
  Perf_6M:            '6-month return %',
  Perf_YTD:           'Year-to-date return %',
  Perf_Y:             '1-year return %',
  Perf_5Y:            '5-year return %',
  Volatility_W:       '1-week realized vol %',
  Volatility_M:       '1-month realized vol %',

  // Technicals
  RSI:                'Relative Strength Index (14)',
  RSI7:               'RSI(7)',
  Stoch_K:            'Stochastic %K',
  Stoch_D:            'Stochastic %D',
  MACD_macd:          'MACD line',
  MACD_signal:        'MACD signal line',
  MACD_Histogram:     'MACD histogram',
  ADX:                'Average Directional Index',
  ATR:                'Average True Range',
  AO:                 'Awesome Oscillator',
  CCI20:              'Commodity Channel Index (20)',
  BB_Lower:           'Bollinger lower band',
  BB_Upper:           'Bollinger upper band',
  SMA20:              'Simple moving average (20)',
  SMA50:              'Simple moving average (50)',
  SMA200:             'Simple moving average (200)',
  EMA20:              'Exponential moving average (20)',
  EMA50:              'Exponential moving average (50)',
  EMA200:             'Exponential moving average (200)',
  VWAP:               'Volume-weighted average price',

  // Composite signals (TV\'s built-in)
  Recommend_All:      'Overall recommendation [-1, 1] (1=strong buy)',
  Recommend_MA:       'Moving averages recommendation',
  Recommend_Other:    'Oscillators recommendation',

  // Crypto-specific
  '24h_vol|5':        '24h volume in quote currency',
  '24h_close_change|5':'24h % price change',
  market_cap_calc:    'Crypto market cap',
  circulating_supply: 'Circulating supply',
};
