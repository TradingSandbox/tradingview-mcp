/**
 * MCP tool wrapper for fundamental analysis, served straight from TradingView's
 * public scanner REST endpoint (see core/fundamentals.js).
 *
 * One tool:
 *   - fundamentals_get : valuation / profitability / growth / health / dividends
 *                        / per-share snapshot for one symbol
 *
 * Like the screener_query and F&O families, this bypasses the UI entirely and
 * auto-detects the symbol from the current chart when not specified.
 */
import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/fundamentals.js';
import { withTarget } from '../connection.js';

const targetIdParam = z.string().optional().describe('Optional CDP target id from target_list/tv_health_check. The chart symbol is auto-detected from that TradingView window/tab when symbol is omitted.');

export function registerFundamentalsTools(server) {
  server.tool(
    'fundamentals_get',
    'Get a company fundamentals snapshot for a symbol from TradingView\'s scanner — valuation (market cap, enterprise value, P/E, PEG, P/B, P/S, P/FCF, EV/EBITDA, beta), profitability margins and returns (gross/operating/net/FCF margin, ROE, ROA, ROIC — all percentages), growth (revenue & EPS YoY %), financial health (debt/equity, current & quick ratio), dividends (yield %, payout %, per-share), per-share metrics (diluted/basic EPS, book value), sector/industry classification and the next earnings date. Auto-detects the symbol from the current chart; pass symbol= to override.',
    {
      symbol: z.string().optional().describe('Symbol, exchange-qualified (e.g. "NASDAQ:AAPL", "NSE:BPCL"). Defaults to the current chart symbol.'),
      target_id: targetIdParam,
    },
    async ({ target_id, ...args }) => {
      try { return jsonResult(await withTarget(target_id, () => core.fundamentals(args))); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
