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
export { SCANNER_BASE };

// ---------------------------------------------------------------------------
// Rate-limit circuit breaker. CloudFront rate-limits scanner.tradingview.com
// per-IP; its 429 responses carry no Access-Control-Allow-Origin header, so
// the in-page fetch can't read them and rejects with a bare "Failed to fetch"
// — indistinguishable from a genuine CORS/CSP/network block from inside the
// page. When that happens we probe once from Node (no CORS there) to read the
// real status. On a confirmed 429 we open the breaker with an exponential
// cooldown so we stop re-tripping CloudFront's rate window, which otherwise
// never cools down while callers keep polling.
// ---------------------------------------------------------------------------
const COOLDOWN_BASE_MS = 60_000;
const COOLDOWN_MAX_MS = 600_000;
let cooldownUntil = 0;
let consecutive429s = 0;

function rateLimitError() {
  const secondsLeft = Math.ceil((cooldownUntil - Date.now()) / 1000);
  return new Error(
    `TradingView scanner is rate-limiting this IP (HTTP 429). ` +
    `Backing off ${secondsLeft}s so the limit can clear — chart-based tools ` +
    `(quote_get for the chart symbol, data_get_ohlcv) still work. ` +
    `Reduce scanner call volume (batch tickers, poll ≥60s) to avoid this.`
  );
}

async function classifyFetchFailure(url) {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{"columns":["name"],"range":[0,1]}',
      signal: AbortSignal.timeout(10_000),
    });
    return r.status;
  } catch {
    return null; // Node can't reach it either — genuine network problem.
  }
}

/**
 * POST a scanner request body from inside the page and return
 * { ok, status, body, textPreview }. Throws on fetch-level failure with an
 * honest message: a Node-side probe distinguishes rate-limiting (429, opens
 * the breaker) from real network/CORS trouble. All scanner callers
 * (single-row, batch, screener, F&O) must go through this so the breaker
 * sees every request.
 */
export async function scannerFetch(url, bodyJson) {
  if (Date.now() < cooldownUntil) throw rateLimitError();

  const expr = `
    (async function() {
      try {
        const r = await fetch(${safeString(url)}, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: ${safeString(bodyJson)}
        });
        const text = await r.text();
        let json = null;
        try { json = JSON.parse(text); } catch (e) {}
        return { ok: r.ok, status: r.status, body: json, textPreview: json ? null : text.slice(0, 400) };
      } catch (e) {
        return { ok: false, fetchError: e.message };
      }
    })()
  `;
  const res = await evaluateAsync(expr);
  if (!res) throw new Error('No response from scanner endpoint');

  if (res.fetchError || res.status === 429) {
    const status = res.status === 429 ? 429 : await classifyFetchFailure(url);
    if (status === 429) {
      consecutive429s += 1;
      const cooldown = Math.min(COOLDOWN_BASE_MS * 2 ** (consecutive429s - 1), COOLDOWN_MAX_MS);
      cooldownUntil = Date.now() + cooldown;
      throw rateLimitError();
    }
    if (res.fetchError) {
      throw new Error(
        `Scanner fetch failed: ${res.fetchError}` +
        (status ? ` (endpoint answered HTTP ${status} outside the page — likely a CSP/CORS block)` : ' (endpoint unreachable — network problem)')
      );
    }
  }

  consecutive429s = 0;
  return res;
}

/**
 * Fetch one symbol's columns and return a column→value map, or null if the
 * scanner has no row for it. Throws with the scanner's own message on a
 * rejected query so callers can surface the exact problem.
 */
export async function scanRow(market, symbol, columns) {
  const url = `${SCANNER_BASE}/${encodeURIComponent(market)}/scan`;
  const body = JSON.stringify({ symbols: { tickers: [symbol] }, columns });
  const res = await scannerFetch(url, body);

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
  const res = await scannerFetch(url, body);
  const row = res?.body?.data?.[0];
  if (!row || !Array.isArray(row.d)) return null;
  const map = {};
  columns.forEach((c, i) => { map[c] = row.d[i]; });
  return { symbol: row.s, map };
}

/**
 * Batch fetch: one scanner request for MANY tickers. Returns a Map of
 * requested ticker → column map; tickers the scanner has no row for are
 * simply absent. This is the volume-friendly path — N symbols cost one HTTP
 * request instead of N (× the resolveRow retry ladder), which is what keeps
 * a polling caller under CloudFront's per-IP rate limit.
 */
export async function scanRows(market, tickers, columns) {
  const url = `${SCANNER_BASE}/${encodeURIComponent(market)}/scan`;
  const body = JSON.stringify({ symbols: { tickers }, columns });
  const res = await scannerFetch(url, body);

  const scannerError = res.body && typeof res.body === 'object' ? res.body.error : null;
  if (!res.ok || scannerError) {
    throw new Error(
      scannerError
        ? `Scanner rejected query: ${scannerError}`
        : `Scanner returned HTTP ${res.status}${res.textPreview ? `: ${res.textPreview}` : ''}`
    );
  }

  const out = new Map();
  for (const row of res.body?.data ?? []) {
    if (!row || !Array.isArray(row.d)) continue;
    const map = {};
    columns.forEach((c, i) => { map[c] = row.d[i]; });
    out.set(row.s, map);
  }
  return out;
}

// "global" is a universal superset scanner market (US/intl stocks, crypto,
// forex, futures incl. MCX/commodity contracts). We fall back to it whenever
// the exchange-derived market has no row, which covers exchanges that
// exchangeToMarket() doesn't map (e.g. MCX → falls back to "america" → empty).
const GLOBAL_MARKET = 'global';

/**
 * Resolve a symbol's columns, most-specific to most-general:
 *   1. exact ticker in the exchange-derived market
 *   2. exact ticker in the "global" superset market (catches unmapped
 *      exchanges like MCX)
 *   3. bare-ticker name match in the derived market, then in global
 *      (catches exchange-prefix mismatches, e.g. BATS:CDNL → NASDAQ:CDNL)
 * Returns { symbol, map } (symbol = the resolved one, possibly different from
 * input), or null if nothing matched.
 */
export async function resolveRow(market, symbol, columns) {
  const exact = await scanRow(market, symbol, columns);
  if (exact) return { symbol, map: exact };

  if (market !== GLOBAL_MARKET) {
    const exactGlobal = await scanRow(GLOBAL_MARKET, symbol, columns);
    if (exactGlobal) return { symbol, map: exactGlobal };
  }

  const bareTicker = String(symbol).split(':').pop();
  const byName = await scanRowByName(market, bareTicker, columns);
  if (byName) return { symbol: byName.symbol || symbol, map: byName.map };

  if (market !== GLOBAL_MARKET) {
    const byNameGlobal = await scanRowByName(GLOBAL_MARKET, bareTicker, columns);
    if (byNameGlobal) return { symbol: byNameGlobal.symbol || symbol, map: byNameGlobal.map };
  }

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
