/**
 * MCP tool wrappers for Futures & Options data, served straight from
 * TradingView's public scanner REST endpoint (see core/fno.js).
 *
 * Three tools:
 *   - options_chain        : strikes × call/put with greeks + IV for an expiry
 *   - options_expirations  : cheap discovery — list expiries before pulling a chain
 *   - futures_curve        : the nearest contract month(s) for a root (term structure via months=)
 *
 * Like the screener_query family, these bypass the UI entirely and auto-detect
 * the underlying / root from the current chart symbol when not specified.
 */
import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/fno.js';
import { withTarget } from '../connection.js';

const targetIdParam = z.string().optional().describe('Optional CDP target id from target_list/tv_health_check. The chart symbol is auto-detected from that TradingView window/tab when underlying/symbol is omitted.');

export function registerFnoTools(server) {
  server.tool(
    'options_chain',
    'Get the option chain for an underlying from TradingView\'s scanner — strikes with call and put bid/ask/last/volume, greeks (delta, gamma, theta, vega, rho) and implied volatility (iv_pct), merged per strike. Auto-detects the underlying from the current chart symbol, defaults to the NEAREST upcoming expiration, and returns an ATM-centered window of strikes. Use options_expirations first to pick an expiration. Note: IV is a percentage; TradingView does not expose open interest.',
    {
      underlying: z.string().optional().describe('Underlying symbol, exchange-qualified (e.g. "NSE:BPCL", "NASDAQ:AAPL"). Defaults to the current chart symbol.'),
      expiration: z.number().int().optional().describe('Expiration as YYYYMMDD (e.g. 20260630). Default: nearest upcoming expiration.'),
      strikes: z.number().int().optional().describe('Number of strikes centered on ATM to return. Default 17 (ATM ±8). Pass 0 for all (hard-capped at 250 nearest ATM).'),
      target_id: targetIdParam,
    },
    async ({ target_id, ...args }) => {
      try { return jsonResult(await withTarget(target_id, () => core.optionsChain(args))); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'options_expirations',
    'List upcoming option expirations for an underlying (expired ones excluded), with days-to-expiry, strike counts (calls/puts), the underlying spot price and overall strike range. Returns the nearest 4 expiries by default. Discovery call — use it to choose an expiration before pulling a full chain with options_chain. Auto-detects the underlying from the current chart symbol; a futures symbol falls back to its cash root.',
    {
      underlying: z.string().optional().describe('Underlying symbol, exchange-qualified (e.g. "NSE:BPCL", "NASDAQ:AAPL"). Defaults to the current chart symbol.'),
      limit: z.number().int().optional().describe('How many nearest expiries to return. Default 4. Pass 0 for all upcoming.'),
      target_id: targetIdParam,
    },
    async ({ target_id, ...args }) => {
      try { return jsonResult(await withTarget(target_id, () => core.expirations(args))); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'futures_curve',
    'Get the nearest futures contract month(s) for a root from TradingView\'s scanner — each contract with expiration, last price, % change and days-to-expiry. Defaults to just the next expiry; pass months>1 (or 0 for the full curve) to get the term structure with front/back contracts and contango/backwardation. Auto-detects from the current chart symbol; continuous like "NYMEX:CL1!" and dated like "NYMEX:CLF2027" both resolve to root "NYMEX:CL".',
    {
      symbol: z.string().optional().describe('A futures root (EXCHANGE:CODE, e.g. "NYMEX:CL", "CME_MINI:ES", "NSE:BPCL") or any contract/continuous symbol (e.g. "NYMEX:CL1!", "MCX:GOLD1!") — the root is derived automatically. Defaults to the current chart symbol.'),
      months: z.number().int().optional().describe('How many nearest contract months to return. Default 1 (next expiry only). Pass 0 for the full curve.'),
      target_id: targetIdParam,
    },
    async ({ target_id, ...args }) => {
      try { return jsonResult(await withTarget(target_id, () => core.futuresCurve(args))); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
