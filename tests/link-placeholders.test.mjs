import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  templateUsesLinks,
  loadLinkPlaceholders,
  linkVarsFromRows,
} from '../lib/link-placeholders.ts';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');

test('templateUsesLinks only fires for link tokens', () => {
  assert.equal(templateUsesLinks('hi {{link1}}'), true);
  assert.equal(templateUsesLinks('all: {{links}}'), true);
  assert.equal(templateUsesLinks('{{ link12 }}'), true);
  assert.equal(templateUsesLinks('nope {{name}}, {{city}}'), false);
  assert.equal(templateUsesLinks(null, undefined, ''), false);
});

test('loadLinkPlaceholders maps positions, keeps live-only {{links}}, http(s)-only', async () => {
  const rows = [
    { position: 1, url: 'https://a.example', status: 'live' },
    { position: 2, url: 'http://b.example', status: 'removed' },
    { position: 3, url: 'javascript:alert(1)', status: 'live' }, // must be dropped
    { position: 4, url: '', status: 'live' }, // empty dropped
  ];
  const admin = {
    from: () => ({ select: () => ({ eq: () => ({ order: async () => ({ data: rows }) }) }) }),
  };
  const vars = await loadLinkPlaceholders(admin, 'c1');
  assert.equal(vars.link1, 'https://a.example');
  assert.equal(vars.link2, 'http://b.example');
  assert.equal(vars.link3, undefined); // javascript: excluded
  assert.equal(vars.link4, undefined); // empty excluded
  // {{links}} = live http(s) links only, newline-joined (b is removed).
  assert.equal(vars.links, 'https://a.example');
});

test('every send path resolves link placeholders per contact', async () => {
  const route = await read('../app/api/email/send/route.ts');
  assert.match(route, /loadLinkPlaceholdersForContacts/);
  // Bulk paths load link rows once; the single-send branch retains the helper.
  assert.match(route, /withLinkPlaceholders\(admin, contact, body\.subject, body\.html\)/);
  assert.match(route, /enqueueJobsBatch\(jobs\)/);
  assert.match(route, /withLinkPlaceholders\(admin, contact, body\.subject, body\.html\)/);
  assert.match(route, /renderTemplate\(body\.subject, rendered\)/);

  const runner = await read('../lib/sequence-runner.ts');
  assert.match(runner, /withLinkPlaceholders\(supabase, contact, rawSubject, rawHtml\)/);
  assert.match(runner, /renderTemplate\(rawSubject, rendered\)/);
});

test('the editor offers a link-placeholder dropdown; email surfaces pass tokens', async () => {
  const editor = await read('../components/RichTextEditor.tsx');
  assert.match(editor, /linkPlaceholders\?: LinkPlaceholder\[\]/);
  assert.match(editor, /const insertLinkPlaceholder/);
  assert.match(editor, /Insert link…/);
  // a single link inserts a clickable anchor; the list token goes in as text
  assert.match(editor, /entry\.asLink === false/);

  const cp = await read('../components/ContactPanel.tsx');
  assert.match(cp, /linkPlaceholders=\{linkPlaceholders\}/);
  assert.match(cp, /token: `\{\{link\$\{l\.position\}\}\}`/);

  // The placeholder list is now shared; the marketing sequence-step editor
  // still offers it.
  const shared = await read('../lib/template-placeholders.ts');
  assert.match(shared, /export const LINK_PLACEHOLDERS/);
  const mk = await read('../app/(app)/marketing/page.tsx');
  assert.match(mk, /linkPlaceholders=\{LINK_PLACEHOLDERS\}/);
});

test('linkVarsFromRows maps positions, keeps live-only {{links}}, http(s)-only', () => {
  const vars = linkVarsFromRows([
    { position: 1, url: 'https://a.example', status: 'live' },
    { position: 2, url: 'http://b.example', status: 'removed' },
    { position: 3, url: 'javascript:alert(1)', status: 'live' }, // dropped
    { position: 4, url: '', status: 'live' }, // dropped
    { position: 5, url: '  https://c.example  ', status: 'live' }, // trimmed + kept
  ]);
  assert.equal(vars.link1, 'https://a.example');
  assert.equal(vars.link2, 'http://b.example');
  assert.equal(vars.link3, undefined);
  assert.equal(vars.link4, undefined);
  assert.equal(vars.link5, 'https://c.example');
  // {{links}} = live http(s) links only, newline-joined, in position order.
  assert.equal(vars.links, 'https://a.example\nhttps://c.example');
});

test('linkVarsFromRows tolerates empty / nullish input', () => {
  assert.deepEqual(linkVarsFromRows([]), { links: '' });
  assert.deepEqual(linkVarsFromRows(null), { links: '' });
  assert.deepEqual(linkVarsFromRows(undefined), { links: '' });
});

test('the one-off SMS path resolves deep-search links and the composer inserts them', async () => {
  const route = await read('../app/api/contacts/[id]/sms/route.ts');
  assert.match(route, /withLinkPlaceholders\(admin, contact, rawBody\)/); // resolved at send
  assert.match(route, /renderTemplate\(rawBody, enriched\)/);

  const panel = await read('../components/ContactPanel.tsx');
  assert.match(panel, /linkVarsFromRows\(links\)/); // preview/counter enriched
  assert.match(panel, /\.\.\.linkVars/);
  assert.match(panel, /Insert deep-search link…/); // composer insert control
});
