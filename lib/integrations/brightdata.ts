import { getSetting } from '@/lib/settings';

/**
 * BrightData integration.
 *
 * SERP API (https://brightdata.com/products/serp-api): we send a Google
 * search URL through the customer's SERP zone and get parsed JSON back.
 * Used for the auto-search on lead import and for manual "Search Google"
 * from a contact's panel.
 *
 * The same settings blob also stores the BACKCONNECT ROTATING PROXY zone
 * credentials (proxy_zone / proxy_username / proxy_password). Those are for
 * manual web searches done outside this app (browser/proxy manager) — the
 * Admin → Integrations page displays the connection string, e.g.
 *   brd.superproxy.io:33335, user brd-customer-<id>-zone-<zone>, pass <pass>
 */

export interface SerpResult {
  title: string;
  link: string;
  snippet: string;
  position: number;
}

export async function runGoogleSearch(
  query: string,
  opts?: { numResults?: number; country?: string }
): Promise<SerpResult[]> {
  const cfg = await getSetting<{ api_key?: string; serp_zone?: string }>('brightdata');
  if (!cfg.api_key || !cfg.serp_zone) {
    throw new Error('BrightData is not configured (Admin → Integrations).');
  }

  const search = await getSetting<{ country?: string; num_results?: number }>('search');
  const num = opts?.numResults ?? search.num_results ?? 20;
  const country = opts?.country ?? search.country ?? 'us';

  const target = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${num}&gl=${country}&brd_json=1`;

  const res = await fetch('https://api.brightdata.com/request', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.api_key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ zone: cfg.serp_zone, url: target, format: 'raw' }),
  });

  if (!res.ok) {
    throw new Error(`BrightData SERP request failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const organic = data.organic ?? data.organic_results ?? [];

  return organic.map((r: any, i: number) => ({
    title: r.title ?? '',
    link: r.link ?? r.url ?? '',
    snippet: r.description ?? r.snippet ?? '',
    position: r.rank ?? r.position ?? i + 1,
  }));
}
