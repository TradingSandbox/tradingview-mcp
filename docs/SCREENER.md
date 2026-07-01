# Screener

Three tools that query TradingView's public scanner
(`scanner.tradingview.com/<market>/scan`) directly, run as an in-page `fetch()`
over CDP — no UI dialog required, so they work even when the floating Screener
won't open. `screener_query` auto-detects the market from the current chart
symbol's exchange; pass `market=` to override.

| Tool | Purpose |
|------|---------|
| `screener_query` | Run a filter/sort against the scanner and return matching rows |
| `screener_fields` | List known column/filter field names (flat, curated ~70) |
| `screener_ops` | List filter operators + known market slugs |
| `screener_catalog` | Browse the structured field catalog by category / search (concepts + value menus) |
| `screener_field_info` | Resolve one field + optionally live-validate it against the scanner |

## screener_query

**Params:**
- `market?` — slug: `america`, `india`, `crypto`, `forex`, `options`, `futures`, … Defaults to the exchange of the current chart symbol.
- `columns?` — field names to return. Default: `name, close, change, volume, market_cap_basic, sector`.
- `filter?` — array of clauses, AND'd together: `{ left: field, operation: op, right: value }`.
- `sort?` — `{ sortBy: field, sortOrder: "asc" | "desc" }` (default `desc`).
- `range?` — `[start, end]` row indices. Window capped at **500** rows. Default `[0, 100]`.

```jsonc
// filter=[{left:"RSI",operation:"less",right:30},
//         {left:"market_cap_basic",operation:"greater",right:1e10}]
// sort={sortBy:"volume",sortOrder:"desc"}
{
  "success": true, "market": "america", "total": 73, "count": 73,
  "columns": ["symbol", "name", "close", "change", "volume", "market_cap_basic", "sector"],
  "rows": [
    { "symbol": "NASDAQ:INTC", "name": "INTC", "close": 19.84, "change": -1.2,
      "volume": 51200000, "market_cap_basic": 8.6e10, "sector": "Electronic Technology" }
  ]
}
```

Rows map each scanner column to a named field (plus `symbol`), so you never index by position.

## screener_fields

Lists the curated `FIELDS_CATALOG` (name → one-line description). TradingView's
scanner has thousands of fields; this is the subset most queries use. Any field
name works in `columns` / `filter[].left` even if absent here — unknown fields
just return `null`.

For the **full field reference** — all 3,770 columns organised by the 8 UI
categories, with the length / timeframe / reporting-period values each attribute
accepts — see [SCREENER_FIELDS.md](SCREENER_FIELDS.md).

```json
{ "success": true, "count": 70,
  "fields": { "close": "Last traded price", "RSI": "Relative Strength Index (14)", "...": "..." } }
```

## screener_catalog

Browses the **structured** field catalog — the ~260 scannable concepts grouped
into the 8 categories TradingView's UI uses. Unlike `screener_fields` (a flat
list), each concept carries its allowed **values**: length/timeframe for
technicals (`RSI` → 2..30 × 9 timeframes), window for market data (`Perf.6M`),
reporting period for fundamentals (`net_income_ttm`). Static — no network.

**Params:** `category?` (one of the 8), `search?` (substring), `verbose?`
(expand every concrete column name). The response includes a `naming` block
explaining how to assemble a column such as `RSI7|60`.

## screener_field_info

Resolves a single field to its concept (category, type, value menu, example
columns). Pass `market` to **live-validate** against `scanner.tradingview.com/<market>/metainfo`
— confirms the exact column exists and reports how many of the concept's
columns are present. Works for fields absent from the curated catalog too
(`known:false`, still live-checkable). Use it to verify a hand-built column
before dropping it into `screener_query`.

See [SCREENER_FIELDS.md](SCREENER_FIELDS.md) for the full field reference.

## screener_ops

Lists the filter operators and the known market slugs.

```json
{
  "success": true,
  "operations": {
    "greater": "Numeric: left > right", "egreater": "Numeric: left >= right",
    "less": "Numeric: left < right", "in_range": "Numeric range: right is [min, max]",
    "match": "String contains (case-insensitive)", "empty": "Field is null/missing", "...": "..."
  },
  "markets_known": ["america", "india", "crypto", "forex", "options", "futures", "..."]
}
```

## Notes

- **Multi-part field names use DOTS, not underscores**: `Perf.1M`, `Stoch.K`, `MACD.macd`, `BB.lower`, `Volatility.W`. The underscore variants are rejected with `Unknown field`.
- **Errors are surfaced verbatim**: a rejected query returns the scanner's own message (e.g. naming the exact bad field/operator) so you can fix it without guessing.
- **`in_range` / `not_in_range`** take `right: [min, max]`. `crosses*` / `above` / `below` are streaming-only.
- For derivatives, prefer the dedicated [F&O tools](FUTURES_OPTIONS.md) (`options_chain`, `futures_curve`) over the raw `options` / `futures` markets — they add greeks, ATM windowing, and term-structure analysis.
- These are **global** tools: they hit a REST endpoint, so they take no `target_id`.
