/**
 * MCP tool wrappers for news, served from TradingView's public news service
 * (see core/news.js).
 *
 * Two tools:
 *   - news_list : recent headlines for a symbol (cheap; ids + titles only)
 *   - news_read : the full story body for one headline id (lazy — keeps
 *                 news_list small)
 *
 * Auto-detects the symbol from the current chart when not specified.
 */
import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/news.js';
import { withTarget } from '../connection.js';

const targetIdParam = z.string().optional().describe('Optional CDP target id from target_list/tv_health_check. The chart symbol is auto-detected from that TradingView window/tab when symbol is omitted.');

export function registerNewsTools(server) {
  server.tool(
    'news_list',
    'List recent news headlines for a symbol from TradingView — each with an id, title, provider, publish time + relative age, urgency and related symbols. Returns headlines only (no article bodies) so it stays cheap; use news_read with an id to fetch a full story. Works for stocks, futures, forex, crypto and international symbols. Auto-detects the symbol from the current chart; pass symbol= to override.',
    {
      symbol: z.string().optional().describe('Symbol, exchange-qualified (e.g. "NASDAQ:AAPL", "BINANCE:BTCUSDT"). Defaults to the current chart symbol.'),
      limit: z.number().int().optional().describe('Max headlines to return. Default 20, hard cap 50.'),
      target_id: targetIdParam,
    },
    async ({ target_id, ...args }) => {
      try { return jsonResult(await withTarget(target_id, () => core.newsList(args))); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'news_read',
    'Read the full body of one news story by its id (obtained from news_list) — returns the article text (flattened to plain text), provider, publish time, estimated read time, tags and related symbols. Fetch headlines with news_list first, then pass a headline id here.',
    {
      id: z.string().describe('Story id from a news_list headline (e.g. "tag:reuters.com,2026:newsml_...").'),
      target_id: targetIdParam,
    },
    async ({ target_id, ...args }) => {
      try { return jsonResult(await withTarget(target_id, () => core.newsRead(args))); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );
}
