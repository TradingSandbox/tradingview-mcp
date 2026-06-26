/**
 * Shared single-symbol scanner helpers for the snapshot-style tools
 * (fundamentals_get, technicals_get). Both pull one row of columns for one
 * symbol from TradingView's public scanner (scanner.tradingview.com/<market>/
 * scan), run as an in-page fetch() over CDP so the request carries TV's auth
 * cookies and dodges CSP/CORS.
 *
 * Why text/plain on a JSON body: keeps the request "simple" per the Fetch spec
 * so the browser skips the CORS preflight that scanner.tradingview.com doesn't
 * answer. TV's server ignores the declared content type.
 *
 * The screener (core/screener_query.js) and F&O (core/fno.js) modules keep
 * their own scan() because they fetch many rows with filters/sorts; these two
 * helpers are the single-row case shared by the snapshot tools.
 */
import { evaluateAsync, evaluate, safeString } from '../connection.js';

const SCANNER_BASE = 'https://scanner.tradingview.com';

/**
 * Fetch one symbol's columns and return a column→value map, or null if the
 * scanner has no row for it. Throws with the scanner's own message on a
 * rejected query so callers can surface the exact problem.
 */
export async function scanRow(market, symbol, columns) {
  const url = `${SCANNER_BASE}/${encodeURIComponent(market)}/scan`;
  const body = JSON.stringify({ symbols: { tickers: [symbol] }, columns });
  const expr = `
    (async function() {
      try {
        const r = await fetch(${safeString(url)}, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: ${safeString(body)}
        });
        const text = await r.text();
        let json = null;
        try { json = JSON.parse(text); } catch (e) {}
        return { ok: r.ok, status: r.status, body: json, textPreview: json ? null : text.slice(0, 300) };
      } catch (e) {
        return { ok: false, fetchError: e.message };
      }
    })()
  `;
  const res = await evaluateAsync(expr);
  if (!res) throw new Error('No response from scanner endpoint');
  if (res.fetchError) throw new Error(`Scanner fetch failed: ${res.fetchError}`);

  const scannerError = res.body && typeof res.body === 'object' ? res.body.error : null;
  if (!res.ok || scannerError) {
    throw new Error(
      scannerError
        ? `Scanner rejected query: ${scannerError}`
        : `Scanner returned HTTP ${res.status}${res.textPreview ? `: ${res.textPreview}` : ''}`
    );
  }

  const d = res.body?.data?.[0]?.d;
  if (!Array.isArray(d)) return null;
  const map = {};
  columns.forEach((c, i) => { map[c] = d[i]; });
  return map;
}

/**
 * Fallback resolver for when the chart's exchange prefix doesn't match the
 * scanner's canonical listing (e.g. chart "BATS:CDNL" → scanner "NASDAQ:CDNL").
 * Scans the market filtered by the bare ticker on the `name` column and returns
 * { symbol, map } for the first match, or null.
 */
export async function scanRowByName(market, ticker, columns) {
  const url = `${SCANNER_BASE}/${encodeURIComponent(market)}/scan`;
  const body = JSON.stringify({
    filter: [{ left: 'name', operation: 'equal', right: ticker }],
    columns,
    range: [0, 1],
  });
  const expr = `
    (async function() {
      try {
        const r = await fetch(${safeString(url)}, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: ${safeString(body)}
        });
        const text = await r.text();
        let json = null;
        try { json = JSON.parse(text); } catch (e) {}
        return { ok: r.ok, body: json };
      } catch (e) {
        return { ok: false, fetchError: e.message };
      }
    })()
  `;
  const res = await evaluateAsync(expr);
  const row = res?.body?.data?.[0];
  if (!row || !Array.isArray(row.d)) return null;
  const map = {};
  columns.forEach((c, i) => { map[c] = row.d[i]; });
  return { symbol: row.s, map };
}

/**
 * Resolve a symbol's columns: try the exact ticker, then fall back to a
 * bare-ticker name match if the exchange prefix didn't resolve. Returns
 * { symbol, map } (symbol = the resolved one, possibly different from input),
 * or null if nothing matched.
 */
export async function resolveRow(market, symbol, columns) {
  const m = await scanRow(market, symbol, columns);
  if (m) return { symbol, map: m };
  const bareTicker = String(symbol).split(':').pop();
  const byName = await scanRowByName(market, bareTicker, columns);
  if (byName) return { symbol: byName.symbol || symbol, map: byName.map };
  return null;
}

/** Current chart symbol (exchange-qualified, e.g. "NSE:BPCL"), or null. */
export async function getCurrentSymbol() {
  try {
    return await evaluate(`window.TradingViewApi._activeChartWidgetWV.value().symbol()`);
  } catch {
    return null;
  }
}
