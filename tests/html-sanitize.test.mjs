import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeEmailHtml } from '../lib/html-sanitize.ts';

test('removes <script> blocks and their contents', () => {
  assert.equal(sanitizeEmailHtml('<p>hi</p><script>alert(1)</script>'), '<p>hi</p>');
  assert.doesNotMatch(sanitizeEmailHtml('<div><script>steal()</script></div>'), /steal/);
});

test('removes iframe/object/embed', () => {
  assert.doesNotMatch(sanitizeEmailHtml('<iframe src="evil"></iframe>'), /iframe/i);
  assert.doesNotMatch(sanitizeEmailHtml('<object data="x"></object>'), /object/i);
});

test('strips inline event handlers but keeps the element', () => {
  const out = sanitizeEmailHtml('<img src="x.png" onerror="alert(1)" alt="a">');
  assert.doesNotMatch(out, /onerror/i);
  assert.match(out, /src="x\.png"/);
  assert.match(out, /alt="a"/);
});

test('neutralizes javascript: links, keeps safe ones', () => {
  assert.match(sanitizeEmailHtml('<a href="javascript:alert(1)">x</a>'), /href="#"/);
  assert.match(sanitizeEmailHtml('<a href="https://ex.com/p">x</a>'), /href="https:\/\/ex\.com\/p"/);
  assert.match(sanitizeEmailHtml('<a href="mailto:a@b.com">x</a>'), /mailto:a@b\.com/);
});

test('defeats whitespace/entity-obfuscated javascript scheme', () => {
  assert.match(sanitizeEmailHtml('<a href="java\tscript:alert(1)">x</a>'), /href="#"/);
  assert.match(sanitizeEmailHtml('<a href="java&#09;script:alert(1)">x</a>'), /href="#"/);
  assert.match(sanitizeEmailHtml('<a href="  javascript:alert(1)">x</a>'), /href="#"/);
});

test('allows data:image but blocks other data: URIs', () => {
  assert.match(sanitizeEmailHtml('<img src="data:image/png;base64,iVBORw0KG">'), /data:image\/png/);
  assert.match(sanitizeEmailHtml('<img src="data:text/html;base64,PHNjcmlwdD4=">'), /src="#"/);
});

test('preserves <style> blocks (designed emails rely on them)', () => {
  const out = sanitizeEmailHtml('<style>.a{color:red}</style><p class="a">hi</p>');
  assert.match(out, /<style>\.a\{color:red\}<\/style>/);
});

test('preserves ordinary formatting, lists, images, links', () => {
  const html =
    '<p><b>bold</b> <i>it</i> <u>u</u></p><ul><li>one</li></ul><img src="https://x/y.png" style="max-width:100%">';
  const out = sanitizeEmailHtml(html);
  assert.match(out, /<b>bold<\/b>/);
  assert.match(out, /<ul><li>one<\/li><\/ul>/);
  assert.match(out, /<img src="https:\/\/x\/y\.png"/);
});

test('is idempotent', () => {
  const dirty = '<p onclick="x()">hi</p><script>y()</script><a href="javascript:1">l</a>';
  const once = sanitizeEmailHtml(dirty);
  assert.equal(sanitizeEmailHtml(once), once);
});

test('handles empty / nullish input', () => {
  assert.equal(sanitizeEmailHtml(''), '');
  assert.equal(sanitizeEmailHtml(undefined), '');
  assert.equal(sanitizeEmailHtml(null), '');
});
