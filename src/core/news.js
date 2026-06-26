/**
 * Core news logic — reads symbol/market news from TradingView's public news
 * service, run as an in-page fetch() over CDP (carries TV's auth cookies,
 * dodges CSP/CORS), same technique as the scanner-backed modules.
 *
 * Two endpoints (verified live 2026-06-26):
 *  - Headlines feed: GET news-headlines.tradingview.com/v2/headlines
 *      ?client=overview&lang=en&streaming=false&symbol=<EXCHANGE:TICKER>
 *    Returns up to ~25 items: { id, title, provider, source, published (unix
 *    ms), urgency, relatedSymbols, storyPath, ... }. No `category` param is
 *    required — `client=overview` + `symbol=` works across stocks, futures,
 *    forex, crypto and international symbols.
 *  - Story body: GET news-headlines.tradingview.com/v3/story?id=<id>&lang=en
 *    Returns the full article with the body as a rich-text AST in
 *    `astDescription` (a {type, children, params} tree) plus shortDescription,
 *    read_time, tags. (The news-mining host is CORS-blocked — use v3/story.)
 */
import { evaluateAsync, evaluate, safeString } from '../connection.js';

const NEWS_BASE = 'https://news-headlines.tradingview.com';

// Default and hard cap on headlines returned to the caller, to keep context
// small. The feed itself returns ~25; we never return more than MAX.
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/** Fetch a URL in-page and return its parsed JSON, or throw with context. */
async function fetchJson(url) {
  const expr = `
    (async function() {
      try {
        const r = await fetch(${safeString(url)}, {
          method: "GET",
          headers: { "Content-Type": "text/plain" }
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
  if (!res) throw new Error('No response from news endpoint');
  if (res.fetchError) throw new Error(`News fetch failed: ${res.fetchError}`);
  if (!res.ok) {
    throw new Error(`News endpoint returned HTTP ${res.status}${res.textPreview ? `: ${res.textPreview}` : ''}`);
  }
  return res.body;
}

/** Current chart symbol (exchange-qualified, e.g. "NSE:BPCL"), or null. */
async function getCurrentSymbol() {
  try {
    return await evaluate(`window.TradingViewApi._activeChartWidgetWV.value().symbol()`);
  } catch {
    return null;
  }
}

/** Compact relative age from a unix-ms timestamp: "2h", "3d", "just now". */
function age(publishedMs) {
  if (!Number.isFinite(Number(publishedMs))) return null;
  // published is unix SECONDS in v3/story and ms in v2/headlines — normalise:
  let ms = Number(publishedMs);
  if (ms < 1e12) ms *= 1000; // looks like seconds
  const diff = Date.now() - ms;
  if (diff < 0) return 'upcoming';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

/** Unix (s or ms) → ISO string, or null. */
function iso(ts) {
  if (!Number.isFinite(Number(ts))) return null;
  let ms = Number(ts);
  if (ms < 1e12) ms *= 1000;
  return new Date(ms).toISOString();
}

/** Normalise a provider/source field that may be a string or {id,name,...}. */
function providerName(p) {
  if (p == null) return null;
  if (typeof p === 'string') return p;
  return p.name || p.id || null;
}

/** Pull the headline array out of whatever envelope the feed used. */
function feedItems(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  return body.items || body.news || body.data || [];
}

/** Flatten a TradingView rich-text AST node into plain text. */
function astText(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(astText).join('');
  // object node
  const t = node.type;
  if (t === 'symbol') return node.params?.text || node.params?.symbol || '';
  if (t === 'url') return node.params?.text || astText(node.children) || node.params?.url || '';
  const inner = node.children ? astText(node.children) : '';
  if (t === 'p') return `${inner}\n\n`;
  if (t === 'br') return '\n';
  if (inner) return inner;
  return node.params?.text || '';
}

/**
 * List recent news headlines for a symbol (or the current chart symbol).
 *
 * @param {object} [opts]
 * @param {string} [opts.symbol] Exchange-qualified symbol; defaults to chart.
 * @param {number} [opts.limit]  Max headlines (default 20, hard cap 50).
 * @returns {Promise<{success, symbol, count, headlines}>}
 */
export async function newsList({ symbol, limit } = {}) {
  const sym = symbol || await getCurrentSymbol();
  if (!sym) {
    return { success: false, error: 'No symbol given and no active chart symbol detected.' };
  }
  const n = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(Number(limit)) ? Number(limit) : DEFAULT_LIMIT));

  const url = `${NEWS_BASE}/v2/headlines?client=overview&lang=en&streaming=false&symbol=${encodeURIComponent(sym)}`;
  const body = await fetchJson(url);
  const items = feedItems(body).slice(0, n);

  const headlines = items.map((it) => ({
    id: it.id ?? null,
    title: it.title ?? null,
    provider: providerName(it.provider ?? it.source),
    published: iso(it.published),
    age: age(it.published),
    urgency: it.urgency ?? null,
    symbols: Array.isArray(it.relatedSymbols)
      ? it.relatedSymbols.map((s) => s.symbol || s).slice(0, 6)
      : undefined,
  }));

  return { success: true, symbol: sym, count: headlines.length, headlines };
}

/**
 * Read the full body of one story by id (from newsList).
 *
 * @param {object} opts
 * @param {string} opts.id  Story id from a newsList headline.
 * @returns {Promise<{success, id, title, body, ...}>}
 */
export async function newsRead({ id } = {}) {
  if (!id) return { success: false, error: 'A story id (from news_list) is required.' };

  const url = `${NEWS_BASE}/v3/story?id=${encodeURIComponent(id)}&lang=en`;
  const story = await fetchJson(url);
  if (!story || typeof story !== 'object') {
    return { success: false, id, error: 'Story endpoint returned no usable body.' };
  }

  const bodyText = astText(story.astDescription).replace(/\n{3,}/g, '\n\n').trim();

  return {
    success: true,
    id,
    title: story.title ?? null,
    provider: providerName(story.provider ?? story.source),
    published: iso(story.published),
    read_time: story.read_time ?? null,
    tags: Array.isArray(story.tags) ? story.tags.map((t) => t.title || t).slice(0, 10) : undefined,
    symbols: Array.isArray(story.relatedSymbols)
      ? story.relatedSymbols.map((s) => s.symbol || s).slice(0, 10)
      : undefined,
    body: bodyText || story.shortDescription || null,
  };
}
