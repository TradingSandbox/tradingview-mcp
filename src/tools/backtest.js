import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/backtest.js';
import { withTarget } from '../connection.js';

const targetIdParam = z.string().optional().describe('Optional CDP target id from target_list/tv_health_check. Runs this command against that TradingView window/tab.');
const entityIdParam = z.string().optional().describe('Strategy entity ID (from chart_get_state). Omit to use the first strategy on the chart.');

export function registerBacktestTools(server) {
  server.tool('strategy_get_properties', 'Read the strategy\'s backtest properties: initial capital, base currency, commission type/value, slippage, default order qty, pyramiding, margin, bar magnifier, etc. These are the Properties-tab settings, separate from the script\'s own inputs.', {
    entity_id: entityIdParam,
    target_id: targetIdParam,
  }, async ({ entity_id, target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.getProperties({ entity_id }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('strategy_set_properties', `Change the strategy's backtest properties and wait for the recalculation. Keys: ${Object.keys(core.STRATEGY_PROPERTY_IDS).join(', ')}. Example: {"initial_capital": 100000, "commission_type": "percent", "commission_value": 0.05, "slippage": 2}`, {
    properties: z.string().describe('JSON object of property overrides, e.g. \'{"initial_capital": 100000, "commission_value": 0.05}\''),
    entity_id: entityIdParam,
    timeout_ms: z.coerce.number().optional().describe('Max ms to wait for the strategy to recalculate (default 30000)'),
    target_id: targetIdParam,
  }, async ({ properties, entity_id, timeout_ms, target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.setProperties({ properties, entity_id, timeout_ms }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('strategy_set_backtest_range', 'Run the strategy over an EXPLICIT date range (TradingView Deep Backtesting) instead of whatever bars the chart happens to have loaded. After this completes, data_get_strategy_results / data_get_trades / data_get_equity read the deep report. Pass from+to, or a preset, or action="reset" to return to the normal chart backtest.', {
    from: z.string().optional().describe('Range start — ISO date ("2024-01-01") or unix timestamp'),
    to: z.string().optional().describe('Range end — ISO date ("2024-12-31") or unix timestamp'),
    preset: z.string().optional().describe('Shortcut range: last_7d, last_30d, last_90d, last_365d, entire_history'),
    action: z.string().optional().describe('"reset" → leave deep-backtest mode and read the standard chart report again'),
    timeout_ms: z.coerce.number().optional().describe('Max ms to wait for the deep backtest report (default 60000)'),
    target_id: targetIdParam,
  }, async ({ from, to, preset, action, timeout_ms, target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.setBacktestRange({ from, to, preset, action, timeout_ms }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('strategy_optimize', 'Parameter sweep: test every combination of the given input values, collect performance metrics per run, rank them and restore the original inputs. Grid keys match by input name ("Swing length"), id ("in_1"), or strategy property internalID. Runs on the standard chart backtest (not deep mode). Combinations are capped (default 30, hard cap 100) — each one is a full server-side recalculation taking a few seconds.', {
    grid: z.string().describe('JSON object mapping input → array of values, e.g. \'{"Swing length": [30, 50, 70], "ATR stop multiplier": [1.5, 2, 2.5]}\' (9 combinations)'),
    metric: z.string().optional().describe('Metric to rank by (default netProfit). Options: netProfit, netProfitPercent, profitFactor, percentProfitable, sharpeRatio, sortinoRatio, maxStrategyDrawDown (ranked ascending), totalTrades, avgTrade'),
    max_combinations: z.coerce.number().optional().describe('Abort if the grid exceeds this many combinations (default 30, hard cap 100)'),
    entity_id: entityIdParam,
    timeout_ms: z.coerce.number().optional().describe('Max ms to wait per combination (default 45000)'),
    target_id: targetIdParam,
  }, async ({ grid, metric, max_combinations, entity_id, timeout_ms, target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.optimize({ grid, metric, max_combinations, entity_id, timeout_ms }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
