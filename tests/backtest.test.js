/**
 * Tests for src/core/backtest.js — pure shaping helpers + mock-driven behaviors.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapTrade, summarizeTrades, downsample, shapeMetrics, gridCombos,
  getTrades, getEquity, setProperties, optimize, resolveOptimizeRange,
  STRATEGY_PROPERTY_IDS, MAX_TRADES_LIMIT,
} from '../src/core/backtest.js';

// ── Fixtures ─────────────────────────────────────────────────────────────

const rawTrade = (over = {}) => ({
  e: { c: 'Long', p: 100, tm: 1000, b: 1, tp: 'le' },
  x: { c: 'Long X', p: 110, tm: 2000, b: 5, tp: 'lx' },
  q: 10,
  tp: { v: 100, p: 0.1 },
  cp: { v: 100, p: 0.001 },
  rn: { v: 120, p: 0.12 },
  dd: { v: 20, p: 0.02 },
  v: 1000,
  ...over,
});

// ── mapTrade ─────────────────────────────────────────────────────────────

describe('mapTrade()', () => {
  it('maps entry/exit/qty and converts fraction percents', () => {
    const t = mapTrade(rawTrade(), 0);
    assert.equal(t.side, 'long');
    assert.equal(t.entry.price, 100);
    assert.equal(t.exit.price, 110);
    assert.equal(t.qty, 10);
    assert.equal(t.profit, 100);
    assert.equal(t.profit_pct, 10);
    assert.equal(t.runup_pct, 12);
    assert.equal(t.drawdown_pct, 2);
    assert.equal(t.open, false);
  });

  it('marks short trades and open trades', () => {
    const t = mapTrade(rawTrade({ e: { c: 'Short', p: 100, tm: 1, b: 1, tp: 'se' }, x: undefined }), 3);
    assert.equal(t.side, 'short');
    assert.equal(t.open, true);
    assert.equal(t.exit, null);
    assert.equal(t.index, 3);
  });
});

// ── summarizeTrades ──────────────────────────────────────────────────────

describe('summarizeTrades()', () => {
  it('computes wins/losses/win rate and side buckets', () => {
    const trades = [
      mapTrade(rawTrade(), 0),                                          // +100 long
      mapTrade(rawTrade({ tp: { v: -50, p: -0.05 } }), 1),              // -50 long
      mapTrade(rawTrade({ e: { c: 'S', p: 1, tm: 1, b: 1, tp: 'se' }, tp: { v: 30, p: 0.03 } }), 2), // +30 short
      mapTrade(rawTrade({ x: undefined }), 3),                          // open — excluded
    ];
    const s = summarizeTrades(trades);
    assert.equal(s.total, 4);
    assert.equal(s.open, 1);
    assert.equal(s.wins, 2);
    assert.equal(s.losses, 1);
    assert.equal(s.win_rate_pct, 66.67);
    assert.equal(s.net_profit, 80);
    assert.equal(s.long.count, 2);
    assert.equal(s.short.count, 1);
    assert.equal(s.best_trade, 100);
    assert.equal(s.worst_trade, -50);
  });

  it('handles empty trade list', () => {
    const s = summarizeTrades([]);
    assert.equal(s.total, 0);
    assert.equal(s.win_rate_pct, null);
  });
});

// ── downsample ───────────────────────────────────────────────────────────

describe('downsample()', () => {
  it('returns array unchanged when under the cap', () => {
    const a = [1, 2, 3];
    assert.deepEqual(downsample(a, 10), a);
  });

  it('keeps first and last points', () => {
    const a = Array.from({ length: 100 }, (_, i) => i);
    const d = downsample(a, 10);
    assert.equal(d.length, 10);
    assert.equal(d[0], 0);
    assert.equal(d[9], 99);
  });
});

// ── shapeMetrics ─────────────────────────────────────────────────────────

describe('shapeMetrics()', () => {
  it('converts *Percent and percentProfitable fractions to percentages', () => {
    const m = shapeMetrics({
      all: { netProfit: 500, netProfitPercent: 0.05, percentProfitable: 0.32, profitFactor: 1.2 },
      long: null, short: undefined,
      sharpeRatio: 1.5,
      maxStrategyDrawDownPercent: 0.014,
    });
    assert.equal(m.all.netProfit, 500);
    assert.equal(m.all.netProfitPercent, 5);
    assert.equal(m.all.percentProfitable, 32);
    assert.equal(m.all.profitFactor, 1.2);
    assert.equal(m.sharpeRatio, 1.5);
    assert.equal(m.maxStrategyDrawDownPercent, 1.4);
  });
});

// ── gridCombos ───────────────────────────────────────────────────────────

describe('gridCombos()', () => {
  it('builds the cartesian product', () => {
    const combos = gridCombos({ a: [1, 2], b: ['x', 'y', 'z'] });
    assert.equal(combos.length, 6);
    assert.deepEqual(combos[0], { a: 1, b: 'x' });
    assert.deepEqual(combos[5], { a: 2, b: 'z' });
  });
});

// ── Mock-driven behaviors ────────────────────────────────────────────────

const mockDeps = (result) => ({
  evaluate: async () => result,
  evaluateAsync: async () => result,
});

describe('getTrades() windowing', () => {
  const trades = Array.from({ length: 50 }, (_, i) => rawTrade({ e: { c: 'L' + i, p: i, tm: i, b: i, tp: 'le' } }));

  it('returns the most recent window by default', async () => {
    const r = await getTrades({ _deps: mockDeps({ source: 'chart', trades }) });
    assert.equal(r.total_trades, 50);
    assert.equal(r.returned, 20);
    assert.equal(r.window.from_index, 30);
    assert.equal(r.window.to_index, 49);
  });

  it('offset pages back from the latest trade', async () => {
    const r = await getTrades({ max_trades: 10, offset: 5, _deps: mockDeps({ source: 'chart', trades }) });
    assert.equal(r.window.from_index, 35);
    assert.equal(r.window.to_index, 44);
  });

  it('clamps max_trades to the hard limit', async () => {
    const r = await getTrades({ max_trades: 99999, _deps: mockDeps({ source: 'chart', trades }) });
    assert.ok(r.returned <= MAX_TRADES_LIMIT);
  });

  it('summary=true returns aggregates instead of trades', async () => {
    const r = await getTrades({ summary: true, _deps: mockDeps({ source: 'chart', trades }) });
    assert.equal(r.summary.total, 50);
    assert.equal(r.trades, undefined);
  });

  it('propagates page-side errors', async () => {
    await assert.rejects(
      getTrades({ _deps: mockDeps({ error: 'No strategy found on chart.' }) }),
      /No strategy found/
    );
  });
});

describe('getEquity()', () => {
  it('builds equity from initial capital + cumulative profit and downsamples', async () => {
    const trades = Array.from({ length: 30 }, (_, i) => rawTrade({ cp: { v: (i + 1) * 10, p: 0 }, x: { c: 'X', p: 1, tm: i * 100, b: i, tp: 'lx' } }));
    const r = await getEquity({ max_points: 5, _deps: mockDeps({ source: 'chart', trades, buyHold: null, initialCapital: 1000 }) });
    assert.equal(r.initial_capital, 1000);
    assert.equal(r.final_equity, 1300);
    assert.equal(r.total_points, 31);
    assert.equal(r.returned_points, 5);
    assert.equal(r.points[0].equity, 1000);
    assert.equal(r.points[4].equity, 1300);
  });
});

describe('setProperties() validation', () => {
  it('rejects empty properties', async () => {
    await assert.rejects(setProperties({ properties: {}, _deps: mockDeps({}) }), /non-empty/);
  });

  it('rejects unknown property keys', async () => {
    await assert.rejects(setProperties({ properties: { bogus_key: 1 }, _deps: mockDeps({}) }), /Unknown strategy properties: bogus_key/);
  });

  it('accepts every documented property key', () => {
    assert.ok(Object.keys(STRATEGY_PROPERTY_IDS).includes('initial_capital'));
    assert.ok(Object.keys(STRATEGY_PROPERTY_IDS).includes('commission_value'));
    assert.ok(Object.keys(STRATEGY_PROPERTY_IDS).includes('use_bar_magnifier'));
  });
});

describe('optimize() validation', () => {
  it('resolves the default one-year deep-backtest range deterministically', () => {
    const now = Date.UTC(2026, 6, 7);
    assert.deepEqual(resolveOptimizeRange({ range_preset: 'last_365d', now_ms: now }), {
      fromMs: now - 365 * 86400e3,
      toMs: now,
    });
  });

  it('accepts a custom deep-backtest range and rejects incomplete ranges', () => {
    const range = resolveOptimizeRange({ range_from: '2025-01-01', range_to: '2026-01-01' });
    assert.equal(range.fromMs, Date.parse('2025-01-01'));
    assert.equal(range.toMs, Date.parse('2026-01-01'));
    assert.throws(() => resolveOptimizeRange({ range_from: '2025-01-01' }), /both range_from and range_to/);
  });

  it('rejects an empty grid', async () => {
    await assert.rejects(optimize({ grid: {}, _deps: mockDeps({}) }), /non-empty/);
  });

  it('rejects non-array grid values', async () => {
    await assert.rejects(optimize({ grid: { a: 5 }, _deps: mockDeps({}) }), /must be a non-empty array/);
  });

  it('rejects grids over the combination cap', async () => {
    const meta = {
      entity_id: 'X', name: 'S',
      inputs: [{ id: 'in_1', name: 'a', type: 'integer', current: 1 }, { id: 'in_2', name: 'b', type: 'integer', current: 1 }],
    };
    await assert.rejects(
      optimize({ grid: { a: Array.from({ length: 20 }, (_, i) => i), b: Array.from({ length: 20 }, (_, i) => i) }, _deps: mockDeps(meta) }),
      /combinations — over the cap/
    );
  });

  it('limits diagnostics and retained inputs to singleton evaluations', async () => {
    const meta = { entity_id: 'X', name: 'S', inputs: [{ id: 'in_1', name: 'a', type: 'integer', current: 1 }] };
    await assert.rejects(
      optimize({ grid: { a: [1, 2] }, diagnostics: true, _deps: mockDeps(meta) }),
      /require exactly one parameter combination/
    );
    await assert.rejects(
      optimize({ grid: { a: [1, 2] }, retain_inputs: true, _deps: mockDeps(meta) }),
      /require exactly one parameter combination/
    );
  });

  it('rejects unknown input names with a helpful list', async () => {
    const meta = { entity_id: 'X', name: 'S', inputs: [{ id: 'in_1', name: 'Swing length', type: 'integer', current: 50 }] };
    await assert.rejects(
      optimize({ grid: { nope: [1] }, _deps: mockDeps(meta) }),
      /No strategy input matches "nope"/
    );
  });
});
