/**
 * MCP tool wrappers for the direct REST screener (scanner.tradingview.com).
 *
 * Five tools:
 *   - screener_query       : run a filter against the public scanner endpoint
 *   - screener_fields      : list known column / filter field names (flat, legacy)
 *   - screener_ops         : list filter operators
 *   - screener_catalog     : browse the structured field catalog by category/search
 *   - screener_field_info  : resolve + optionally live-validate a single field
 *
 * These are independent of the UI-dialog screener tools (screener_open /
 * screener_get / etc.). Use this family when you want to ask the LLM /
 * scripts to mine the market without depending on the floating dialog.
 */
import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/screener_query.js';
import * as catalog from '../core/screener_catalog.js';

const filterClauseSchema = z.object({
  left: z.string().describe('Field name (e.g., "market_cap_basic", "RSI", "close")'),
  operation: z.string().describe('One of: greater, egreater, less, eless, equal, nequal, in_range, not_in_range, match, nmatch, empty, nempty'),
  right: z.any().describe('Right-hand value. Number, string, or [min,max] for in_range.'),
});

const sortSchema = z.object({
  sortBy: z.string().describe('Field name to sort by'),
  sortOrder: z.enum(['asc', 'desc']).optional().describe('Default: desc'),
});

export function registerScreenerQueryTools(server) {
  server.tool(
    'screener_query',
    'Run a screener query directly against TradingView\'s public scanner REST endpoint. Bypasses the UI dialog — works even when screener_open fails. Auto-detects market from current chart symbol if not specified. Returns up to 500 rows. Example: filter=[{left:"RSI",operation:"less",right:30},{left:"market_cap_basic",operation:"greater",right:1e10}], sort={sortBy:"volume",sortOrder:"desc"}.',
    {
      market: z.string().optional().describe('Market slug: america, india, crypto, forex, uk, germany, japan, ... Defaults to the exchange of the current chart symbol.'),
      columns: z.array(z.string()).optional().describe('Field names to return. Default: name, close, change, volume, market_cap_basic, sector. Use screener_fields to discover available fields.'),
      filter: z.array(filterClauseSchema).optional().describe('Filter clauses, AND\'d together. Each clause: {left: fieldName, operation: opName, right: value}.'),
      sort: sortSchema.optional().describe('Sort spec: {sortBy: field, sortOrder: "asc"|"desc"}.'),
      range: z.array(z.number()).length(2).optional().describe('[start, end] row indices. Window capped at 500 rows. Default: [0, 100].'),
    },
    async (args) => {
      try { return jsonResult(await core.query(args)); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'screener_fields',
    'List known column / filter field names for screener_query, with one-line descriptions. Curated — TradingView\'s scanner has thousands of fields, this is the subset most queries use. Pass any field name to screener_query.columns or screener_query.filter[].left even if it\'s not in this list; unknown fields just return null.',
    {},
    async () => {
      try {
        return jsonResult({
          success: true,
          count: Object.keys(core.FIELDS_CATALOG).length,
          fields: core.FIELDS_CATALOG,
        });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'screener_ops',
    'List filter operators (operation field) accepted by screener_query, with descriptions. Use these for the filter[].operation parameter.',
    {},
    async () => {
      try {
        return jsonResult({
          success: true,
          operations: core.FILTER_OPERATIONS,
          markets_known: core.KNOWN_MARKETS,
        });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'screener_catalog',
    'Browse the structured screener field catalog — the ~260 scannable concepts organized into the 8 categories TradingView\'s UI uses (security_info, market_data, technicals, valuation, financials, margins, growth, dividends). Unlike screener_fields (a flat ~70-field list), each concept shows its allowed VALUES: the length/timeframe for technicals (RSI takes 2..30 + any of 9 timeframes), the window for market data (Perf.6M), the reporting period for fundamentals (net_income_ttm). Pass category to focus one group, search to substring-match concepts (e.g. "margin", "rsi"), verbose to expand every concrete column name. Returns a naming block explaining how to assemble a column (e.g. RSI7|60). Static — no network. Use screener_field_info to live-validate a specific field.',
    {
      category: z.enum(catalog.CATEGORIES).optional().describe('Restrict to one UI category.'),
      search: z.string().optional().describe('Substring filter across concept labels / fields / descriptions.'),
      verbose: z.boolean().optional().describe('Include the full expanded column list (all length×timeframe / period variants) per concept.'),
    },
    async (args) => {
      try { return jsonResult(catalog.catalogView(args || {})); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    }
  );

  server.tool(
    'screener_field_info',
    'Resolve a single screener field to its concept: category, type, description, the concrete columns it covers, its value menu, and up to 12 example column names. Pass market (e.g. "america", "india") to LIVE-VALIDATE against TradingView\'s real metainfo endpoint — confirms the exact field exists and reports how many of the concept\'s columns are present for that market. Works for any field, even ones absent from the curated catalog (known:false, still live-checkable). Use this to verify a hand-built column like "RSI7|60" or "return_on_equity_fy" before putting it in a screener_query.',
    {
      field: z.string().describe('A field/column name, e.g. "RSI", "RSI7|60", "net_income_ttm", "Perf.6M".'),
      market: z.string().optional().describe('If set, live-validate against this market\'s scanner schema (schema is global; defaults to america when omitted-but-requested).'),
    },
    async (args) => {
      try {
        const { field, market } = args || {};
        return jsonResult(await catalog.fieldInfo(field, market));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );
}
