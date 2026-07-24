import { getSetting } from '@/lib/settings';
import { logDebug } from '@/lib/debug-log';

/**
 * BrightData integration.
 *
 * SERP API (https://brightdata.com/products/serp-api): we send a search-engine
 * results URL through the customer's SERP zone and get parsed JSON back. The
 * same zone serves Google and Bing — only the target URL differs — so the auto
 * search queries both and merges the results (a link Google buries often ranks
 * on Bing, and vice versa). Used on lead intake and for the manual "Run search"
 * from a contact's panel.
 *
 * The same settings blob also stores the BACKCONNECT ROTATING PROXY zone
 * credentials (proxy_zone / proxy_username / proxy_password). Those are for
 * manual web searches done outside this app (browser/proxy manager) — the
 * Admin → Integrations page displays the connection string, e.g.
 *   brd.superproxy.io:33335, user brd-customer-<id>-zone-<zone>, pass <pass>
 */

export type SearchEngine = 'google' | 'bing';

export interface SerpResult {
  title: string;
  link: string;
  snippet: string;
  position: number;
  engine: SearchEngine;
}

/** Builds the engine-specific search URL. brd_json=1 asks BrightData to parse it. */
function buildSerpTarget(
  engine: SearchEngine,
  query: string,
  num: number,
  country: string
): string {
  const q = encodeURIComponent(query);
  return engine === 'bing'
    ? `https://www.bing.com/search?q=${q}&count=${num}&cc=${country}&brd_json=1`
    : `https://www.google.com/search?q=${q}&num=${num}&gl=${country}&brd_json=1`;
}

export async function runSerpSearch(
  query: string,
  opts?: { engine?: SearchEngine; numResults?: number; country?: string }
): Promise<SerpResult[]> {
  const engine = opts?.engine ?? 'google';

  const cfg = await getSetting<{ api_key?: string; serp_zone?: string }>('brightdata');
  if (!cfg.api_key || !cfg.serp_zone) {
    throw new Error('BrightData is not configured (Admin → Integrations).');
  }

  const search = await getSetting<{ country?: string; num_results?: number }>('search');
  const num = opts?.numResults ?? search.num_results ?? 20;
  const country = opts?.country ?? search.country ?? 'us';

  const target = buildSerpTarget(engine, query, num, country);

  const res = await fetch('https://api.brightdata.com/request', {
    method: 'POST',
    signal: AbortSignal.timeout(60_000),
    headers: {
      Authorization: `Bearer ${cfg.api_key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ zone: cfg.serp_zone, url: target, format: 'raw' }),
  });

  // Read as text first. A 200 with an empty or non-JSON body is a real
  // BrightData failure mode (wrong zone type, zone disabled, upstream block),
  // and res.json() would only report "Unexpected end of JSON input" — which
  // says nothing about the cause.
  const bodyText = await res.text();
  const snippet = bodyText.slice(0, 300);

  if (!res.ok) {
    await logDebug({
      source: 'brightdata',
      message: `${engine} SERP request failed: HTTP ${res.status}`,
      context: { engine, zone: cfg.serp_zone, query, response: snippet },
    });
    throw new Error(`BrightData ${engine} SERP request failed: ${res.status} ${snippet}`);
  }

  if (!bodyText.trim()) {
    await logDebug({
      source: 'brightdata',
      message: `${engine} SERP returned HTTP 200 with an empty body`,
      context: { engine, zone: cfg.serp_zone, query },
    });
    throw new Error(
      `BrightData returned an empty ${engine} response for zone "${cfg.serp_zone}". ` +
        'Confirm the zone exists, is active, and is a SERP API zone (not a proxy zone).'
    );
  }

  let data: any;
  try {
    data = JSON.parse(bodyText);
  } catch {
    await logDebug({
      source: 'brightdata',
      message: `${engine} SERP returned a non-JSON body`,
      context: { engine, zone: cfg.serp_zone, query, response: snippet },
    });
    throw new Error(`BrightData returned a non-JSON ${engine} response: ${snippet}`);
  }

  // Depending on zone configuration BrightData may wrap the target response
  // in an envelope ({ body: "<json string>" }) instead of returning it raw.
  if (data && typeof data.body === 'string') {
    try {
      data = JSON.parse(data.body);
    } catch {
      // Not JSON inside the envelope — fall through to the empty-results path.
    }
  }

  const organic = data?.organic ?? data?.organic_results ?? [];

  if (!Array.isArray(organic) || organic.length === 0) {
    await logDebug({
      level: 'warn',
      source: 'brightdata',
      message: `${engine} SERP response contained no organic results`,
      context: { engine, zone: cfg.serp_zone, query, top_level_keys: Object.keys(data ?? {}) },
    });
  }

  return organic.map((r: any, i: number) => ({
    title: r.title ?? '',
    link: r.link ?? r.url ?? '',
    snippet: r.description ?? r.snippet ?? '',
    position: r.rank ?? r.position ?? i + 1,
    engine,
  }));
}

/**
 * Strips scheme / www / trailing slash so the same page returned by two engines
 * dedupes to one entry. The path and query are preserved on purpose — on a
 * mugshot or complaint site each record is a distinct URL that differs only in
 * its path, and collapsing those would drop real results.
 */
function canonicalUrl(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

/**
 * Merges results from multiple engines, de-duplicated by canonical URL. Lists
 * are interleaved by rank (Google #1, Bing #1, Google #2, …) so the strongest
 * hits from each engine stay near the top; first writer wins, so a page found
 * by both keeps whichever engine ranked it higher.
 */
export function mergeSerpResults(lists: SerpResult[][]): SerpResult[] {
  const seen = new Set<string>();
  const merged: SerpResult[] = [];
  const maxLen = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < maxLen; i++) {
    for (const list of lists) {
      const result = list[i];
      if (!result?.link) continue;
      const key = canonicalUrl(result.link);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(result);
    }
  }
  return merged;
}
