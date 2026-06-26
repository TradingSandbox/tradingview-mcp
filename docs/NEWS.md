# News

Two tools that read symbol/market news from TradingView's public news service
(`news-headlines.tradingview.com`), run as an in-page `fetch()` over CDP — no
UI required. Both auto-detect the symbol from the current chart; pass `symbol=`
to override.

| Tool | Purpose |
|------|---------|
| `news_list` | Recent headlines for a symbol (ids + titles only — cheap) |
| `news_read` | Full article body for one headline id (lazy — keeps `news_list` small) |

## news_list

Returns headlines only — no article bodies — so it stays cheap. Use a returned
`id` with `news_read` to pull a full story. Works across stocks, futures,
forex, crypto and international symbols (no `category` param needed).

**Params:**
- `symbol?` — exchange-qualified, e.g. `NASDAQ:AAPL`, `BINANCE:BTCUSDT`; defaults to the chart symbol.
- `limit?` — max headlines (default `20`, hard cap `50`).
- `target_id?` — symbol auto-detected from that window/tab when `symbol` is omitted.

```json
{
  "success": true, "symbol": "NASDAQ:AAPL", "count": 5,
  "headlines": [
    {
      "id": "tag:reuters.com,2026:newsml_L6N42Y0EY:0",
      "title": "Europe before the bell: Shaky sentiment",
      "provider": "reuters",
      "published": "2026-06-26T06:44:12.000Z",
      "age": "27m",
      "urgency": 2,
      "symbols": ["NASDAQ:AAPL", "KRX:KOSPI", "TVC:NI225", "EUREX:FESX1!", "BMFBOVESPA:DAX1!", "ICEEUR:Z1!"]
    }
  ]
}
```

`age` is a compact relative string (`"27m"`, `"1h"`, `"3d"`). `urgency` is
TradingView's own priority flag (lower = more urgent / breaking).

## news_read

**Params:**
- `id` — a story id from a `news_list` headline (required).
- `target_id?` — optional window/tab.

```json
{
  "success": true,
  "id": "tag:reuters.com,2026:newsml_L6N42Y0EY:0",
  "title": "Europe before the bell: Shaky sentiment",
  "provider": "Reuters",
  "published": "2026-06-26T06:44:12.000Z",
  "read_time": 70,
  "tags": ["Indices", "Management", "Reuters"],
  "symbols": ["NASDAQ:AAPL", "KRX:KOSPI", "TVC:NI225"],
  "body": "EUROPE BEFORE THE BELL: SHAKY SENTIMENT\n\nEuropean stock index futures are soft on Friday…"
}
```

## Notes

- **Headlines first, bodies on demand.** `news_list` never returns article text;
  always go through `news_read` for the full story so `news_list` stays small.
- **`body` is flattened plain text** from TradingView's rich-text AST; inline
  symbol references render as their ticker (e.g. `NASDAQ:AAPL`). Falls back to
  the short description if a story has no rich body.
- **No `category` needed** — `news_list` works for any asset class with just the
  symbol.
- These are **global** tools: they hit a REST endpoint, so `target_id` only
  selects the window whose chart symbol is auto-detected.
