# Futures & Options (F&O)

Three tools that read derivatives data straight from TradingView's public
scanner (`scanner.tradingview.com/<options|futures>/scan`), run as an in-page
`fetch()` over CDP — same path as the screener, no UI required. All three
auto-detect the underlying/root from the current chart symbol; pass
`underlying=` (options) / `symbol=` (futures) to override.

| Tool | Purpose |
|------|---------|
| `options_expirations` | List upcoming expiries for an underlying (pick one before pulling a chain) |
| `options_chain` | Strikes × call/put with greeks + IV for one expiry |
| `futures_curve` | Nearest contract month(s) for a root; `months` for the full term structure + contango/backwardation |

## options_expirations

Cheap discovery call. Expired contracts are excluded. Returns the **nearest 4 expiries** by default.

**Params:**
- `underlying?` — exchange-qualified, e.g. `NSE:NIFTY`; defaults to chart symbol.
- `limit?` — how many nearest expiries to return (default `4`; `0` = all upcoming).

```json
{
  "success": true, "underlying": "NSE:NIFTY", "spot": 24056,
  "strike_range": { "min": 1500, "max": 49500 },
  "total_contracts": 4415, "count": 4, "total_expiries": 18,
  "expirations": [
    { "expiration": 20260630, "days_to_expiry": 4, "strikes": 298, "calls": 297, "puts": 297 }
  ]
}
```

`count` is how many are returned (capped by `limit`); `total_expiries` is how many upcoming expiries exist in total.

## options_chain

Defaults to the **nearest upcoming** expiry and an **ATM-centered** strike window.

**Params:**
- `underlying?` — exchange-qualified; defaults to chart symbol. A futures symbol with no chain falls back to its cash root (`NSE:NIFTY1!` → `NSE:NIFTY`).
- `expiration?` — `YYYYMMDD` (e.g. `20260623`). Default: nearest upcoming.
- `strikes?` — count centered on ATM (default `17`, i.e. ATM ±8; `0` = all).

Calls and puts are always returned merged per strike.

```json
{
  "success": true, "underlying": "NSE:NIFTY", "spot": 23989.15,
  "expiration": 20260623, "days_to_expiry": 6, "atm_strike": 24000,
  "total_for_expiry": 460, "truncated": false,
  "strikes": [
    {
      "strike": 24000, "atm": true, "dist_pct": 0.05,
      "call": { "symbol": "NSE:NIFTY260623C24000", "bid": 158.85, "ask": 158.95,
                "last": null, "volume": null, "iv_pct": 12.11,
                "delta": 0.4928, "gamma": 0.001, "theta": -11.19, "vega": 13.56, "rho": 2.34 },
      "put":  { "symbol": "NSE:NIFTY260623P24000", "bid": 163.1, "ask": 164.8, "iv_pct": 12.11,
                "delta": -0.507, "gamma": 0.001, "theta": -11.19, "vega": 13.56, "rho": -2.48 }
    }
  ]
}
```

**Size handling.** A request is funneled so context stays small even for deep chains (NSE:NIFTY ≈ 4.4k contracts): the scanner is filtered server-side to one underlying + one expiry; only that expiry's ladder crosses CDP; output is then windowed to `strikes` (default 17 = ATM ±8). `strikes: 0` returns the full ladder up to a hard ceiling of **250 strikes** nearest ATM — when that trips, the result carries `strikes_capped: 250`, `truncated: true` and a `note`. Use `options_expirations` (≈1.6 KB) to browse expiries rather than widening the chain.

## futures_curve

Defaults to **just the next expiry**. Pass `months` for more (or `0` for the full curve + term-structure analysis).

**Params:**
- `symbol?` — a futures root (`EXCHANGE:CODE`, e.g. `NYMEX:CL`, `CME_MINI:ES`, `NSE:NIFTY`) **or** any contract/continuous symbol; the root is derived automatically (`NYMEX:CL1!` and `NYMEX:CLF2027` both → `NYMEX:CL`). Defaults to the chart symbol.
- `months?` — number of nearest contract months to return (default `1`; `0` = full curve).

```json
// futures_curve({ symbol: "NYMEX:CL" })  → next expiry only (~0.4 KB)
{
  "success": true, "root": "NYMEX:CL", "currency": "USD",
  "months": 1, "total_available": 127,
  "structure": null, "spread_pct": null,
  "front": { "symbol": "NYMEX:CLQ2026", "expiration": 20260721, "last": 75.36 },
  "back": null,
  "count": 1,
  "contracts": [
    { "symbol": "NYMEX:CLQ2026", "description": "Crude Oil Futures (Aug 2026)",
      "expiration": 20260721, "last": 75.36, "change_pct": 0.12,
      "days_to_expiry": 26, "is_continuous": false }
  ]
}
```

With `months ≥ 2` (or `0`), `structure` compares the front vs back of the returned contracts: `contango` (back > front), `backwardation` (back < front), or `flat`. Only **upcoming** dated contracts are returned; continuous (`…1!`) and expired contracts are excluded. `total_available` reports how many upcoming months exist.

## Notes

- **Symbols must be exchange-qualified**: `NSE:BPCL`, `NSE:NIFTY`, `NASDAQ:AAPL`. US option contracts resolve under `OPRA:`.
- **`iv_pct` is a percentage** (e.g. `12.11` = 12.11%). Greeks are per-contract.
- **No open interest** — TradingView's options feed does not expose OI.
- **`expiration` is a `YYYYMMDD` integer**; `last` is the last traded price (`null` when untraded; `bid`/`ask` are usually present).
- These are **global** tools (like `screener_*`): they hit a REST endpoint, so they take no `target_id`.
