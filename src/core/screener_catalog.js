/**
 * Structured screener field catalog + live metainfo validation.
 *
 * The scanner exposes ~3,770 raw columns (see docs/SCREENER_FIELDS.md), which is
 * far too many to hand to an LLM. TradingView's own UI collapses these into ~260
 * *concepts* across 8 categories, where each concept has a small menu of allowed
 * "values" baked into the column name:
 *
 *   - technicals   : <indicator><length?><|timeframe?>   e.g. RSI7|60, SMA50
 *   - market data  : <metric>.<window>                    e.g. Perf.6M
 *   - fundamentals : <metric>_<period>                    e.g. net_income_ttm
 *
 * This module encodes that concept model (the part metainfo *can't* give — it
 * only carries {name, type}) and adds an on-demand live check against the real
 * metainfo endpoint so a specific field can be validated/expanded without ever
 * shipping the whole namespace.
 *
 * Powers two MCP tools (see tools/screener_query.js):
 *   - screener_catalog     : browse concepts by category / search (static)
 *   - screener_field_info  : resolve + optionally live-validate one field
 *
 * The legacy screener_fields tool (flat FIELDS_CATALOG in core/screener_query.js)
 * is left untouched for backward compatibility.
 */
import { evaluateAsync, safeString } from '../connection.js';

const SCANNER_BASE = 'https://scanner.tradingview.com';

// Timeframe suffixes a technical column accepts (no suffix = daily).
export const TIMEFRAMES = ['1', '5', '15', '30', '60', '120', '240', '1W', '1M'];
export const TIMEFRAME_LABELS = {
  '1': '1m', '5': '5m', '15': '15m', '30': '30m', '60': '1h',
  '120': '2h', '240': '4h', '1W': 'weekly', '1M': 'monthly',
};

// The SMA/EMA lengths TradingView precomputes as columns.
const MA_LEN = [2, 3, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 20, 21, 25, 26,
  30, 34, 40, 50, 55, 60, 75, 89, 100, 120, 144, 150, 200, 250, 300];

// Naming rules surfaced to the caller so it can construct columns itself.
export const NAMING = {
  technicals: '<indicator><length?><|timeframe?>  — e.g. RSI7|60, SMA50, MACD.macd|1W',
  market_data: '<metric>.<window>  — e.g. Perf.6M, Volatility.W',
  fundamentals: '<metric>_<period>  — e.g. net_income_ttm, return_on_equity_fy',
  timeframe_suffix: TIMEFRAME_LABELS,
  period_suffix: {
    '(none)': 'default snapshot (most-recent / current)',
    ttm: 'trailing twelve months', fq: 'latest fiscal quarter',
    fy: 'latest fiscal year', fh: 'latest fiscal half-year',
    current: 'live-computed (uses today\'s price)',
  },
  note: 'Multi-part names use DOTS not underscores (Perf.1M, Stoch.K). Only the '
    + 'precomputed values below exist — RSI11 / SMA45 are not columns.',
};

// Helpers to build column-variant lists tersely.
const tf = true; // marker: this concept also takes |timeframe suffixes
const suffixed = (stem, sufs, { bare = false } = {}) =>
  (bare ? [stem] : []).concat(sufs.map(s => `${stem}_${s}`));

/**
 * The catalog. Keyed by UI category. Each entry:
 *   { label, stem, type, tf?, desc, cols }
 *   - stem : searchable/base string, also stripped to render the value menu
 *   - cols : every concrete (daily / default-period) column the concept expands
 *            to; cols[0] is the sensible default. Timeframe variants are added
 *            programmatically when tf is set.
 */
export const FIELD_GROUPS = {
  security_info: [
    { label: 'Symbol', stem: 'name', type: 'text', desc: 'Ticker symbol', cols: ['name'] },
    { label: 'Name', stem: 'description', type: 'text', desc: 'Company / instrument name', cols: ['description'] },
    { label: 'Type', stem: 'type', type: 'text', desc: 'stock, etf, fund, dr, structured', cols: ['type'] },
    { label: 'Subtype', stem: 'subtype', type: 'text', desc: 'common, preferred, etf, etn', cols: ['subtype'] },
    { label: 'Exchange', stem: 'exchange', type: 'text', desc: 'Exchange code (NASDAQ, NSE, ...)', cols: ['exchange'] },
    { label: 'Country', stem: 'country', type: 'text', desc: 'Listing country', cols: ['country'] },
    { label: 'Currency', stem: 'currency', type: 'text', desc: 'Trading currency', cols: ['currency'] },
    { label: 'Sector', stem: 'sector', type: 'text', desc: 'Sector (Finance, Technology, ...)', cols: ['sector'] },
    { label: 'Industry', stem: 'industry', type: 'text', desc: 'Industry sub-classification', cols: ['industry'] },
    { label: 'Employees', stem: 'number_of_employees', type: 'number', desc: 'Employee count', cols: ['number_of_employees'] },
    { label: 'Shareholders', stem: 'number_of_shareholders', type: 'number', desc: 'Shareholder count', cols: ['number_of_shareholders'] },
  ],

  market_data: [
    { label: 'Last price', stem: 'close', type: 'price', desc: 'Last traded price', cols: ['close'] },
    { label: 'Open', stem: 'open', type: 'price', desc: "Today's open", cols: ['open'] },
    { label: 'High', stem: 'high', type: 'price', desc: "Today's high", cols: ['high'] },
    { label: 'Low', stem: 'low', type: 'price', desc: "Today's low", cols: ['low'] },
    { label: 'Change %', stem: 'change', type: 'percent', desc: '% change vs prev close', cols: ['change'] },
    { label: 'Change abs', stem: 'change_abs', type: 'price', desc: 'Absolute change vs prev close', cols: ['change_abs'] },
    { label: 'Gap %', stem: 'gap', type: 'percent', desc: "Today's gap vs prev close", cols: ['gap', 'gap_up', 'gap_down'] },
    { label: 'Volume', stem: 'volume', type: 'number', desc: "Today's volume", cols: ['volume'] },
    { label: 'Rel. volume', stem: 'relative_volume_10d_calc', type: 'number', desc: 'Volume / 10d average', cols: ['relative_volume_10d_calc'] },
    { label: 'Avg volume', stem: 'average_volume', type: 'number', desc: 'Average daily volume', cols: ['average_volume_10d_calc', 'average_volume_30d_calc', 'average_volume_60d_calc', 'average_volume_90d_calc'] },
    { label: 'Turnover', stem: 'Value.Traded', type: 'number', desc: 'Price × volume', cols: ['Value.Traded', 'AvgValue.Traded_10d', 'AvgValue.Traded_30d', 'AvgValue.Traded_60d', 'AvgValue.Traded_90d'] },
    { label: 'VWAP', stem: 'VWAP', type: 'number', tf, desc: 'Volume-weighted average price', cols: ['VWAP'] },
    { label: 'Performance %', stem: 'Perf', type: 'percent', desc: 'Return over a window', cols: ['Perf.W', 'Perf.1M', 'Perf.3M', 'Perf.6M', 'Perf.YTD', 'Perf.Y', 'Perf.5Y', 'Perf.10Y', 'Perf.All', 'Perf.5D', 'Perf.3Y'] },
    { label: 'Volatility %', stem: 'Volatility', type: 'percent', desc: 'Realized volatility', cols: ['Volatility.D', 'Volatility.W', 'Volatility.M'] },
    { label: 'Period high', stem: 'High', type: 'price', desc: 'High over a window', cols: ['High.5D', 'High.1M', 'High.3M', 'High.6M', 'High.All', 'price_52_week_high'] },
    { label: 'Period low', stem: 'Low', type: 'price', desc: 'Low over a window', cols: ['Low.5D', 'Low.1M', 'Low.3M', 'Low.6M', 'Low.All', 'price_52_week_low'] },
  ],

  technicals: [
    { label: 'RSI', stem: 'RSI', type: 'number', tf, desc: 'Relative Strength Index (default 14)', cols: ['RSI', 'RSI2', 'RSI3', 'RSI4', 'RSI5', 'RSI7', 'RSI9', 'RSI20', 'RSI21', 'RSI30'] },
    { label: 'Stochastic %K', stem: 'Stoch.K', type: 'number', tf, desc: 'Stoch %K (default 14,1,3)', cols: ['Stoch.K', 'Stoch.K_5_3_3', 'Stoch.K_6_3_3', 'Stoch.K_8_3_3', 'Stoch.K_14_1_3'] },
    { label: 'Stochastic %D', stem: 'Stoch.D', type: 'number', tf, desc: 'Stoch %D (default 14,1,3)', cols: ['Stoch.D', 'Stoch.D_5_3_3', 'Stoch.D_6_3_3', 'Stoch.D_8_3_3', 'Stoch.D_14_1_3'] },
    { label: 'Stochastic RSI %K', stem: 'Stoch.RSI.K', type: 'number', tf, desc: 'Stoch RSI %K (3,3,14,14)', cols: ['Stoch.RSI.K'] },
    { label: 'Stochastic RSI %D', stem: 'Stoch.RSI.D', type: 'number', tf, desc: 'Stoch RSI %D (3,3,14,14)', cols: ['Stoch.RSI.D'] },
    { label: 'MACD line', stem: 'MACD.macd', type: 'number', tf, desc: 'MACD (12,26,9)', cols: ['MACD.macd'] },
    { label: 'MACD signal', stem: 'MACD.signal', type: 'number', tf, desc: 'MACD signal line', cols: ['MACD.signal'] },
    { label: 'MACD histogram', stem: 'MACD.hist', type: 'number', tf, desc: 'MACD histogram', cols: ['MACD.hist'] },
    { label: 'CCI', stem: 'CCI20', type: 'number', tf, desc: 'Commodity Channel Index (20)', cols: ['CCI20'] },
    { label: 'Momentum', stem: 'Mom', type: 'number', tf, desc: 'Momentum (default 10)', cols: ['Mom', 'Mom_14'] },
    { label: 'Rate of change', stem: 'ROC', type: 'number', tf, desc: 'Rate of Change', cols: ['ROC'] },
    { label: 'Awesome Oscillator', stem: 'AO', type: 'number', tf, desc: 'Awesome Oscillator', cols: ['AO'] },
    { label: 'Ultimate Oscillator', stem: 'UO', type: 'number', tf, desc: 'Ultimate Oscillator', cols: ['UO'] },
    { label: 'Williams %R', stem: 'W.R', type: 'number', tf, desc: 'Williams %R', cols: ['W.R'] },
    { label: 'Bull/Bear Power', stem: 'BBPower', type: 'number', tf, desc: 'Elder Bull/Bear Power', cols: ['BBPower'] },
    { label: 'Aroon Up', stem: 'Aroon.Up', type: 'number', tf, desc: 'Aroon Up (14)', cols: ['Aroon.Up'] },
    { label: 'Aroon Down', stem: 'Aroon.Down', type: 'number', tf, desc: 'Aroon Down (14)', cols: ['Aroon.Down'] },
    { label: 'ADX', stem: 'ADX', type: 'number', tf, desc: 'Average Directional Index (default 14)', cols: ['ADX', 'ADX_9', 'ADX_20', 'ADX_50', 'ADX_100'] },
    { label: '+DI', stem: 'ADX+DI', type: 'number', tf, desc: 'Positive Directional Indicator', cols: ['ADX+DI', 'ADX+DI_9', 'ADX+DI_20', 'ADX+DI_50', 'ADX+DI_100'] },
    { label: '-DI', stem: 'ADX-DI', type: 'number', tf, desc: 'Negative Directional Indicator', cols: ['ADX-DI', 'ADX-DI_9', 'ADX-DI_20', 'ADX-DI_50', 'ADX-DI_100'] },
    { label: 'ATR', stem: 'ATR', type: 'number', tf, desc: 'Average True Range (14)', cols: ['ATR'] },
    { label: 'ATR %', stem: 'ATRP', type: 'number', tf, desc: 'ATR as % of price', cols: ['ATRP'] },
    { label: 'SMA', stem: 'SMA', type: 'price', tf, desc: 'Simple moving average', cols: MA_LEN.map(n => `SMA${n}`) },
    { label: 'EMA', stem: 'EMA', type: 'price', tf, desc: 'Exponential moving average', cols: MA_LEN.map(n => `EMA${n}`) },
    { label: 'Hull MA', stem: 'HullMA', type: 'price', tf, desc: 'Hull moving average', cols: ['HullMA9', 'HullMA20', 'HullMA200'] },
    { label: 'VWMA', stem: 'VWMA', type: 'price', tf, desc: 'Volume-weighted MA', cols: ['VWMA'] },
    { label: 'Bollinger upper', stem: 'BB.upper', type: 'price', tf, desc: 'Bollinger upper (20 or 50)', cols: ['BB.upper', 'BB.upper_50'] },
    { label: 'Bollinger basis', stem: 'BB.basis', type: 'price', tf, desc: 'Bollinger basis (20 or 50)', cols: ['BB.basis', 'BB.basis_50'] },
    { label: 'Bollinger lower', stem: 'BB.lower', type: 'price', tf, desc: 'Bollinger lower (20 or 50)', cols: ['BB.lower', 'BB.lower_50'] },
    { label: 'Keltner upper', stem: 'KltChnl.upper', type: 'price', tf, desc: 'Keltner Channel upper', cols: ['KltChnl.upper'] },
    { label: 'Keltner basis', stem: 'KltChnl.basis', type: 'price', tf, desc: 'Keltner Channel basis', cols: ['KltChnl.basis'] },
    { label: 'Keltner lower', stem: 'KltChnl.lower', type: 'price', tf, desc: 'Keltner Channel lower', cols: ['KltChnl.lower'] },
    { label: 'Donchian upper', stem: 'DonchCh20.Upper', type: 'price', tf, desc: 'Donchian upper (20)', cols: ['DonchCh20.Upper'] },
    { label: 'Donchian middle', stem: 'DonchCh20.Middle', type: 'price', tf, desc: 'Donchian middle (20)', cols: ['DonchCh20.Middle'] },
    { label: 'Donchian lower', stem: 'DonchCh20.Lower', type: 'price', tf, desc: 'Donchian lower (20)', cols: ['DonchCh20.Lower'] },
    { label: 'Ichimoku conversion', stem: 'Ichimoku.CLine', type: 'price', tf, desc: 'Tenkan-sen', cols: ['Ichimoku.CLine'] },
    { label: 'Ichimoku base', stem: 'Ichimoku.BLine', type: 'price', tf, desc: 'Kijun-sen', cols: ['Ichimoku.BLine'] },
    { label: 'Ichimoku lead 1', stem: 'Ichimoku.Lead1', type: 'price', tf, desc: 'Senkou span A', cols: ['Ichimoku.Lead1'] },
    { label: 'Ichimoku lead 2', stem: 'Ichimoku.Lead2', type: 'price', tf, desc: 'Senkou span B', cols: ['Ichimoku.Lead2'] },
    { label: 'Parabolic SAR', stem: 'P.SAR', type: 'price', tf, desc: 'Parabolic SAR', cols: ['P.SAR'] },
    { label: 'Chaikin Money Flow', stem: 'ChaikinMoneyFlow', type: 'number', tf, desc: 'Chaikin Money Flow (20)', cols: ['ChaikinMoneyFlow'] },
    { label: 'Money Flow Index', stem: 'MoneyFlow', type: 'number', tf, desc: 'Money Flow Index (14)', cols: ['MoneyFlow'] },
    { label: 'Rating (all)', stem: 'Recommend.All', type: 'number', tf, desc: 'Overall rating [-1,1]', cols: ['Recommend.All'] },
    { label: 'Rating (MAs)', stem: 'Recommend.MA', type: 'number', tf, desc: 'Moving-averages rating', cols: ['Recommend.MA'] },
    { label: 'Rating (oscillators)', stem: 'Recommend.Other', type: 'number', tf, desc: 'Oscillators rating', cols: ['Recommend.Other'] },
  ],

  valuation: [
    { label: 'Market cap', stem: 'market_cap_basic', type: 'number', desc: 'Market capitalization', cols: ['market_cap_basic'] },
    { label: 'Enterprise value', stem: 'enterprise_value', type: 'fundamental_price', desc: 'Enterprise value', cols: suffixed('enterprise_value', ['fq', 'current']) },
    { label: 'P/E', stem: 'price_earnings', type: 'number', desc: 'Price / earnings', cols: suffixed('price_earnings', ['ttm', 'current']) },
    { label: 'P/E forward', stem: 'price_earnings_forward', type: 'number', desc: 'Forward P/E', cols: ['price_earnings_forward_fy'] },
    { label: 'PEG', stem: 'price_earnings_growth', type: 'number', desc: 'PEG ratio', cols: ['price_earnings_growth_ttm'] },
    { label: 'P/B', stem: 'price_book', type: 'number', desc: 'Price / book', cols: suffixed('price_book', ['fq', 'current']) },
    { label: 'P/S', stem: 'price_sales', type: 'number', desc: 'Price / sales', cols: suffixed('price_sales', ['current'], { bare: true }) },
    { label: 'P/FCF', stem: 'price_free_cash_flow', type: 'number', desc: 'Price / free cash flow', cols: suffixed('price_free_cash_flow', ['ttm', 'current']) },
    { label: 'P/CF', stem: 'price_cash_flow', type: 'number', desc: 'Price / cash flow', cols: ['price_cash_flow_current'] },
    { label: 'EV/EBITDA', stem: 'enterprise_value_ebitda', type: 'number', desc: 'EV / EBITDA', cols: suffixed('enterprise_value_ebitda', ['ttm', 'current']) },
    { label: 'Beta (1Y)', stem: 'beta_1_year', type: 'number', desc: '1-year beta', cols: ['beta_1_year'] },
  ],

  financials: [
    { label: 'Total revenue', stem: 'total_revenue', type: 'fundamental_price', desc: 'Total revenue', cols: suffixed('total_revenue', ['fq', 'fy', 'ttm', 'fh'], { bare: true }) },
    { label: 'Gross profit', stem: 'gross_profit', type: 'fundamental_price', desc: 'Gross profit', cols: suffixed('gross_profit', ['fq', 'fy', 'ttm', 'fh'], { bare: true }) },
    { label: 'Operating income', stem: 'oper_income', type: 'fundamental_price', desc: 'Operating income', cols: suffixed('oper_income', ['fq', 'fy', 'ttm', 'fh']) },
    { label: 'Net income', stem: 'net_income', type: 'fundamental_price', desc: 'Net income', cols: suffixed('net_income', ['fq', 'fy', 'ttm', 'fh'], { bare: true }) },
    { label: 'EBITDA', stem: 'ebitda', type: 'fundamental_price', desc: 'EBITDA', cols: suffixed('ebitda', ['fq', 'fy', 'ttm', 'fh'], { bare: true }) },
    { label: 'EBIT', stem: 'ebit', type: 'fundamental_price', desc: 'EBIT', cols: ['ebit_ttm'] },
    { label: 'Total assets', stem: 'total_assets', type: 'fundamental_price', desc: 'Total assets', cols: suffixed('total_assets', ['fq', 'fy'], { bare: true }) },
    { label: 'Total debt', stem: 'total_debt', type: 'fundamental_price', desc: 'Total debt', cols: suffixed('total_debt', ['fq', 'fy'], { bare: true }) },
    { label: 'Total equity', stem: 'total_equity', type: 'fundamental_price', desc: 'Total equity', cols: suffixed('total_equity', ['fq', 'fy']) },
    { label: 'Cash & equivalents', stem: 'cash_n_equivalents', type: 'fundamental_price', desc: 'Cash and equivalents', cols: suffixed('cash_n_equivalents', ['fq', 'fy']) },
    { label: 'Free cash flow', stem: 'free_cash_flow', type: 'fundamental_price', desc: 'Free cash flow', cols: suffixed('free_cash_flow', ['fq', 'fy', 'ttm', 'fh'], { bare: true }) },
    { label: 'EPS diluted', stem: 'earnings_per_share_diluted', type: 'number', desc: 'Diluted EPS', cols: suffixed('earnings_per_share_diluted', ['fq', 'fy', 'ttm', 'fh']) },
    { label: 'EPS basic', stem: 'earnings_per_share_basic', type: 'number', desc: 'Basic EPS', cols: suffixed('earnings_per_share_basic', ['fq', 'fy', 'ttm', 'fh']) },
    { label: 'Shares outstanding', stem: 'total_shares_outstanding', type: 'number', desc: 'Shares outstanding', cols: suffixed('total_shares_outstanding', ['current'], { bare: true }) },
    { label: 'Book value / share', stem: 'book_value_per_share', type: 'number', desc: 'Book value per share', cols: suffixed('book_value_per_share', ['fq', 'fy', 'current', 'fh']) },
    { label: 'Next earnings date', stem: 'earnings_release_next_trading_date_fq', type: 'time', desc: 'Next earnings date (unix)', cols: ['earnings_release_next_trading_date_fq'] },
  ],

  margins: [
    { label: 'Gross margin %', stem: 'gross_margin', type: 'percent', desc: 'Gross margin', cols: suffixed('gross_margin', ['fy', 'ttm'], { bare: true }) },
    { label: 'Operating margin %', stem: 'operating_margin', type: 'percent', desc: 'Operating margin', cols: suffixed('operating_margin', ['fy', 'ttm'], { bare: true }) },
    { label: 'Net margin %', stem: 'net_margin', type: 'percent', desc: 'Net margin', cols: suffixed('net_margin', ['fy', 'ttm'], { bare: true }) },
    { label: 'Pretax margin %', stem: 'pre_tax_margin', type: 'percent', desc: 'Pretax margin', cols: suffixed('pre_tax_margin', ['ttm'], { bare: true }) },
    { label: 'FCF margin %', stem: 'free_cash_flow_margin', type: 'percent', desc: 'Free cash flow margin', cols: suffixed('free_cash_flow_margin', ['fy', 'ttm']) },
    { label: 'EBITDA margin %', stem: 'ebitda_margin', type: 'percent', desc: 'EBITDA margin', cols: suffixed('ebitda_margin', ['fy', 'ttm']) },
    { label: 'ROE %', stem: 'return_on_equity', type: 'percent', desc: 'Return on equity', cols: suffixed('return_on_equity', ['fq', 'fy'], { bare: true }) },
    { label: 'ROA %', stem: 'return_on_assets', type: 'percent', desc: 'Return on assets', cols: suffixed('return_on_assets', ['fq', 'fy'], { bare: true }) },
    { label: 'ROIC %', stem: 'return_on_invested_capital', type: 'percent', desc: 'Return on invested capital', cols: suffixed('return_on_invested_capital', ['fq', 'fy'], { bare: true }) },
    { label: 'Debt / Equity', stem: 'debt_to_equity', type: 'number', desc: 'Debt-to-equity ratio', cols: suffixed('debt_to_equity', ['fq', 'fy'], { bare: true }) },
    { label: 'Current ratio', stem: 'current_ratio', type: 'number', desc: 'Current ratio', cols: suffixed('current_ratio', ['fq', 'fy', 'current'], { bare: true }) },
    { label: 'Quick ratio', stem: 'quick_ratio', type: 'number', desc: 'Quick ratio', cols: suffixed('quick_ratio', ['fq', 'fy', 'current'], { bare: true }) },
  ],

  growth: [
    { label: 'Revenue growth %', stem: 'total_revenue', type: 'percent', desc: 'Revenue YoY/QoQ growth', cols: ['total_revenue_yoy_growth_fq', 'total_revenue_yoy_growth_fy', 'total_revenue_yoy_growth_ttm', 'total_revenue_qoq_growth_fq'] },
    { label: 'EPS growth %', stem: 'earnings_per_share_diluted', type: 'percent', desc: 'Diluted EPS YoY/QoQ growth', cols: ['earnings_per_share_diluted_yoy_growth_fq', 'earnings_per_share_diluted_yoy_growth_fy', 'earnings_per_share_diluted_yoy_growth_ttm', 'earnings_per_share_diluted_qoq_growth_fq'] },
    { label: 'Net income growth %', stem: 'net_income', type: 'percent', desc: 'Net income YoY/QoQ growth', cols: ['net_income_yoy_growth_fq', 'net_income_yoy_growth_fy', 'net_income_yoy_growth_ttm', 'net_income_qoq_growth_fq'] },
    { label: 'Gross profit growth %', stem: 'gross_profit', type: 'percent', desc: 'Gross profit YoY/QoQ growth', cols: ['gross_profit_yoy_growth_fq', 'gross_profit_yoy_growth_fy', 'gross_profit_yoy_growth_ttm', 'gross_profit_qoq_growth_fq'] },
    { label: 'EBITDA growth %', stem: 'ebitda', type: 'percent', desc: 'EBITDA YoY/QoQ growth', cols: ['ebitda_yoy_growth_fq', 'ebitda_yoy_growth_fy', 'ebitda_yoy_growth_ttm', 'ebitda_qoq_growth_fq'] },
    { label: 'FCF growth %', stem: 'free_cash_flow', type: 'percent', desc: 'FCF YoY/QoQ growth', cols: ['free_cash_flow_yoy_growth_fq', 'free_cash_flow_yoy_growth_fy', 'free_cash_flow_yoy_growth_ttm', 'free_cash_flow_qoq_growth_fq'] },
    { label: 'CapEx growth %', stem: 'capital_expenditures', type: 'percent', desc: 'CapEx YoY/QoQ growth', cols: ['capital_expenditures_yoy_growth_fq', 'capital_expenditures_yoy_growth_fy', 'capital_expenditures_yoy_growth_ttm', 'capital_expenditures_qoq_growth_fq'] },
    { label: 'Total assets growth %', stem: 'total_assets', type: 'percent', desc: 'Total assets YoY/QoQ growth', cols: ['total_assets_yoy_growth_fq', 'total_assets_yoy_growth_fy', 'total_assets_qoq_growth_fq'] },
    { label: 'Total debt growth %', stem: 'total_debt', type: 'percent', desc: 'Total debt YoY/QoQ growth', cols: ['total_debt_yoy_growth_fq', 'total_debt_yoy_growth_fy', 'total_debt_qoq_growth_fq'] },
    { label: 'Dividend/share growth %', stem: 'dps_common_stock_prim_issue', type: 'percent', desc: 'DPS YoY growth', cols: ['dps_common_stock_prim_issue_yoy_growth_fy'] },
  ],

  dividends: [
    { label: 'Dividend yield %', stem: 'dividend_yield_recent', type: 'percent', desc: 'Recent annualized yield', cols: ['dividend_yield_recent'] },
    { label: 'Dividends / share', stem: 'dividends_per_share', type: 'number', desc: 'Dividends per share', cols: ['dividends_per_share_fq'] },
    { label: 'Payout ratio %', stem: 'dividend_payout_ratio', type: 'percent', desc: 'Dividend payout ratio', cols: suffixed('dividend_payout_ratio', ['fy', 'ttm']) },
    { label: 'Div growth streak', stem: 'continuous_dividend_growth', type: 'number', desc: 'Consecutive years of dividend growth', cols: ['continuous_dividend_growth'] },
    { label: 'Div payout streak', stem: 'continuous_dividend_payout', type: 'number', desc: 'Consecutive years paying dividends', cols: ['continuous_dividend_payout'] },
  ],
};

export const CATEGORIES = Object.keys(FIELD_GROUPS);

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

const TF_RE = new RegExp(`\\|(${TIMEFRAMES.join('|')})$`);

/** Strip a |timeframe and/or [n] prev-bar suffix to get the base column. */
function stripSuffix(field) {
  return String(field).replace(TF_RE, '').replace(/\[\d+\]$/, '');
}

/** Human labels for a concept's value menu (e.g. RSI → ['·','2','7',...]). */
export function valueMenu(entry) {
  return entry.cols.map(c => {
    if (c === entry.stem) return '·';
    const s = c.startsWith(entry.stem) ? c.slice(entry.stem.length).replace(/^[_.]/, '') : c;
    return s || '·';
  });
}

/** Every concrete column a concept expands to (cols × timeframes). */
export function expandField(entry) {
  if (!entry.tf) return [...entry.cols];
  const out = [];
  for (const c of entry.cols) {
    out.push(c);
    for (const t of TIMEFRAMES) out.push(`${c}|${t}`);
  }
  return out;
}

/** Resolve a field string to its concept entry (exact-ish), or null. */
export function findConcept(field) {
  const stripped = stripSuffix(field);
  const lc = String(field).toLowerCase();
  for (const [category, entries] of Object.entries(FIELD_GROUPS)) {
    for (const e of entries) {
      if (e.cols.includes(stripped) || e.cols.includes(field)
        || e.stem === stripped || e.label.toLowerCase() === lc) {
        return { ...e, category };
      }
    }
  }
  return null;
}

/** Substring search across label / stem / description / columns. */
export function searchCatalog(query) {
  const q = String(query).toLowerCase();
  const out = {};
  for (const [category, entries] of Object.entries(FIELD_GROUPS)) {
    const hits = entries.filter(e =>
      e.label.toLowerCase().includes(q)
      || e.stem.toLowerCase().includes(q)
      || e.desc.toLowerCase().includes(q)
      || e.cols.some(c => c.toLowerCase().includes(q)));
    if (hits.length) out[category] = hits;
  }
  return out;
}

/** Render one concept for tool output. verbose adds the full column list. */
function renderEntry(entry, verbose) {
  const out = { label: entry.label, field: entry.cols[0], type: entry.type, desc: entry.desc };
  if (entry.cols.length > 1) out.values = valueMenu(entry);
  if (entry.tf) out.timeframes = verbose ? TIMEFRAMES : 'all 9 + daily';
  if (verbose) out.columns = expandField(entry);
  return out;
}

/**
 * Build the catalog view for the screener_catalog tool.
 * @param {object} opts
 * @param {string} [opts.category] restrict to one UI category
 * @param {string} [opts.search]   substring filter across concepts
 * @param {boolean} [opts.verbose] include full expanded column lists
 */
export function catalogView({ category, search, verbose = false } = {}) {
  let groups = FIELD_GROUPS;
  if (search) groups = searchCatalog(search);
  if (category) {
    if (!FIELD_GROUPS[category]) {
      return { success: false, error: `Unknown category "${category}". Known: ${CATEGORIES.join(', ')}` };
    }
    groups = { [category]: groups[category] || [] };
  }
  const categories = {};
  let count = 0;
  for (const [cat, entries] of Object.entries(groups)) {
    categories[cat] = entries.map(e => renderEntry(e, verbose));
    count += entries.length;
  }
  return { success: true, count, categories, naming: NAMING };
}

// ---------------------------------------------------------------------------
// Live metainfo (validation / expansion) — fetched in-page over CDP, cached.
// Schema is global across markets, so the cache key barely matters, but we key
// by market anyway to stay correct if TV ever diverges.
// ---------------------------------------------------------------------------

const _metaCache = new Map();

// A handful of columns are queryable but NOT enumerated in /metainfo (TV treats
// them as intrinsic identity/derived columns). Verified live against /scan.
// Without this, live-validation would false-negative on them.
const INTRINSIC_COLUMNS = ['name', 'description', 'Value.Traded'];

/** Fetch the set of every column name the scanner exposes for a market. */
export async function fetchMetainfo(market = 'america') {
  if (_metaCache.has(market)) return _metaCache.get(market);
  const url = `${SCANNER_BASE}/${encodeURIComponent(market)}/metainfo`;
  const expr = `
    (async function() {
      try {
        const r = await fetch(${safeString(url)}, { method: "GET", headers: { "Content-Type": "text/plain" } });
        const t = await r.text();
        let j = null; try { j = JSON.parse(t); } catch (e) {}
        return { ok: r.ok, status: r.status, fields: j && Array.isArray(j.fields) ? j.fields.map(f => f.n) : null };
      } catch (e) { return { ok: false, fetchError: e.message }; }
    })()
  `;
  const res = await evaluateAsync(expr);
  if (!res || !Array.isArray(res.fields)) {
    throw new Error(res && res.fetchError
      ? `metainfo fetch failed: ${res.fetchError}`
      : `metainfo fetch failed (HTTP ${res && res.status})`);
  }
  const set = new Set(res.fields);
  for (const c of INTRINSIC_COLUMNS) set.add(c);
  _metaCache.set(market, set);
  return set;
}

/**
 * Resolve one field: static concept info + example columns, plus (if a market
 * is given) a live check against the real metainfo endpoint.
 * @param {string} field
 * @param {string} [market] if provided, validate against this market's schema
 */
export async function fieldInfo(field, market) {
  const concept = findConcept(field);
  const resolved = concept ? {
    category: concept.category,
    label: concept.label,
    stem: concept.stem,
    type: concept.type,
    desc: concept.desc,
    timeframes: concept.tf ? 'all 9 + daily' : null,
    columns: concept.cols,
    values: concept.cols.length > 1 ? valueMenu(concept) : null,
  } : null;

  const examples = concept ? expandField(concept).slice(0, 12) : [field];

  let live = null;
  if (market !== undefined) {
    const mkt = market || 'america';
    try {
      const set = await fetchMetainfo(mkt);
      const all = concept ? expandField(concept) : [field];
      live = {
        market: mkt,
        field_valid: set.has(field),
        concept_columns_total: concept ? all.length : null,
        concept_columns_present: concept ? all.filter(c => set.has(c)).length : null,
      };
    } catch (err) {
      live = { market: mkt, error: err.message };
    }
  }

  return {
    success: true,
    field,
    known: !!concept,
    resolved,
    examples,
    live,
    hint: concept ? undefined
      : 'Not in the curated catalog. It may still be a valid scanner column — '
        + 'pass a market to live-validate, or use it directly in screener_query.',
  };
}
