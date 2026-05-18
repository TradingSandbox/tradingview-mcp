/**
 * Core tab management logic.
 * Controls TradingView Desktop tabs via CDP and Electron keyboard shortcuts.
 */
import { getClient, switchTarget, listTargets, withTarget, evaluate } from '../connection.js';

const CDP_HOST = 'localhost';
const CDP_PORT = 9222;

const NEW_TAB_URL_RE = /app\.asar\/app\/new-tab\/index\.html/i;
const CHART_URL_RE = /tradingview\.com\/chart/i;
const SHELL_TITLE_RE = /tabbed-window/i;

function isTabTarget(t) {
  return t.type === 'page' && (CHART_URL_RE.test(t.url || '') || NEW_TAB_URL_RE.test(t.url || ''));
}

async function findShellTarget() {
  const targets = await listTargets();
  return targets.find(t => t.type === 'page' && SHELL_TITLE_RE.test(t.title || ''));
}

/**
 * List all open chart tabs (CDP page targets). Includes "New tab" landing pages,
 * since they appear in the shell's tab strip and can be switched to.
 */
export async function list() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();

  const tabs = targets
    .filter(isTabTarget)
    .map((t, i) => ({
      index: i,
      id: t.id,
      title: NEW_TAB_URL_RE.test(t.url) ? 'New tab' : (t.title || '').replace(/^Live stock.*charts on /, ''),
      url: t.url,
      chart_id: t.url.match(/\/chart\/([^/?]+)/)?.[1] || null,
      is_chart: CHART_URL_RE.test(t.url),
    }));

  return { success: true, tab_count: tabs.length, tabs };
}

/**
 * Open a new chart tab by clicking the "+" button in the shell window's tab strip.
 * CDP-synthesized Cmd+T does not trigger the Electron accelerator, so we invoke
 * the React onClick handler on `button.create-new-tab-button` directly.
 */
export async function newTab() {
  const shell = await findShellTarget();
  if (!shell) throw new Error('Could not find TradingView shell (tabbed-window) target. Is the desktop app running?');

  const before = await list();

  const clickResult = await withTarget(shell.id, () => evaluate(`
    (function(){
      var btn = document.querySelector('button.create-new-tab-button');
      if (!btn) return { ok: false, reason: 'button_not_found' };
      var key = Object.keys(btn).find(function(k){ return k.indexOf('__reactProps') === 0; });
      if (key && typeof btn[key].onClick === 'function') {
        btn[key].onClick({ preventDefault: function(){}, stopPropagation: function(){}, currentTarget: btn, target: btn });
        return { ok: true, via: 'react_onclick' };
      }
      btn.click();
      return { ok: true, via: 'dom_click' };
    })()
  `));

  if (!clickResult?.ok) {
    throw new Error(`Failed to open new tab: ${clickResult?.reason || 'unknown'}`);
  }

  // Poll for the tab to appear (new-tab landing page registers as a CDP target shortly after click).
  const deadline = Date.now() + 5000;
  let after = before;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 300));
    after = await list();
    if (after.tab_count > before.tab_count) break;
  }

  if (after.tab_count <= before.tab_count) {
    throw new Error('New tab click was dispatched but no new tab appeared within 5s.');
  }

  return { success: true, action: 'new_tab_opened', via: clickResult.via, ...after };
}

/**
 * Close a tab by clicking its close button in the shell window's tab strip.
 * Defaults to the active tab (Cmd+W semantics). CDP-level `/json/close` leaves
 * the shell's tab strip out of sync, so we must go through the UI handler.
 */
export async function closeTab() {
  const before = await list();
  if (before.tab_count <= 1) {
    throw new Error('Cannot close the last tab. Use tv_launch to restart TradingView instead.');
  }

  const shell = await findShellTarget();
  if (!shell) throw new Error('Could not find TradingView shell (tabbed-window) target.');

  const clickResult = await withTarget(shell.id, () => evaluate(`
    (function(){
      var tab = document.querySelector('.tabs-container .tab.active') || document.querySelector('.tabs-container .tab');
      if (!tab) return { ok: false, reason: 'no_tab_in_strip' };
      var btn = tab.querySelector('.tab-close-button-container button');
      if (!btn) return { ok: false, reason: 'no_close_button' };
      var key = Object.keys(btn).find(function(k){ return k.indexOf('__reactProps') === 0; });
      if (key && typeof btn[key].onClick === 'function') {
        btn[key].onClick({ preventDefault: function(){}, stopPropagation: function(){}, currentTarget: btn, target: btn });
        return { ok: true, via: 'react_onclick' };
      }
      btn.click();
      return { ok: true, via: 'dom_click' };
    })()
  `));

  if (!clickResult?.ok) {
    throw new Error(`Failed to close tab: ${clickResult?.reason || 'unknown'}`);
  }

  // Poll for the tab count to drop.
  const deadline = Date.now() + 5000;
  let after = before;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 300));
    after = await list();
    if (after.tab_count < before.tab_count) break;
  }

  if (after.tab_count >= before.tab_count) {
    throw new Error('Close click was dispatched but tab count did not drop within 5s.');
  }

  return { success: true, action: 'tab_closed', via: clickResult.via, tabs_before: before.tab_count, tabs_after: after.tab_count };
}

/**
 * Switch to a tab by index. Reconnects CDP to the new target.
 */
export async function switchTab({ index }) {
  const tabs = await list();
  const idx = Number(index);

  if (idx >= tabs.tab_count) {
    throw new Error(`Tab index ${idx} out of range (have ${tabs.tab_count} tabs)`);
  }

  const target = tabs.tabs[idx];

  // Use CDP Target.activateTarget to bring the tab to front
  try {
    const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/activate/${target.id}`);
    if (!resp.ok) throw new Error(`activate returned HTTP ${resp.status}`);
    await switchTarget(target.id);
    return { success: true, action: 'switched', index: idx, tab_id: target.id, chart_id: target.chart_id };
  } catch (e) {
    throw new Error(`Failed to activate tab ${idx}: ${e.message}`);
  }
}
