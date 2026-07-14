/**
 * Order-flow / volume profile data extraction.
 *
 * TradingView's volume-by-price studies (Volume Profile Visible Range /
 * Session / Fixed Range / Periodic) render through graphics primitives:
 * `study._graphics._primitivesCollection.hhists` — a Map of named horizontal
 * histogram collections. Each row is {firstBarTime, lastBarTime, rate:
 * [upVolume, downVolume], priceHigh, priceLow}; "…VA"-suffixed collections
 * hold the value-area subset. first/lastBarTime are BAR INDEXES, converted to
 * unix seconds via the main series.
 */
import { evaluate as _evaluate, evaluateAsync as _evaluateAsync, safeString } from '../connection.js';

const CHART_WIDGET = 'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget';

// Friendly type → study id in the tv-volumebyprice package.
export const VOLUME_PROFILE_TYPES = {
  visible_range: 'VbPVisible@tv-volumebyprice',
  session: 'VbPSessions@tv-volumebyprice',
  fixed_range: 'VbPFixed@tv-volumebyprice',
  periodic: 'VbPPeriodic@tv-volumebyprice',
  footprint: 'Footprint@tv-volumebyprice',
};

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    evaluateAsync: deps?.evaluateAsync || _evaluateAsync,
  };
}

/** Shape one raw profile (rows + VA rows) into totals, POC and value area. */
export function shapeProfile(profile, maxRows) {
  const rows = (profile.rows || []).map((r) => ({
    price_low: r.price_low,
    price_high: r.price_high,
    up_volume: r.up,
    down_volume: r.down,
    total_volume: (r.up || 0) + (r.down || 0),
    delta: (r.up || 0) - (r.down || 0),
    in_value_area: !!r.is_va,
  })).sort((a, b) => b.price_low - a.price_low);

  let poc = null;
  let totalUp = 0, totalDown = 0;
  let vah = null, val = null;
  for (const r of rows) {
    totalUp += r.up_volume;
    totalDown += r.down_volume;
    if (!poc || r.total_volume > poc.volume) {
      poc = { price_low: r.price_low, price_high: r.price_high, price: Math.round((r.price_low + r.price_high) / 2 * 10000) / 10000, volume: r.total_volume };
    }
    if (r.in_value_area) {
      if (vah === null || r.price_high > vah) vah = r.price_high;
      if (val === null || r.price_low < val) val = r.price_low;
    }
  }

  const out = {
    range: {
      from_time: profile.first_time ?? null,
      to_time: profile.last_time ?? null,
    },
    row_count: rows.length,
    total_volume: totalUp + totalDown,
    up_volume: totalUp,
    down_volume: totalDown,
    delta: totalUp - totalDown,
    poc,
    value_area: vah !== null ? { high: vah, low: val } : null,
    rows: maxRows && rows.length > maxRows ? rows.slice(0, maxRows) : rows,
  };
  if (maxRows && rows.length > maxRows) out.note = `rows truncated to top ${maxRows} by price (of ${rows.length})`;
  return out;
}

/**
 * Read volume profile / order-flow rows from all volume-by-price studies on
 * the chart. Rows carry the up/down (buy/sell) volume split per price bucket.
 */
export async function getVolumeProfile({ study_filter, max_rows, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const raw = await evaluate(`
    (function() {
      var chart = ${CHART_WIDGET};
      var model = chart.model().model();
      var bars = model.mainSeries().bars();
      function idxTime(i) {
        if (i === null || i === undefined) return null;
        try { var v = bars.valueAt(i); return v ? v[0] : null; } catch (e) { return null; }
      }
      var filter = ${safeString(study_filter || '')};
      var out = [];
      model.dataSources().forEach(function(s) {
        var mi = null;
        try { mi = s.metaInfo ? s.metaInfo() : null; } catch (e) {}
        if (!mi || !/volumebyprice/.test(mi.id)) return;
        var desc = mi.shortDescription || mi.description || mi.id;
        if (filter && desc.indexOf(filter) === -1) return;
        var pc = s._graphics && s._graphics._primitivesCollection;
        if (!pc || !pc.hhists) return;
        var profiles = {};
        pc.hhists.forEach(function(coll, name) {
          var isVA = /va$/i.test(name);
          if (!coll || typeof coll.forEach !== 'function') return;
          coll.forEach(function(v) {
            if (!v || v.priceLow === undefined) return;
            var pk = String(v.firstBarTime) + '|' + String(v.lastBarTime);
            if (!profiles[pk]) profiles[pk] = { first_bar: v.firstBarTime, last_bar: v.lastBarTime, rows: [] };
            profiles[pk].rows.push({
              price_low: v.priceLow, price_high: v.priceHigh,
              up: (v.rate && v.rate[0]) || 0, down: (v.rate && v.rate[1]) || 0,
              is_va: isVA
            });
          });
        });
        var plist = Object.keys(profiles).map(function(k) {
          var p = profiles[k];
          return { first_bar: p.first_bar, last_bar: p.last_bar, first_time: idxTime(p.first_bar), last_time: idxTime(p.last_bar), rows: p.rows };
        });
        plist.sort(function(a, b) { return (a.first_bar || 0) - (b.first_bar || 0); });
        out.push({ entity_id: s.id(), study: desc, meta_id: mi.id, profiles: plist });
      });
      return out;
    })()
  `);

  if (!raw || raw.length === 0) {
    return {
      success: false,
      error: 'No volume profile study on the chart. Add one with volume_profile_manage (action: "add") or the Indicators dialog.',
      hint: `Types: ${Object.keys(VOLUME_PROFILE_TYPES).join(', ')}`,
    };
  }

  const studies = raw.map((s) => ({
    entity_id: s.entity_id,
    study: s.study,
    profile_count: s.profiles.length,
    profiles: s.profiles.map((p) => shapeProfile(p, max_rows)),
  }));
  return {
    success: true,
    study_count: studies.length,
    note: 'rate split per row: up_volume/down_volume (buy/sell at that price). POC = highest-volume row. Times are unix seconds.',
    studies,
  };
}

/** Shape one raw footprint candle: totals, delta, sorted levels. */
export function shapeFootprintCandle(candle, { levels = true } = {}) {
  let buy = 0, sell = 0;
  const rows = (candle.levels || []).map((l) => {
    buy += l.buyVolume || 0;
    sell += l.sellVolume || 0;
    return {
      price: l.price,
      buy_volume: l.buyVolume || 0,
      sell_volume: l.sellVolume || 0,
      delta: (l.buyVolume || 0) - (l.sellVolume || 0),
      ...(l.imbalance ? { imbalance: l.imbalance } : {}),
    };
  }).sort((a, b) => b.price - a.price);

  const out = {
    time: candle.time ?? null,
    bar_index: candle.index,
    poc: candle.poc ?? null,
    value_area: candle.vah !== undefined && candle.vah !== null ? { high: candle.vah, low: candle.val } : null,
    buy_volume: buy,
    sell_volume: sell,
    total_volume: buy + sell,
    delta: buy - sell,
    level_count: rows.length,
  };
  if (levels) out.levels = rows;
  return out;
}

/**
 * Read per-candle footprint (order flow) data: buy/sell volume at every price
 * level inside each candle, with imbalance flags and per-candle POC/VA.
 * Requires a Volume Footprint study on the chart (volume_profile_manage
 * action:"add" type:"footprint").
 */
export async function getOrderFlow({ count, summary, study_filter, _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const limit = Math.min(Math.max(1, count || 10), 100);
  const raw = await evaluate(`
    (function() {
      var chart = ${CHART_WIDGET};
      var model = chart.model().model();
      var bars = model.mainSeries().bars();
      function idxTime(i) {
        if (i === null || i === undefined) return null;
        try { var v = bars.valueAt(i); return v ? v[0] : null; } catch (e) { return null; }
      }
      var filter = ${safeString(study_filter || '')};
      var out = [];
      model.dataSources().forEach(function(s) {
        var mi = null;
        try { mi = s.metaInfo ? s.metaInfo() : null; } catch (e) {}
        if (!mi || !/Footprint@tv-volumebyprice/.test(mi.id)) return;
        var desc = mi.shortDescription || mi.description || mi.id;
        if (filter && desc.indexOf(filter) === -1) return;
        var pc = s._graphics && s._graphics._primitivesCollection;
        if (!pc || !pc.footprints) return;
        var candles = [];
        pc.footprints.forEach(function(coll) {
          if (!coll || typeof coll.forEach !== 'function') return;
          coll.forEach(function(c) {
            if (!c || c.index === undefined) return;
            candles.push({ index: c.index, poc: c.poc, vah: c.vah, val: c.val, levels: c.levels || [] });
          });
        });
        candles.sort(function(a, b) { return a.index - b.index; });
        candles = candles.slice(-${limit});
        candles.forEach(function(c) { c.time = idxTime(c.index); });
        // extras: stacked imbalances / unfinished auctions (shape varies; pass through raw)
        var extras = {};
        if (pc.footprintLevels && typeof pc.footprintLevels.forEach === 'function') {
          pc.footprintLevels.forEach(function(coll, name) {
            var items = [];
            if (coll && typeof coll.forEach === 'function') {
              coll.forEach(function(v) { if (items.length < 200) { try { items.push(JSON.parse(JSON.stringify(v))); } catch (e) {} } });
            }
            extras[String(name)] = items;
          });
        }
        out.push({ entity_id: s.id(), study: desc, total_candles_available: null, candles: candles, extras: extras });
      });
      return out;
    })()
  `);

  if (!raw || raw.length === 0) {
    return {
      success: false,
      error: 'No Volume Footprint study on the chart. Add one with volume_profile_manage (action: "add", type: "footprint").',
    };
  }

  const studies = raw.map((s) => ({
    entity_id: s.entity_id,
    study: s.study,
    candle_count: s.candles.length,
    candles: s.candles.map((c) => shapeFootprintCandle(c, { levels: !summary })),
    stacked_imbalances: s.extras.stackedImbalance || [],
    unfinished_auctions: s.extras.unfinishedAuction || [],
  }));
  return {
    success: true,
    note: 'Most recent candles last. Per level: buy_volume (market buys at ask), sell_volume (market sells at bid), delta, imbalance flag. Times are unix seconds. summary=true drops per-price levels.',
    studies,
  };
}

/**
 * Add or remove a volume profile study. These are NOT java studies, so the
 * public createStudy(name) lookup misses them — insert goes through the
 * study metaInfo repository + a study inserter instead.
 */
export async function manageVolumeProfile({ action, type, entity_id, _deps } = {}) {
  const { evaluate, evaluateAsync } = _resolve(_deps);

  if (action === 'remove') {
    if (!entity_id) throw new Error('entity_id required for remove. Use data_get_volume_profile or chart_get_state to find it.');
    await evaluate(`window.TradingViewApi._activeChartWidgetWV.value().removeEntity(${safeString(entity_id)})`);
    return { success: true, action: 'remove', entity_id };
  }
  if (action !== 'add') throw new Error('action must be "add" or "remove"');

  const t = (type || 'visible_range').toLowerCase();
  const studyId = VOLUME_PROFILE_TYPES[t];
  if (!studyId) throw new Error(`Unknown volume profile type "${type}". Use: ${Object.keys(VOLUME_PROFILE_TYPES).join(', ')}`);

  const result = await evaluateAsync(`
    (function() {
      return new Promise(function(resolve) {
        var tm = setTimeout(function() { resolve({ error: 'Timed out inserting the study (15s). Your TradingView plan may not include volume profile.' }); }, 15000);
        try {
          // locate the study metaInfo repository via the webpack module cache
          var wp = window.webpackChunktradingview;
          var req = window.__tvmcpWpReq;
          if (!req) {
            wp.push([[Math.random().toString(36)], {}, function(r) { req = r; }]);
            window.__tvmcpWpReq = req;
          }
          var repo = null;
          var ids = Object.keys(req.c);
          for (var i = 0; i < ids.length; i++) {
            var exp = req.c[ids[i]] && req.c[ids[i]].exports;
            if (exp && typeof exp === 'object' && typeof exp.studyMetaInfoRepository === 'function') { repo = exp.studyMetaInfoRepository(); break; }
          }
          if (!repo) { clearTimeout(tm); return resolve({ error: 'study metaInfo repository not found' }); }
          repo.findById({ type: 'java', studyId: ${safeString(studyId)} }).then(function(mi) {
            var chartModel = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model();
            var inserter = chartModel.createStudyInserter({ type: 'java', studyId: mi.id }, []);
            inserter.setForceOverlay(true);
            return inserter.insert(function() { return Promise.resolve({ inputs: {}, parentSources: [] }); });
          }).then(function(study) {
            clearTimeout(tm);
            resolve(study ? { entity_id: study.id() } : { error: 'insert returned no study' });
          }).catch(function(e) {
            clearTimeout(tm);
            resolve({ error: String(e && e.message || e) });
          });
        } catch (e) { clearTimeout(tm); resolve({ error: e.message }); }
      });
    })()
  `);

  if (!result || result.error) throw new Error(result?.error || 'Volume profile insert failed');
  // give the server-side study a moment to compute before the first read
  await new Promise((r) => setTimeout(r, 2000));
  return { success: true, action: 'add', type: t, study_id: studyId, entity_id: result.entity_id };
}
