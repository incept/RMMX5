-- Sequence steps can now carry their own inline email (subject + body) written
-- right in the sequence builder, instead of only pointing at a saved template.
--
-- Backward compatible: template_id stays (nullable), and the runner falls back
-- to the linked template whenever a step has no inline html. Editing a sequence
-- in the new UI backfills each step's inline body from its template and saves it
-- on the step, so the step becomes self-contained from then on.
alter table public.sequence_steps
  add column if not exists subject text,
  add column if not exists html text;
