/**
 * Core fundamental-analysis logic — reads company fundamentals (valuation,
 * profitability, growth, financial health, dividends, per-share metrics) for a
 * single symbol straight from TradingView's public scanner REST endpoint
 * (https://scanner.tradingview.com/<market>/scan), the same data path the
 * screener and F&O modules use. The request runs as an in-page fetch() over CDP
 * so it carries TV's auth cookies and dodges CSP/CORS.
 *
 * Why text/plain on a JSON body: keeps the request "simple" per the Fetch spec
 * so the browser skips the CORS preflight that scanner.tradingview.com doesn't
 * answer. TV's server ignores the declared content type.
 *
 * Column facts (verified live 2026-06-26 against NASDAQ:AAPL): margins, ROE/ROA/
 * ROIC, growth rates and dividend yields come back already in PERCENT (47.86 =
 * 47.86%). market_cap_basic / enterprise_value_fq are USD-equivalent absolutes.
 * earnings_release_next_date is a unix-seconds timestamp. The scanner returns
 * null for an unknown column rather than 400-ing, so the column list is safe to
 * extend.
 */
import { exchangeToMarket } from './screener_query.js';
import { resolveRow, getCurrentSymbol } from './_scanner.js';

// Columns pulled for the snapshot. Order is irrelevant here (we map by name),
// but every entry is verified to return a real value for a typical equity.
const COLUMNS = [
  'description', 'close', 'currency',
  // classification
  'sector', 'industry', 'number_of_employees',
  // valuation
  'market_cap_basic', 'enterprise_value_fq', 'price_earnings_ttm',
  'price_earnings_growth_ttm', 'price_book_fq', 'price_sales_ratio',
  'price_free_cash_flow_ttm', 'enterprise_value_ebitda_ttm', 'beta_1_year',
  // profitability (percent)
  'gross_margin_ttm', 'operating_margin_ttm', 'net_margin_ttm',
  'free_cash_flow_margin_ttm', 'return_on_equity', 'return_on_assets',
  'return_on_invested_capital',
  // growth
  'total_revenue_ttm', 'total_revenue_yoy_growth_ttm',
  'earnings_per_share_diluted_yoy_growth_ttm',
  // financial health
  'debt_to_equity', 'current_ratio', 'quick_ratio',
  // dividends (percent for yield/payout)
  'dividend_yield_recent', 'dividend_payout_ratio_ttm', 'dividends_per_share_fq',
  // per-share
  'earnings_per_share_diluted_ttm', 'earnings_per_share_basic_ttm',
  'book_value_per_share_fq',
  // events
  'earnings_release_next_date',
];

/** Round to `dp` decimals; pass through null / non-finite as null. */
function round(v, dp = 2) {
  if (v == null || !Number.isFinite(Number(v))) return null;
  const f = 10 ** dp;
  return Math.round(Number(v) * f) / f;
}

/** Compact human string for a large absolute number: 4041225940774 → "4.04T". */
function abbrev(v) {
  if (v == null || !Number.isFinite(Number(v))) return null;
  const n = Number(v);
  const abs = Math.abs(n);
  const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [scale, suffix] of units) {
    if (abs >= scale) return `${round(n / scale, 2)}${suffix}`;
  }
  return String(round(n, 2));
}

/** Unix-seconds → ISO date (YYYY-MM-DD), or null. */
function unixToDate(secs) {
  if (secs == null || !Number.isFinite(Number(secs))) return null;
  return new Date(Number(secs) * 1000).toISOString().slice(0, 10);
}

/**
 * Fundamental snapshot for one symbol, bucketed into valuation / profitability /
 * growth / health / dividends / per-share / classification. Auto-detects the
 * symbol from the current chart when not given.
 *
 * @param {object} [opts]
 * @param {string} [opts.symbol] Exchange-qualified symbol (e.g. "NASDAQ:AAPL").
 * @returns {Promise<{success, symbol, ...}>}
 */
export async function fundamentals({ symbol } = {}) {
  const sym = symbol || await getCurrentSymbol();
  if (!sym) {
    return { success: false, error: 'No symbol given and no active chart symbol detected.' };
  }
  if (!String(sym).includes(':')) {
    return { success: false, error: `Symbol must be exchange-qualified (e.g. "NASDAQ:AAPL"); got "${sym}".` };
  }

  // resolveRow tries the exact ticker, then falls back to a bare-ticker name
  // match when the chart's exchange prefix isn't the scanner's canonical
  // listing (e.g. "BATS:CDNL" → "NASDAQ:CDNL").
  const resolved = await resolveRow(exchangeToMarket(sym), sym, COLUMNS);
  if (!resolved) {
    return { success: false, symbol: sym, error: 'Scanner returned no row for this symbol — check it is exchange-qualified and tradable.' };
  }
  const m = resolved.map;
  const resolvedSymbol = resolved.symbol;

  return {
    success: true,
    symbol: resolvedSymbol,
    ...(resolvedSymbol !== sym && { requested_symbol: sym }),
    description: m.description ?? null,
    currency: m.currency ?? null,
    price: round(m.close),
    classification: {
      sector: m.sector ?? null,
      industry: m.industry ?? null,
      employees: m.number_of_employees ?? null,
    },
    valuation: {
      market_cap: round(m.market_cap_basic, 0),
      market_cap_abbr: abbrev(m.market_cap_basic),
      enterprise_value: round(m.enterprise_value_fq, 0),
      enterprise_value_abbr: abbrev(m.enterprise_value_fq),
      pe_ttm: round(m.price_earnings_ttm),
      peg_ttm: round(m.price_earnings_growth_ttm),
      pb: round(m.price_book_fq),
      ps: round(m.price_sales_ratio),
      pfcf: round(m.price_free_cash_flow_ttm),
      ev_ebitda: round(m.enterprise_value_ebitda_ttm),
      beta: round(m.beta_1_year),
    },
    profitability_pct: {
      gross_margin: round(m.gross_margin_ttm),
      operating_margin: round(m.operating_margin_ttm),
      net_margin: round(m.net_margin_ttm),
      fcf_margin: round(m.free_cash_flow_margin_ttm),
      roe: round(m.return_on_equity),
      roa: round(m.return_on_assets),
      roic: round(m.return_on_invested_capital),
    },
    growth: {
      revenue_ttm: round(m.total_revenue_ttm, 0),
      revenue_ttm_abbr: abbrev(m.total_revenue_ttm),
      revenue_yoy_pct: round(m.total_revenue_yoy_growth_ttm),
      eps_yoy_pct: round(m.earnings_per_share_diluted_yoy_growth_ttm),
    },
    health: {
      debt_to_equity: round(m.debt_to_equity),
      current_ratio: round(m.current_ratio),
      quick_ratio: round(m.quick_ratio),
    },
    dividends: {
      yield_pct: round(m.dividend_yield_recent),
      payout_ratio_pct: round(m.dividend_payout_ratio_ttm),
      per_share: round(m.dividends_per_share_fq),
    },
    per_share: {
      eps_diluted_ttm: round(m.earnings_per_share_diluted_ttm),
      eps_basic_ttm: round(m.earnings_per_share_basic_ttm),
      book_value: round(m.book_value_per_share_fq),
    },
    next_earnings_date: unixToDate(m.earnings_release_next_date),
  };
}
