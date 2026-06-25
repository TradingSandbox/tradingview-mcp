/**
 * Core Futures & Options logic — reads option chains (with greeks) and futures
 * term structures directly from TradingView's public scanner REST endpoint
 * (https://scanner.tradingview.com/<market>/scan), the same data path the
 * screener uses (see core/screener_query.js). The request runs as an in-page
 * fetch() over CDP so it carries TV's auth cookies and dodges CSP/CORS.
 *
 * Why text/plain on a JSON body: keeps the request "simple" per the Fetch spec
 * so the browser skips the CORS preflight that scanner.tradingview.com doesn't
 * answer. TV's server ignores the declared content type.
 *
 * Key facts about the F&O scanner (verified live 2026-06-17):
 *  - Options: POST /options/scan REQUIRES an index filter naming the underlying
 *    ({index_filters:[{name:"underlying_symbol", values:["NSE:BPCL"]}]}); without
 *    it the endpoint 400s. Greeks (delta/gamma/theta/vega/rho) and iv are valid
 *    columns once the index is present. `iv` is a decimal fraction (×100 for %).
 *    `expiration` is a YYYYMMDD integer. `close` is the last traded price.
 *    There is no open-interest column — TV's chain doesn't expose it.
 *  - Futures: POST /futures/scan scoped by {filter:[{left:"root", ...}]} where
 *    `root` is EXCHANGE:CODE (e.g. "NYMEX:CL", "NSE:BPCL"), NOT the bare ticker.
 *    Continuous contracts (e.g. "BPCL1!") come back with a null expiration.
 */
import { evaluate, evaluateAsync, safeString } from '../connection.js';
import { exchangeToMarket } from './screener_query.js';

const SCANNER_BASE = 'https://scanner.tradingview.com';

// Repo-wide cap on rows for the user-facing list (futures term structure).
const MAX_ROWS = 500;

// Internal scan caps. These rows are aggregated/windowed before anything
// reaches the caller, so they can be large without bloating tool output:
//  - EXP_SCAN_ROWS: enough contracts to enumerate every upcoming expiry even
//    for deep index chains where near weeklies carry hundreds of strikes each
//    (NSE:NIFTY ≈ 4k contracts → ~18 expiries; verified live).
//  - CHAIN_SCAN_ROWS: must hold a whole single-expiry chain so the ATM-centered
//    window is computed over the full strike ladder, never a truncated prefix.
const EXP_SCAN_ROWS = 10000;
const CHAIN_SCAN_ROWS = 2000;

// Hard ceiling on strikes returned to the caller, even for strikes=0 ("all") or
// a wide min/max — so a deep expiry (e.g. SPX with ~1k strikes) can never dump
// unbounded data into context. Kept around ATM; output flags strikes_capped.
const MAX_CHAIN_STRIKES = 250;

// Columns we read for each option contract. Order defines the d[] mapping in
// mapOption() — keep the two in sync.
const OPTION_COLUMNS = [
  'name', 'option-type', 'strike', 'expiration',
  'bid', 'ask', 'close', 'volume',
  'delta', 'gamma', 'theta', 'vega', 'rho', 'iv',
];

// Columns we read for each futures contract.
const FUTURES_COLUMNS = ['name', 'description', 'expiration', 'close', 'change', 'currency'];

// Futures month codes (Jan..Dec). Used to peel a dated/continuous contract
// suffix off a symbol to recover its root.
const MONTH_CODES = 'FGHJKMNQUVXZ';

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------

/** Round to `dp` decimals; pass through null / non-finite as null. */
function round(v, dp = 2) {
  if (v == null || !Number.isFinite(Number(v))) return null;
  const f = 10 ** dp;
  return Math.round(Number(v) * f) / f;
}

/** Today as a YYYYMMDD integer, to compare against `expiration`. */
function todayYmd() {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

/** Calendar days from today until a YYYYMMDD expiration (negative if past). */
function daysToExpiry(ymd) {
  if (ymd == null) return null;
  const s = String(ymd);
  if (s.length < 8) return null;
  const exp = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((exp - today) / 86400000);
}

/**
 * Run a scan against the given market and return {total, rows}. Throws an Error
 * carrying the scanner's own message on a rejected/failed query so callers can
 * surface the exact bad field/operator instead of retrying blindly.
 */
async function scan(market, body) {
  const url = `${SCANNER_BASE}/${encodeURIComponent(market)}/scan`;
  const expr = `
    (async function() {
      try {
        const r = await fetch(${safeString(url)}, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: ${safeString(JSON.stringify(body))}
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

  const data = Array.isArray(res.body?.data) ? res.body.data : [];
  return { total: res.body?.totalCount ?? data.length, rows: data };
}

/** Current chart symbol (exchange-qualified, e.g. "NSE:BPCL"), or null. */
async function getCurrentSymbol() {
  try {
    return await evaluate(`window.TradingViewApi._activeChartWidgetWV.value().symbol()`);
  } catch {
    return null;
  }
}

/** Last price + description for any symbol via the scanner. Best-effort. */
async function getSpot(symbol) {
  try {
    const { rows } = await scan(exchangeToMarket(symbol), {
      symbols: { tickers: [symbol] },
      columns: ['close', 'description'],
    });
    const d = rows[0]?.d;
    return { price: Number.isFinite(d?.[0]) ? d[0] : null, description: d?.[1] ?? null };
  } catch {
    return { price: null, description: null };
  }
}

/**
 * Recover a futures root (EXCHANGE:CODE) from any contract symbol:
 *   NYMEX:CL1!     -> NYMEX:CL   (continuous)
 *   NYMEX:CLF2027  -> NYMEX:CL   (dated, 4-digit year)
 *   CME_MINI:ESM26 -> CME_MINI:ES (dated, 2-digit year)
 *   NSE:BPCL       -> NSE:BPCL   (stock root, unchanged)
 */
export function deriveFuturesRoot(symbol) {
  if (!symbol) return null;
  let s = String(symbol).toUpperCase().trim();
  s = s.replace(/\d*!$/, '');                                   // continuous suffix
  s = s.replace(new RegExp(`[${MONTH_CODES}]\\d{4}$`), '');     // dated, YYYY
  s = s.replace(new RegExp(`[${MONTH_CODES}]\\d{2}$`), '');     // dated, YY
  return s;
}

/**
 * Does this symbol look like a futures contract (continuous "X1!" or dated
 * "XF2027")? Used to recover the cash underlying when someone asks for an
 * option chain while charting the future — e.g. NSE:NIFTY1! → NSE:NIFTY.
 */
function looksLikeDerivative(symbol) {
  const s = String(symbol || '').toUpperCase();
  return /\d*!$/.test(s) || new RegExp(`[${MONTH_CODES}]\\d{2,4}$`).test(s);
}

/**
 * Scan upcoming option contracts for one underlying candidate (expired
 * contracts filtered out server-side). Returns the scan result, or null on a
 * scanner error so callers can fall back to the next candidate.
 */
async function scanExpiryRows(underlying) {
  try {
    return await scan('options', {
      columns: ['expiration', 'strike', 'option-type'],
      index_filters: [{ name: 'underlying_symbol', values: [underlying] }],
      filter: [{ left: 'expiration', operation: 'egreater', right: todayYmd() }],
      sort: { sortBy: 'expiration', sortOrder: 'asc' },
      range: [0, EXP_SCAN_ROWS],
    });
  } catch {
    return null;
  }
}

/** The symbol as given, then its cash root if it looks like a futures contract. */
function underlyingCandidates(requested) {
  const cands = [requested];
  if (looksLikeDerivative(requested)) {
    const root = deriveFuturesRoot(requested);
    if (root && root !== requested) cands.push(root);
  }
  return cands;
}

/**
 * Resolve which symbol actually carries an option chain (applying the
 * future→cash fallback) and its nearest upcoming expiry — one cheap 1-row scan
 * per candidate, so a chain request never pulls the full expiry enumeration.
 * Returns {underlying, nearest} or null when nothing has a chain.
 */
async function resolveNearestExpiry(requested) {
  for (const cand of underlyingCandidates(requested)) {
    let res = null;
    try {
      res = await scan('options', {
        columns: ['expiration'],
        index_filters: [{ name: 'underlying_symbol', values: [cand] }],
        filter: [{ left: 'expiration', operation: 'egreater', right: todayYmd() }],
        sort: { sortBy: 'expiration', sortOrder: 'asc' },
        range: [0, 1],
      });
    } catch { res = null; }
    if (res && res.rows.length) return { underlying: cand, nearest: res.rows[0].d[0] };
  }
  return null;
}

/** Map a raw option row (s + d[]) to a typed contract object. */
function mapOption(row) {
  const d = row.d || [];
  return {
    symbol: row.s,
    type: d[1],            // 'call' | 'put'
    strike: d[2],
    expiration: d[3],      // YYYYMMDD
    bid: round(d[4]),
    ask: round(d[5]),
    last: round(d[6]),     // close = last traded price
    volume: d[7] ?? null,
    iv_pct: round(d[13] != null ? d[13] * 100 : null, 2),
    delta: round(d[8], 4),
    gamma: round(d[9], 4),
    theta: round(d[10], 4),
    vega: round(d[11], 4),
    rho: round(d[12], 4),
  };
}

/** Strip a contract down to the per-leg fields shown inside a merged strike. */
function optionLeg(c) {
  return {
    symbol: c.symbol, bid: c.bid, ask: c.ask, last: c.last, volume: c.volume,
    iv_pct: c.iv_pct, delta: c.delta, gamma: c.gamma, theta: c.theta, vega: c.vega, rho: c.rho,
  };
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * List the upcoming option expirations for an underlying (expired contracts
 * excluded) — a discovery call so callers can pick an expiry before pulling a
 * full chain. A futures symbol with no chain falls back to its cash root.
 *
 * @param {object} opts
 * @param {string} [opts.underlying] Underlying symbol (default: current chart).
 * @returns {Promise<{success, underlying, spot, expirations, ...}>}
 */
export async function expirations(opts = {}) {
  const requested = opts.underlying || (await getCurrentSymbol());
  if (!requested) {
    return { success: false, error: 'No underlying given and no current chart symbol available.' };
  }

  // Try the symbol as given; if it's a futures contract with no chain, retry
  // with its cash root (charting NSE:NIFTY1! and asking for options → NSE:NIFTY).
  let underlying = requested;
  let result = null;
  for (const cand of underlyingCandidates(requested)) {
    const rows = await scanExpiryRows(cand);
    if (rows && rows.rows.length) { underlying = cand; result = rows; break; }
  }

  if (!result || !result.rows.length) {
    return {
      success: false,
      underlying: requested,
      error: `No options found for "${requested}". Pass an equity/index underlying like "NSE:BPCL", "NSE:NIFTY", or "NASDAQ:AAPL".`,
    };
  }

  // Aggregate per expiration: distinct strikes, call/put counts.
  const byExp = new Map();
  let strikeMin = Infinity, strikeMax = -Infinity;
  for (const row of result.rows) {
    const [exp, strike, type] = row.d;
    if (Number.isFinite(strike)) { strikeMin = Math.min(strikeMin, strike); strikeMax = Math.max(strikeMax, strike); }
    if (!byExp.has(exp)) byExp.set(exp, { strikes: new Set(), call: 0, put: 0 });
    const e = byExp.get(exp);
    e.strikes.add(strike);
    if (type === 'call') e.call++; else if (type === 'put') e.put++;
  }

  const expirations = [...byExp.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([exp, e]) => ({
      expiration: exp,
      days_to_expiry: daysToExpiry(exp),
      strikes: e.strikes.size,
      calls: e.call,
      puts: e.put,
    }));

  const { price, description } = await getSpot(underlying);

  return {
    success: true,
    underlying,
    description,
    spot: price,
    strike_range: strikeMin <= strikeMax ? { min: strikeMin, max: strikeMax } : null,
    total_contracts: result.total,
    truncated: result.total > EXP_SCAN_ROWS,
    count: expirations.length,
    expirations,
  };
}

/**
 * Read the option chain for an underlying.
 *
 * @param {object} opts
 * @param {string} [opts.underlying]   Underlying symbol (default: current chart).
 * @param {number} [opts.expiration]   YYYYMMDD. Default: nearest upcoming expiry.
 * @param {string} [opts.option_type]  'call' | 'put' | 'both' (default 'both').
 * @param {number} [opts.strikes]      Number of strikes centered on ATM to keep.
 *                                     Default 17 (ATM ±8). Pass 0 for all
 *                                     (capped at MAX_CHAIN_STRIKES).
 * @param {number} [opts.min_strike]   Lower strike bound (overrides `strikes`).
 * @param {number} [opts.max_strike]   Upper strike bound (overrides `strikes`).
 * @returns {Promise<object>}
 */
export async function optionsChain(opts = {}) {
  const requested = opts.underlying || (await getCurrentSymbol());
  if (!requested) {
    return { success: false, error: 'No underlying given and no current chart symbol available.' };
  }

  const optionType = ['call', 'put', 'both'].includes(opts.option_type) ? opts.option_type : 'both';
  const window = opts.strikes == null ? 17 : Math.max(0, Number(opts.strikes) || 0); // 17 = ATM ±8
  const hasRange = Number.isFinite(opts.min_strike) || Number.isFinite(opts.max_strike);

  // Cheap resolution: nearest upcoming expiry + future→cash fallback in one
  // 1-row scan. We do NOT enumerate every expiry here — that's options_expirations'
  // job; pulling one expiry's chain is enough to serve a chain request.
  const res = await resolveNearestExpiry(requested);
  if (!res) {
    return {
      success: false,
      underlying: requested,
      error: `No options found for "${requested}". Pass an equity/index underlying like "NSE:BPCL", "NSE:NIFTY", or "NASDAQ:AAPL".`,
    };
  }
  const resolved = res.underlying;
  const targetExp = opts.expiration != null ? Number(opts.expiration) : res.nearest;
  const { price: spot, description } = await getSpot(resolved);

  // Build filters: underlying index + expiration + optional type/strike-range.
  const filter = [{ left: 'expiration', operation: 'equal', right: targetExp }];
  if (optionType !== 'both') filter.push({ left: 'option-type', operation: 'equal', right: optionType });
  if (hasRange) {
    const lo = Number.isFinite(opts.min_strike) ? opts.min_strike : 0;
    const hi = Number.isFinite(opts.max_strike) ? opts.max_strike : 1e12;
    filter.push({ left: 'strike', operation: 'in_range', right: [lo, hi] });
  }

  let chain;
  try {
    chain = await scan('options', {
      columns: OPTION_COLUMNS,
      index_filters: [{ name: 'underlying_symbol', values: [resolved] }],
      filter,
      sort: { sortBy: 'strike', sortOrder: 'asc' },
      range: [0, CHAIN_SCAN_ROWS],
    });
  } catch (err) {
    return { success: false, error: err.message, underlying: resolved, expiration: targetExp };
  }

  const contracts = chain.rows.map(mapOption);

  // ATM strike: nearest listed strike to spot, falling back to the call whose
  // delta is closest to 0.5 when spot is unavailable.
  const allStrikes = [...new Set(contracts.map(c => c.strike))].sort((a, b) => a - b);
  let atmStrike = null;
  if (Number.isFinite(spot) && allStrikes.length) {
    atmStrike = allStrikes.reduce((a, b) => (Math.abs(b - spot) < Math.abs(a - spot) ? b : a));
  } else {
    const calls = contracts.filter(c => c.type === 'call' && c.delta != null);
    if (calls.length) atmStrike = calls.reduce((a, b) => (Math.abs(b.delta - 0.5) < Math.abs(a.delta - 0.5) ? b : a)).strike;
  }

  // Keep the N strikes nearest the ATM (or middle if spot is unknown).
  const centerOnAtm = (arr, n) => {
    if (n <= 0 || arr.length <= n) return arr;
    const i = atmStrike != null ? arr.indexOf(atmStrike) : Math.floor(arr.length / 2);
    const start = Math.max(0, Math.min(i - Math.floor(n / 2), arr.length - n));
    return arr.slice(start, start + n);
  };

  // Window around ATM unless an explicit range was given, then enforce the hard
  // ceiling so strikes=0 / a wide range can never blow past MAX_CHAIN_STRIKES.
  let keptStrikes = allStrikes;
  if (!hasRange && window > 0) keptStrikes = centerOnAtm(keptStrikes, window);
  let strikesCapped = false;
  if (keptStrikes.length > MAX_CHAIN_STRIKES) {
    keptStrikes = centerOnAtm(keptStrikes, MAX_CHAIN_STRIKES);
    strikesCapped = true;
  }
  const keepSet = new Set(keptStrikes);
  const kept = contracts.filter(c => keepSet.has(c.strike));

  const base = {
    success: true,
    underlying: resolved,
    description,
    spot,
    expiration: targetExp,
    days_to_expiry: daysToExpiry(targetExp),
    atm_strike: atmStrike,
    option_type: optionType,
    total_for_expiry: chain.total,
    truncated: chain.total > chain.rows.length || strikesCapped,
    ...(strikesCapped && { strikes_capped: MAX_CHAIN_STRIKES, note: 'Output capped to the strikes nearest ATM; narrow with strikes, min_strike or max_strike.' }),
  };

  if (optionType !== 'both') {
    const list = kept
      .filter(c => c.type === optionType)
      .map(c => ({ ...c, dist_pct: spot ? round(((c.strike - spot) / spot) * 100, 2) : null, atm: c.strike === atmStrike }));
    return { ...base, count: list.length, options: list };
  }

  // Merge calls and puts onto one row per strike — the natural chain layout.
  const byStrike = new Map();
  for (const c of kept) {
    if (!byStrike.has(c.strike)) byStrike.set(c.strike, { strike: c.strike });
    byStrike.get(c.strike)[c.type] = optionLeg(c);
  }
  const strikes = [...byStrike.values()]
    .sort((a, b) => a.strike - b.strike)
    .map(s => ({
      strike: s.strike,
      atm: s.strike === atmStrike,
      dist_pct: spot ? round(((s.strike - spot) / spot) * 100, 2) : null,
      call: s.call || null,
      put: s.put || null,
    }));

  return { ...base, count: strikes.length, strikes };
}

/**
 * Read the nearest futures contract month(s) for a root. Defaults to just the
 * next expiry; pass months>1 (or 0 for the full curve) to get the term
 * structure with contango/backwardation.
 *
 * @param {object} opts
 * @param {string} [opts.root]    Futures root, EXCHANGE:CODE (e.g. "NYMEX:CL").
 * @param {string} [opts.symbol]  Any contract/continuous symbol to derive the
 *                                root from (default: current chart symbol).
 * @param {number} [opts.months]  How many nearest contract months to return.
 *                                Default 1 (next expiry only); 0 = full curve.
 * @returns {Promise<object>}
 */
export async function futuresCurve(opts = {}) {
  const source = opts.root || opts.symbol || (await getCurrentSymbol());
  if (!source) {
    return { success: false, error: 'No root/symbol given and no current chart symbol available.' };
  }
  const root = opts.root || deriveFuturesRoot(source);
  const months = opts.months == null ? 1 : Math.max(0, Number(opts.months) || 0);

  let result;
  try {
    result = await scan('futures', {
      columns: FUTURES_COLUMNS,
      filter: [{ left: 'root', operation: 'equal', right: root }],
      sort: { sortBy: 'expiration', sortOrder: 'asc' },
      range: [0, MAX_ROWS],
    });
  } catch (err) {
    return { success: false, error: err.message, root };
  }

  if (!result.rows.length) {
    return {
      success: false,
      root,
      error: `No futures contracts found for root "${root}". Roots are EXCHANGE:CODE, e.g. "NYMEX:CL", "CME_MINI:ES", "NSE:BPCL". Pass root= to override.`,
    };
  }

  const all = result.rows.map(row => {
    const d = row.d || [];
    return {
      symbol: row.s,
      name: d[0],
      description: d[1],
      expiration: d[2],                       // YYYYMMDD, null for continuous
      last: round(d[3], 4),
      change_pct: round(d[4], 2),
      currency: d[5] ?? null,
      days_to_expiry: daysToExpiry(d[2]),
      is_continuous: typeof row.s === 'string' && row.s.endsWith('!'),
    };
  });

  // Upcoming dated contracts in calendar order (skip continuous / undated /
  // already-expired). Default to just the nearest month; months=0 = whole curve.
  const today = todayYmd();
  const dated = all.filter(c => !c.is_continuous && c.expiration != null && c.expiration >= today);
  const selected = months > 0 ? dated.slice(0, months) : dated;

  // Term structure over the returned contracts — needs ≥2 priced months.
  const priced = selected.filter(c => c.last != null);
  let structure = null, front = null, back = null, spread_pct = null;
  if (priced.length) {
    front = priced[0];
    if (priced.length >= 2 && front.last) {
      back = priced[priced.length - 1];
      spread_pct = round(((back.last - front.last) / front.last) * 100, 2);
      const eps = front.last * 0.0005; // 0.05% deadband for "flat"
      structure = back.last - front.last > eps ? 'contango'
        : front.last - back.last > eps ? 'backwardation'
        : 'flat';
    }
  }

  const currency = all.find(c => c.currency)?.currency ?? null;

  return {
    success: true,
    root,
    currency,
    months: selected.length,
    total_available: dated.length,
    structure,
    front: front && { symbol: front.symbol, expiration: front.expiration, last: front.last },
    back: back && { symbol: back.symbol, expiration: back.expiration, last: back.last },
    spread_pct,
    count: selected.length,
    contracts: selected,
  };
}
