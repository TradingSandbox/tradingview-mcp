/**
 * Tests for src/core/orderflow.js — volume profile and footprint shaping.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shapeProfile, shapeFootprintCandle, VOLUME_PROFILE_TYPES } from '../src/core/orderflow.js';

describe('VOLUME_PROFILE_TYPES', () => {
  it('maps every friendly type to a tv-volumebyprice study id', () => {
    for (const [key, id] of Object.entries(VOLUME_PROFILE_TYPES)) {
      assert.match(id, /@tv-volumebyprice$/, `${key} should map into the volume-by-price package`);
    }
    assert.ok(VOLUME_PROFILE_TYPES.visible_range);
    assert.ok(VOLUME_PROFILE_TYPES.footprint);
  });
});

describe('shapeProfile()', () => {
  const profile = {
    first_time: 100, last_time: 200,
    rows: [
      { price_low: 10, price_high: 11, up: 50, down: 30, is_va: false },
      { price_low: 11, price_high: 12, up: 100, down: 120, is_va: true },  // POC (220)
      { price_low: 12, price_high: 13, up: 60, down: 70, is_va: true },
      { price_low: 13, price_high: 14, up: 5, down: 2, is_va: false },
    ],
  };

  it('computes POC, value area, totals and delta', () => {
    const p = shapeProfile(profile);
    assert.equal(p.total_volume, 437);
    assert.equal(p.up_volume, 215);
    assert.equal(p.down_volume, 222);
    assert.equal(p.delta, -7);
    assert.equal(p.poc.price_low, 11);
    assert.equal(p.poc.volume, 220);
    assert.deepEqual(p.value_area, { high: 13, low: 11 });
    assert.equal(p.rows[0].price_low, 13); // sorted highest price first
    assert.deepEqual(p.range, { from_time: 100, to_time: 200 });
  });

  it('caps rows with max_rows and notes the truncation', () => {
    const p = shapeProfile(profile, 2);
    assert.equal(p.rows.length, 2);
    assert.match(p.note, /truncated/);
    assert.equal(p.row_count, 4); // full count still reported
  });

  it('handles a profile with no VA rows', () => {
    const p = shapeProfile({ rows: [{ price_low: 1, price_high: 2, up: 10, down: 5, is_va: false }] });
    assert.equal(p.value_area, null);
    assert.equal(p.poc.volume, 15);
  });

  it('handles an empty profile', () => {
    const p = shapeProfile({ rows: [] });
    assert.equal(p.total_volume, 0);
    assert.equal(p.poc, null);
    assert.equal(p.rows.length, 0);
  });
});

describe('shapeFootprintCandle()', () => {
  const candle = {
    index: 42, time: 1700000000, poc: 100.5, vah: 101, val: 100,
    levels: [
      { price: 100, buyVolume: 500, sellVolume: 800, imbalance: 'sell' },
      { price: 101, buyVolume: 900, sellVolume: 300, imbalance: 'buy' },
      { price: 100.5, buyVolume: 400, sellVolume: 400, imbalance: '' },
    ],
  };

  it('computes candle totals, delta and sorts levels by price desc', () => {
    const c = shapeFootprintCandle(candle);
    assert.equal(c.buy_volume, 1800);
    assert.equal(c.sell_volume, 1500);
    assert.equal(c.delta, 300);
    assert.equal(c.total_volume, 3300);
    assert.deepEqual(c.value_area, { high: 101, low: 100 });
    assert.equal(c.time, 1700000000);
    assert.equal(c.poc, 100.5);
    assert.equal(c.levels[0].price, 101);
    assert.equal(c.levels[0].imbalance, 'buy');
    assert.equal(c.levels[2].imbalance, 'sell');
    assert.equal(c.levels[1].imbalance, undefined); // empty flag omitted
    assert.equal(c.levels[1].delta, 0);
  });

  it('summary mode drops levels but keeps totals', () => {
    const c = shapeFootprintCandle(candle, { levels: false });
    assert.equal(c.levels, undefined);
    assert.equal(c.delta, 300);
    assert.equal(c.level_count, 3);
  });

  it('handles an empty candle', () => {
    const c = shapeFootprintCandle({ index: 1, levels: [] });
    assert.equal(c.total_volume, 0);
    assert.equal(c.value_area, null);
    assert.equal(c.poc, null);
  });
});
