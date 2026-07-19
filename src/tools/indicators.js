import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/indicators.js';
import { withTarget } from '../connection.js';

const targetIdParam = z.string().optional().describe('Optional CDP target id from target_list/tv_health_check. Runs this command against that TradingView window/tab.');

export function registerIndicatorTools(server) {
  server.tool('indicator_set_inputs', 'Change indicator/study input values (e.g., length, source, period)', {
    entity_id: z.string().describe('Entity ID of the study (from chart_get_state)'),
    inputs: z.string().describe('JSON string of input overrides, e.g. \'{"length": 50, "source": "close"}\'. Keys are input IDs, values are the new values.'),
    wait_for_recalc: z.coerce.boolean().optional().describe('Wait until the study finishes recalculating with the new inputs before returning. Set this when you read results (reports, values) right after — without it the read races the recalc.'),
    timeout_ms: z.coerce.number().optional().describe('Max ms to wait for the recalculation when wait_for_recalc is set (default 30000)'),
    target_id: targetIdParam,
  }, async ({ entity_id, inputs, wait_for_recalc, timeout_ms, target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.setInputs({ entity_id, inputs, wait_for_recalc, timeout_ms }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('indicator_toggle_visibility', 'Show or hide an indicator/study on the chart', {
    entity_id: z.string().describe('Entity ID of the study (from chart_get_state)'),
    visible: z.coerce.boolean().describe('true to show, false to hide'),
    target_id: targetIdParam,
  }, async ({ entity_id, visible, target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.toggleVisibility({ entity_id, visible }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
