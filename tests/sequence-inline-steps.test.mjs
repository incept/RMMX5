import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');

test('migration adds inline subject + html to sequence_steps', async () => {
  const mig = await read('../supabase/migrations/0048_sequence_step_inline.sql');
  assert.match(mig, /alter table public\.sequence_steps/i);
  assert.match(mig, /add column if not exists subject text/i);
  assert.match(mig, /add column if not exists html text/i);
});

test('runner still selects the template join and prefers a step inline body', async () => {
  const src = await read('../lib/sequence-runner.ts');
  // inline columns arrive via select('*'); template stays joined as a fallback
  assert.match(src, /sequence_steps'\)\s*\.select\('\*, email_templates/);
  // resolution: use the step's own subject/html when it has a body, else template
  assert.match(src, /step\.html \? \(step\.subject \?\? ''\) : \(template\?\.subject \?\? ''\)/);
  assert.match(src, /step\.html \? step\.html : \(template\?\.html \?\? ''\)/);
});

test('sequence step form uses the rich editor with a per-step subject + template seed', async () => {
  const mk = await read('../app/(app)/marketing/page.tsx');
  assert.match(mk, /value=\{step\.html \?\? ''\}/); // body editor bound to the step
  assert.match(mk, /onImageUpload=\{uploadEmailImage\}/);
  assert.match(mk, /updateStep\(i, \{ subject: e\.target\.value \}\)/); // per-step subject
  assert.match(mk, /Start from template/);
  assert.match(mk, /applyStepTemplate/);
});

test('saved steps are self-contained, sanitized, and require a subject', async () => {
  const mk = await read('../app/(app)/marketing/page.tsx');
  assert.match(mk, /html: sanitizeEmailHtml\(s\.html/); // stored HTML scrubbed
  assert.match(mk, /template_id: null/); // no live template link
  assert.match(mk, /Each step needs a subject/); // validation
  assert.match(mk, /stepHasBody/); // blank steps dropped
});

test('editing a legacy template-linked step backfills its content inline', async () => {
  const mk = await read('../app/(app)/marketing/page.tsx');
  assert.match(mk, /templates\.find\(\(x\) => x\.id === s\.template_id\)/);
});
