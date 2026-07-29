import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { sequenceFailureUpdate } from '../lib/sequence-retry.ts';
import {
  CONTACT_FILE_MAX_BYTES,
  validateContactFile,
  validateVoicemailFile,
} from '../lib/uploads.ts';
import { verifyBearerSecret, verifyEmailitWebhook } from '../lib/webhook-auth.ts';
import { parseCallScalerPage } from '../lib/callscaler-page.ts';
import { deliveryKey, validIdempotencyKey } from '../lib/bulk-delivery.ts';
import {
  readJsonBody,
  requestErrorResponse,
  RequestSizeError,
} from '../lib/request-limits.ts';

test('the super administrator sees the admin menu', async () => {
  const sidebar = await readFile(new URL('../components/Sidebar.tsx', import.meta.url), 'utf8');
  // requireAdmin and useMyRole both treat super_admin as an admin; the nav's
  // own literal role check was the one place that did not, hiding the Admin
  // section from the account with the most authority.
  assert.doesNotMatch(sidebar, /role === 'admin'/);
  assert.match(sidebar, /\['admin', 'super_admin'\]\.includes\(role\)/);
});

test('the public landing page has no signup call', async () => {
  const source = await readFile(new URL('../app/page.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\.auth\.signUp\s*\(/);
  assert.match(source, /provisioned by an administrator/i);
});

test('failed sequence deliveries do not advance and stop after five attempts', () => {
  const retry = sequenceFailureUpdate(0, 'temporary failure', 0);
  assert.equal(retry.attempt_count, 1);
  assert.equal(retry.next_send_at, new Date(15 * 60_000).toISOString());
  assert.equal('current_step' in retry, false);

  const terminal = sequenceFailureUpdate(4, 'permanent failure', 0);
  assert.equal(terminal.status, 'stopped');
  assert.equal(terminal.stop_reason, 'delivery_failed');
  assert.equal(terminal.next_send_at, null);
  assert.equal('current_step' in terminal, false);
});

test('query-string secrets are rejected while bearer secrets work', () => {
  const queryOnly = new Request('https://example.test/hook?secret=correct');
  assert.equal(verifyBearerSecret(queryOnly, 'correct'), false);

  const bearer = new Request('https://example.test/hook', {
    headers: { Authorization: 'Bearer correct' },
  });
  assert.equal(verifyBearerSecret(bearer, 'correct'), true);
  assert.equal(verifyBearerSecret(bearer, 'wrong'), false);
});

test('Emailit HMAC verification binds the raw body and rejects stale requests', () => {
  const rawBody = '{"event_id":"evt_123","type":"email.bounced"}';
  const timestamp = '2000000000';
  const secret = 'whsec_test';
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  assert.equal(verifyEmailitWebhook(rawBody, signature, timestamp, secret, 2000000000), true);
  assert.equal(verifyEmailitWebhook(`${rawBody} `, signature, timestamp, secret, 2000000000), false);
  assert.equal(verifyEmailitWebhook(rawBody, signature, timestamp, secret, 2000000301), false);
});

test('upload validation enforces size and active-content restrictions', () => {
  assert.equal(
    validateContactFile({ name: 'payload.html', size: 10, type: 'text/html' }),
    'HTML, SVG, XML, and JavaScript files are not allowed'
  );
  assert.equal(
    validateContactFile({
      name: 'large.pdf',
      size: CONTACT_FILE_MAX_BYTES + 1,
      type: 'application/pdf',
    }),
    'Files must be 10 MB or smaller'
  );
  assert.equal(
    validateContactFile({ name: 'report.pdf', size: 10, type: 'application/pdf' }),
    null
  );
  assert.equal(
    validateVoicemailFile({ name: 'not-audio.pdf', size: 10, type: 'application/pdf' }),
    'An audio file is required'
  );
});

test('JSON request bodies are bounded even without Content-Length', async () => {
  const request = new Request('https://example.test/api', {
    method: 'POST',
    body: JSON.stringify({ value: 'x'.repeat(100) }),
  });
  await assert.rejects(() => readJsonBody(request, 40), RequestSizeError);
});

test('the forward migration contains the database-level concurrency controls', async () => {
  const migration = await readFile(
    new URL('../supabase/migrations/0003_access_and_delivery_hardening.sql', import.meta.url),
    'utf8'
  );
  assert.match(migration, /status set default 'disabled'/i);
  assert.match(migration, /for update skip locked/i);
  assert.match(
    migration,
    /create policy "email accounts update"[\s\S]*using \(public\.is_admin\(\)\)/i
  );
  assert.match(migration, /notifications_log_dedupe_idx/i);
  assert.match(migration, /webhook_receipts/i);
});

test('CallScaler pagination parses the documented nested response envelope', () => {
  const page = parseCallScalerPage({
    data: {
      calls: [{ id: 'call-1' }],
      has_more: true,
      next_cursor: 'cursor-2',
    },
  });
  assert.deepEqual(page.calls, [{ id: 'call-1' }]);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextCursor, 'cursor-2');
  assert.throws(() => parseCallScalerPage({ data: { total: 1 } }), /calls array/);
});

test('bulk delivery keys are stable and recipient-specific', () => {
  const requestKey = '018f0c73-4f8a-7f62-bf29-5f60fbe60610';
  assert.equal(validIdempotencyKey(requestKey), true);
  assert.equal(validIdempotencyKey('short'), false);
  assert.equal(
    deliveryKey('email', requestKey, 'contact-1'),
    `email:${requestKey}:contact-1`
  );
});

test('operational migration has atomic leases, jobs, usage, and durable call claims', async () => {
  const migration = await readFile(
    new URL('../supabase/migrations/0009_operational_resilience.sql', import.meta.url),
    'utf8'
  );
  assert.match(migration, /try_acquire_app_lease/i);
  assert.match(migration, /for update skip locked/i);
  assert.match(migration, /reserve_usage_event/i);
  assert.match(migration, /claim_call_processing/i);
  assert.match(migration, /phone_normalized text[\s\S]*generated always/i);
  assert.match(migration, /email_messages_delivery_key_idx/i);
});

test('webhooks persist searches instead of retaining response workers', async () => {
  const fluent = await readFile(
    new URL('../app/api/webhooks/fluent-forms/route.ts', import.meta.url),
    'utf8'
  );
  const calls = await readFile(
    new URL('../app/api/webhooks/callscaler/route.ts', import.meta.url),
    'utf8'
  );
  const migration = await readFile(
    new URL('../supabase/migrations/0024_comprehensive_hardening.sql', import.meta.url),
    'utf8'
  );
  assert.doesNotMatch(fluent, /\bafter\s*\(/);
  assert.doesNotMatch(calls, /\bafter\s*\(/);
  assert.match(fluent, /processFluentFormsLead\(payload, eventId\)/);
  assert.match(calls, /processCallScalerCall/);
  assert.match(migration, /create_fluent_lead[\s\S]*?insert into public\.job_queue/i);
  assert.match(migration, /complete_call_processing[\s\S]*?insert into public\.job_queue/i);
});

test('unexpected server errors become generic 500 responses', () => {
  assert.deepEqual(requestErrorResponse(new Error('relation private_table does not exist')), {
    message: 'The server could not complete this request',
    status: 500,
  });
  const validation = Object.assign(new Error('Invalid field'), { status: 400 });
  assert.deepEqual(requestErrorResponse(validation), { message: 'Invalid field', status: 400 });
});

test('comprehensive hardening protects ownership, tracking, imports, files and retention', async () => {
  const migration = await readFile(
    new URL('../supabase/migrations/0024_comprehensive_hardening.sql', import.meta.url),
    'utf8'
  );
  assert.match(migration, /role in \('super_admin', 'admin', 'worker'\)/i);
  assert.match(migration, /primary super administrator cannot be deleted/i);
  assert.match(migration, /import_contact_chunk/i);
  assert.match(migration, /enforce_contact_file_quota/i);
  assert.match(migration, /track_email_event_bounded/i);
  assert.match(migration, /purge_admin_data/i);
  assert.match(migration, /prune_growth_tables/i);
});

test('provider bodies, browser pages, and public destinations are bounded', async () => {
  const trestle = await readFile(new URL('../lib/integrations/trestle.ts', import.meta.url), 'utf8');
  const browser = await readFile(new URL('../lib/deep-search/browser.ts', import.meta.url), 'utf8');
  const voicemail = await readFile(
    new URL('../lib/integrations/voicemail.ts', import.meta.url),
    'utf8'
  );
  assert.match(trestle, /readResponseText\(res, 256 \* 1024\)/);
  assert.match(browser, /TEMPORARY HOST COMPATIBILITY/);
  assert.match(browser, /'--no-sandbox'/);
  assert.match(browser, /'--disable-setuid-sandbox'/);
  assert.match(browser, /MAX_RENDERED_HTML_BYTES/);
  assert.match(voicemail, /assertPublicHttpsUrl/);
});

test('runtime hardening migration wires atomic search, aggregate reads, and indexes', async () => {
  const migration = await readFile(
    new URL('../supabase/migrations/0020_runtime_hardening.sql', import.meta.url),
    'utf8'
  );
  assert.match(migration, /kind in \([\s\S]*?'deep_search'/i);
  assert.match(migration, /create or replace function public\.accept_search_candidate/i);
  assert.match(migration, /for update/i);
  assert.match(migration, /create or replace function public\.finish_usage_event/i);
  assert.match(migration, /create or replace function public\.usage_summary_since/i);
  assert.match(migration, /create or replace function public\.dashboard_metrics/i);
  assert.match(migration, /create or replace function public\.contacts_grid_page/i);
  assert.match(migration, /gin_trgm_ops/i);
});

test('manual searches are admin-only durable jobs', async () => {
  for (const path of [
    '../app/api/contacts/[id]/search/route.ts',
    '../app/api/contacts/[id]/deep-search/route.ts',
  ]) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.match(source, /requireAdmin/);
    assert.match(source, /enqueue(?:DeepSearch)?Job/);
    assert.doesNotMatch(source, /runDeepSearch\s*\(/);
    assert.doesNotMatch(source, /runAutoSearchForContact\s*\(/);
  }
});

test('provider metering uses database aggregation and bounded response streams', async () => {
  const usage = await readFile(new URL('../lib/usage.ts', import.meta.url), 'utf8');
  const brightdata = await readFile(
    new URL('../lib/integrations/brightdata.ts', import.meta.url),
    'utf8'
  );
  const llm = await readFile(new URL('../lib/deep-search/llm.ts', import.meta.url), 'utf8');
  assert.match(usage, /\.rpc\('usage_summary_since'/);
  assert.match(usage, /\.rpc\('finish_usage_event'/);
  assert.doesNotMatch(usage, /\.from\('usage_events'\)\s*\.select/);
  assert.match(brightdata, /readResponseText\(res, 2 \* 1024 \* 1024\)/);
  assert.match(llm, /readResponseText\(res, 1024 \* 1024\)/);
});

test('browser capacity is bounded and idle shutdown cannot kill active work', async () => {
  const browser = await readFile(new URL('../lib/deep-search/browser.ts', import.meta.url), 'utf8');
  assert.match(browser, /MAX_QUEUED_PAGES/);
  assert.match(browser, /SLOT_WAIT_MS/);
  assert.match(browser, /reason === 'idle' && activePages > 0/);
  assert.match(browser, /waiters\.length >= MAX_QUEUED_PAGES/);
});

test('every integrations-page section can actually be saved, secrets masked', async () => {
  // The live failure: the Trestle section rendered and accepted an API key, but
  // 'trestle' was never added to the settings route's KNOWN_KEYS — so every
  // save returned "Unknown settings key: trestle". The page and the route must
  // agree, and any field the page marks secret must be masked by the route.
  const page = await readFile(
    new URL('../app/(app)/admin/integrations/page.tsx', import.meta.url),
    'utf8'
  );
  const route = await readFile(
    new URL('../app/api/admin/settings/route.ts', import.meta.url),
    'utf8'
  );

  const knownKeys = route.match(/const KNOWN_KEYS = \[([\s\S]*?)\]/)?.[1] ?? '';
  const secretFields = route.match(/const SECRET_FIELDS[\s\S]*?\n\};/)?.[0] ?? '';

  const sections = [...page.matchAll(/key: '([a-z_]+)',\s*\n\s*title:/g)].map((m) => m[1]);
  assert.ok(sections.includes('trestle'), 'expected to find the trestle section');
  for (const key of sections) {
    assert.ok(knownKeys.includes(`'${key}'`), `settings route must accept saves for '${key}'`);
  }

  for (const match of page.matchAll(/key: '([a-z_]+)', label:[^\n]*secret: true/g)) {
    assert.ok(
      secretFields.includes(`'${match[1]}'`),
      `secret field '${match[1]}' must be masked by the settings route`
    );
  }
});

test('manual reverse lookup is admin-gated and still only fills blanks', async () => {
  const route = await readFile(
    new URL('../app/api/contacts/[id]/enrich/route.ts', import.meta.url),
    'utf8'
  );
  const enrichment = await readFile(new URL('../lib/enrichment.ts', import.meta.url), 'utf8');

  // Every press is a billed provider call — workers must not have the button's
  // endpoint even if they discover its URL.
  assert.match(route, /requireAdmin/);
  assert.match(route, /force: true/);

  // Force skips the "already complete" short-circuit (the admin wants to SEE
  // the answer) but must never widen what gets written: name/city/state writes
  // stay behind their needsName/needsLocation guards.
  assert.match(enrichment, /!needsName && !needsLocation && !opts\?\.force/);
  assert.match(enrichment, /if \(needsName && identity\.name\)/);
  assert.match(enrichment, /if \(needsLocation && identity\.city && identity\.state\)/);
});

test('contact merge is admin-gated, atomic, and deletes last', async () => {
  const route = await readFile(
    new URL('../app/api/contacts/[id]/merge/route.ts', import.meta.url),
    'utf8'
  );
  const migration = await readFile(
    new URL('../supabase/migrations/0026_merge_contacts.sql', import.meta.url),
    'utf8'
  );

  // Merging deletes a contact; deletion is already admin-gated, so this must
  // be too — and the target id is validated before it reaches SQL.
  assert.match(route, /requireAdmin/);
  assert.match(route, /UUID\.test\(mergeId\)/);
  assert.match(route, /mergeId === id/);

  // One transaction, deterministic lock order, and the duplicate dies LAST —
  // after every child row has been repointed — so a failure part-way leaves
  // both contacts intact rather than orphaning a call history.
  assert.match(migration, /least\(p_winner, p_loser\) for update/);
  const deleteAt = migration.indexOf('delete from public.contacts where id = p_loser');
  assert.ok(deleteAt > 0, 'the duplicate must be deleted');
  for (const table of [
    'activity_log',
    'calls',
    'email_messages',
    'contact_files',
    'search_candidates',
  ]) {
    const moveAt = migration.indexOf(`public.${table}`, migration.indexOf('begin'));
    assert.ok(
      moveAt > 0 && moveAt < deleteAt,
      `${table} must be repointed before the duplicate is deleted`
    );
  }
  // Survivor's values win; the merged row only fills blanks — same rule as
  // enrichment. And rejected-candidate tombstones survive the move.
  assert.match(migration, /coalesce\(nullif\(btrim\(w\.email\), ''\), l\.email\)/);
  assert.match(migration, /not exists \(\s*select 1 from public\.search_candidates/);
  // Locked down like every other privileged function.
  assert.match(migration, /revoke all on function public\.merge_contacts[\s\S]*?authenticated/);
  assert.match(migration, /grant execute on function public\.merge_contacts[\s\S]*?service_role/);
});

test('password reset is non-enumerating and has a recovery page', async () => {
  const landing = await readFile(new URL('../app/page.tsx', import.meta.url), 'utf8');
  const reset = await readFile(
    new URL('../app/auth/reset-password/page.tsx', import.meta.url),
    'utf8'
  );
  assert.match(landing, /resetPasswordForEmail/);
  assert.match(landing, /If that account exists/);
  assert.match(reset, /exchangeCodeForSession/);
  assert.match(reset, /updateUser\(\{ password \}\)/);
});

test('selected audit hardening protects credentials and marketing mutations', async () => {
  const migration = await readFile(
    new URL('../supabase/migrations/0027_selected_audit_hardening.sql', import.meta.url),
    'utf8'
  );
  const inbox = await readFile(new URL('../app/(app)/inbox/page.tsx', import.meta.url), 'utf8');
  const enroll = await readFile(
    new URL('../app/api/email/sequences/[id]/enroll/route.ts', import.meta.url),
    'utf8'
  );
  assert.match(migration, /create or replace view public\.email_accounts_safe/);
  const safeView = migration.slice(
    migration.indexOf('create or replace view public.email_accounts_safe'),
    migration.indexOf('revoke all on table public.email_accounts')
  );
  assert.doesNotMatch(safeView, /smtp_password/);
  assert.match(
    migration,
    /revoke all on table public\.email_accounts from public, anon, authenticated/
  );
  assert.match(inbox, /from\('email_accounts_safe'\)/);
  assert.match(inbox, /\/api\/admin\/email-accounts/);
  assert.match(enroll, /requireAdmin/);
  assert.match(migration, /"sequences admin write"/);
  assert.match(migration, /"enrollments admin write"/);
});

test('sequence and deep-search workers use stable generation identities', async () => {
  const sequence = await readFile(new URL('../lib/sequence-runner.ts', import.meta.url), 'utf8');
  const queue = await readFile(new URL('../lib/job-queue.ts', import.meta.url), 'utf8');
  const engine = await readFile(new URL('../lib/deep-search/index.ts', import.meta.url), 'utf8');
  assert.match(sequence, /deliveryKey: `sequence:\$\{enrollment\.id\}:step:\$\{nextStep\.id\}`/);
  assert.match(sequence, /if \(advanceError\) throw new Error/);
  assert.match(queue, /jobId: String\(job\.id\)/);
  assert.match(queue, /jobWorker: worker/);
  assert.match(queue, /jobAttempt: Number\(job\.attempt_count\)/);
  assert.match(engine, /if \(opts\?\.signal\?\.aborted\)/);
  assert.match(engine, /finish_deep_search_attempt/);
});

test('voicemail lifecycle is quota-bound and deletion cancels delivery', async () => {
  const migration = await readFile(
    new URL('../supabase/migrations/0027_selected_audit_hardening.sql', import.meta.url),
    'utf8'
  );
  const drops = await readFile(
    new URL('../app/api/voicemail/drops/route.ts', import.meta.url),
    'utf8'
  );
  const queue = await readFile(new URL('../lib/job-queue.ts', import.meta.url), 'utf8');
  assert.match(drops, /requireAdmin/);
  assert.match(drops, /size_bytes: file\.size/);
  assert.match(drops, /prepare_voicemail_drop_delete/);
  assert.match(migration, /Voicemail storage is limited to 500 MB/);
  assert.match(migration, /status in \('pending', 'processing'\)/);
  assert.match(queue, /lifecycle_status/);
  assert.match(queue, /existing\.status !== 'queued'/);
});

test('growth paths are paged, indexed, and pruned in bounded batches', async () => {
  const migration = await readFile(
    new URL('../supabase/migrations/0027_selected_audit_hardening.sql', import.meta.url),
    'utf8'
  );
  const sms = await readFile(new URL('../app/(app)/sms/page.tsx', import.meta.url), 'utf8');
  const voicemail = await readFile(
    new URL('../app/(app)/voicemail/page.tsx', import.meta.url),
    'utf8'
  );
  assert.match(migration, /from paged p/);
  assert.match(migration, /job_queue_contact_payload_idx/);
  assert.match(migration, /before insert or update of contact_id, size_bytes/);
  assert.match(migration, /limit 5000/g);
  assert.doesNotMatch(sms, /sms_messages \( id, status \)/);
  assert.match(sms, /\.limit\(100\)/);
  assert.match(voicemail, /voicemail_drop_summaries/);
});

test('contact mutations commit durable side effects instead of partial request chains', async () => {
  const migration = await readFile(
    new URL('../supabase/migrations/0027_selected_audit_hardening.sql', import.meta.url),
    'utf8'
  );
  const contactRoute = await readFile(
    new URL('../app/api/contacts/[id]/route.ts', import.meta.url),
    'utf8'
  );
  const linksRoute = await readFile(
    new URL('../app/api/contacts/[id]/links/route.ts', import.meta.url),
    'utf8'
  );
  assert.match(migration, /update_contact_status_atomic/);
  assert.match(migration, /'contact_side_effects'/);
  assert.match(migration, /replace_contact_links_atomic/);
  assert.match(migration, /'event', 'link_status_change'/);
  assert.match(contactRoute, /p_expected_updated_at: before\.updated_at/);
  assert.match(linksRoute, /replace_contact_links_atomic/);
});
