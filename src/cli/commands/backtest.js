import { register } from '../router.js';
import * as core from '../../core/backtest.js';

register('backtest', {
  description: 'Strategy Tester: results, trades, equity, properties, date range, optimize',
  subcommands: new Map([
    ['results', {
      description: 'Get strategy performance metrics (all/long/short buckets)',
      options: {
        entity: { type: 'string', short: 'e', description: 'Strategy entity ID (default: first strategy on chart)' },
      },
      handler: (opts) => core.getStrategyResults({ entity_id: opts.entity }),
    }],
    ['trades', {
      description: 'Get the trade list (most recent window) or aggregate stats',
      options: {
        max: { type: 'string', short: 'n', description: 'Max trades to return (default 20, cap 500)' },
        offset: { type: 'string', short: 'o', description: 'Skip N trades counting back from the most recent' },
        summary: { type: 'boolean', short: 's', description: 'Aggregate stats (win rate, long/short split) instead of the list' },
        entity: { type: 'string', short: 'e', description: 'Strategy entity ID' },
      },
      handler: (opts) => core.getTrades({
        max_trades: opts.max ? Number(opts.max) : undefined,
        offset: opts.offset ? Number(opts.offset) : undefined,
        summary: opts.summary,
        entity_id: opts.entity,
      }),
    }],
    ['equity', {
      description: 'Get the equity curve (per closed trade, with buy&hold)',
      options: {
        points: { type: 'string', short: 'p', description: 'Max curve points (default 100)' },
        entity: { type: 'string', short: 'e', description: 'Strategy entity ID' },
      },
      handler: (opts) => core.getEquity({
        max_points: opts.points ? Number(opts.points) : undefined,
        entity_id: opts.entity,
      }),
    }],
    ['props', {
      description: 'Get strategy properties (initial capital, commission, slippage, …)',
      options: {
        entity: { type: 'string', short: 'e', description: 'Strategy entity ID' },
      },
      handler: (opts) => core.getProperties({ entity_id: opts.entity }),
    }],
    ['set-props', {
      description: `Set strategy properties (waits for recalc). Usage: tv backtest set-props '{"commission_value":0.05}'. Keys: ${Object.keys(core.STRATEGY_PROPERTY_IDS).join(', ')}`,
      options: {
        entity: { type: 'string', short: 'e', description: 'Strategy entity ID' },
        timeout: { type: 'string', short: 't', description: 'Max ms to wait for recalc (default 30000)' },
      },
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Properties JSON required. Usage: tv backtest set-props \'{"initial_capital":100000}\'');
        return core.setProperties({
          properties: positionals[0],
          entity_id: opts.entity,
          timeout_ms: opts.timeout ? Number(opts.timeout) : undefined,
        });
      },
    }],
    ['range', {
      description: 'Deep-backtest an explicit date range. Usage: tv backtest range 2024-01-01 2024-12-31 | --preset last_365d | --reset',
      options: {
        preset: { type: 'string', short: 'p', description: 'last_7d, last_30d, last_90d, last_365d, entire_history' },
        reset: { type: 'boolean', short: 'r', description: 'Leave deep-backtest mode (back to the chart report)' },
        timeout: { type: 'string', short: 't', description: 'Max ms to wait for the deep report (default 60000)' },
      },
      handler: (opts, positionals) => core.setBacktestRange({
        action: opts.reset ? 'reset' : undefined,
        from: positionals[0],
        to: positionals[1],
        preset: opts.preset,
        timeout_ms: opts.timeout ? Number(opts.timeout) : undefined,
      }),
    }],
    ['optimize', {
      description: 'Parameter sweep. Usage: tv backtest optimize \'{"Swing length":[30,50,70]}\' [--metric netProfit]',
      options: {
        metric: { type: 'string', short: 'm', description: 'Rank by: netProfit, profitFactor, percentProfitable, sharpeRatio, maxStrategyDrawDown, …' },
        max: { type: 'string', short: 'n', description: 'Combination cap (default 30, hard cap 100)' },
        entity: { type: 'string', short: 'e', description: 'Strategy entity ID' },
        timeout: { type: 'string', short: 't', description: 'Max ms per combination (default 45000)' },
      },
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Grid JSON required. Usage: tv backtest optimize \'{"ATR stop multiplier":[1.5,2,2.5]}\'');
        return core.optimize({
          grid: positionals[0],
          metric: opts.metric,
          max_combinations: opts.max ? Number(opts.max) : undefined,
          entity_id: opts.entity,
          timeout_ms: opts.timeout ? Number(opts.timeout) : undefined,
        });
      },
    }],
  ]),
});
