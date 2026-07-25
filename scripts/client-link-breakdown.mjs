/**
 * Breaks a column of client links down by site, state, and county, so registry
 * work can be aimed at where the business actually is.
 *
 *   node --experimental-strip-types scripts/client-link-breakdown.mjs <links.xlsx>
 *
 * Caveats worth remembering when reading the output: counts are per URL, and
 * only URLs whose shape carries a county yield one, so the county table
 * undercounts and the state table is the more reliable cut. Fused subdomains
 * ("palmbeachfl") produce squashed county names, which matching tolerates.
 */

import XLSX from 'xlsx';
import * as fs from 'node:fs';
XLSX.set_fs(fs);
import { factsFromUrl } from '../lib/deep-search/extract.ts';
import { stateCode } from '../lib/deep-search/facts.ts';

const file = process.argv[2];
if (!file) {
  console.error('usage: node --experimental-strip-types scripts/client-link-breakdown.mjs <links.xlsx>');
  process.exit(1);
}
const wb = XLSX.readFile(file);
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, blankrows: false });
const urls = rows.map(r => String(r[0]||'').trim()).filter(u => /^https?:/i.test(u));
const NONAME = { first:'', last:'', middle:'' };
const bump = (m,k) => m.set(k, (m.get(k)||0)+1);
const sites = new Map(), states = new Map(), counties = new Map(), hosts = new Map();
let social = 0, news = 0;
const SOCIAL = /facebook\.com|instagram\.com|x\.com|twitter\.com|tiktok\.com|threads\.net|reddit\.com|youtube\.com/i;

for (const u of urls) {
  let h; try { h = new URL(u).hostname.toLowerCase().replace(/^www\./,''); } catch { continue; }
  const base = h.split('.').slice(-2).join('.');
  bump(sites, base);
  bump(hosts, h);
  if (SOCIAL.test(h)) social++;
  const f = factsFromUrl(u, NONAME);
  for (const s of new Set(f.state ?? [])) bump(states, s);
  const st = (f.state ?? [])[0] ?? '';
  for (const c of new Set(f.county ?? [])) bump(counties, st ? `${c}, ${st}` : c);
}
const show = (title, map, n, total) => {
  console.log(`\n## ${title}`);
  [...map.entries()].sort((a,b)=>b[1]-a[1]).slice(0,n)
    .forEach(([k,v],i) => console.log(`${String(i+1).padStart(2)}. ${String(v).padStart(4)}  ${(100*v/total).toFixed(1).padStart(4)}%  ${k}`));
};
console.log(`TOTAL URLS: ${urls.length}   distinct sites: ${sites.size}   social: ${social} (${(100*social/urls.length).toFixed(1)}%)`);
show('Top sites', sites, 20, urls.length);
show('States', states, 15, urls.length);
show('Counties', counties, 20, urls.length);
show('mugshots.zone county subdomains', new Map([...hosts].filter(([h])=>h.endsWith('mugshots.zone'))), 15, 207);
