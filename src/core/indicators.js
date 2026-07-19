/**
 * Core indicator settings logic.
 */
import { evaluate, evaluateAsync, safeString } from '../connection.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

/**
 * setInputValues() returns before the study recalculates. That's fine for
 * interactive tweaks, but a caller that reads results right after (e.g. the
 * backtest runner: set inputs → request deep report) races the recalc and
 * reads a report computed from the OLD inputs. wait_for_recalc subscribes to
 * the study model's status (LOADING 1 → COMPLETED 2 / ERROR 3) and, for
 * strategies, reportChanged — resolving only once the new inputs are live.
 */
export async function setInputs({ entity_id, inputs: inputsRaw, wait_for_recalc, timeout_ms }) {
  const inputs = inputsRaw ? (typeof inputsRaw === 'string' ? JSON.parse(inputsRaw) : inputsRaw) : undefined;
  if (!entity_id) throw new Error('entity_id is required. Use chart_get_state to find study IDs.');
  if (!inputs || typeof inputs !== 'object' || Object.keys(inputs).length === 0) {
    throw new Error('inputs must be a non-empty object, e.g. { length: 50 }');
  }

  const inputsJson = JSON.stringify(inputs);
  const applySnippet = `
      var chart = ${CHART_API};
      var study = chart.getStudyById(${safeString(entity_id)});
      if (!study) return { error: 'Study not found: ' + ${safeString(entity_id)} };
      var currentInputs = study.getInputValues();
      var overrides = ${inputsJson};
      var updatedKeys = {};
      var changed = false;
      for (var i = 0; i < currentInputs.length; i++) {
        if (overrides.hasOwnProperty(currentInputs[i].id)) {
          if (currentInputs[i].value !== overrides[currentInputs[i].id]) changed = true;
          currentInputs[i].value = overrides[currentInputs[i].id];
          updatedKeys[currentInputs[i].id] = overrides[currentInputs[i].id];
        }
      }
  `;

  if (!wait_for_recalc) {
    const result = await evaluate(`
      (function() {
        ${applySnippet}
        study.setInputValues(currentInputs);
        return { updated_inputs: updatedKeys };
      })()
    `);
    if (result && result.error) throw new Error(result.error);
    return { success: true, entity_id, updated_inputs: result.updated_inputs };
  }

  const result = await evaluateAsync(`
    (function() {
      try {
        ${applySnippet}
        // Setting inputs to their current values triggers NO recalculation —
        // waiting for one can only time out. Report success immediately.
        if (!changed) return Promise.resolve({ updated_inputs: updatedKeys, wait: { event: 'noop' } });
        var source = null;
        try {
          source = chart._chartWidget.model().model().dataSources().filter(function(s) {
            return s.id && s.id() === ${safeString(entity_id)};
          })[0] || null;
        } catch (e) {}
        return new Promise(function(resolve) {
          var done = false, sawLoading = false;
          function finish(r) {
            if (done) return; done = true;
            try { source && source.reportChanged && source.reportChanged().unsubscribe(null, onRep); } catch (e) {}
            clearInterval(iv); clearTimeout(tm);
            setTimeout(function() { resolve({ updated_inputs: updatedKeys, wait: r }); }, 150);
          }
          function onRep() { finish({ event: 'report_changed' }); }
          try { source && source.reportChanged && source.reportChanged().subscribe(null, onRep); } catch (e) {}
          var iv = setInterval(function() {
            if (!source) return;
            var st = null;
            try { st = source.status(); if (st && typeof st.value === 'function') st = st.value(); } catch (e) {}
            if (!st) return;
            if (st.type === 1) sawLoading = true;
            else if (st.type === 3) finish({ event: 'error', error: (st.errorDescription && st.errorDescription.error) || 'study error' });
            else if (sawLoading && st.type === 2) finish({ event: 'completed' });
          }, 200);
          var tm = setTimeout(function() { finish({ event: 'timeout' }); }, ${Number(timeout_ms) || 30000});
          study.setInputValues(currentInputs);
        });
      } catch (e) { return Promise.resolve({ error: e.message }); }
    })()
  `);

  if (result && result.error) throw new Error(result.error);
  if (result?.wait?.event === 'error') throw new Error(`Inputs applied but recalculation failed: ${result.wait.error}`);
  return {
    success: true,
    entity_id,
    updated_inputs: result.updated_inputs,
    recalculated: result?.wait?.event !== 'timeout',
    ...(result?.wait?.event === 'timeout' ? { warning: 'Recalculation did not signal completion within the timeout — results may still be updating.' } : {}),
  };
}

export async function toggleVisibility({ entity_id, visible }) {
  if (!entity_id) throw new Error('entity_id is required. Use chart_get_state to find study IDs.');
  if (typeof visible !== 'boolean') throw new Error('visible must be a boolean (true or false)');

  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var study = chart.getStudyById(${safeString(entity_id)});
      if (!study) return { error: 'Study not found: ' + ${safeString(entity_id)} };
      study.setVisible(${visible});
      var actualVisible = study.isVisible();
      return { visible: actualVisible };
    })()
  `);

  if (result && result.error) throw new Error(result.error);
  return { success: true, entity_id, visible: result.visible };
}
