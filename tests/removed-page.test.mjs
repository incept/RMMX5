import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLoadedPage, pageMentionsName } from '../lib/deep-search/removed-page.ts';

test('a live record page that names the client reads live', () => {
  const html =
    '<html><head><title>John Smith — Booking #4412</title></head><body>' +
    '<h1>John Smith</h1><p>Booked into county jail on 2026-01-04. Charges pending for John Smith.</p>' +
    '</body></html>';
  assert.equal(
    classifyLoadedPage('https://recordsite.example/john-smith', 'John Smith', html),
    'live'
  );
});

test('a "record removed" placeholder reads gone even when it still echoes the name', () => {
  const html =
    '<html><head><title>Record Removed</title></head><body>' +
    'This record has been removed at the request of John Smith.</body></html>';
  assert.equal(
    classifyLoadedPage('https://recordsite.example/john-smith', 'John Smith', html),
    'gone'
  );
});

test('a generic "no longer available" placeholder reads gone', () => {
  const html = '<html><body>This profile is no longer available.</body></html>';
  assert.equal(classifyLoadedPage('https://recordsite.example/x', 'Jane Doe', html), 'gone');
});

test('a page that no longer names the client reads gone', () => {
  const html = '<html><body><h1>County Roster</h1><p>No matching records.</p></body></html>';
  assert.equal(classifyLoadedPage('https://recordsite.example/x', 'John Smith', html), 'gone');
});

test('unrelated "removed" wording on a live page does not false-positive', () => {
  // "removed from custody" must not be read as a removed RECORD.
  const html =
    '<html><head><title>Jane Doe — Arrest Record</title></head><body>' +
    '<h1>Jane Doe</h1><p>Jane Doe was removed from custody on bond.</p></body></html>';
  assert.equal(classifyLoadedPage('https://recordsite.example/jane', 'Jane Doe', html), 'live');
});

test('name matching needs every token present as a whole word', () => {
  assert.equal(pageMentionsName('booking for john q smith today', 'John Smith'), true);
  assert.equal(pageMentionsName('john johnson was here', 'John Smith'), false);
  assert.equal(pageMentionsName('anything at all', ''), true); // no name -> cannot disprove
});
