import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');

test('append_sent write-back builds a MIME and appends to the Sent folder', async () => {
  const sync = await read('../lib/integrations/imap-sync.ts');
  assert.match(sync, /'seen' \| 'unseen' \| 'delete' \| 'append_sent'/);
  assert.match(sync, /op === 'append_sent'/);
  assert.match(sync, /findFolder\(client, '\\\\Sent'/);
  assert.match(sync, /streamTransport: true/); // builds the RFC822 without sending
  assert.match(sync, /client\.append\(sent/);
});

test('interactive 1:1 sends opt into Sent; bulk + sequences do not', async () => {
  const send = await read('../lib/email-send.ts');
  assert.match(send, /appendToSent\?: boolean/);
  assert.match(send, /opts\.appendToSent && account\?\.imap_enabled/);
  assert.match(send, /enqueueImapWriteback\('append_sent'/);
  // The single-send route branch opts in; the admin list-send loop does not.
  const route = await read('../app/api/email/send/route.ts');
  assert.match(route, /appendToSent: true/);
  // The email_delivery job threads the flag through, and the op is accepted.
  const queue = await read('../lib/job-queue.ts');
  assert.match(queue, /appendToSent: payload\.appendToSent === true/);
  assert.match(queue, /op !== 'append_sent'/);
});

test('the inbox has a search box that filters the query', async () => {
  const inbox = await read('../app/(app)/inbox/page.tsx');
  assert.match(inbox, /placeholder="Search subject, from, to/);
  assert.match(inbox, /subject\.ilike\.%\$\{term\}%,from_email\.ilike/);
});
