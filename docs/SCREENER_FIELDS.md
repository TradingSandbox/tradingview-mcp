# Screener Fields — full reference

The `screener_fields` MCP tool exposes a **curated ~70-field** subset. The live
scanner (`scanner.tradingview.com/<market>/metainfo`) actually carries **3,770
columns**. `screener_query` passes field names straight through, so **any column
below is queryable** even though the tool doesn't list it — unknown fields just
return `null`.

## Why 3,770 columns but the UI shows ~260 filters

The Screener UI counts **concepts** (one row per metric). The API is the **raw
column namespace**: each concept is pre-flattened into `concept + its settings`,
because the endpoint is stateless (no settings panel — every allowed combination
gets its own address).

| Slice | Count |
|-------|-------|
| Total columns | 3,770 |
| Columns with a `\|timeframe` suffix (9 TFs × ~295) | 2,656 |
| Base columns (no timeframe) | 1,114 |
| Distinct after folding `\|tf` + `[n]` prev-bar dupes | 1,079 |
| Distinct **name-families** (period/param folded) | ~898 |
| UI-visible **filters** (the 8 categories) | ~260 |

So one UI "filter" (e.g. RSI) becomes many API columns: `RSI`, `RSI7`,
`RSI|60`, `RSI7|60`, … The "extra" fields are not new metrics — they're the
**length / timeframe / reporting-period settings baked into the column name**.

## How to build a column name

```
technicals:   <indicator><length?><|timeframe?>     e.g. RSI7|60   SMA50   MACD.macd|1W
market data:  <metric>.<window>                      e.g. Perf.6M   Volatility.W
fundamentals: <metric>_<period>                      e.g. net_income_ttm   return_on_equity_fy
```

- **You can only use precomputed values** — arbitrary lengths/periods don't
  exist. `RSI11` and `SMA45` are not columns; pick from the menus below.
- **Multi-part names use DOTS**: `Perf.1M`, `Stoch.K`, `MACD.macd`, `BB.lower`.
  Underscore variants are rejected with `Unknown field`.
- **No suffix = daily** (technicals) / **default/most-recent snapshot** (fundamentals).
- The schema is **identical across markets** (`america`, `india`, …) — only the
  data + reporting currency differ. Pass `market="india"` for NSE/BSE.

### Timeframe suffix (technicals & performance)

| Code | `\|1` | `\|5` | `\|15` | `\|30` | `\|60` | `\|120` | `\|240` | `\|1W` | `\|1M` | *(none)* |
|------|-----|-----|------|------|------|-------|-------|------|------|----------|
| Interval | 1m | 5m | 15m | 30m | 1h | 2h | 4h | Weekly | Monthly | **Daily** |

### Reporting-period suffix (fundamentals)

| Suffix | Meaning |
|--------|---------|
| *(none)* | default snapshot (usually most-recent / current) |
| `_ttm` | trailing twelve months |
| `_fq` | latest fiscal quarter |
| `_fy` | latest fiscal year |
| `_fh` | latest fiscal half-year |
| `_current` | live-computed (uses today's price) |
| `_fq_h` / `_fy_h` | historical array (`num_slice` — past N quarters/years) |

---

## 1. Security info (UI: 25) — `text`, no period values

`name` · `description` · `type` (stock/etf/fund/dr/structured) · `subtype`
(common/preferred/etf/etn) · `exchange` · `country` · `currency` ·
`fundamental_currency_code` · `sector` · `industry` · `number_of_employees` ·
`number_of_shareholders` · index-membership flags · IDs (ISIN/FIGI).

Filter with `match` / `equal` / `in_range`, not period suffixes.

## 2. Market data (UI: 40) — value = lookback window

| Attribute | Column base | Values available |
|-----------|-------------|------------------|
| Last / O / H / L | `close` `open` `high` `low` | — |
| Change % / abs | `change` `change_abs` | — |
| Gap % | `gap` (`gap_up` / `gap_down`) | — |
| Volume | `volume` | — |
| Rel. volume | `relative_volume` · `relative_volume_10d_calc` | 10d |
| Avg volume | `average_volume` + `_10d_calc` `_30d_calc` `_60d_calc` `_90d_calc` | 10 / 30 / 60 / 90 d |
| Turnover | `Value.Traded` · `AvgValue.Traded_10d…_90d` | 10 / 30 / 60 / 90 d |
| Pre / post volume | `premarket_volume` `postmarket_volume` | — |
| Volume change % | `volume_change` (`_abs`) | — |
| VWAP | `VWAP` | + all 9 timeframes |
| **Performance %** | `Perf.<w>` (`_abs` for absolute) | 5D, W, 1M, 3M, 6M, YTD, Y, 3Y, 5Y, 10Y, All |
| **Volatility %** | `Volatility.<w>` | D, W, M |
| Period high | `High.<w>` · `price_52_week_high` | 5D, 1M, 3M, 6M, All, 52wk (+ `.Date`) |
| Period low | `Low.<w>` · `price_52_week_low` | 5D, 1M, 3M, 6M, All, 52wk (+ `.Date`) |

## 3. Technicals (UI: 39) — value = length + timeframe

Every row below also takes a `|timeframe` suffix (all 9 + daily).

| Attribute | Column base | Length / param values |
|-----------|-------------|-----------------------|
| RSI | `RSI` | 2, 3, 4, 5, 7, 9, **14**, 20, 21, 30 |
| Stochastic %K / %D | `Stoch.K` `Stoch.D` | 5,3,3 · 6,3,3 · 8,3,3 · **14,1,3** |
| Stochastic RSI | `Stoch.RSI.K` `Stoch.RSI.D` | fixed (3,3,14,14) |
| MACD | `MACD.macd` `MACD.signal` `MACD.hist` | fixed (12,26,9) |
| CCI | `CCI20` | fixed (20) |
| Momentum | `Mom` | 10, 14 |
| Rate of change | `ROC` | fixed |
| Awesome / Ultimate Osc | `AO` `UO` | fixed |
| Williams %R | `W.R` | fixed |
| Bull/Bear Power | `BBPower` | fixed |
| Aroon | `Aroon.Up` `Aroon.Down` | fixed (14) |
| ADX + DI | `ADX` `ADX+DI` `ADX-DI` | 9, **14**, 20, 50, 100 |
| ATR / ATR% | `ATR` `ATRP` | fixed (14) |
| SMA | `SMA<n>` | 2,3,5,6,7,8,9,10,12,13,14,15,20,21,25,26,30,34,40,50,55,60,75,89,100,120,144,150,200,250,300 |
| EMA | `EMA<n>` | (same 31 lengths as SMA) |
| Hull MA | `HullMA<n>` | 9, 20, 200 |
| VWMA / VWAP | `VWMA` `VWAP` | fixed |
| Bollinger Bands | `BB.upper` `BB.basis` `BB.lower` | 20 (default) or 50 → `BB.upper_50` |
| Keltner Channels | `KltChnl.upper` `.basis` `.lower` | fixed (20) |
| Donchian Channels | `DonchCh20.Upper` `.Middle` `.Lower` | fixed (20) |
| Ichimoku | `Ichimoku.CLine` `.BLine` `.Lead1` `.Lead2` | fixed (9,26,52,26) |
| Parabolic SAR | `P.SAR` | fixed |
| Chaikin / Money Flow | `ChaikinMoneyFlow` `MoneyFlow` | fixed (20 / 14) |
| **Rating** | `Recommend.All` `Recommend.MA` `Recommend.Other` | [-1,1] score |

Per-indicator rating votes also exist: `Rec.Ichimoku`, `Rec.VWMA`,
`Rec.HullMA9`, `Rec.UO`, `Rec.WR`, `Rec.BBPower`, `Rec.Stoch.RSI`; count buckets
`recommendation_buy/sell/hold/total`. Prev-bar values via `[1]` (e.g.
`Stoch.K[1]`) for crossover logic.

## 4. Valuation (UI: 24) — value = reporting period

| Attribute | Column base | Periods |
|-----------|-------------|---------|
| Market cap | `market_cap_basic` | · |
| Enterprise value | `enterprise_value` | fq, current |
| P/E | `price_earnings` | ttm, current |
| P/E forward | `price_earnings_forward` | fy |
| PEG | `price_earnings_growth` | ttm |
| P/B | `price_book` | fq, current |
| P/S | `price_sales` | ·, current |
| P/FCF | `price_free_cash_flow` | ttm, current |
| P/CF | `price_cash_flow` | current |
| EV/EBITDA | `enterprise_value_ebitda` | ttm, current |
| Beta (1Y) | `beta_1_year` | · |

## 5. Financials (UI: 47) — income / balance sheet / cash flow

| Attribute | Column base | Periods |
|-----------|-------------|---------|
| Total revenue | `total_revenue` | ·, fq, fy, ttm, fh, fy_h, fq_h |
| Gross profit | `gross_profit` | ·, fq, fy, ttm, fh, fy_h, fq_h |
| Operating income | `oper_income` | fq, fy, ttm, fh |
| Net income | `net_income` | ·, fq, fy, ttm, fh, fy_h, fq_h |
| EBITDA | `ebitda` | ·, fq, fy, ttm, fh, fy_h, fq_h |
| EBIT | `ebit` | ttm |
| Total assets | `total_assets` | ·, fq, fy, fy_h, fq_h |
| Total debt | `total_debt` | ·, fq, fy, fy_h, fq_h |
| Total equity | `total_equity` | fq, fy |
| Cash & equivalents | `cash_n_equivalents` | fq, fy |
| Free cash flow | `free_cash_flow` | ·, fq, fy, ttm, fh, fy_h, fq_h |
| EPS diluted | `earnings_per_share_diluted` | fq, fy, ttm, fh, fy_h, fq_h |
| EPS basic | `earnings_per_share_basic` | fq, fy, ttm, fh, fy_h |
| Shares outstanding | `total_shares_outstanding` | ·, current |
| Book value / share | `book_value_per_share` | fq, fy, current, fh |

## 6. Valuation → Margins / Returns (UI: 69) — `percent`

| Attribute | Column base | Periods |
|-----------|-------------|---------|
| Gross margin % | `gross_margin` | ·, fy, ttm |
| Operating margin % | `operating_margin` | ·, fy, ttm |
| Net margin % | `net_margin` | ·, fy, ttm |
| Pretax margin % | `pre_tax_margin` | ·, ttm |
| FCF margin % | `free_cash_flow_margin` | fy, ttm |
| EBITDA margin % | `ebitda_margin` | fy, ttm |
| Return on equity % | `return_on_equity` | ·, fq, fy |
| Return on assets % | `return_on_assets` | ·, fq, fy |
| Return on invested capital % | `return_on_invested_capital` | ·, fq, fy |
| Debt / Equity | `debt_to_equity` | ·, fq, fy |
| Current ratio | `current_ratio` | ·, fq, fy, current |
| Quick ratio | `quick_ratio` | ·, fq, fy, current |

## 7. Growth (UI: 9) — value = basis (`yoy`/`qoq`) × period

Pattern: `<metric>_<yoy|qoq>_growth_<period>`

| Attribute | Column base | Values |
|-----------|-------------|--------|
| Revenue growth | `total_revenue_?_growth_?` | yoy: fq/fy/ttm · qoq: fq |
| EPS (diluted) growth | `earnings_per_share_diluted_?_growth_?` | yoy: fq/fy/ttm · qoq: fq |
| Net income growth | `net_income_?_growth_?` | yoy: fq/fy/ttm · qoq: fq |
| Gross profit growth | `gross_profit_?_growth_?` | yoy: fq/fy/ttm · qoq: fq |
| EBITDA growth | `ebitda_?_growth_?` | yoy: fq/fy/ttm · qoq: fq |
| FCF growth | `free_cash_flow_?_growth_?` | yoy: fq/fy/ttm · qoq: fq |
| CapEx growth | `capital_expenditures_?_growth_?` | yoy: fq/fy/ttm · qoq: fq |
| Total assets growth | `total_assets_?_growth_?` | yoy: fq/fy · qoq: fq |
| Total debt growth | `total_debt_?_growth_?` | yoy: fq/fy · qoq: fq |
| Dividend/share growth | `dps_common_stock_prim_issue_yoy_growth_fy` | yoy: fy |

## 8. Dividends (UI: 8)

| Attribute | Column base | Periods |
|-----------|-------------|---------|
| Dividend yield % | `dividend_yield_recent` | · |
| Dividends / share | `dividends_per_share` | fq |
| Payout ratio % | `dividend_payout_ratio` | fy, ttm |
| Continuous div growth (streak) | `continuous_dividend_growth` | · |
| Continuous div payout (streak) | `continuous_dividend_payout` | · |

---

## Example — mixed technical + fundamental scan (India)

```jsonc
// market: "india"
// columns: ["name","close","RSI","RSI|1W","return_on_equity_fy",
//           "total_revenue_yoy_growth_fy","Perf.6M","sector"]
// filter:
[
  { "left": "market_cap_basic",             "operation": "greater", "right": 1e11 },
  { "left": "return_on_equity_fy",           "operation": "greater", "right": 15   },
  { "left": "total_revenue_yoy_growth_fy",   "operation": "greater", "right": 20   },
  { "left": "RSI|1W",                        "operation": "less",    "right": 60   }
]
```

## Regenerating this reference

The counts and value menus above are derived from the live metainfo:

```bash
curl -s "https://scanner.tradingview.com/america/metainfo" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); \
  print(len(d['fields']), 'columns')"
```

The schema is global, so `america` and `india` return identical field sets.
