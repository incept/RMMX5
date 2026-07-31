import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('fast scoring jobs drain in a batch so a backlog cannot starve email/SMS', async () => {
  const migration = await readFile(
    new URL('../supabase/migrations/0036_light_job_drain.sql', import.meta.url),
    'utf8'
  );
  assert.match(migration, /function public\.claim_light_jobs/);
  // Everything except the heavy Chrome-owning searches, in priority order:
  // deliveries first, scoring last.
  assert.match(migration, /j\.kind not in \('deep_search', 'auto_search'\)/);
  assert.match(migration, /when 'email_delivery' then 0/);
  assert.match(migration, /when 'score_contact' then 9/);
  assert.match(migration, /order by prio, j\.available_at, j\.created_at/);
  // Safe to run alongside claim_jobs.
  assert.match(migration, /for update of j skip locked/);
  assert.match(
    migration,
    /grant execute on function public\.claim_light_jobs\(text, int, int\) to service_role/
  );

  const jobQueue = await readFile(new URL('../lib/job-queue.ts', import.meta.url), 'utf8');
  assert.match(jobQueue, /opts\?\.light \? 'claim_light_jobs' : 'claim_jobs'/);

  const tick = await readFile(new URL('../app/api/cron/tick/route.ts', import.meta.url), 'utf8');
  // Each tick drains a priority batch of light jobs and one heavy job.
  assert.match(tick, /processQueuedJobs\(20, \{ light: true \}\)/);
  assert.match(tick, /drainQueue\(\)/);
});
