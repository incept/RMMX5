import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Chromium rejects HTTP failures, blank documents, and soft error pages', async () => {
  const source = await readFile(
    new URL('../lib/deep-search/browser.ts', import.meta.url),
    'utf8'
  );

  assert.match(source, /status < 200 \|\| status >= 300/);
  assert.match(source, /browser returned a blank page/);
  assert.match(source, /looksLikeErrorDocument\(size\.title, size\.bodyText\)/);
  assert.match(source, /browser returned an error page with a successful HTTP status/);
});

test('every page-fetch tier rejects empty and synthetic error bodies', async () => {
  const source = await readFile(
    new URL('../lib/deep-search/fetch-page.ts', import.meta.url),
    'utf8'
  );

  assert.match(source, /function pageFailure\(status: number, html: string\)/);
  assert.match(source, /!html\.trim\(\) \|\| !bodyText/);
  assert.match(source, /const failure = pageFailure\(res\.status, html\)/);
  assert.match(source, /const unlockerPageFailure = pageFailure\(res\.status, body\)/);
  assert.match(source, /HTTP \$\{status\} \(error page\)/);
});

test('the optional Anthropic tier cannot suppress deterministic page parsing', async () => {
  const source = await readFile(
    new URL('../lib/deep-search/llm.ts', import.meta.url),
    'utf8'
  );
  const extraction = source.slice(0, source.indexOf('export interface SerpItem'));

  assert.match(
    extraction,
    /try \{\s*cfg = await getSetting<[\s\S]*?catch[\s\S]*?using deterministic parser/
  );
  assert.match(
    extraction,
    /try \{\s*usage = await reserveUsage\([\s\S]*?catch[\s\S]*?using deterministic parser/
  );
  assert.match(extraction, /return null;/);
});

test('browser slots and Puppeteer resources are abort-aware and bounded', async () => {
  const source = await readFile(
    new URL('../lib/deep-search/browser.ts', import.meta.url),
    'utf8'
  );

  assert.match(source, /async function acquireSlot\(signal\?: AbortSignal\)/);
  assert.match(source, /signal\?\.addEventListener\('abort', waiter\.onAbort/);
  assert.match(source, /boundedOperation\(\s*browser\.createBrowserContext\(\)/);
  assert.match(source, /boundedOperation\(\s*context\.newPage\(\)/);
  assert.match(source, /'configuring browser request interception'/);
  assert.match(source, /'browser navigation',\s*PAGE_TIMEOUT_MS \+ 5_000/);
  assert.match(source, /'reading rendered browser HTML'/);
  assert.match(source, /'browser page close',\s*RESOURCE_CLOSE_TIMEOUT_MS/);
  assert.match(source, /'browser context close',\s*RESOURCE_CLOSE_TIMEOUT_MS/);
  assert.match(source, /kill\('SIGKILL'\)/);
});

test('deep search fails closed on database reads and a total provider outage', async () => {
  const source = await readFile(
    new URL('../lib/deep-search/index.ts', import.meta.url),
    'utf8'
  );

  assert.match(source, /Could not load contact for deep search/);
  assert.match(source, /Could not load confirmed contact links/);
  assert.match(source, /Could not load probe sites/);
  assert.match(source, /Could not load URL rules/);
  assert.match(source, /if \(discoverySuccesses === 0\)/);
  assert.match(source, /Deep search had no runnable external source/);
  assert.match(source, /source: 'deep-search:health'/);
  assert.match(source, /the run was not marked complete/);
});

test('worker and activity failures are externally observable', async () => {
  const cron = await readFile(
    new URL('../app/api/cron/tick/route.ts', import.meta.url),
    'utf8'
  );
  const activity = await readFile(new URL('../lib/activity.ts', import.meta.url), 'utf8');
  const queue = await readFile(new URL('../lib/job-queue.ts', import.meta.url), 'utf8');
  const debugLog = await readFile(new URL('../lib/debug-log.ts', import.meta.url), 'utf8');
  const pkg = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  );

  assert.match(cron, /Number\([\s\S]*?\.failed \?\? 0\) > 0/);
  assert.match(cron, /status: degraded \? 500 : 200/);
  assert.match(activity, /const \{ error \} = await supabase\.from\('activity_log'\)\.insert/);
  assert.match(activity, /source: 'activity-log'/);
  assert.match(queue, /async function completeJob/);
  assert.match(queue, /async function failJob/);
  assert.doesNotMatch(queue, /if \(!failure\)/);
  assert.match(debugLog, /JSON\.stringify\(e\) \?\? String\(e\)/);
  assert.equal(pkg.engines.node, '>=22.19.0');
});
