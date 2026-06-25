# Futures & Options (F&O)

Three tools that read derivatives data straight from TradingView's public
scanner (`scanner.tradingview.com/<options|futures>/scan`), run as an in-page
`fetch()` over CDP — same path as the screener, no UI required. All three
auto-detect the underlying/root from the current chart symbol; pass
`underlying=` / `root=` to override.

| Tool | Purpose |
|------|---------|
| `options_expirations` | List upcoming expiries for an underlying (pick one before pulling a chain) |
| `options_chain` | Strikes × call/put with greeks + IV for one expiry |
| `futures_curve` | Nearest contract month(s) for a root; `months` for the full term structure + contango/backwardation |

## options_expirations

Cheap discovery call. Expired contracts are excluded.

**Params:** `underlying?` (exchange-qualified, e.g. `NSE:NIFTY`; defaults to chart symbol).

```json
{
  "success": true, "underlying": "NSE:NIFTY", "spot": 23989.15,
  "strike_range": { "min": 15000, "max": 33000 },
  "total_contracts": 3975, "count": 17,
  "expirations": [
    { "expiration": 20260623, "days_to_expiry": 6, "strikes": 230, "calls": 230, "puts": 230 }
  ]
}
```

## options_chain

Defaults to the **nearest upcoming** expiry and an **ATM-centered** strike window.

**Params:**
- `underlying?` — exchange-qualified; defaults to chart symbol. A futures symbol with no chain falls back to its cash root (`NSE:NIFTY1!` → `NSE:NIFTY`).
- `expiration?` — `YYYYMMDD` (e.g. `20260623`). Default: nearest upcoming.
- `option_type?` — `"call"` | `"put"` | `"both"` (default `"both"`, calls+puts merged per strike).
- `strikes?` — count centered on ATM (default `17`, i.e. ATM ±8; `0` = all).
- `min_strike?` / `max_strike?` — explicit strike bounds (override `strikes`).

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

For `option_type: "call"`/`"put"`, the result is a flat `options: [...]` array instead of merged `strikes`.

**Size handling.** A request is funneled so context stays small even for deep chains (NSE:NIFTY ≈ 4.4k contracts): the scanner is filtered server-side to one underlying + one expiry; only that expiry's ladder crosses CDP; output is then windowed to `strikes` (default 17 = ATM ±8). `strikes: 0` returns the full ladder up to a hard ceiling of **250 strikes** nearest ATM — when that trips, the result carries `strikes_capped: 250`, `truncated: true` and a `note`. Use `options_expirations` (≈1.6 KB) to browse expiries rather than widening the chain.

## futures_curve

Defaults to **just the next expiry**. Pass `months` for more (or `0` for the full curve + term-structure analysis).

**Params:**
- `root?` — `EXCHANGE:CODE` (e.g. `NYMEX:CL`, `CME_MINI:ES`, `NSE:NIFTY`). Overrides detection.
- `symbol?` — any contract/continuous symbol to derive the root from; defaults to chart symbol. `NYMEX:CL1!` and `NYMEX:CLF2027` both → `NYMEX:CL`.
- `months?` — number of nearest contract months to return (default `1`; `0` = full curve).

```json
// futures_curve({ root: "NYMEX:CL" })  → next expiry only (~0.4 KB)
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
