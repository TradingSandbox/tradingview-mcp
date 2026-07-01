/**
 * Unit tests for the structured screener field catalog.
 * Pure logic only — no TradingView connection needed (fetchMetainfo / fieldInfo
 * with a market are excluded as they require a live CDP page).
 *
 * Run: node --test tests/screener_catalog.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  FIELD_GROUPS, CATEGORIES, TIMEFRAMES,
  catalogView, searchCatalog, findConcept, expandField, valueMenu, fieldInfo,
} from '../src/core/screener_catalog.js';

describe('catalog structure', () => {
  it('has the 8 UI categories', () => {
    assert.deepEqual(CATEGORIES, [
      'security_info', 'market_data', 'technicals',
      'valuation', 'financials', 'margins', 'growth', 'dividends',
    ]);
  });

  it('every concept has label, stem, type, desc, and non-empty cols', () => {
    for (const cat of CATEGORIES) {
      for (const e of FIELD_GROUPS[cat]) {
        assert.ok(e.label && e.stem && e.type && e.desc, `${cat} entry missing field`);
        assert.ok(Array.isArray(e.cols) && e.cols.length > 0, `${cat}/${e.label} has no cols`);
      }
    }
  });

  it('stems are unique within a category', () => {
    for (const cat of CATEGORIES) {
      const stems = FIELD_GROUPS[cat].map(e => e.stem);
      assert.equal(new Set(stems).size, stems.length, `duplicate stem in ${cat}`);
    }
  });
});

describe('catalogView', () => {
  it('returns all categories by default with a naming block', () => {
    const v = catalogView();
    assert.equal(v.success, true);
    assert.equal(Object.keys(v.categories).length, CATEGORIES.length);
    assert.ok(v.naming && v.naming.timeframe_suffix);
  });

  it('filters to one category', () => {
    const v = catalogView({ category: 'technicals' });
    assert.deepEqual(Object.keys(v.categories), ['technicals']);
  });

  it('rejects an unknown category', () => {
    const v = catalogView({ category: 'nope' });
    assert.equal(v.success, false);
  });

  it('search narrows to matching concepts', () => {
    const v = catalogView({ search: 'margin' });
    assert.deepEqual(Object.keys(v.categories), ['margins']);
  });

  it('non-verbose omits full column lists, verbose includes them', () => {
    const plain = catalogView({ category: 'technicals' }).categories.technicals[0];
    const verbose = catalogView({ category: 'technicals', verbose: true }).categories.technicals[0];
    assert.equal(plain.columns, undefined);
    assert.ok(Array.isArray(verbose.columns) && verbose.columns.length > 0);
  });
});

describe('findConcept', () => {
  it('resolves a bare indicator', () => {
    assert.equal(findConcept('RSI').label, 'RSI');
  });
  it('resolves through a length + timeframe suffix', () => {
    const c = findConcept('RSI7|60');
    assert.equal(c.label, 'RSI');
    assert.equal(c.category, 'technicals');
  });
  it('resolves a period-suffixed fundamental', () => {
    assert.equal(findConcept('net_income_ttm').label, 'Net income');
  });
  it('resolves a prev-bar [1] suffix', () => {
    assert.equal(findConcept('Stoch.K[1]').label, 'Stochastic %K');
  });
  it('returns null for garbage', () => {
    assert.equal(findConcept('definitely_not_a_field'), null);
  });
});

describe('expandField / valueMenu', () => {
  it('expands a tf concept to cols x (daily + 9 timeframes)', () => {
    const rsi = findConcept('RSI');
    assert.equal(expandField(rsi).length, rsi.cols.length * (TIMEFRAMES.length + 1));
  });
  it('does not add timeframes to a non-tf concept', () => {
    const ni = findConcept('net_income');
    assert.deepEqual(expandField(ni), ni.cols);
  });
  it('renders a readable value menu', () => {
    assert.deepEqual(valueMenu(findConcept('net_income')), ['·', 'fq', 'fy', 'ttm', 'fh']);
    assert.equal(valueMenu(findConcept('RSI'))[0], '·');
    assert.ok(valueMenu(findConcept('RSI')).includes('7'));
  });
});

describe('fieldInfo (static, no market)', () => {
  it('resolves a known field with examples', async () => {
    const r = await fieldInfo('RSI');
    assert.equal(r.success, true);
    assert.equal(r.known, true);
    assert.equal(r.resolved.category, 'technicals');
    assert.ok(r.examples.includes('RSI'));
    assert.equal(r.live, null);
  });
  it('flags an unknown field but still returns it', async () => {
    const r = await fieldInfo('some_made_up_column');
    assert.equal(r.known, false);
    assert.equal(r.resolved, null);
    assert.deepEqual(r.examples, ['some_made_up_column']);
    assert.ok(r.hint);
  });
});
