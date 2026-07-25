/**
 * Measures what the deep-search parsers can extract from a column of real
 * client links, so a registry or parser change can be judged against history
 * instead of a hunch.
 *
 *   node --experimental-strip-types scripts/extraction-coverage.mjs <links.xlsx>
 *
 * The spreadsheet is one URL per row in the first column. Coverage is per URL;
 * per CLIENT it is far higher, because deep search merges facts across every
 * link it finds for one person.
 */
const file = process.argv[2];
if (!file) {
  console.error('usage: node --experimental-strip-types scripts/extraction-coverage.mjs <links.xlsx>');
  process.exit(1);
}

import XLSX from 'xlsx';
import * as fs from 'node:fs';
XLSX.set_fs(fs); // the ESM build needs fs injected explicitly
import { factsFromUrl, findMiddleNames } from '../lib/deep-search/extract.ts';
import { splitName } from '../lib/deep-search/facts.ts';
const wb = XLSX.readFile(file);
const rows = XLSX.utils.sheet_to_json(wb.Sheets['Sheet1'], { header: 1, blankrows: false });
const urls = rows.map(r => String(r[0]||'').trim()).filter(u => /^https?:/i.test(u));
const NO_NAME = { first: '', last: '', middle: '' };
let state = 0, county = 0, date = 0, id = 0;
const perDomain = new Map();
for (const u of urls) {
  const f = factsFromUrl(u, NO_NAME);
  let host = ''; try { host = new URL(u).hostname.replace(/^www\./,'').split('.').slice(-2).join('.'); } catch {}
  const e = perDomain.get(host) ?? { n:0, s:0, c:0, d:0 };
  e.n++;
  if (f.state?.length) { state++; e.s++; }
  if (f.county?.length) { county++; e.c++; }
  if (f.booking_dates?.length) { date++; e.d++; }
  if (f.record_ids?.length) id++;
  perDomain.set(host, e);
}
const pct = n => (100*n/urls.length).toFixed(0) + '%';
console.log(`urls=${urls.length}  state=${pct(state)}  county=${pct(county)}  date=${pct(date)}  recordId=${pct(id)}`);
console.log('--- n / state / county / date ---');
[...perDomain.entries()].sort((a,b)=>b[1].n-a[1].n).slice(0,7)
  .forEach(([d,e]) => console.log(`${String(e.n).padStart(4)}  ${d.padEnd(22)} state ${String(e.s).padStart(3)}  county ${String(e.c).padStart(3)}  date ${String(e.d).padStart(3)}`));

// middle names, on the one lead we know the identity of
const R = splitName('Jeffery Remmark');
console.log('--- Remmark middle-name extraction ---');
for (const u of urls.filter(u => /remmark/i.test(u)).slice(0,5)) {
  const f = factsFromUrl(u, R);
  console.log(`  ${JSON.stringify({middle:f.middle,county:f.county,state:f.state,date:f.booking_dates})}  <- ${u.slice(0,72)}`);
}
