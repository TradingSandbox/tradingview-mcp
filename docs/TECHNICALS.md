# Technical Analysis

One tool that reads indicator values and TradingView's own buy/sell ratings for
a single symbol straight from the public scanner
(`scanner.tradingview.com/<market>/scan`), run as an in-page `fetch()` over CDP
— same data path as `fundamentals_get`, no UI required. Auto-detects the symbol
from the current chart; pass `symbol=` to override.

| Tool | Purpose |
|------|---------|
| `technicals_get` | One-symbol snapshot: TradingView rating, oscillators, moving averages, volatility |

## technicals_get

**Params:**
- `symbol?` — exchange-qualified, e.g. `NASDAQ:AAPL`, `NSE:BPCL`; defaults to the chart symbol.
- `timeframe?` — resolution: minutes `"1"`/`"5"`/`"15"`/`"30"`/`"60"`/`"120"`/`"240"`, `"D"` (daily, default), `"W"` (weekly), `"M"` (monthly).
- `target_id?` — run against a specific window/tab (symbol auto-detected from it when `symbol` is omitted).

```json
{
  "success": true,
  "symbol": "NASDAQ:AAPL",
  "timeframe": "1D",
  "price": 275.15,
  "rating": {
    "overall":         { "score": -0.515, "signal": "Strong Sell" },
    "moving_averages": { "score": -0.667, "signal": "Strong Sell" },
    "oscillators":     { "score": -0.364, "signal": "Sell" }
  },
  "oscillators": {
    "rsi": 32.2, "rsi7": 19.25, "stoch_k": 15.08, "stoch_d": 23.32,
    "macd": -1.588, "macd_signal": 1.1993, "macd_hist": -2.7872,
    "cci": -182.22, "ao": -5.7699, "momentum": -16.43, "adx": 23.92
  },
  "moving_averages": { "sma20": 299.72, "sma50": 291.15, "sma200": 269.21, "ema20": 295.44, "ema50": 290.26, "ema200": 267.79, "vwap": 279.23 },
  "volatility": { "atr": 7.88, "bb_upper": 319, "bb_lower": 280.45 }
}
```

The three `rating` blocks are TradingView's own composite recommendations
(`Recommend.All` / `Recommend.MA` / `Recommend.Other`), each a score in
`[-1, 1]` mapped to a signal with TV's thresholds:

| Score | Signal |
|-------|--------|
| `≥ 0.5` | Strong Buy |
| `0.1 … 0.5` | Buy |
| `-0.1 … 0.1` | Neutral |
| `-0.5 … -0.1` | Sell |
| `≤ -0.5` | Strong Sell |

## Notes

- **Snapshot, not real-time.** Scanner technicals are refreshed periodically
  (≈ per-minute during market hours), not tick-by-tick, and are subject to your
  data subscription's exchange delay. For tick-accurate readings of an indicator
  that's **on the chart**, use `data_get_study_values` instead.
- **Timeframe defaults to daily.** Bare numbers are minutes (TradingView
  convention): `"1"` = 1-minute, `"60"` = 1-hour. `"D"`/`"W"`/`"M"` are
  day/week/month. (`"1M"` = one month, not one minute.)
- **Null fields are normal** — an indicator that doesn't compute for a symbol /
  timeframe (e.g. VWAP on higher timeframes, MAs on a young listing) comes back
  `null`.
- **Symbol resolution.** Like `fundamentals_get`, a chart exchange prefix that
  doesn't match the scanner listing (`BATS:CDNL` → `NASDAQ:CDNL`) auto-resolves
  and echoes the original as `requested_symbol`. Exchanges that aren't in the
  market map (e.g. **MCX** commodity futures) resolve via the scanner's `global`
  superset market, so `MCX:GOLD1!`, `MCX:CRUDEOIL1!` etc. work.
- This is a **global** tool: it hits a REST endpoint, so `target_id` only
  selects the window whose chart symbol is auto-detected.
