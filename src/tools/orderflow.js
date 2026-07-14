import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/orderflow.js';
import { withTarget } from '../connection.js';

const targetIdParam = z.string().optional().describe('Optional CDP target id from target_list/tv_health_check. Runs this command against that TradingView window/tab.');

export function registerOrderflowTools(server) {
  server.tool('data_get_volume_profile', 'Read volume profile / order-flow data from volume-by-price studies on the chart (Volume Profile Visible Range, Session, Fixed Range, Periodic). Per price row: up_volume/down_volume (buy/sell split), total, delta — plus POC, value area (VAH/VAL) and per-profile totals. Session/periodic studies return one profile per session. Study must be on the chart (add via volume_profile_manage).', {
    study_filter: z.string().optional().describe('Substring to match the study name (e.g. "Visible", "Session"). Omit for all volume profile studies.'),
    max_rows: z.coerce.number().optional().describe('Cap rows per profile (highest price first). Omit for all rows.'),
    target_id: targetIdParam,
  }, async ({ study_filter, max_rows, target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.getVolumeProfile({ study_filter, max_rows }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_order_flow', 'Read per-candle order-flow (footprint) data: buy vs sell volume at EVERY price level inside each candle, imbalance flags, per-candle POC + value area, candle delta — plus stacked-imbalance and unfinished-auction markers. Requires a Volume Footprint study on the chart (add via volume_profile_manage type="footprint"). Use summary=true for per-candle totals without the price levels.', {
    count: z.coerce.number().optional().describe('Number of most-recent candles to return (default 10, cap 100)'),
    summary: z.coerce.boolean().optional().describe('Per-candle totals (buy/sell/delta/POC) without individual price levels — much smaller'),
    study_filter: z.string().optional().describe('Substring to match the study name if several footprint studies are loaded'),
    target_id: targetIdParam,
  }, async ({ count, summary, study_filter, target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.getOrderFlow({ count, summary, study_filter }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('volume_profile_manage', `Add or remove a volume profile / footprint study on the chart. Types: ${Object.keys(core.VOLUME_PROFILE_TYPES).join(', ')}. These are premium volume-by-price studies that chart_manage_indicator cannot add.`, {
    action: z.enum(['add', 'remove']).describe('add or remove'),
    type: z.string().optional().describe('Profile type for add: visible_range (default), session, fixed_range, periodic, footprint'),
    entity_id: z.string().optional().describe('Study entity ID (required for remove; from data_get_volume_profile or chart_get_state)'),
    target_id: targetIdParam,
  }, async ({ action, type, entity_id, target_id }) => {
    try { return jsonResult(await withTarget(target_id, () => core.manageVolumeProfile({ action, type, entity_id }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
