/**
 * MCP tool wrapper for technical analysis, served straight from TradingView's
 * public scanner REST endpoint (see core/technicals.js).
 *
 * One tool:
 *   - technicals_get : oscillators / moving averages / volatility readings plus
 *                      TradingView's overall buy/sell rating for one symbol
 *
 * Like fundamentals_get, this bypasses the UI and auto-detects the symbol from
 * the current chart when not specified. Snapshot data — refreshed periodically,
 * not tick-by-tick (use data_get_study_values for tick-accurate chart readings).
 */
import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/technicals.js';
import { withTarget } from '../connection.js';

const targetIdParam = z.string().optional().describe('Optional CDP target id from target_list/tv_health_check. The chart symbol is auto-detected from that TradingView window/tab when symbol is omitted.');

export function registerTechnicalsTools(server) {
  server.tool(
    'technicals_get',
    'Get a technical-analysis snapshot for a symbol from TradingView\'s scanner — TradingView\'s overall buy/sell rating (Strong Buy/Buy/Neutral/Sell/Strong Sell, with sub-ratings for moving averages and oscillators), oscillators (RSI, RSI7, Stochastic %K/%D, MACD line/signal/hist, CCI, Awesome Oscillator, Momentum, ADX), moving averages (SMA & EMA 20/50/200, VWAP) and volatility (ATR, Bollinger upper/lower). Defaults to the DAILY timeframe; pass timeframe= for intraday/weekly/monthly. Auto-detects the symbol from the current chart; pass symbol= to override. NOTE: scanner data is a periodic snapshot (refreshed ~per-minute, plus any subscription delay), not tick-by-tick — use data_get_study_values for tick-accurate readings of indicators already on the chart.',
    {
      symbol: z.string().optional().describe('Symbol, exchange-qualified (e.g. "NASDAQ:AAPL", "NSE:BPCL"). Defaults to the current chart symbol.'),
      timeframe: z.string().optional().describe('Resolution for the readings: minutes "1"/"5"/"15"/"30"/"60"/"120"/"240", "D" (daily, default), "W" (weekly) or "M" (monthly).'),
      target_id: targetIdParam,
    },
    async ({ target_id, ...args }) => {
      try { return jsonResult(await withTarget(target_id, () => core.technicals(args))); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
