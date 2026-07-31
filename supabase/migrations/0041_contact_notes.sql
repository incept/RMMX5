-- ---------------------------------------------------------------------------
-- Contact notes
-- ---------------------------------------------------------------------------
-- A single free-form notes field per contact, shown on its own tab in the
-- contact panel. This is distinct from the activity log's timestamped `note`
-- entries (a running history): notes here are one editable scratchpad for the
-- record — background, context, reminders — that staff overwrite in place.
alter table public.contacts add column if not exists notes text;
