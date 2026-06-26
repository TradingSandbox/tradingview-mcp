# Fundamental Analysis

One tool that reads company fundamentals straight from TradingView's public
scanner (`scanner.tradingview.com/<market>/scan`), run as an in-page `fetch()`
over CDP — same data path as the screener and F&O tools, no UI required. It
auto-detects the symbol from the current chart; pass `symbol=` to override.

| Tool | Purpose |
|------|---------|
| `fundamentals_get` | One-symbol snapshot: valuation, profitability, growth, financial health, dividends, per-share, classification |

## fundamentals_get

**Params:**
- `symbol?` — exchange-qualified, e.g. `NASDAQ:AAPL`, `NSE:BPCL`; defaults to the chart symbol.
- `target_id?` — run against a specific window/tab (symbol auto-detected from it when `symbol` is omitted).

```json
{
  "success": true,
  "symbol": "NASDAQ:AAPL",
  "description": "Apple Inc.",
  "currency": "USD",
  "price": 275.15,
  "classification": { "sector": "Electronic Technology", "industry": "Telecommunications Equipment", "employees": 166000 },
  "valuation": {
    "market_cap": 4041226036283, "market_cap_abbr": "4.04T",
    "enterprise_value": 3680001202400, "enterprise_value_abbr": "3.68T",
    "pe_ttm": 33.28, "peg_ttm": 1.22, "pb": 37.9, "ps": 9.92,
    "pfcf": 31.37, "ev_ebitda": 25.36, "beta": 1.09
  },
  "profitability_pct": { "gross_margin": 47.86, "operating_margin": 32.64, "net_margin": 27.15, "fcf_margin": 28.61, "roe": 141.47, "roa": 34.91, "roic": 75.14 },
  "growth": { "revenue_ttm": 451442000000, "revenue_ttm_abbr": "451.44B", "revenue_yoy_pct": 12.76, "eps_yoy_pct": 29 },
  "health": { "debt_to_equity": 0.8, "current_ratio": 1.07, "quick_ratio": 1.02 },
  "dividends": { "yield_pct": 0.39, "payout_ratio_pct": 12.58, "per_share": 0.26 },
  "per_share": { "eps_diluted_ttm": 8.27, "eps_basic_ttm": 8.3, "book_value": 7.26 },
  "next_earnings_date": "2026-07-30"
}
```

## Notes

- **Percentages are percentages.** Every field under `profitability_pct`, plus
  `revenue_yoy_pct`, `eps_yoy_pct`, `dividends.yield_pct` and
  `dividends.payout_ratio_pct`, is already in percent (`47.86` = 47.86%).
- **`market_cap` / `enterprise_value` are USD-equivalent absolutes**; each comes
  with a compact `*_abbr` string (`"4.04T"`) for readability.
- **Null fields are normal.** Metrics that don't apply to a company (e.g. a P/E
  for a firm with no earnings, dividends for a non-payer) come back `null`.
- **Symbol resolution.** If the chart's exchange prefix doesn't match the
  scanner's canonical listing (e.g. chart `BATS:CDNL` vs scanner `NASDAQ:CDNL`),
  the tool retries by bare ticker and returns the resolved `symbol`, echoing the
  original as `requested_symbol`.
- This is a **global** tool (like `screener_*` and the F&O tools): it hits a
  REST endpoint, so it ignores `target_id` except to pick the window whose chart
  symbol is auto-detected.
